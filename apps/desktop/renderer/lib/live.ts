import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import {
  UiSafeApprovalSchema,
  type UiSafeApproval,
  UiSafeIngestionItemSchema,
  type UiSafeIngestionItem,
} from "@sow/contracts/api/ui-safe";
import type { SowBridge } from "../../preload/bridge";
import type { Store, UiSafeStoreState } from "../store";
import {
  hydrateCards,
  hydrateHealth,
  hydrateGlobal,
  hydrateApprovals,
  replaceCards,
  replaceRecentChanges,
  replaceProjects,
  replaceIngestion,
} from "../store/projections";
import { scopeMeta, resolveWorkspaceId, WORKSPACE_SCOPES, type WorkspaceScope } from "../store/scope";
import { createEventStream } from "./event-stream";
import { createScopeRefresher } from "./scope-refresh";
import { createLiveClient } from "./live-client";
import { createWsStreamTransport } from "./ws-transport";
import { createDrillDown, type DrillResult } from "./drilldown";
import { createAskCopilot, type AskResult } from "./copilot-ask";
import { createApprovalDecision, type ApprovalDecision, type DecisionResult } from "./approval-decision";
import { createTriageDisposition, type TriageDisposition, type DispositionResult } from "./triage-disposition";

/** The live-session handle: stop the stream + drill-down (§9.4) + scope-aware re-hydrate (§9.5). */
export interface StartLiveHandle {
  readonly stop: () => void;
  readonly drillDown: (workspaceId: string, projectionType: string) => Promise<DrillResult>;
  /** Re-hydrate for a scope (called on a scope change) — clears then re-queries, no blend. */
  readonly hydrateScope: (scope: WorkspaceScope) => Promise<void>;
  /** Ask Copilot a question (§9.6, wired to query.copilotAsk); fails closed to {ok:false}. */
  readonly askCopilot: (workspaceId: string, question: string) => Promise<AskResult>;
  /** Decide an approval (§9.8, wired to command.decideApproval, mac channel); fails closed to {ok:false}. */
  readonly decideApproval: (approvalId: string, decision: ApprovalDecision) => Promise<DecisionResult>;
  /** Dispose a triage item (§9.7, wired to command.disposeTriage, deterministic key); fails closed to {ok:false}. */
  readonly disposeTriage: (sourceId: string, disposition: TriageDisposition) => Promise<DispositionResult>;
}

// Connect the UI-safe store to the LIVE worker over the §10 push stream (9.4b E).
// Reads the loopback endpoint + session token from the preload bridge, builds the
// tRPC client (ws + http), wires the event-stream controller, and starts it. The
// controller owns reconnect/backoff + the distinct worker-down state, so a
// not-yet-ready worker just shows "reconnecting" until it comes up.
//
// A first render over a Temporal-degraded worker has an EMPTY read-model, so the
// stream alone yields the live connection + empty states; initial read-model queries
// (to hydrate persisted data) are a follow-up.

/** Start the live stream. Returns a handle, or null when there is no worker bridge. */
export async function startLive(store: Store<UiSafeStoreState>): Promise<StartLiveHandle | null> {
  const bridge = (window as unknown as { sow?: SowBridge }).sow;
  if (bridge?.worker?.getConnection === undefined) return null;

  const endpoint = await bridge.worker.getConnection();
  if (endpoint === null) return null;

  const token = await bridge.session.getToken();
  const live = createLiveClient({ httpUrl: endpoint.httpUrl, wsUrl: endpoint.wsUrl, token });
  const refresher = createScopeRefresher(live.client, store);
  const stream = createEventStream({
    store,
    transport: createWsStreamTransport(live.client),
    scheduleReconnect: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    // Push-path liveness (§9.5): a read_model.change is suppressed in a workspace scope
    // (isolation), so re-hydrate that scope's cards through the scope-correct pull path.
    // Reads the CURRENT scope at fire time; a no-op in Global (it stays live via the fold).
    onReadModelChange: () => void refresher.refresh(store.getSnapshot().scope),
  });
  stream.start();

  // Initial read-model hydrate — persisted data shows on load; the live stream then
  // keeps it current. Best-effort: a query failure just leaves the store to the
  // stream. dashboard → UiSafeDashboardCard, systemHealth.items → UiSafeHealthItem,
  // global → UiSafeGclProjection (all server-projected), so each folds in directly.
  void hydrate(live.client, store);

  return {
    stop: (): void => {
      stream.stop();
      live.close();
    },
    drillDown: createDrillDown(live.client),
    hydrateScope: (scope: WorkspaceScope): Promise<void> => hydrateScope(live.client, store, scope),
    askCopilot: createAskCopilot(live.client),
    decideApproval: createApprovalDecision(live.client),
    disposeTriage: createTriageDisposition(live.client),
  };
}

