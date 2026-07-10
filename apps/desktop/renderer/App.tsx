import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { AppShell } from "./chrome/AppShell";
import { Today } from "./surfaces/today/Today";
import { Projects } from "./surfaces/projects/Projects";
import { Approvals } from "./surfaces/approvals/Approvals";
import { IngestionInbox } from "./surfaces/ingestion-inbox";
import { createUiSafeStore } from "./store";
import { setScope, navigate, hydrateApprovals } from "./store/projections";
import { WORKSPACE_SCOPES, resolveWorkspaceId, type WorkspaceScope } from "./store/scope";
import type { Route } from "./store/route";
import { startLive, type StartLiveHandle } from "./lib/live";
import type { AskResult } from "./lib/copilot-ask";
import type { ApprovalDecision } from "./lib/approval-decision";
import { seedDevStore } from "./dev/seed";

// The renderer's single UI-safe store (app singleton — one window).
const store = createUiSafeStore();

export function App(): ReactElement {
  const liveRef = useRef<StartLiveHandle | null>(null);
  // Whether a REAL live worker handle exists (reactive — drives affordances that must be
  // disabled without a worker, e.g. the approval-decision buttons). Distinct from the
  // `connection` status: the dev-seed fallback sets connection="live" for a populated demo
  // even though there is NO handle, so gating on `connection` would render dead controls.
  const [hasLiveWorker, setHasLiveWorker] = useState(false);

  useEffect(() => {
    // Connect the live worker over the §10 push stream (9.4b E). When there is no
    // worker bridge (a standalone browser without Electron main), fall back to the
    // sample seed so the surface still renders populated in dev.
    let cancelled = false;
    void startLive(store).then((handle) => {
      if (cancelled) {
        handle?.stop();
        return;
      }
      liveRef.current = handle;
      setHasLiveWorker(handle !== null);
      if (handle === null && import.meta.env.DEV) seedDevStore(store);
    });
    return () => {
      cancelled = true;
      liveRef.current?.stop();
      liveRef.current = null;
      setHasLiveWorker(false);
    };
  }, []);

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // §9.4 policy-gated drill-down: REQUEST the worker-enforced query; on a permitted
  // result fold the workspace-scoped cards in + switch scope to that workspace. A
  // denial / no-bridge is a safe no-op — the worker enforces, the renderer only asks.
  // Scope change (§9.5): set the scope, then re-hydrate the scope-appropriate reads
  // (the live handle clears + re-queries, so nothing blends across scopes).
  const onScopeChange = (scope: WorkspaceScope): void => {
    store.dispatch((st) => setScope(st, scope));
    void liveRef.current?.hydrateScope(scope);
  };

  // Drill-down = the worker-enforced PERMISSION gate. On a permitted result, navigate
  // to that workspace's scope (a within-workspace read re-loads its cards via
  // hydrateScope); on a denial we do nothing. The gated cards themselves are the same
  // workspace read the scope switch performs, so no separate hydrate is needed.
  const onDrillDown = (workspaceId: string, projectionType: string): void => {
    void liveRef.current?.drillDown(workspaceId, projectionType).then((r) => {
      if (!r.ok) return;
      const scope = WORKSPACE_SCOPES.find((m) => m.workspaceId === workspaceId);
      if (scope) onScopeChange(scope.id);
    });
  };

  // §9.5 routing: select the mounted SURFACE (left-rail nav). Scope-preserving — `navigate`
  // never touches the scope or the scope-hydrated read-models.
  const onNavigate = (route: Route): void => {
    store.dispatch((st) => navigate(st, route));
  };

  // Select a project's detail — carries the id in the route (scope-preserving; §9.5).
  const onSelectProject = (projectId: string): void => {
    store.dispatch((st) => navigate(st, { surface: "projects", projectId }));
  };

  // §9.6 Copilot ask: resolve the CURRENT scope's workspaceId (fail-closed for Global / unknown) and
  // ask the worker. No single workspace or no live bridge → {ok:false}; the worker re-derives its own
  // workspace scoping + runs the WS-8 / candidate-data gates, so the renderer only requests.
  const onAskCopilot = (question: string): Promise<AskResult> => {
    const workspaceId = resolveWorkspaceId(state.scope);
    if (workspaceId === null || liveRef.current === null) return Promise.resolve({ ok: false });
    return liveRef.current.askCopilot(workspaceId, question);
  };

  // §9.8 approval decision: REQUEST the worker's exactly-once transition (mac channel). On a
  // decided (or idempotent no-op) result, fold the worker's authoritative UI-safe record into
  // the inbox Map — the item transitions in place (approved/rejected drop it from the inbox;
  // deferred moves it to snoozed). A failed decision / no live worker is a safe no-op — the
  // worker owns the CAS + one-writer dispatch; the renderer only asks.
  const onDecideApproval = (approvalId: string, decision: ApprovalDecision): void => {
    const handle = liveRef.current;
    if (handle === null) return;
    void handle.decideApproval(approvalId, decision).then((r) => {
      if (r.ok) store.dispatch((s) => hydrateApprovals(s, [r.approval]));
    });
  };

  const approvals = [...state.approvals.values()];
  const pendingApprovalCount = approvals.filter((a) => a.status === "pending").length;

  const selectedProjectId =
    state.route.surface === "projects" ? state.route.projectId : undefined;

  return (
    <AppShell
      connection={state.connection}
      scope={state.scope}
      onScopeChange={onScopeChange}
      route={state.route}
      onNavigate={onNavigate}
      onAskCopilot={onAskCopilot}
      pendingApprovalCount={pendingApprovalCount}
      ingestionCount={state.ingestion.length}
    >
      {state.route.surface === "approvals" ? (
        <Approvals
          approvals={approvals}
          // Enabled only over a REAL live worker (the decision needs the CAS); no worker
          // (incl. the dev-seed demo) → disabled buttons, never a silently no-op control.
          onDecide={hasLiveWorker ? onDecideApproval : undefined}
        />
      ) : state.route.surface === "ingestion" ? (
        <IngestionInbox items={state.ingestion} />
      ) : state.route.surface === "projects" ? (
        <Projects
          scope={state.scope}
          projects={state.projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
        />
      ) : (
        <Today
          scope={state.scope}
          cards={[...state.cards.values()]}
          health={[...state.health.values()]}
          global={state.global}
          recentChanges={state.recentChanges}
          onDrillDown={onDrillDown}
        />
      )}
    </AppShell>
  );
}
