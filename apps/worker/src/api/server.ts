// Task 8.2 (c) — `createApiServer(deps)`: assemble the root appRouter over a
// loopback caller, BEHIND the 8.1 auth interceptor.
//
// `createApiServer` is the composition seam the integrator (worker bootstrap)
// mounts. It:
//   1. builds the single composed 8.1 auth interceptor from `deps`
//      (expectedToken + Origin/Host allowlist) — the worker VERIFIES, never mints;
//   2. composes the root `appRouter` from the procedure-module routers (for now
//      the always-present `health` seam; 8.3's query router + 8.4's command router
//      mount here — the SEAM is `mountRouters` below);
//   3. exposes `createCaller(req)` — a loopback caller that runs the interceptor
//      in the CONTEXT FACTORY (before any resolver) and stores its typed outcome
//      on `ApiContext.auth`. No secret rides the context; an auth failure is a
//      typed `err(FailureVariant)` surfaced as resolver DATA, never a throw.
//
// `AppRouter = typeof appRouter` is exported for the renderer's typed client
// (Phase 9). This module owns the httpBatchLink-compatible loopback handler seam;
// the actual socket bind (loopback-only, REQ-NF-004) is asserted by the transport
// at startup via `assertLoopbackBind` — NOT here (that is a per-bind, not per-call,
// invariant), so it is imported/re-exported for the integrator, not folded in.
import { createCallerFactory, router, type ApiContext } from "./trpc";
import { healthRouter } from "./router";
import {
  makeAuthInterceptor,
  type AuthInterceptor,
  type AuthInterceptorInput,
} from "./auth/interceptor";
import type { SessionToken } from "@sow/policy";
import type { WorkerOriginAllowlist } from "./auth/originAllowlist";

/**
 * Dependencies for {@link createApiServer}. `expectedToken` is the current-launch
 * token (minted by Electron main, INJECTED here — never minted in the worker);
 * `allowlist` is the strict Origin/Host anti-rebind allowlist. NO secret is
 * stored on the returned server beyond the interceptor's closure.
 */
export interface ApiServerDeps {
  readonly expectedToken: SessionToken;
  readonly allowlist: WorkerOriginAllowlist;
}

// ── The root router composition ──────────────────────────────────────────────
// The record below is the seam 8.3 (query router) + 8.4 (command router) extend:
// they add their sub-routers here. Kept as a single place so the integrator's
// wiring stays a one-line change and `AppRouter` tracks the set. The type is left
// to inference (an explicit annotation would lose each sub-router's procedure map).
const appRouter = router({
  health: healthRouter,
  // query: buildQueryRouter(...),     // ← 8.3 mounts here
  // command: buildCommandRouter(...), // ← 8.4 mounts here
});

/** The renderer's typed client target (Phase 9). */
export type AppRouter = typeof appRouter;

// The loopback caller factory for the composed router. Built ONCE at module scope
// (the router shape is static); each request gets a fresh caller bound to its
// per-request context. `ApiCaller` is derived from this VALUE so the caller keeps
// the full decorated procedure map (`.health.ping`, …) — re-applying the factory
// generic to `AppRouter` (a BuiltRouter) instead widens it to a bare RouterRecord.
const appCallerFactory = createCallerFactory(appRouter);

/** The loopback caller shape for {@link AppRouter} (derived from the factory value). */
export type ApiCaller = ReturnType<typeof appCallerFactory>;

/**
 * The assembled server. `appRouter` is the composed root router; `createCaller`
 * is a loopback caller that runs the auth interceptor in the context factory
 * (BEFORE any resolver) from the raw request inputs, then invokes the router.
 */
export interface ApiServer {
  readonly appRouter: AppRouter;
  /**
   * Build a loopback caller for ONE request. `req` is the raw transport tuple the
   * 8.1 interceptor consumes (presented token + Origin + Host). The interceptor
   * runs HERE, before any resolver; its typed outcome is stored on the context.
   */
  readonly createCaller: (req: AuthInterceptorInput) => ApiCaller;
}

/**
 * Build the worker API server. Assembles the root `appRouter` and returns a
 * `createCaller` that admits a request only after the 8.1 interceptor passes —
 * on failure the resolver sees a typed `err(FailureVariant)` on `ctx.auth` and
 * returns it as data (never throws, §16). The renderer imports {@link AppRouter}
 * for its typed client.
 */
export function createApiServer(deps: ApiServerDeps): ApiServer {
  const interceptor: AuthInterceptor = makeAuthInterceptor({
    expectedToken: deps.expectedToken,
    allowlist: deps.allowlist,
  });

  const createCaller = (req: AuthInterceptorInput): ApiCaller => {
    // Run the interceptor in the CONTEXT FACTORY — before any resolver. The
    // context carries ONLY the typed outcome (secret-free): ok(AuthedContext) or
    // err(FailureVariant). httpBatchLink-compatible: the same `req` tuple is what
    // an HTTP transport would extract from headers.
    const context: ApiContext = { auth: interceptor(req) };
    return appCallerFactory(context);
  };

  return { appRouter, createCaller };
}
