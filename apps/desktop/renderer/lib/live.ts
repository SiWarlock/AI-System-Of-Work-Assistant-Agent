import type { SowBridge } from "../../preload/bridge";
import type { Store, UiSafeStoreState } from "../store";
import { createEventStream } from "./event-stream";
import { createLiveClient } from "./live-client";
import { createWsStreamTransport } from "./ws-transport";

// Connect the UI-safe store to the LIVE worker over the §10 push stream (9.4b E).
// Reads the loopback endpoint + session token from the preload bridge, builds the
// tRPC client (ws + http), wires the event-stream controller, and starts it. The
// controller owns reconnect/backoff + the distinct worker-down state, so a
// not-yet-ready worker just shows "reconnecting" until it comes up.
//
// A first render over a Temporal-degraded worker has an EMPTY read-model, so the
// stream alone yields the live connection + empty states; initial read-model queries
// (to hydrate persisted data) are a follow-up.

/** Start the live stream. Returns a stop fn, or null when there is no worker bridge. */
export async function startLive(store: Store<UiSafeStoreState>): Promise<(() => void) | null> {
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

  return () => {
    stream.stop();
    live.close();
  };
}
