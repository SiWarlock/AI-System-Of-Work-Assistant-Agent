import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { AppShell } from "./chrome/AppShell";
import { Today } from "./surfaces/today/Today";
import { Projects } from "./surfaces/projects/Projects";
import { Calendar } from "./surfaces/calendar";
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
  connectorsForWorkspace,
  upsertConnectorInstance,
  crossWorkspaceLinksList,
  upsertCrossWorkspaceLink,
} from "./store/projections";
import { scopeMeta, type WorkspaceScope } from "./store/scope";
import { scopeForType } from "./store/onboarding";
import { Onboarding } from "./surfaces/onboarding";
import { Connectors } from "./surfaces/connectors";
import { SystemHealth } from "./surfaces/system-health";
import { CrossWorkspaceLinks } from "./surfaces/cross-workspace-links";
import { EgressSettings } from "./surfaces/workspace-settings/egress";
import { requestVaultOpen, requestVaultReveal } from "./lib/open-in-vault";
import type { RegisterConnectorInput, ConnectorConfigResult } from "./lib/connector-config";
import type { CreateCrossWorkspaceLinkInput, CrossWorkspaceLinkResult } from "./lib/cross-workspace-link";
import type { EgressStatusResult } from "./lib/egress-status";
import type { Route } from "./store/route";
import { startLive, type StartLiveHandle } from "./lib/live";
import type { AskResult } from "./lib/copilot-ask";
import type { AuditDrillResult } from "./lib/audit-drill";
import type { ApprovalDecision } from "./lib/approval-decision";
import type { TriageDisposition, RerouteTarget } from "./lib/triage-disposition";
import { reroutePickerOptions } from "./lib/reroute-picker";
import { shouldShowOnboarding, shouldBackfillMarker, type FirstRunSignal } from "./lib/first-run-gate";
import { buildDailyBrief } from "./lib/daily-brief";
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
  // The durable first-run marker signal (9.17): `undefined` while the async read is pending, then the
  // marker Result. Drives the authoritative onboarding gate (below) with a registry fallback. `backfilledRef`
  // makes the existing-install marker backfill fire AT MOST ONCE (a persistent read fault can't loop writes).
  const [firstRunSignal, setFirstRunSignal] = useState<FirstRunSignal>(undefined);
  const backfilledRef = useRef(false);

  useEffect(() => {
    // Read the durable first-run marker once at boot (9.17). No bridge (a standalone browser without Electron
    // main) ⇒ leave the signal pending; the gate falls back to the registry. A read fault resolves to an err
    // Result the gate also maps to the fallback — never a lock-out.
    let cancelled = false;
    void window.sow?.lifecycle?.firstRunStatus().then((s) => {
      if (!cancelled) setFirstRunSignal(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    // Existing-install marker BACKFILL (9.17): a pre-feature install has a populated registry but NO marker,
    // so the durable authority never engages until we write it once. Once the registry shows onboarded and
    // the marker read RESOLVED to not-complete, write it ONCE (idempotent) — future worker-down boots then
    // stay past onboarding. Fire-once guard prevents a persistent read fault from looping writes every render.
    if (!backfilledRef.current && shouldBackfillMarker(firstRunSignal, hasAnyOnboardedWorkspace(state))) {
      backfilledRef.current = true;
      void window.sow?.lifecycle?.markOnboarded();
    }
  }, [firstRunSignal, state]);

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

  // 9.41 leg C: audit-drill REQUEST for a Recent Activity row's opaque changeId. Resolves the
  // CURRENT scope's workspaceId (fail-closed for Global/unknown/no-live-worker, mirrors
  // onAskCopilot) — the worker re-derives the AuditRecord + re-checks WS-8 scope-ownership; the
  // renderer only asks, and RecentActivity never sees a raw workspaceId.
  const onAuditDrill = (changeId: string): Promise<AuditDrillResult> => {
    const workspaceId = resolveOnboardedWorkspaceId(state, state.scope);
    if (workspaceId === null || liveRef.current === null) return Promise.resolve({ ok: false });
    return liveRef.current.auditDrill(workspaceId, changeId);
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
  // deferred moves it to snoozed). Resolves to the outcome so the card can render it: a real
  // transition is "applied"; an idempotent no-op (`applied:false`) OR a lost-CAS `write_conflict`
  // BOTH map to the same honest "already_resolved" (§9.8's DecisionResult already collapsed the
  // two wire shapes into one reason — this just also folds the `applied:false` ok case in); every
  // other failure (incl. no live worker) is "unavailable". Never surfaces the worker's raw kind/
  // message (rule 7) — only this closed 3-value outcome crosses into the surface.
  const onDecideApproval = (
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<"applied" | "already_resolved" | "unavailable"> => {
    const handle = liveRef.current;
    if (handle === null) return Promise.resolve("unavailable");
    return handle.decideApproval(approvalId, decision).then((r) => {
      if (!r.ok) return r.reason;
      store.dispatch((s) => hydrateApprovals(s, [r.approval]));
      return r.applied ? "applied" : "already_resolved";
    });
  };

  // §9.7 triage disposition: REQUEST the worker's replay-safe pipeline re-entry (deterministic
  // idempotency key, minted caller-side). On ok, DRAIN the item from the workspace-scoped inbox
  // (`disposeTriage` returns no post-state record — no re-query) via the existing scope-replace
  // reducer; on a failed/again disposition the item REMAINS (fail closed — the card surfaces the
  // error). No live worker → `{ ok: false }`, so the card never shows a false drain.
  const onDisposeTriage = (
    sourceId: string,
    disposition: TriageDisposition,
    target?: RerouteTarget,
  ): Promise<boolean> => {
    const handle = liveRef.current;
    if (handle === null) return Promise.resolve(false);
    return handle.disposeTriage(sourceId, disposition, target).then((r) => {
      if (!r.ok) return false;
      store.dispatch((s) => replaceIngestion(s, s.ingestion.filter((it) => it.sourceId !== sourceId)));
      return true;
    });
  };

  // 15.8 reroute picker options — the human routing-resolution target choices. Workspaces come from
  // the onboarded/registered set (14.1); projects from the CURRENT scope's read model (14.6), bound
  // to the resolved current-scope workspace (WS-8 — the only workspace whose projects we hold).
  const rerouteOptions = reroutePickerOptions(
    state.onboarded,
    state.projects,
    resolveOnboardedWorkspaceId(state, state.scope),
  );

  const approvals = [...state.approvals.values()];
  const pendingApprovalCount = approvals.filter((a) => a.status === "pending").length;

  // §9.20 Today daily brief — a DETERMINISTIC, model-free summary from store counts. recentChanges +
  // ingestion are scope-hydrated (WS-8-cleared to [] under Global, so they reflect the current workspace);
  // pendingApprovals is the INTENTIONALLY-GLOBAL approval inbox (not scope-cleared — ratified design), so it
  // counts across workspaces in every scope. UI-safe (counts only, no raw content).
  const brief = buildDailyBrief({
    recentChanges: state.recentChanges.length,
    toTriage: state.ingestion.length,
    pendingApprovals: pendingApprovalCount,
  });

  const selectedProjectId =
    state.route.surface === "projects" ? state.route.projectId : undefined;

  // First-run gate (§19.1 / 14.1 + 9.17): the app IS the onboarding surface ONLY on a genuine first run.
  // The AUTHORITATIVE, durable main-owned marker decides: a complete marker suppresses onboarding even under
  // a transiently-empty registry (worker unreachable at boot); absent / faulted / pending ⇒ fall back to the
  // registry-derived gate (`!hasAnyOnboardedWorkspace`) — never re-onboarding a real install. Gates ONLY this
  // mount, never the WS-8 isolation predicate (LESSON 9).
  if (shouldShowOnboarding(firstRunSignal, hasAnyOnboardedWorkspace(state))) {
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
          // Persist the durable first-run marker (9.17) on this CONFIRMED create so future launches skip
          // onboarding even if the worker is unreachable at boot. Fire-and-forget + idempotent; a write
          // fault is non-fatal (the in-memory registry already updated; the backfill effect retries later).
          // Mark the fire-once guard so the backfill effect does not also write.
          backfilledRef.current = true;
          void window.sow?.lifecycle?.markOnboarded();
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

  // 14.2 connectors — scoped to the SELECTED onboarded workspace (WS-8). Null (global / non-onboarded)
  // → the surface disables the form + shows no instances (connectorsForWorkspace over a null id is []).
  const connectorsWorkspaceId = resolveOnboardedWorkspaceId(state, state.scope);
  const scopedConnectors =
    connectorsWorkspaceId !== null ? connectorsForWorkspace(state, connectorsWorkspaceId) : [];
  // On a successful connectorConfig mutation, upsert the returned UI-safe instance into the optimistic
  // store slice (no cold-load list read yet). Fail-closed to {ok:false} when there is no live worker.
  const upsertOnOk = (p: Promise<ConnectorConfigResult>): Promise<ConnectorConfigResult> =>
    p.then((r) => {
      if (r.ok) store.dispatch((s) => upsertConnectorInstance(s, r.instance));
      return r;
    });
  const onRegisterConnector = (input: RegisterConnectorInput): Promise<ConnectorConfigResult> =>
    upsertOnOk(liveRef.current?.registerConnector(input) ?? Promise.resolve({ ok: false as const }));
  const onSetConnectorState = (instanceId: string, cstate: "enabled" | "paused"): Promise<ConnectorConfigResult> =>
    upsertOnOk(liveRef.current?.setConnectorState(instanceId, cstate) ?? Promise.resolve({ ok: false as const }));
  const onSetConnectorCadence = (instanceId: string, cadence: string): Promise<ConnectorConfigResult> =>
    upsertOnOk(liveRef.current?.setConnectorCadence(instanceId, cadence) ?? Promise.resolve({ ok: false as const }));

  // 14.7 cross-workspace links — a GLOBAL coordination surface (spans workspaces). The from/to
  // pickers offer only onboarded workspaces (WS-8); `from` defaults to the selected onboarded scope.
  const onboardedWorkspaces = [...state.onboarded.values()].map((ow) => ({ id: ow.workspaceId, label: ow.name }));
  const crossLinkDefaultFrom = resolveOnboardedWorkspaceId(state, state.scope);
  const upsertLinkOnOk = (p: Promise<CrossWorkspaceLinkResult>): Promise<CrossWorkspaceLinkResult> =>
    p.then((r) => {
      if (r.ok) store.dispatch((s) => upsertCrossWorkspaceLink(s, r.link));
      return r;
    });
  // 9.10-C egress posture (⚠ safety rule 5) — READ per workspace, and the ONE fail-SAFE revoke command.
  // Both fail closed without a live worker: the read resolves {ok:false} → "posture unavailable" (never
  // "acknowledged"), and the revoke callback is UNDEFINED so the surface offers no dead control. There is
  // deliberately no ack-ON counterpart — that direction is an owner-gated provisioning-time crossing.
  const onLoadEgressStatus = (workspaceId: string): Promise<EgressStatusResult> =>
    liveRef.current?.egressStatus(workspaceId) ?? Promise.resolve({ ok: false as const });
  const onRevokeEgressAck = (workspaceId: string): Promise<EgressStatusResult> =>
    liveRef.current?.revokeEgressAck(workspaceId) ?? Promise.resolve({ ok: false as const });

  const onCreateCrossLink = (input: CreateCrossWorkspaceLinkInput): Promise<CrossWorkspaceLinkResult> =>
    upsertLinkOnOk(liveRef.current?.createCrossWorkspaceLink(input) ?? Promise.resolve({ ok: false as const }));
  const onApproveCrossLink = (linkId: string): Promise<CrossWorkspaceLinkResult> =>
    upsertLinkOnOk(liveRef.current?.approveCrossWorkspaceLink(linkId) ?? Promise.resolve({ ok: false as const }));
  const onRevokeCrossLink = (linkId: string): Promise<CrossWorkspaceLinkResult> =>
    upsertLinkOnOk(liveRef.current?.revokeCrossWorkspaceLink(linkId) ?? Promise.resolve({ ok: false as const }));

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
          // 9.42 — the navigation-target half: a `{ surface: "approvals", approvalId }` route
          // (route.ts) marks that card current + scrolls to it. No producer supplies a real id
          // yet (the producer leg is blocked — see route.ts's header note); this only wires the
          // target side of the type-narrowed route so it is ready once one does.
          focusedApprovalId={state.route.approvalId}
        />
      ) : state.route.surface === "ingestion" ? (
        <IngestionInbox
          items={state.ingestion}
          onDispose={hasLiveWorker ? onDisposeTriage : undefined}
          reroute={rerouteOptions}
        />
      ) : state.route.surface === "projects" ? (
        <Projects
          scope={state.scope}
          projects={state.projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          // 9.12r — the workspace-repo action is enabled only when the active scope resolves to an onboarded
          // workspace (its repo exists); the Coordination-repo action is always available. Main owns the path.
          workspaceRepoAvailable={resolveOnboardedWorkspaceId(state, state.scope) !== null}
          onOpenRepo={requestVaultOpen}
          onRevealRepo={requestVaultReveal}
        />
      ) : state.route.surface === "calendar" ? (
        // §9.9 — the GLOBAL availability surface (empty-until-wired honest empty-state).
        <Calendar entries={state.schedule} />
      ) : state.route.surface === "connectors" ? (
        <Connectors
          // The one-way credential-provisioning bridge (owner-authorized 2026-09-03). Folds any
          // failure to `{ok:false}` — the surface shows a fixed string, never a Keychain diagnostic
          // (rule 7). A missing bridge (never in a real launch; possible in a bare render) reports
          // failure rather than silently pretending the key was stored.
          onProvisionCredential={(ref, value) =>
            window.sow?.secrets?.provision(ref, value).catch(() => ({ ok: false })) ??
            Promise.resolve({ ok: false })
          }
          workspaceId={connectorsWorkspaceId}
          instances={scopedConnectors}
          onRegister={onRegisterConnector}
          onSetState={onSetConnectorState}
          onSetCadence={onSetConnectorCadence}
        />
      ) : state.route.surface === "system-health" ? (
        <SystemHealth items={[...state.health.values()]} />
      ) : state.route.surface === "workspace-settings" ? (
        // 9.10-C — per-workspace egress posture + the audited fail-SAFE revoke (REQ-S-002, rule 5).
        <EgressSettings
          workspaces={onboardedWorkspaces}
          onLoadStatus={onLoadEgressStatus}
          // No live worker ⇒ no revoke affordance at all (never a silently no-op policy control).
          onRevoke={hasLiveWorker ? onRevokeEgressAck : undefined}
        />
      ) : state.route.surface === "cross-workspace-links" ? (
        <CrossWorkspaceLinks
          workspaces={onboardedWorkspaces}
          defaultFrom={crossLinkDefaultFrom}
          links={crossWorkspaceLinksList(state)}
          onCreate={onCreateCrossLink}
          onApprove={onApproveCrossLink}
          onRevoke={onRevokeCrossLink}
        />
      ) : (
        <Today
          scope={state.scope}
          cards={[...state.cards.values()]}
          health={[...state.health.values()]}
          global={state.global}
          recentChanges={state.recentChanges}
          workspaceMeta={workspaceMeta}
          brief={brief}
          tasks={state.taskRollup}
          workflowRuns={[...state.workflows.values()]}
          onDrillDown={onDrillDown}
          onAuditDrill={onAuditDrill}
        />
      )}
    </AppShell>
  );
}
