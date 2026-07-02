// §5 route → processor identity (REQ-S-002/S-005). The identity layer beneath
// the egress veto (3.4): it answers "does this route egress, and if so to WHICH
// processor?" so the veto/allowlist can reason over a stable processor id.
//
// PURE — no clock, network, or randomness. FAIL-CLOSED: the tunneled-local hole
// (a route that CLAIMS egressClass 'local' but points at a remote/proxied
// endpoint) is treated as EGRESS, never as safe-local. REDACTION-SAFE: this
// module returns ids only (a ProcessorId or null) — no content.
import type { ProviderId, ProviderRoute, ProcessorId } from "@sow/contracts";
import { processorId } from "@sow/contracts";

// The ONLY provider ids that name a genuinely LOCAL (zero-egress) engine. A CLOUD
// provider id (claude/openai/openrouter) can NEVER be laundered into a
// non-egress route by an endpoint claim — the named provider identity wins.
const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["ollama", "lm_studio"]);

/** The substring before the earliest of `delimiters`, or the whole string if none occur. */
export function firstSegment(str: string, delimiters: string): string {
  let cut = str.length;
  for (const d of delimiters) {
    const i = str.indexOf(d);
    if (i >= 0 && i < cut) cut = i;
  }
  return str.slice(0, cut);
}

/**
 * Isolate the AUTHORITY (`host[:port]`, lowercased) from an endpoint / URL /
 * Origin string, or null if it can't be reduced to a non-empty authority.
 *
 * THIS IS THE Lesson-4-SAFE URL-authority isolator — the SINGLE vetted copy
 * (root CLAUDE.md Lesson 4). The ORDER of stripping is a SECURITY BOUNDARY:
 *   1. strip an explicit `scheme://` (or protocol-relative `//`) prefix,
 *   2. strip path / query / fragment — delimiter set `/?#\` (backslash is a
 *      path separator under the WHATWG special-scheme rule),
 *   3. strip userinfo — the LAST `@` separates userinfo from host.
 * Step 2 MUST precede step 3: an `@` that appears AFTER the first `/ ? # \` is
 * part of the path/query/fragment, NOT userinfo. Stripping userinfo first was
 * the loopback-spoof hole — `evil.com/@127.0.0.1` was misread as host
 * `127.0.0.1`. Do NOT reorder these steps.
 *
 * The PORT IS PRESERVED (unlike {@link extractHost}) — a port-aware allowlist
 * (e.g. the worker's Origin/Host allowlist whose entries carry `:port`) needs
 * `host:port` so an off-port caller does not collapse onto an on-port entry.
 * Bracketed / bare IPv6 literals are preserved as written (brackets kept).
 * Pure; never throws.
 */
export function extractAuthority(raw: string): string | null {
  let s = raw.trim();
  if (s.length === 0) return null;

  // Strip an explicit `scheme://` prefix, or a protocol-relative `//` prefix.
  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  const schemePrefix = scheme?.[0];
  if (schemePrefix !== undefined) {
    s = s.slice(schemePrefix.length);
  } else if (s.startsWith("//")) {
    s = s.slice(2);
  }

  // Isolate the AUTHORITY first: strip path / query / fragment. Backslash is a
  // path separator (WHATWG special-scheme rule), so it delimits too. This MUST
  // precede userinfo stripping — an `@` that appears AFTER the first `/ ? # \` is
  // part of the path/query/fragment, NOT userinfo. (Stripping userinfo first was
  // the loopback-spoof hole: `evil.com/@127.0.0.1` was misread as host 127.0.0.1.)
  s = firstSegment(s, "/?#\\");
  if (s.length === 0) return null;

  // Within the authority, strip userinfo (`user:pass@host`) — the LAST `@`
  // separates userinfo from host (WHATWG). The host[:port] is what remains.
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.length === 0) return null;

  return s.toLowerCase();
}

/**
 * Extract the bare host from an endpoint string, or null if unparseable — the
 * {@link extractAuthority} authority with the port stripped (and IPv6 brackets
 * removed). Handles `scheme://`, protocol-relative `//`, `user@`, `host:port`,
 * bracketed IPv6 (`[::1]:port`), bare IPv6 literals, and `/path?query#frag`.
 * Lowercased. Pure; never throws (returns null on anything it can't reduce).
 */
export function extractHost(raw: string): string | null {
  const authority = extractAuthority(raw);
  if (authority === null || authority.length === 0) return null;
  const s = authority;

  // Bracketed IPv6: `[::1]` or `[::1]:port` → the inner literal.
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) return null;
    return s.slice(1, close);
  }

  const colons = (s.match(/:/g) ?? []).length;
  // A bare IPv6 literal (no brackets) has ≥2 colons and carries no port → as-is.
  if (colons >= 2) return s;
  // `host:port` → strip the single port.
  if (colons === 1) return s.slice(0, s.indexOf(":"));
  return s;
}

/**
 * True iff `host` is a loopback host: `localhost`, `::1` (and its long form), or
 * an address in the IPv4 127.0.0.0/8 range. The EXACT four-octet match on the
 * 127-range rejects the prefix/suffix spoofs `127.0.0.1.attacker.com` /
 * `localhost.evil.com` (extra labels ⇒ no match). `host` is expected already
 * lowercased (as {@link extractHost} / the worker bind-addr normalizer yield).
 * This is the SINGLE vetted loopback predicate (root CLAUDE.md Lesson 4). Pure.
 */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // IPv4 loopback range 127.0.0.0/8. The EXACT four-octet match rejects the
  // prefix trick "127.0.0.1.attacker.com" (extra labels ⇒ no match).
  const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  return m.slice(1).every((oct) => {
    const n = Number(oct);
    return n >= 0 && n <= 255;
  });
}