/**
 * Re-hydrate the store for a scope change (§9.5). CLEARS the prior scope's cards + the
 * Global GCL FIRST — so switching scope never blends the previous scope's data under
 * the new one, even if the re-query errors (an unknown/placeholder workspace) — then
 * re-queries the scope-appropriate read-model: Global → the cross-workspace aggregate
 * (dashboard) + the GCL surface; a workspace scope → that ONE workspace's cards.
 *
 * A stale-scope guard drops a superseded result (a fast A→B→A switch): the store's
 * current `scope` must still equal the requested one before any dispatch.
 *
 * The STREAM push path is scope-ISOLATED too (§9.5): `applyStreamEvent` folds a
 * read_model.change into `cards` ONLY in Global scope (where `cards` is the
 * cross-workspace dashboard aggregate the push emits); in a workspace scope it advances
 * the resume cursor but never blends the card (UiSafeDashboardCard carries no
 * workspaceId), so no foreign workspace's card can surface under the tab. Workspace-scope
 * LIVENESS is then restored by `createScopeRefresher` (in `./scope-refresh`, wired above
 * in `startLive`), which re-hydrates the scoped pull path on each such push.
 *
 * KNOWN follow-up: this scope-change re-hydrate and the push-refresh apply `replaceCards`
 * through INDEPENDENT latest-wins tokens, so on a rare same-scope race (a switch into B
 * whose slow initial query resolves AFTER a fast push-refresh for B) the older result can
 * transiently overwrite the newer — scope-correct (B-under-B), non-isolation, self-healing
 * on the next push. A shared generation token (or an AbortController) would close it.
 */
async function hydrateScope(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
  scope: WorkspaceScope,
): Promise<void> {
  const meta = scopeMeta(scope);
  // Clear immediately — no stale cross-scope cards/GCL/recent-activity/projects linger while
  // the query runs.
  store.dispatch((s) => replaceCards(s, []));
  store.dispatch((s) => hydrateGlobal(s, []));
  store.dispatch((s) => replaceRecentChanges(s, []));
  store.dispatch((s) => replaceProjects(s, []));
  store.dispatch((s) => replaceIngestion(s, []));
  try {
    if (meta.workspaceId === null) {
      // Global: dashboard + the gated GCL surface. Recent activity AND projects are
      // workspace-scoped (never a cross-workspace blend; WS-8) — they stay cleared under Global.
      const [cardsR, globalR] = await Promise.all([client.query.dashboard.query(), client.query.global.query()]);
      if (store.getSnapshot().scope !== scope) return; // superseded by a newer scope
      if (cardsR?.ok === true) store.dispatch((s) => replaceCards(s, cardsR.value));
      if (globalR?.ok === true) store.dispatch((s) => hydrateGlobal(s, globalR.value));
    } else {
      // allSettled, not all: ONE scoped query's failure (a not-yet-served route, a hiccup)
      // must NOT drop the other two surfaces — each applies independently iff it resolved ok.
      const [cardsR, recentR, projectsR] = await Promise.allSettled([
        client.query.workspace.query({ workspaceId: meta.workspaceId }),
        client.query.recentChanges.query({ workspaceId: meta.workspaceId }),
        client.query.projectList.query({ workspaceId: meta.workspaceId }),
      ]);
      if (store.getSnapshot().scope !== scope) return; // superseded by a newer scope
      // Bind each ok payload to a local const BEFORE the dispatch closure — TS preserves a
      // local-const's narrowing into a closure, but not a nested property access's (`settled.value`).
      if (cardsR.status === "fulfilled" && cardsR.value.ok === true) {
        const cards = cardsR.value.value;
        store.dispatch((s) => replaceCards(s, cards));
      }
      if (recentR.status === "fulfilled" && recentR.value.ok === true) {
        const changes = recentR.value.value;
        store.dispatch((s) => replaceRecentChanges(s, changes));
      }
      if (projectsR.status === "fulfilled" && projectsR.value.ok === true) {
        const projects = projectsR.value.value;
        store.dispatch((s) => replaceProjects(s, projects));
      }
    }
  } catch {
    // Best-effort — the cleared state stands; the live stream remains the source of truth.
  }
  // Re-load the ingestion inbox for the new scope (its own workspace-scope guard + validation;
  // empty under Global). Serial after the cards/recent/projects fan-out — ingestion is
  // empty-until-producer, so the extra round-trip is negligible and keeps the load-path un-duplicated.
  await hydrateIngestionInbox(client, store, scope);
}

