import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { AppShell } from "./chrome/AppShell";
import { Today } from "./surfaces/today/Today";
import { Projects } from "./surfaces/projects/Projects";
import { Approvals } from "./surfaces/approvals/Approvals";
import { IngestionInbox } from "./surfaces/ingestion-inbox";
import { createUiSafeStore } from "./store";
import {
  setScope,
  navigate,
  hydrateApprovals,
  replaceIngestion,
  resolveOnboardedWorkspaceId,
  scopeForWorkspaceId,
  hasAnyOnboardedWorkspace,
  recordOnboardedWorkspace,
} from "./store/projections";
import { scopeMeta, type WorkspaceScope } from "./store/scope";
import { scopeForType } from "./store/onboarding";
import { Onboarding } from "./surfaces/onboarding";
import type { Route } from "./store/route";
import { startLive, type StartLiveHandle } from "./lib/live";
import type { AskResult } from "./lib/copilot-ask";
import type { ApprovalDecision } from "./lib/approval-decision";
import type { TriageDisposition } from "./lib/triage-disposition";
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
      // Map the permitted workspaceId back to its scope via the ONBOARDED set (§19.1 / 14.1) —
      // a drill can only target an onboarded workspace; an unmatched id is a safe no-op.
      const scope = scopeForWorkspaceId(store.getSnapshot(), workspaceId);
      if (scope !== null) onScopeChange(scope);
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
    const workspaceId = resolveOnboardedWorkspaceId(state, state.scope);
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

  // §9.7 triage disposition: REQUEST the worker's replay-safe pipeline re-entry (deterministic
  // idempotency key, minted caller-side). On ok, DRAIN the item from the workspace-scoped inbox
  // (`disposeTriage` returns no post-state record — no re-query) via the existing scope-replace
  // reducer; on a failed/again disposition the item REMAINS (fail closed — the card surfaces the
  // error). No live worker → `{ ok: false }`, so the card never shows a false drain.
  const onDisposeTriage = (sourceId: string, disposition: TriageDisposition): Promise<boolean> => {
    const handle = liveRef.current;
    if (handle === null) return Promise.resolve(false);
    return handle.disposeTriage(sourceId, disposition).then((r) => {
      if (!r.ok) return false;
      store.dispatch((s) => replaceIngestion(s, s.ingestion.filter((it) => it.sourceId !== sourceId)));
      return true;
    });
  };

  const approvals = [...state.approvals.values()];
  const pendingApprovalCount = approvals.filter((a) => a.status === "pending").length;

  const selectedProjectId =
    state.route.surface === "projects" ? state.route.projectId : undefined;

  // First-run gate (§19.1 / 14.1): until AT LEAST ONE workspace is onboarded, the app IS the
  // onboarding surface (fail-closed empty-until-onboarded — there is nothing to scope-read yet).
  // Once a workspace enters the registry-backed scope store, the app proper mounts.
  if (!hasAnyOnboardedWorkspace(state)) {
    return (
      <Onboarding
        onCreateWorkspace={(input) =>
          liveRef.current?.onboardWorkspace(input) ?? Promise.resolve({ ok: false as const })
        }
        onPreviewPreset={(preset) =>
          liveRef.current?.previewPreset(preset) ?? Promise.resolve({ ok: false as const })
        }
        onOnboarded={(workspace, input) => {
          // Record the REAL minted id into the scope store → the workspace becomes selectable and
          // the app leaves first-run. Bucket derived from the immutable workspace type.
          store.dispatch((s) =>
            recordOnboardedWorkspace(s, {
              workspaceId: workspace.workspaceId,
              scope: scopeForType(input.type),
              name: input.name,
              type: input.type,
              preset: workspace.preset,
            }),
          );
        }}
      />
    );
  }

  // WS-8 gate for the Copilot ask composer: enabled ONLY when the active scope resolves to a
  // single ONBOARDED workspace (§19.1 / 14.1). Global, a non-onboarded bucket, or an unknown
  // scope → null → the pick-a-workspace state (you can't ask an un-onboarded workspace).
  const copilotWorkspaceScoped = resolveOnboardedWorkspaceId(state, state.scope) !== null;
  // Real workspaceId → { display name, subtle scope accent } (from the onboarded set) for Today's
  // Global per-workspace rows — replaces the former placeholder-id → ScopeMeta lookup.
  const workspaceMeta = new Map<string, { readonly label: string; readonly accent: string }>(
    [...state.onboarded.values()].map((ow) => [ow.workspaceId, { label: ow.name, accent: scopeMeta(ow.scope).accent }]),
  );

  return (
    <AppShell
      connection={state.connection}
      scope={state.scope}
      onScopeChange={onScopeChange}
      route={state.route}
      onNavigate={onNavigate}
      onAskCopilot={onAskCopilot}
      copilotWorkspaceScoped={copilotWorkspaceScoped}
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
        <IngestionInbox
          items={state.ingestion}
          onDispose={hasLiveWorker ? onDisposeTriage : undefined}
        />
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
          workspaceMeta={workspaceMeta}
          onDrillDown={onDrillDown}
        />
      )}
    </AppShell>
  );
}
