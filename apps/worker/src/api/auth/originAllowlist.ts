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
  // Parse BOTH authorities up front (Lesson-4-safe isolation). This is the
  // FAIL-CLOSED parseability guard: an unparseable Origin/Host (e.g. `null` from a
  // `file://` page, or garbage) is refused before it can reach the matcher.
  const originAuthority = extractAuthority(origin);
  const hostToken = extractAuthority(host);
  if (rawOrigin.length === 0 || originAuthority === null || hostToken === null) {
    return rejected();
  }

  // INDEPENDENT allowlisting (native-client topology — 9.4b). The renderer is a
  // distinct trusted origin, NOT same-origin with the loopback worker, so the
  // request Origin (the page: `app://sow`, or `http://localhost:5173` in dev) and
  // the request Host (the worker target: `127.0.0.1:<port>`) are LEGITIMATELY
  // different authorities. We match each against the allowlist on its own — the
  // FULL raw Origin (scheme-bearing) against `origins`, and the Lesson-4-isolated
  // Host token against `hosts`.
  //
  // There is deliberately NO Origin==Host equality check. It encoded a same-origin
  // *web app* assumption that never held for a native client, and it caught
  // nothing the two exact-match allowlists don't already catch: a rebind/CSRF page
  // cannot get its Origin onto `origins`, and an off-list (rebind) Host is refused
  // on `hosts`. A userinfo-spoofed Origin (whose raw form isn't on-list) still
  // fails the exact-origin match, and its host cannot be forged past the isolation
  // above. DO NOT "restore" the equality check — it would re-break the renderer
  // without adding protection.
  const decision = isOriginAllowed(rawOrigin, hostToken, allowlist);
  if (isAllow(decision)) {
    return ok({ ok: true });
  }
  return rejected();
}

function rejected(): Result<{ ok: true }, FailureVariant> {
  return err(failure("validation_rejected", "origin not allowed"));
}
