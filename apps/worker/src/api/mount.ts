// MOUNT wave — the REAL loopback transport (Phase-0 API spike 0.5) for the worker
// control-plane API. `startApiServer(deps)` stands up:
//
//   • an HTTP server (@trpc/server/adapters/standalone `createHTTPServer`) for the
//     query + command procedures (httpBatchLink-compatible). Its `createContext`
//     extracts the presented BEARER token from the `authorization` header + the
//     Origin/Host headers, and runs the SAME composed 8.1 `makeAuthInterceptor`
//     BEFORE any resolver — a wrong/absent token (UNAUTHORIZED) or a wrong
//     Origin/Host (DNS-rebind → FORBIDDEN) is rejected PRE-HANDLER by storing the
//     typed `err` on `ApiContext.auth` (the resolver body then never runs the work;
//     it returns the typed err as DATA, §16 — the transport never throws it).
//
//   • a WebSocket server (`ws` WebSocketServer + @trpc/server/adapters/ws
//     `applyWSSHandler`) for the push-stream `onEvent` subscription. The token rides
//     the FIRST-message `connectionParams` (NEVER a URL — safety rule 7: secrets
//     never in a loggable request line), read off `info.connectionParams.token`;
//     the Origin/Host come from the WS UPGRADE request headers. The SAME interceptor
//     gates the handshake, so no event flows to an unauthenticated / off-origin peer.
//     `keepAlive` heartbeats { pingMs: 1000, pongWaitMs: 2000 } keep the socket live.
//
// LOOPBACK-ONLY BIND (REQ-NF-004, safety §5). `assertLoopbackBind` is checked on the
// bind host at STARTUP and a non-loopback host is REFUSED (fail-closed) — the bind is
// the FIRST line of defense (the token + Origin gate is the second); we bind
// 127.0.0.1 only, never 0.0.0.0 / a LAN / a public address. Loopback binding is NOT
// authentication (a local page can reach it), which is exactly why the interceptor
// still runs on every request + handshake.
//
// The HTTP + WS servers SHARE one `createApiServer` composition (one `appRouter`,
// one interceptor, one push-stream publisher) so the loopback caller, the HTTP
// transport, and the WS transport are the SAME surface. The worker feeds
// `handle.publisher` from its workflow/approval/health/read-model sources.
//
// §16: `startApiServer` returns a typed handle (or rejects only on a genuine
// startup fault — a non-loopback bind refusal, or a socket that cannot listen). No
// per-request throw crosses the boundary — the interceptor + `authedResolver` keep
// every request/handshake a typed Result.
import { createHTTPHandler, type CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import { applyWSSHandler, type CreateWSSContextFnOptions } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { resolveCors } from "./auth/cors";

import { isErr } from "@sow/contracts";
import { createApiServer, type ApiServerDeps, type AppRouter } from "./server";
import { assertLoopbackBind } from "./auth/loopbackBind";
import type { ApiContext } from "./trpc";
import type { AuthInterceptor, AuthInterceptorInput } from "./auth/interceptor";
import type { StreamPublisher } from "./stream/eventClasses";

/** The loopback host the transport binds to (127.0.0.1 only — REQ-NF-004). */
export const LOOPBACK_HOST = "127.0.0.1" as const;

/** WS keep-alive heartbeat cadence (spike 0.5): ping every 1s, terminate after 2s of no pong. */
export const WS_KEEPALIVE = { pingMs: 1000, pongWaitMs: 2000 } as const;

/**
 * Options for {@link startApiServer}. Extends the composition {@link ApiServerDeps}
 * (the ports + the per-launch token + the Origin/Host allowlist) with the bind
 * target. `host` defaults to loopback; a NON-loopback host is refused at startup.
 * `port` 0 (the default) binds an EPHEMERAL loopback port (the test path); a real
 * deployment pins a fixed port.
 */
export interface StartApiServerOptions extends ApiServerDeps {
  /** Bind host — defaults to 127.0.0.1. A non-loopback host is REFUSED (REQ-NF-004). */
  readonly host?: string;
  /** Bind port — 0 (default) = an ephemeral loopback port; a deployment pins one. */
  readonly port?: number;
}

/** A running loopback API server handle: the bound coordinates + a graceful close. */
export interface RunningApiServer {
  /** The bound loopback host (always a loopback address — asserted at startup). */
  readonly host: string;
  /** The actual bound port (resolved even when `port: 0` requested an ephemeral one). */
  readonly port: number;
  /** The push-stream publisher the worker feeds workflow/approval/health/read-model changes into. */
  readonly publisher: StreamPublisher;
  /** The composed 8.1 interceptor (exposed for symmetry / diagnostics; the same one both transports run). */
  readonly interceptor: AuthInterceptor;
  /** The renderer's typed client target (Phase 9). */
  readonly appRouter: AppRouter;
  /** Gracefully close the HTTP + WS servers (idempotent). */
  close(): Promise<void>;
}

/** A non-loopback bind refusal (REQ-NF-004) — a typed startup fault, never a silent bind. */
export class LoopbackBindRefusedError extends Error {
  constructor(host: string) {
    super(`worker API refused a non-loopback bind address: ${host} (REQ-NF-004)`);
    this.name = "LoopbackBindRefusedError";
  }
}

/**
 * Read the presented BEARER token off an HTTP `authorization` header. Accepts
 * `Authorization: Bearer <token>` (case-insensitive scheme); anything else (absent,
 * a non-Bearer scheme, a bare value) is treated as ABSENT so the token gate
 * fail-closes. The token NEVER comes from the URL (safety rule 7).
 */
function bearerFromHeader(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return undefined;
  const match = /^bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1];
}

