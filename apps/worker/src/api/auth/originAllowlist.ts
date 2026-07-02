// Task 8.1 (b) — Origin/Host allowlist check (anti-DNS-rebinding), worker-side.
//
// A malicious page can reach the worker's loopback port (loopback binding is NOT
// authentication, §5) and, via DNS-rebinding, resolve an allowlisted name to
// loopback while presenting a FOREIGN Host header. So the worker checks BOTH the
// request Origin AND the request Host against a strict exact-match allowlist, IN
// ADDITION to the session token.
//
// LESSON 4 (root CLAUDE.md / packages/contracts LESSONS.md §4): a security
// predicate parsing an untrusted URL/endpoint MUST isolate the URL authority —
// strip scheme, path/query/fragment/backslash — BEFORE stripping userinfo and
// extracting the host. Stripping userinfo first is loopback/SSRF-spoofable:
// `http://evil.com/@localhost:5173` has REAL host `evil.com` (the `@` is in the
// PATH), yet a userinfo-first parser reads the host as `localhost:5173` and would
// wrongly admit it.
//
// converge-url-authority: the authority isolator is the SINGLE vetted copy
// exported by @sow/policy (`extractAuthority` — the Lesson-4-safe, PORT-PRESERVING
// isolator), NOT a worker-local re-implementation. Two copies of a security
// predicate can drift (Lesson 4's meta-lesson: order-of-stripping is a boundary).
// We isolate the authority here via that shared export, then delegate the
// exact-match decision to the Phase-3 policy predicate `isOriginAllowed`.
//
// §16: never throws — every path returns a typed Result. FAIL-CLOSED: missing /
// empty / unparseable Origin or Host ⇒ reject.
import { ok, err, type Result, type FailureVariant, failure } from "@sow/contracts";
import { isOriginAllowed, isAllow, extractAuthority, type OriginAllowlist } from "@sow/policy";

/**
 * The worker's strict Origin/Host allowlist. `origins` are exact request-Origin
 * strings (scheme://host[:port], no trailing slash); `hosts` are exact request
 * Host-header strings (host[:port]). Both must match for admission.
 */
export type WorkerOriginAllowlist = OriginAllowlist;

/**
 * Check the raw request `origin` + `host` against the strict `allowlist`.
 *
 * Isolates the URL authority of BOTH headers (Lesson-4-safe: authority isolated
 * BEFORE userinfo/host, via @sow/policy `extractAuthority` — the single vetted
 * copy, which PRESERVES the port so an off-port caller cannot collapse onto an
 * on-port allowlist entry) then requires an EXACT match of the request Origin
 * against `allowlist.origins` AND the request Host against `allowlist.hosts`.
 * The exact match itself is delegated to the Phase-3 policy predicate
 * `isOriginAllowed`.
 *
 * The FULL raw Origin (scheme-bearing) is matched against `allowlist.origins`
 * (after trimming); the DERIVED authority is matched against `allowlist.hosts`.
 * A userinfo-spoof / path-`@` origin therefore fails BOTH the exact-origin match
 * (its raw form isn't on-list) and cannot inject a fake host authority (the
 * isolator reads its true authority, e.g. `evil.com`).
 *
 * FAIL-CLOSED: missing / empty / unparseable Origin or Host ⇒ reject. §16: never
 * throws.
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
  const originHostToken = extractAuthority(origin);
  const hostToken = extractAuthority(host);
  if (rawOrigin.length === 0 || originHostToken === null || hostToken === null) {
    return rejected();
  }

  // Cross-check: the Origin's authority MUST equal the Host header's authority.
  // (Both are still matched against the allowlist independently below — this is a
  // defense-in-depth consistency gate on top of the exact-match decision.)
  if (originHostToken !== hostToken) {
    return rejected();
  }

  // Delegate the exact-match decision to the frozen policy predicate. We match the
  // FULL raw Origin (scheme-bearing) against `origins`, and the isolated Host
  // token against `hosts` — so a userinfo-spoofed origin (whose raw form isn't
  // on-list) is rejected, and its host cannot be forged past the isolation above.
  const decision = isOriginAllowed(rawOrigin, hostToken, allowlist);
  if (isAllow(decision)) {
    return ok({ ok: true });
  }
  return rejected();
}

function rejected(): Result<{ ok: true }, FailureVariant> {
  return err(failure("validation_rejected", "origin not allowed"));
}
