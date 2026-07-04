import type { CreateTRPCClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import type { SowBridge } from "../../preload/bridge";
import type { Store, UiSafeStoreState } from "../store";
import { hydrateCards, hydrateHealth, hydrateGlobal } from "../store/projections";
import { createEventStream } from "./event-stream";
import { createLiveClient } from "./live-client";
import { createWsStreamTransport } from "./ws-transport";
import { createDrillDown, type DrillResult } from "./drilldown";

/** The live-session handle: stop the stream + the policy-gated drill-down caller (§9.4). */
export interface StartLiveHandle {
  readonly stop: () => void;
  readonly drillDown: (workspaceId: string, projectionType: string) => Promise<DrillResult>;
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
  const stream = createEventStream({
    store,
    transport: createWsStreamTransport(live.client),
    scheduleReconnect: (ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
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
  };
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