/** Read a single header value (first of a repeated header), else undefined. */
function headerValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Build the HTTP `createContext`: extract the bearer token + Origin/Host from the
 * request headers and run the SAME composed interceptor BEFORE any resolver. The
 * result is stored on `ApiContext.auth` as a typed Result — a rejection is DATA the
 * resolver returns, never a throw. Typed against the standalone adapter's own
 * `CreateHTTPContextOptions` so the shape matches `createHTTPServer` exactly.
 */
function makeHttpContext(
  interceptor: AuthInterceptor,
): (opts: CreateHTTPContextOptions) => ApiContext {
  return ({ req }): ApiContext => {
    const input: AuthInterceptorInput = {
      token: bearerFromHeader(req.headers.authorization),
      origin: headerValue(req.headers.origin),
      host: headerValue(req.headers.host),
    };
    return { auth: interceptor(input) };
  };
}

/**
 * Build the WS `createContext`: the token rides the FIRST-message
 * `info.connectionParams` (NEVER a URL); the Origin/Host come from the UPGRADE
 * request headers. Runs the SAME interceptor so the handshake is gated pre-stream.
 * Typed against the ws adapter's own `CreateWSSContextFnOptions` (`{ req, res, info }`
 * where `info.connectionParams: Dict<string> | null`).
 */
function makeWsContext(
  interceptor: AuthInterceptor,
): (opts: CreateWSSContextFnOptions) => ApiContext {
  return ({ req, info }): ApiContext => {
    const params = info.connectionParams;
    const token =
      params !== null && typeof params.token === "string" ? params.token : undefined;
    const input: AuthInterceptorInput = {
      token,
      origin: headerValue(req.headers.origin),
      host: headerValue(req.headers.host),
    };
    return { auth: interceptor(input) };
  };
}

/**
 * Stand up the real loopback HTTP + WS transport over one `createApiServer`
 * composition. Refuses a non-loopback bind at startup (REQ-NF-004), binds
 * 127.0.0.1 only, and mounts the WS push-stream handler with the spike-0.5
 * keep-alive. Returns a handle with the bound port + `close()`; the worker feeds
 * `handle.publisher` from its change sources.
 */
export function startApiServer(opts: StartApiServerOptions): Promise<RunningApiServer> {
  const host = opts.host ?? LOOPBACK_HOST;

  // REQ-NF-004 — REFUSE a non-loopback bind at startup (fail-closed, BEFORE any
  // socket is opened). The bind is the first line of defense; the token/Origin gate
  // is the second. A non-loopback host rejects the whole start (never a partial bind).
  const loopback = assertLoopbackBind(host);
  if (isErr(loopback)) {
    return Promise.reject(new LoopbackBindRefusedError(host));
  }
  const boundHost = loopback.value.addr;

  const api = createApiServer(opts);
  const httpContext = makeHttpContext(api.interceptor);
  const wsContext = makeWsContext(api.interceptor);

  // The HTTP server for queries/commands (httpBatchLink-compatible). We wrap the
  // tRPC standalone request handler in our OWN http.Server so we can answer the
  // browser's cross-origin CORS PREFLIGHT (OPTIONS) and reflect an EXACT allowlisted
  // Origin on every response (9.4b): the renderer is a distinct origin, so without
  // this the browser blocks its reads. CORS is only the browser-facing read control
  // — `createContext` still runs the token/Origin/Host interceptor on every actual
  // request before any resolver, and only `opts.allowlist.origins` are ever
  // reflected (never `*`, never credentials — see auth/cors.ts).
  const trpcHandler = createHTTPHandler({
    router: api.appRouter,
    createContext: httpContext,
  });
  const httpServer = createServer((req, res) => {
    const cors = resolveCors(req.method, headerValue(req.headers.origin), opts.allowlist.origins);
    for (const [key, value] of Object.entries(cors.headers)) res.setHeader(key, value);
    if (cors.shortCircuitStatus !== undefined) {
      res.statusCode = cors.shortCircuitStatus;
      res.end();
      return;
    }
    trpcHandler(req, res);
  });

  // The WS server for the push-stream subscription. `noServer: false` + an explicit
  // host/port would double-bind; instead we attach the WS server to the SAME HTTP
  // server so ONE loopback port carries both transports (the renderer connects
  // http:// for queries/commands and ws:// for the stream on the same origin).
  const wss = new WebSocketServer({ server: httpServer });
  const wsHandler = applyWSSHandler({
    wss,
    router: api.appRouter,
    createContext: wsContext,
    keepAlive: {
      enabled: true,
      pingMs: WS_KEEPALIVE.pingMs,
      pongWaitMs: WS_KEEPALIVE.pongWaitMs,
    },
  });

  return new Promise<RunningApiServer>((resolve, reject) => {
    const onListenError = (cause: unknown): void => {
      // A genuine listen fault (port in use, permission) — reject the start cleanly,
      // tearing down anything half-opened. No per-request throw path is involved.
      wss.close();
      httpServer.close();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    httpServer.once("error", onListenError);

    httpServer.listen(opts.port ?? 0, boundHost, () => {
      httpServer.removeListener("error", onListenError);
      const address = httpServer.address() as AddressInfo | null;
      const boundPort = address !== null && typeof address === "object" ? address.port : 0;

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        // Tear down the WS handler + server first (stop the poll/heartbeat loop),
        // then the HTTP server. Both closes are awaited so the port is released.
        wsHandler.broadcastReconnectNotification();
        await new Promise<void>((res) => wss.close(() => res()));
        await new Promise<void>((res) => httpServer.close(() => res()));
      };

      resolve({
        host: boundHost,
        port: boundPort,
        publisher: api.pushStream.publisher,
        interceptor: api.interceptor,
        appRouter: api.appRouter,
        close,
      });
    });
  });
}