async function hydrate(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
): Promise<void> {
  try {
    const [cardsR, healthR, globalR] = await Promise.all([
      client.query.dashboard.query(),
      client.systemHealth.items.query(),
      client.query.global.query(),
    ]);
    if (cardsR?.ok === true) store.dispatch((s) => hydrateCards(s, cardsR.value));
    if (healthR?.ok === true) store.dispatch((s) => hydrateHealth(s, healthR.value));
    if (globalR?.ok === true) store.dispatch((s) => hydrateGlobal(s, globalR.value));
  } catch {
    // Best-effort snapshot — the live stream is the source of truth.
  }
  await hydrateApprovalInbox(client, store);
  // Cold-load the active workspace scope's ingestion inbox (§9.7) — empty under Global.
  await hydrateIngestionInbox(client, store, store.getSnapshot().scope);
}

/**
 * Cold-load the active WORKSPACE scope's ingestion inbox (§9.7) via `query.ingestionInbox`. Ingestion
 * is workspace-scoped (WS-8) — Global (or any UNRECOGNIZED scope, via the fail-closed `resolveWorkspaceId`)
 * aggregates NOTHING, so it clears to `[]` WITHOUT a query. Re-validates each record through
 * `UiSafeIngestionItemSchema` (.strict) before it enters the store — the same defense-in-depth the
 * approvals/stream paths apply; a leaky/malformed record (a server-projector regression) is DROPPED,
 * never folded. A superseded scope (a fast switch during the await) is dropped. Best-effort +
 * never-crashing: a query `err`/throw resolves to the empty state, never a white-screen.
 * Empty-until-producer — returns `[]` today until the producer's Temporal wiring populates the row.
 */
export async function hydrateIngestionInbox(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
  scope: WorkspaceScope,
): Promise<void> {
  const workspaceId = resolveWorkspaceId(scope);
  if (workspaceId === null) {
    store.dispatch((s) => replaceIngestion(s, []));
    return;
  }
  try {
    const res = await client.query.ingestionInbox.query({ workspaceId });
    if (store.getSnapshot().scope !== scope) return; // superseded by a newer scope
    if (res?.ok === true && Array.isArray(res.value)) {
      const valid: UiSafeIngestionItem[] = [];
      for (const it of res.value) {
        const parsed = UiSafeIngestionItemSchema.safeParse(it);
        if (parsed.success) valid.push(parsed.data);
      }
      store.dispatch((s) => replaceIngestion(s, valid));
    } else {
      store.dispatch((s) => replaceIngestion(s, [])); // an err result → empty (don't leave stale)
    }
  } catch {
    store.dispatch((s) => replaceIngestion(s, [])); // best-effort — non-crashing
  }
}

/**
 * Seed the GLOBAL approval inbox (§9.8) on cold load. `query.approvalInbox` is
 * per-workspace (WS-8 — each query is workspace-scoped server-side), so the global
 * inbox is assembled by fanning out over the KNOWN workspace scopes and merging the
 * (already UI-safe) results by id via `hydrateApprovals`. `allSettled` so one
 * workspace's failure never drops the others; best-effort — the live `approval.update`
 * stream + each decision's authoritative record keep the inbox current afterward.
 *
 * This only reshapes what the server already returns as UI-safe — no raw content
 * crosses (`UiSafeApproval` carries ids + status + channel + timing only), which is
 * why a single cross-scope inbox is WS-8-safe.
 */
async function hydrateApprovalInbox(
  client: CreateTRPCClient<AppRouter>,
  store: Store<UiSafeStoreState>,
): Promise<void> {
  const workspaceIds = WORKSPACE_SCOPES.map((m) => m.workspaceId).filter(
    (id): id is string => id !== null,
  );
  try {
    const results = await Promise.allSettled(
      workspaceIds.map((workspaceId) => client.query.approvalInbox.query({ workspaceId })),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.ok === true && Array.isArray(r.value.value)) {
        // Re-validate each record against the UI-safe schema (.strict) before it enters
        // the store — the same defense-in-depth the stream path applies; a leaky/malformed
        // record (a server-projector regression) is DROPPED, never folded into the inbox.
        const valid: UiSafeApproval[] = [];
        for (const a of r.value.value) {
          const parsed = UiSafeApprovalSchema.safeParse(a);
          if (parsed.success) valid.push(parsed.data);
        }
        if (valid.length > 0) store.dispatch((s) => hydrateApprovals(s, valid));
      }
    }
  } catch {
    // Best-effort — the live stream remains the source of truth.
  }
}
