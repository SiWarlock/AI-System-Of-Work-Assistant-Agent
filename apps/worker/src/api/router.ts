// Task 8.2 (d) — the shared router skeleton the procedure modules extend.
//
// This is the single import surface the 8.3 query router + 8.4 command router
// build on: `router`, `publicProcedure`, and the `authedResolver` wrapper that
// enforces the auth gate + the typed-`Result` boundary. It also defines the tiny
// `health` router — the always-present liveness seam (an authenticated no-op
// probe) that lets the transport + interceptor be exercised end-to-end before the
// real query/command routers land. 8.3/8.4 mount THEIR routers alongside `health`
// in `server.ts`'s `appRouter`.
//
// PURE-ish: re-exports the `trpc.ts` base + declares the health seam. No I/O.
import {
  router,
  publicProcedure,
  authedResolver,
  ok,
  type Result,
  type FailureVariant,
} from "./trpc";

/** The typed payload of the health-probe (kept trivial + UI-safe). */
export interface HealthPingResult {
  readonly ready: true;
}

/**
 * The always-present health seam. `ping` runs BEHIND the auth gate (via
 * `authedResolver`) and returns a typed `Result` as data — proving the
 * interceptor → context → resolver path end-to-end. An unauthenticated caller
 * gets the interceptor's typed `err(FailureVariant)`, never a throw.
 */
export const healthRouter = router({
  ping: publicProcedure.query(
    authedResolver<undefined, HealthPingResult>(
      (): Result<HealthPingResult, FailureVariant> => ok({ ready: true as const }),
    ),
  ),
});

// Re-export the base seam so 8.3/8.4 import ONE module.
export { router, publicProcedure, authedResolver };
export type { Result, FailureVariant };
