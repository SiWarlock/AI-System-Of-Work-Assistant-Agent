// A tiny main-side holder for the worker's loopback endpoint, so the IPC handler
// (ipc.ts) and the worker starter (index.ts) share it WITHOUT an import cycle.
//
// Deliberately carries NO token: the endpoint is the non-secret { httpUrl, wsUrl }
// pair. The renderer gets the session token from the separate audited
// `session:getToken` channel (§5) — keeping exactly one token-bearing channel.
import type { WorkerConnection } from "./worker-launch";

let current: WorkerConnection | null = null;

export function setWorkerEndpoint(endpoint: WorkerConnection | null): void {
  current = endpoint;
}

export function getWorkerEndpoint(): WorkerConnection | null {
  return current;
}
