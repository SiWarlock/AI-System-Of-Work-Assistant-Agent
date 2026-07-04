import type { CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import type { SowBridge } from "../../preload/bridge";
import type { Store, UiSafeStoreState } from "../store";
import {
  hydrateCards,
  hydrateHealth,
  hydrateGlobal,
  replaceCards,
  replaceRecentChanges,
  replaceProjects,
} from "../store/projections";
import { scopeMeta, type WorkspaceScope } from "../store/scope";
import { createEventStream } from "./event-stream";
import { createScopeRefresher } from "./scope-refresh";
import { createLiveClient } from "./live-client";
import { createWsStreamTransport } from "./ws-transport";
import { createDrillDown, type DrillResult } from "./drilldown";

/** The live-session handle: stop the stream + drill-down (§9.4) + scope-aware re-hydrate (§9.5). */
export interface StartLiveHandle {
  readonly stop: () => void;
  readonly drillDown: (workspaceId: string, projectionType: string) => Promise<DrillResult>;
  /** Re-hydrate for a scope (called on a scope change) — clears then re-queries, no blend. */
  readonly hydrateScope: (scope: WorkspaceScope) => Promise<void>;
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
  client: CreateTRPCClient<AnyTRPCRouter>,
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
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    if (meta.workspaceId === null) {
      // Global: dashboard + the gated GCL surface. Recent activity AND projects are
      // workspace-scoped (never a cross-workspace blend; WS-8) — they stay cleared under Global.
      const [cardsR, globalR] = await Promise.all([c.query.dashboard.query(), c.query.global.query()]);
      if (store.getSnapshot().scope !== scope) return; // superseded by a newer scope
      if (cardsR?.ok === true) store.dispatch((s) => replaceCards(s, cardsR.value));
      if (globalR?.ok === true) store.dispatch((s) => hydrateGlobal(s, globalR.value));
    } else {
      // allSettled, not all: ONE scoped query's failure (a not-yet-served route, a hiccup)
      // must NOT drop the other two surfaces — each applies independently iff it resolved ok.
      const [cardsR, recentR, projectsR] = await Promise.allSettled([
        c.query.workspace.query({ workspaceId: meta.workspaceId }),
        c.query.recentChanges.query({ workspaceId: meta.workspaceId }),
        c.query.projectList.query({ workspaceId: meta.workspaceId }),
      ]);
      if (store.getSnapshot().scope !== scope) return; // superseded by a newer scope
      if (cardsR.status === "fulfilled" && cardsR.value?.ok === true) {
        store.dispatch((s) => replaceCards(s, cardsR.value.value));
      }
      if (recentR.status === "fulfilled" && recentR.value?.ok === true) {
        store.dispatch((s) => replaceRecentChanges(s, recentR.value.value));
      }
      if (projectsR.status === "fulfilled" && projectsR.value?.ok === true) {
        store.dispatch((s) => replaceProjects(s, projectsR.value.value));
      }
    }
  } catch {
    // Best-effort — the cleared state stands; the live stream remains the source of truth.
  }
}

async function hydrate(
  client: CreateTRPCClient<AnyTRPCRouter>,
  store: Store<UiSafeStoreState>,
): Promise<void> {
  try {
    // Generic-router client (full AppRouter typing deferred) → dynamic access.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    const [cardsR, healthR, globalR] = await Promise.all([
      c.query.dashboard.query(),
      c.systemHealth.items.query(),
      c.query.global.query(),
    ]);
    if (cardsR?.ok === true) store.dispatch((s) => hydrateCards(s, cardsR.value));
    if (healthR?.ok === true) store.dispatch((s) => hydrateHealth(s, healthR.value));
    if (globalR?.ok === true) store.dispatch((s) => hydrateGlobal(s, globalR.value));
  } catch {
    // Best-effort snapshot — the live stream is the source of truth.
  }
}
