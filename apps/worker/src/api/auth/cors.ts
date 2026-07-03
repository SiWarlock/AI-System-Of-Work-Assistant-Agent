// Task 9.4b — strict single-origin CORS for the native renderer.
//
// The Electron renderer is a DISTINCT origin (app://sow in prod,
// http://localhost:5173 in dev) calling the loopback worker cross-origin, and it
// sends a custom `Authorization: Bearer` header. That makes the browser issue a
// CORS PREFLIGHT (OPTIONS) and then block the actual response unless the worker
// reflects an allowlisted `Access-Control-Allow-Origin`.
//
// This is a BROWSER-facing response-read control, NOT the access control — the
// session token + Origin/Host allowlist (interceptor.ts) remain the real gate and
// run on every request regardless of CORS. So the ONLY origins reflected here are
// the SAME `allowlist.origins` the interceptor admits.
//
// SAFETY: reflect the EXACT allowlisted Origin, never `*`, and never emit
// `Access-Control-Allow-Credentials` — the token rides an Authorization header,
// not a cookie, so credentialed-CORS (the `*`-is-forbidden, origin-reflection
// footgun) is neither needed nor enabled. Exact string match (no normalization),
// mirroring the interceptor's exact-match strictness.

/** Methods the loopback API answers for the renderer (httpBatchLink: GET query, POST mutation). */
export const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";

/** Request headers the renderer sends that are not CORS-safelisted (the bearer token + JSON body). */
export const CORS_ALLOW_HEADERS = "authorization, content-type";

/** How long a browser may cache the preflight result (seconds). */
export const CORS_MAX_AGE = "600";

/** The outcome the transport applies to a request before delegating to the tRPC handler. */
export interface CorsOutcome {
  /** Response headers to set (empty when the Origin is absent or off-list). */
  readonly headers: Record<string, string>;
  /**
   * When defined, the transport short-circuits the response with this status and
   * does NOT delegate to the tRPC handler — used for the preflight (OPTIONS), which
   * is never an actual tRPC call.
   */
  readonly shortCircuitStatus?: number;
}

/** The exact-Origin CORS headers for an admitted Origin (never `*`, never credentials). */
function corsHeadersFor(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    // Caches keyed by URL alone must not serve one origin's ACAO to another.
    Vary: "Origin",
  };
}

/**
 * Resolve the CORS action for a request. Pure — no I/O — so the transport stays a
 * thin applier and this decision is exhaustively unit-tested.
 *
 *   - An OPTIONS request is a preflight: answer 204. Include the exact-Origin CORS
 *     headers IFF the Origin is on `allowedOrigins`; a foreign Origin gets a bare
 *     204 with no ACAO, which the browser treats as a blocked preflight.
 *   - Any other method: set the exact-Origin ACAO IFF allowlisted, then delegate
 *     to the tRPC handler (the token/Origin/Host gate still runs there).
 *
 * FAIL-SAFE: a missing/absent Origin, or an Origin not on the list, yields NO
 * `Access-Control-Allow-Origin` — the browser then refuses to expose the response.
 */
export function resolveCors(
  method: string | undefined,
  origin: string | undefined,
  allowedOrigins: readonly string[],
): CorsOutcome {
  const allowed = typeof origin === "string" && allowedOrigins.includes(origin);
  const headers = allowed ? corsHeadersFor(origin) : {};
  if ((method ?? "").toUpperCase() === "OPTIONS") {
    return { headers, shortCircuitStatus: 204 };
  }
  return { headers };
}
