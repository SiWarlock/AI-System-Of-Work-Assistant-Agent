// Task 8.2 (a) — the initTRPC base for the worker's local control-plane API.
//
// THREE guarantees this module establishes:
//   1. CONTEXT carries ONLY the authenticated session outcome — never a secret,
//      never a Keychain handle, never the raw token. `ApiContext` is exactly
//      `{ auth: Result<AuthedContext, FailureVariant> }`: the fact-of-auth (or the
//      typed reason it failed), nothing that could leak to a resolver.
//   2. The 8.1 AUTH INTERCEPTOR runs in the context factory BEFORE any resolver
//      (see `server.ts`), and the base procedure's `authedResolver` wrapper checks
//      that outcome FIRST — so a resolver body never runs unauthenticated.
//   3. Every procedure surfaces a `Result<T, FailureVariant>` as its DATA (an err
//      carries the failure; the call never throws across the boundary, §16). The
//      `errorFormatter` is a defense-in-depth net that maps any UNEXPECTED throw
//      to a redaction-safe shape (a fixed message + code — no stack, no raw error,
//      no prompt, no content), so even a bug cannot leak a raw error to the UI.
//
// PURE-ish: imports @trpc/server + the frozen contract primitives + the 8.1
// AuthedContext type. No I/O here; the transport wiring lives in `server.ts`.
import { initTRPC, TRPCError } from "@trpc/server";
import {
  ok,
  err,
  isErr,
  failure,
  type Result,
  type FailureVariant,
} from "@sow/contracts";
import type { AuthedContext } from "./auth/sessionAuth";

/**
 * The tRPC request context. Deliberately MINIMAL and secret-free: it carries the
 * OUTCOME of the 8.1 auth interceptor (already run in the context factory) as a
 * typed `Result`. A resolver sees either `ok({ authenticated: true })` or the
 * typed `err(FailureVariant)` — never the token, never a Keychain ref.
 */
export interface ApiContext {
  readonly auth: Result<AuthedContext, FailureVariant>;
}

/**
 * The default error shape, extended so a formatted error is ALWAYS redaction-safe.
 * We overwrite `message` with a fixed literal and drop the stack — the renderer
 * receives a stable code + generic message, never a raw error / prompt / content.
 */
const t = initTRPC.context<ApiContext>().create({
  errorFormatter(opts) {
    const { shape } = opts;
    return {
      // A fixed, content-free message. The typed `Result` err (carried as DATA on
      // the happy transport path) is the real, safe error surface; this formatter
      // only ever fires for an UNEXPECTED throw, which must not leak internals.
      message: "internal_error",
      code: shape.code,
      data: {
        code: shape.data.code,
        httpStatus: shape.data.httpStatus,
        // NO stack, NO path echo of input, NO cause — redaction-safe by omission.
      },
    };
  },
});

/** The router builder (compose the appRouter from procedure modules). */
export const router = t.router;

/** The server-side caller factory (loopback invocation, no HTTP round-trip). */
export const createCallerFactory = t.createCallerFactory;

/** The raw base procedure — use `resultProcedure`/`authedResultProcedure` below. */
export const publicProcedure = t.procedure;

/** The tRPC middleware builder, re-exported for procedure modules that need it. */
export const middleware = t.middleware;

/**
 * A resolver that has ALREADY passed the auth gate: it receives the authenticated
 * context + the validated input and returns a typed `Result` as DATA. It must
 * NEVER throw — a domain failure is an `err(FailureVariant)`, not an exception.
 */
export type AuthedResolver<TInput, TOutput> = (
  ctx: AuthedContext,
  input: TInput,
) => Result<TOutput, FailureVariant> | Promise<Result<TOutput, FailureVariant>>;

/**
 * Wrap an {@link AuthedResolver} into a tRPC resolver body that:
 *   1. checks `ctx.auth` FIRST — an unauthenticated / off-origin request returns
 *      the typed `err(FailureVariant)` as DATA (never throws, never runs the body);
 *   2. on success runs the handler with the authenticated context;
 *   3. converts ANY unexpected throw from the handler into a typed
 *      `err(failure("degraded_unavailable", ...))` — so the boundary output is
 *      ALWAYS a `Result`, satisfying §16 even under a handler bug.
 *
 * This is the seam 8.3/8.4 build their query/command procedures on:
 *   `publicProcedure.input(schema).query(authedResolver(async (ctx, input) => ...))`
 */
export function authedResolver<TInput, TOutput>(
  handler: AuthedResolver<TInput, TOutput>,
): (opts: {
  ctx: ApiContext;
  input: TInput;
}) => Promise<Result<TOutput, FailureVariant>> {
  return async (opts): Promise<Result<TOutput, FailureVariant>> => {
    // 1. AUTH GATE FIRST — surface the interceptor's typed failure as data.
    if (isErr(opts.ctx.auth)) {
      return err(opts.ctx.auth.error);
    }
    const authed = opts.ctx.auth.value;
    // 2. Run the handler; 3. never let an unexpected throw cross the boundary.
    try {
      return await handler(authed, opts.input);
    } catch {
      // Redaction-safe: no raw error, message, stack, or content in the failure.
      return err(
        failure("degraded_unavailable", "internal_error", {
          cause: { code: "UNEXPECTED_RESOLVER_ERROR" },
        }),
      );
    }
  };
}

/** Re-export so procedure modules build typed oks without importing @sow/contracts twice. */
export { ok, err, failure, isErr };
export type { Result, FailureVariant, AuthedContext, TRPCError };
