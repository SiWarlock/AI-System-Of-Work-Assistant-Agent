// Task 8.1 (b) — Origin/Host allowlist check (anti-DNS-rebinding), worker-side.
//
// A malicious page can reach the worker's loopback port (loopback binding is NOT
// authentication, §5) and, via DNS-rebinding, resolve an allowlisted name to
// loopback while presenting a FOREIGN Host header. So the worker checks BOTH the
// request Origin AND the request Host against a strict exact-match allowlist,
// IN ADDITION to the session token.
//
// LESSON 4 (root CLAUDE.md / packages/contracts LESSONS.md §4): a security
// predicate parsing an untrusted URL/endpoint MUST isolate the URL authority —
// strip scheme, then path/query/fragment/backslash — BEFORE stripping userinfo
// and extracting the host. Stripping userinfo first is loopback/SSRF-spoofable:
// `http://evil.com/@localhost:5173` has REAL host `evil.com` (the `@` is in the
// PATH), yet a userinfo-first parser reads the host as `localhost:5173` and would
// wrongly admit it. We isolate the authority first here, then delegate the
// exact-match decision to the Phase-3 policy predicate `isOriginAllowed`.
//
// §16: never throws — every path returns a typed Result. FAIL-CLOSED: a missing /
// empty / unparseable Origin or Host ⇒ reject.
import { ok, err, type Result, type FailureVariant, failure } from "@sow/contracts";
import { isOriginAllowed, isAllow, type OriginAllowlist } from "@sow/policy";

/**
 * The worker's strict Origin/Host allowlist. `origins` are exact request-Origin
 * strings (scheme://host[:port], no trailing slash); `hosts` are exact request
 * Host-header strings (host[:port]). Both must match for admission.
 */
export type WorkerOriginAllowlist = OriginAllowlist;

/** The substring before the earliest of `delimiters`, or the whole string if none occur. */
function firstSegment(str: string, delimiters: string): string {
  let cut = str.length;
  for (const d of delimiters) {
    const i = str.indexOf(d);
    if (i >= 0 && i < cut) cut = i;
  }
  return str.slice(0, cut);
}

/**
 * Isolate the AUTHORITY (`[userinfo@]host[:port]`) of a raw request Origin, then
 * strip userinfo, yielding the canonical `host[:port]` for an exact allowlist
 * match. Returns null for anything it cannot reduce to a non-empty host token.
 *
 * ORDER IS A SECURITY BOUNDARY (Lesson 4): scheme → path/query/fragment/backslash
 * → userinfo. An `@` that appears AFTER the first `/ ? # \` is part of the path,
 * NOT userinfo, so the authority is isolated FIRST.
 *
 * Note: the host token is preserved WITH its port (the allowlist entries carry the
 * port, e.g. `localhost:5173`) and lowercased for a stable compare. It is NOT
 * reduced to a bare host — an off-port caller must not match an on-port entry.
 */
function originAuthority(rawOrigin: string): string | null {
  let s = rawOrigin.trim();
  if (s.length === 0) return null;

  // Strip an explicit `scheme://` prefix (keep the scheme is handled by the
  // separate exact-Origin match; here we reduce to the authority for the Host
  // cross-check comparability). Also handle a protocol-relative `//` prefix.
  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  const schemePrefix = scheme?.[0];
  if (schemePrefix !== undefined) {
    s = s.slice(schemePrefix.length);
  } else if (s.startsWith("//")) {
    s = s.slice(2);
  }

  // Isolate the authority: strip path / query / fragment. Backslash is a path
  // separator under the WHATWG special-scheme rule, so it delimits too. This MUST
  // precede userinfo stripping.
  s = firstSegment(s, "/?#\\");
  if (s.length === 0) return null;

  // Within the authority, strip userinfo (`user:pass@host`). The LAST `@`
  // separates userinfo from host (WHATWG).
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.length === 0) return null;

  return s.toLowerCase();
}

/**
 * Normalize a raw Host header for an exact allowlist match: trim, isolate the
 * authority (a Host header carries no scheme/path, but strip defensively), strip
 * any userinfo, lowercase. Returns null on empty/unparseable input (fail-closed).
 */
function hostAuthority(rawHost: string): string | null {
  const trimmed = rawHost.trim();
  if (trimmed.length === 0) return null;
  // A Host header should be bare `host[:port]`, but treat any `/ ? # \` and
  // userinfo defensively so a smuggled path/userinfo cannot shift the match.
  let s = firstSegment(trimmed, "/?#\\");
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.length === 0) return null;
  return s.toLowerCase();
}

/**
 * Check a raw request `origin` + `host` against the strict `allowlist`.
 *
 * Isolates the URL authority of BOTH headers (Lesson-4-safe: authority before
 * userinfo/host) and requires an EXACT match of the request Origin against
 * `allowlist.origins` AND the request Host against `allowlist.hosts`. The exact
 * match itself is delegated to the Phase-3 policy predicate `isOriginAllowed`.
 *
 * The full raw Origin (scheme-bearing) is matched against `allowlist.origins`
 * AFTER trimming; the DERIVED authority is matched against `allowlist.hosts`.
 * A userinfo-spoof / path-`@` origin therefore fails BOTH the exact-origin match
 * (its raw form isn't on-list) and cannot inject a fake host authority.
 *
 * FAIL-CLOSED: a missing / empty / unparseable Origin or Host ⇒ reject. §16:
 * never throws.
 */
export function checkOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowlist: WorkerOriginAllowlist,
): Result<{ ok: true }, FailureVariant> {
  if (typeof origin !== "string" || typeof host !== "string") {
    return rejected();
  }

  const rawOrigin = origin.trim();
  const originHostToken = originAuthority(origin);
  const hostToken = hostAuthority(host);
  if (rawOrigin.length === 0 || originHostToken === null || hostToken === null) {
    return rejected();
  }

  // Cross-check: the Origin's derived host authority MUST equal the request Host
  // authority. This closes the rebind gap where a page presents an on-list Origin
  // but a different Host (or vice versa) — both must describe the SAME loopback
  // endpoint. (isOriginAllowed also checks each against the list independently.)
  if (originHostToken !== hostToken) {
    return rejected();
  }

  // Delegate the exact-match decision to the frozen policy predicate. We match the
  // FULL raw Origin (scheme-bearing) against origins, and the isolated Host token
  // against hosts — so a userinfo-spoofed origin (whose raw form isn't on-list)
  // is rejected, and its host cannot be forged past the isolation above.
  const decision = isOriginAllowed(rawOrigin, hostToken, allowlist);
  if (isAllow(decision)) {
    return ok({ ok: true });
  }
  return rejected();
}

function rejected(): Result<{ ok: true }, FailureVariant> {
  return err(failure("validation_rejected", "origin not allowed"));
}
