// Task 8.1 (d) — the single composed auth interceptor for the worker API.
//
// `makeAuthInterceptor` builds ONE guard that composes the three checks:
//   1. session token verify  (sessionAuth.verifySessionToken — UNAUTHORIZED)
//   2. Origin/Host allowlist  (originAllowlist.checkOrigin  — FORBIDDEN)
// It runs BEFORE any tRPC procedure / handler and before the WebSocket stream
// handshake — a missing / wrong token or a wrong Origin/Host is rejected
// PRE-HANDLER, so no procedure logic and no stream is ever reached unauthenticated.
//
// The loopback-bind assertion (loopbackBind.assertLoopbackBind) is a SEPARATE,
// startup-time invariant checked by the transport when it binds the socket — it
// is not a per-request check, so it is exported alongside but not folded into the
// per-request guard here.
//
// ORDER: token BEFORE origin (authentication precedes authorization) — a request
// with both a wrong token and a wrong origin fails as `unauthenticated`, never
// revealing that the origin was also off-list.
//
// The worker VERIFIES the token; it never MINTS one (Electron main mints —
// Phase 9). §16: never throws — returns a typed Result on every path.
import { type Result, type FailureVariant } from "@sow/contracts";
import { type SessionToken } from "@sow/policy";
import { verifySessionToken, type AuthedContext } from "./sessionAuth";
import { checkOrigin, type WorkerOriginAllowlist } from "./originAllowlist";

/** Config for {@link makeAuthInterceptor}: the current-launch expected token + the strict allowlist. */
export interface AuthInterceptorConfig {
  /** The current-launch expected token (minted by Electron main, injected — NOT minted here). */
  readonly expectedToken: SessionToken;
  /** The strict Origin/Host allowlist for anti-rebinding admission. */
  readonly allowlist: WorkerOriginAllowlist;
}

/**
 * The per-request inputs the transport extracts from the incoming request /
 * handshake: the presented bearer token, and the raw Origin + Host headers. All
 * are optional at the type level because a raw request may omit any of them — a
 * missing value fails closed.
 */
export interface AuthInterceptorInput {
  readonly token: string | undefined;
  readonly origin: string | undefined;
  readonly host: string | undefined;
}

/** The composed guard: an admitted request yields an {@link AuthedContext}. */
export type AuthInterceptor = (
  input: AuthInterceptorInput,
) => Result<AuthedContext, FailureVariant>;

/**
 * Build the single composed auth interceptor. The returned guard, run before any
 * procedure/handler and before the stream handshake:
 *   1. verifies the per-launch session token (constant-time, via the policy
 *      primitive) — a missing / wrong token ⇒ `unauthenticated` (UNAUTHORIZED);
 *   2. checks the Origin/Host allowlist (Lesson-4-safe authority isolation,
 *      anti-DNS-rebind) — a wrong Origin/Host ⇒ `origin not allowed` (FORBIDDEN).
 * On success returns `ok(authedContext)`. Token is checked FIRST. Never throws.
 */
export function makeAuthInterceptor(config: AuthInterceptorConfig): AuthInterceptor {
  const { expectedToken, allowlist } = config;
  return (input: AuthInterceptorInput): Result<AuthedContext, FailureVariant> => {
    // 1. Authentication FIRST — the token gate short-circuits before any origin
    //    reasoning, so an unauthenticated caller learns nothing about the origin.
    const auth = verifySessionToken(input.token, expectedToken);
    if (auth.ok === false) return auth;

    // 2. Authorization — the strict Origin/Host allowlist (anti-rebind).
    const origin = checkOrigin(input.origin, input.host, allowlist);
    if (origin.ok === false) return origin;

    return auth;
  };
}