/**
 * True ONLY for a loopback endpoint — one that provably cannot leave the machine:
 * `localhost`, the 127.0.0.0/8 range, `::1`, or a unix-socket path (`/abs/path`
 * or `unix://…`). FALSE for any remote / proxied / DNS / all-interfaces
 * (`0.0.0.0`) host, and FALSE (fail-closed) for empty / unparseable input.
 *
 * `egressClass` is a CLAIM; this function is the PROOF the veto trusts. Adversarial
 * cases it must reject: the prefix trick (`127.0.0.1.attacker.com`), the suffix
 * trick (`localhost.evil.com`), `0.0.0.0` (remotely reachable), and a
 * protocol-relative `//evil.com`. Pure; never throws.
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== "string") return false;
  const raw = endpoint.trim();
  if (raw.length === 0) return false;

  // Unix-domain-socket / file scheme. On-machine ONLY when it carries no REMOTE
  // authority. `unix://host/…` / `file://host/…` with a non-empty authority must
  // resolve to a loopback host (fail-closed against a remote-authority exfil
  // claim like `file://evil.com/…`); `file:///path` (empty authority) and the
  // non-`//` path forms below are on-machine.
  const fileAuthority = raw.match(/^(?:unix|file):\/\//i);
  if (fileAuthority !== null) {
    const authority = firstSegment(raw.slice(fileAuthority[0].length), "/?#\\");
    if (authority.length === 0) return true; // file:///path — empty authority
    const at = authority.lastIndexOf("@");
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    const host = firstSegment(hostPort, ":").toLowerCase();
    return host.length > 0 && isLoopbackHost(host);
  }
  // Unix domain socket / filesystem path — inherently on-machine. A single
  // leading "/" is an absolute path; "//" is a protocol-relative URL (NOT a
  // socket) and falls through to host parsing. `unix:`/`file:` (no `//authority`)
  // are explicit on-machine paths.
  if (raw.startsWith("unix:") || raw.startsWith("file:")) return true;
  if (raw.startsWith("/") && !raw.startsWith("//")) return true;

  const host = extractHost(raw);
  if (host === null) return false; // fail-closed: unparseable ⇒ not loopback
  return isLoopbackHost(host);
}

/**
 * A REDACTION-SAFE audit ref for a route endpoint: the HOST only (scheme,
 * userinfo, port, and path stripped). A `user:pass@host` basic-auth endpoint
 * therefore never leaks its credential into the audit / System-Health stream
 * (safety rule 7 / §16). Unparseable ⇒ a fixed marker. Pure.
 */
export function endpointHostRef(endpoint: string): string {
  const host = typeof endpoint === "string" ? extractHost(endpoint) : null;
  return `ref:endpoint-host:${host ?? "UNPARSEABLE"}`;
}

/**
 * The processor a route egresses to, or `null` for a genuine NON-EGRESS
 * loopback-local route.
 *
 * Returns `null` IFF ALL hold: `egressClass === 'local'` AND the endpoint is a
 * loopback endpoint AND the route is either a LOCAL provider (ollama / lm_studio)
 * or a runtime (a runtime bound to loopback). Otherwise the route EGRESSES and a
 * DISTINCT ProcessorId is returned:
 *   - provider branch → `processorId(provider)` — OpenRouter is its OWN processor
 *     (`'openrouter'`), NEVER an OpenAI alias; claude→'claude'; openai→'openai'; …
 *   - runtime branch  → `processorId(runtime)`.
 *
 * CRITICAL fail-closed edge (the tunneled-local hole): a route with
 * `egressClass === 'local'` but a NON-loopback / remote / proxied endpoint is
 * treated as EGRESS — it returns a processor, NOT null — so a 'local' claim can
 * never launder an exfiltration endpoint past the veto. Likewise a CLOUD provider
 * id claiming local+loopback still egresses (the named provider wins). Pure.
 */
export function processorOfRoute(route: ProviderRoute): ProcessorId | null {
  // Read through an untyped view so the fail-closed guards hold even for a value
  // the static ProviderRoute type would forbid (null / neither-key / both-keys) —
  // a malformed route must NEVER be classified non-egress.
  const r = route as unknown as {
    provider?: unknown;
    runtime?: unknown;
    endpoint?: unknown;
    egressClass?: unknown;
  } | null;
  if (r === null || typeof r !== "object") {
    return processorId("MALFORMED_ROUTE"); // egress, never non-egress
  }
  const hasProvider = typeof r.provider === "string";
  const hasRuntime = typeof r.runtime === "string";
  // A well-formed ProviderRoute is EXACTLY one of provider|runtime. Neither or
  // both ⇒ malformed ⇒ treated as EGRESS (closes the no-port loopback edge).
  if (hasProvider === hasRuntime) {
    return processorId("MALFORMED_ROUTE");
  }
  const identity = (hasProvider ? r.provider : r.runtime) as string;

  // Non-egress requires BOTH the 'local' claim AND loopback PROOF. egressClass
  // alone is never trusted — that is the tunneled-local hole.
  const loopbackLocal =
    r.egressClass === "local" &&
    typeof r.endpoint === "string" &&
    isLoopbackEndpoint(r.endpoint);

  if (loopbackLocal) {
    // A runtime bound to loopback is a genuine non-egress engine.
    if (hasRuntime) return null;
    // A provider-branch route is non-egress ONLY for a genuinely local provider;
    // a cloud provider id (claude/openai/openrouter) is a cloud processor by
    // identity even when it claims loopback (fail-closed).
    if (LOCAL_PROVIDERS.has(r.provider as ProviderId)) return null;
  }

  // Egress: a distinct processor id per destination. No aliasing.
  return processorId(identity);
}
