// Task 9.4b — the deterministic renderer↔worker launch parameters (pure).
//
// The renderer is a DISTINCT trusted origin from the loopback worker (app://sow in
// prod, the Vite dev-server origin in dev). Main owns the launch decision: it pins
// the worker's loopback port, decides the renderer origin, and builds the strict
// Origin/Host allowlist the worker admits.
//
// SECURITY — the anti-DNS-rebind guarantee now rests ENTIRELY on this allowlist's
// tightness: the worker's Origin==Host equality backstop was removed in 9.4b (it
// assumed a same-origin web app, false for a native client). So this builder is the
// load-bearing control and enforces the discipline the security-reviewer flagged (Q4):
//   • the exact worker port is pinned in EVERY host entry (never a bare host);
//   • the origin is ONE scheme-exact entry;
//   • dev and prod allowlists are NEVER merged into one launched allowlist.

/** The FIXED loopback port the worker binds — deterministic so the allowlist (a
 *  bootWorker INPUT) and the client URLs are known BEFORE the child reports ready.
 *  A high, non-privileged port; the single-instance lock prevents a self-collision. */
export const WORKER_LOOPBACK_PORT = 47100;

/** The loopback host the worker binds — 127.0.0.1 only (never 0.0.0.0/LAN); REQ-NF-004. */
export const WORKER_LOOPBACK_HOST = "127.0.0.1";

/** Which surface the renderer is served from this launch. */
export type LaunchMode = "dev" | "prod";

/** The worker's strict Origin/Host allowlist (mirrors @sow/worker WorkerOriginAllowlist). */
export interface WorkerAllowlist {
  readonly origins: readonly string[];
  readonly hosts: readonly string[];
}

/** The loopback URLs the renderer uses to reach the worker (both transports, one port). */
export interface WorkerConnection {
  readonly httpUrl: string;
  readonly wsUrl: string;
}

/** The packaged renderer's origin (a custom privileged scheme — NOT file://). */
const PROD_ORIGIN = "app://sow";

function assertLoopbackPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`worker-launch: invalid loopback port ${port}`);
  }
}

/**
 * The renderer's page Origin for this launch mode. In prod it is the packaged
 * `app://sow` scheme; in dev it is the Vite dev-server ORIGIN (scheme+host+port,
 * path stripped) derived from the dev URL. Dev with no URL fails closed — main
 * cannot name an origin it does not know, and a lax fallback would widen the gate.
 */
export function rendererOrigin(mode: LaunchMode, devUrl?: string): string {
  if (mode === "prod") return PROD_ORIGIN;
  if (typeof devUrl !== "string" || devUrl.length === 0) {
    throw new Error("worker-launch: dev launch requires the Vite dev-server URL");
  }
  return new URL(devUrl).origin;
}

/**
 * Build the worker's strict Origin/Host allowlist for this launch. Exactly one
 * scheme-exact origin (from {@link rendererOrigin}) and exactly one host — the
 * pinned loopback host:port. Never merges modes; the port is always pinned.
 */
export function buildWorkerAllowlist(
  mode: LaunchMode,
  port: number,
  devUrl?: string,
): WorkerAllowlist {
  assertLoopbackPort(port);
  return {
    origins: [rendererOrigin(mode, devUrl)],
    hosts: [`${WORKER_LOOPBACK_HOST}:${port}`],
  };
}

/** The loopback HTTP + WS URLs the renderer's tRPC client targets. */
export function workerConnection(port: number): WorkerConnection {
  assertLoopbackPort(port);
  return {
    httpUrl: `http://${WORKER_LOOPBACK_HOST}:${port}`,
    wsUrl: `ws://${WORKER_LOOPBACK_HOST}:${port}`,
  };
}
