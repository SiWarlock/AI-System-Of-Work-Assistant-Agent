// Task 8.5 (b) — the stream handshake: the SAME 8.1 auth interceptor runs
// BEFORE any event flows.
//
// Per the Phase-0 API spike (docs/spikes/0.5-api-stream.md), the per-launch
// session token rides `connectionParams` — the FIRST WebSocket message — NEVER
// a URL (safety rule 7: secrets never in a loggable request line). The Origin
// and Host come from the WS upgrade request. This module extracts the token
// from `connectionParams.token` and the Origin/Host from the upgrade, then runs
// the composed 8.1 `AuthInterceptor` (token-first, then Origin/Host allowlist).
//
// The handshake runs in the tRPC `createContext` — BEFORE the subscription
// generator is entered — so a missing/wrong token (UNAUTHORIZED) or a wrong
// Origin/Host (FORBIDDEN) is rejected PRE-SUBSCRIPTION: no event ever flows to
// an unauthenticated / off-origin consumer. The typed outcome is carried on the
// stream context; the subscription checks it first (see `pushStream.ts`).
//
// §16: never throws — returns a typed `Result<AuthedContext, FailureVariant>`.
// REDACTION-SAFE: the token bytes never enter the returned failure (the 8.1
// primitives keep them out); this wrapper only routes headers, never logs them.
import { err, failure, type Result, type FailureVariant } from "@sow/contracts";
import type { AuthInterceptor } from "../auth/interceptor";
import type { AuthedContext } from "../auth/sessionAuth";

/**
 * The raw inputs the WS transport hands the handshake:
 *   - `connectionParams`: the parsed first-message params (the token lives at
 *     `.token`); `null`/`undefined` when the client sent none — fail-closed.
 *   - `origin` / `host`: the Origin + Host headers from the upgrade request.
 * All are permissive at the type level because a raw handshake may omit any of
 * them; a missing value fails closed to `unauthenticated` / rejected.
 */
export interface StreamHandshakeInput {
  readonly connectionParams: Record<string, unknown> | null | undefined;
  readonly origin: string | undefined;
  readonly host: string | undefined;
}

/**
 * Extract the presented token from the first-message connection params. ONLY a
 * string `token` field is accepted — a token smuggled inside a `url` field (or
 * any other shape) is NOT read, so a URL-only token is treated as absent
 * (fail-closed to unauthenticated). This enforces "token never from a URL."
 */
function extractToken(params: Record<string, unknown> | null | undefined): string | undefined {
  if (params === null || params === undefined) return undefined;
  const raw = params.token;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Run the stream handshake: the 8.1 interceptor, BEFORE any event flows. Returns
 * `ok(AuthedContext)` on admission; a missing/wrong token ⇒ UNAUTHORIZED-mapped
 * `err` (token-first), a wrong Origin/Host ⇒ FORBIDDEN-mapped `err`. Never throws.
 */
export function runStreamHandshake(
  interceptor: AuthInterceptor,
  input: StreamHandshakeInput,
): Result<AuthedContext, FailureVariant> {
  const token = extractToken(input.connectionParams);
  // Defense-in-depth: the interceptor already returns a typed Result on every
  // path, but wrap so even an unexpected interceptor bug fails closed (§16).
  try {
    return interceptor({ token, origin: input.origin, host: input.host });
  } catch {
    return err(failure("validation_rejected", "unauthenticated"));
  }
}
