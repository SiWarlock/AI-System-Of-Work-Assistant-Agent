// @sow/providers — the real, dependency-injected HttpTransport over Node `fetch`
// (§19.5 real ModelProvider transport · §5.7 shared adapter infra · §16 redaction).
//
// This is the ONE place raw model HTTP I/O happens. It is a THIN, provider-AGNOSTIC
// pass-through: it performs the round-trip and returns `{ status, body }` verbatim. The
// per-provider wire shape (Anthropic messages, OpenAI chat-completions, …) is built by the
// `ModelWireAdapter`s, not here. Deliberately minimal:
//   • NEVER classifies status — a non-2xx response passes straight through; `executeCompletion`
//     maps it via `providerErrorFromStatus` (fetch fulfills on 4xx/5xx — it rejects only on a
//     network failure, per the WHATWG/undici spec).
//   • NEVER swallows/wraps a throw — a network reject / abort propagates UNCHANGED;
//     `classifyTransportThrow` owns abort→cancelled / timeout→timeout / else→transport_error.
//   • NO built-in timeout — cancellation rides the injected `AbortSignal` (the broker budget
//     enforcer aborts, 5.4); a built-in timeout would double-govern runtime.
//   • NO log sink and NO console output — the request `headers` carry the resolved secret
//     (`x-api-key`); the transport never logs/echoes the request, headers, or body (rule 7 / §16).
//   • redirect:"manual" — NEVER follow a 3xx. A cross-origin redirect would re-send the secret
//     `x-api-key` header VERBATIM to the redirect host (undici strips only authorization/cookie),
//     and the redirect target is chosen inside `fetch` — AFTER `req.url` cleared the upstream
//     egress veto. "manual" returns the 3xx to the executor → providerErrorFromStatus → fail-closed
//     (rule 7 wire-safety). Enforced at `send` for EVERY injected fetch, not just the default.
//   • the secret-bearing `headers` are COPIED at `send` so no injected `fetch` retains the caller's map.
//
// SAFE-BUILD / DORMANT: `fetch` is dependency-injected (tests substitute a deterministic fake —
// no real network), and there is NO production call-site until the worker gate-assembly helper
// (brief 132) injects this at the owner ENABLE. Reachability-WAIVERED (L11) until then.
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
} from "./http-transport";

/** The minimal structural shape the transport reads off a response: a status + a text body.
 *  The Node 22 global `fetch` `Response` satisfies this (`status`, `text()`). */
export interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

/** The minimal structural `fetch` the transport calls. The Node 22 global `fetch` satisfies it;
 *  tests inject a deterministic fake so no real network call is made. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    /** A PER-CALL COPY of the request headers (`send` severs the caller's map — defense-in-depth). */
    readonly headers: Record<string, string>;
    readonly body: string;
    /** Fixed by the transport to "manual": never FOLLOW a 3xx — a cross-origin redirect would
     *  re-send the secret `x-api-key` header verbatim (undici strips only authorization/cookie). */
    readonly redirect: "manual";
    readonly signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Deps for the real transport: ONLY an injectable `fetch` (default = the Node 22 global).
 *  There is deliberately NO log-sink field — the transport carries the resolved secret in
 *  `headers` and must never log/echo it; all mapping + redaction is the executor's (rule 7). */
export interface RealHttpTransportDeps {
  readonly fetch?: FetchLike;
}

/**
 * Construct the real injected-`fetch` `HttpTransport`. `send` calls the injected `fetch` with
 * the request's url/method/headers/body + the caller's `AbortSignal`, and normalizes the result
 * to `{ status, body: await res.text() }` — no status classification, no throw handling, no sink.
 */
export function createRealModelHttpTransport(deps: RealHttpTransportDeps = {}): HttpTransport {
  const fetchImpl: FetchLike =
    deps.fetch ??
    ((url, init) =>
      // `init` already carries the per-call header copy + redirect:"manual" (set in `send`).
      globalThis.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: init.redirect,
        signal: init.signal,
      }));

  return {
    async send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse> {
      const res = await fetchImpl(req.url, {
        method: req.method,
        // COPY the secret-bearing headers so no injected `fetch` retains/mutates the caller's map.
        headers: { ...req.headers },
        body: req.body,
        // NEVER follow a 3xx — a cross-origin redirect re-sends `x-api-key` to the redirect host
        // (rule 7). "manual" returns the 3xx to the executor → providerErrorFromStatus → fail-closed.
        redirect: "manual",
        signal,
      });
      return { status: res.status, body: await res.text() };
    },
  };
}
