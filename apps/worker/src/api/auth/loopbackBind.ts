// Task 8.1 (c) — loopback-only bind assertion (REQ-NF-004).
//
// The worker API MUST bind only to a loopback interface — never `0.0.0.0`
// (all interfaces, remotely reachable) or any LAN / public address. Binding
// non-loopback would expose the local control plane to the network, defeating
// the whole "local-first, self-hosted" posture (and the Origin/token gate is a
// SECOND line — the bind is the FIRST). This predicate refuses any address that
// is not provably loopback.
//
// §16: never throws — returns a typed Result. FAIL-CLOSED: a missing / empty /
// unparseable / suffix-spoofed address ⇒ refuse. The check is on the raw BIND
// address (host, no URL), so we validate it as a host literal directly.
//
// converge-url-authority: the loopback-host predicate is the SINGLE vetted copy
// exported by @sow/policy (isLoopbackHost) — NOT a worker-local re-implementation
// (root CLAUDE.md Lesson 4: two copies of a security predicate can drift). The
// bind address is a bare host literal, so we normalize (trim + lowercase) and
// hand it straight to the shared predicate.
import { ok, err, type Result, type FailureVariant, failure } from "@sow/contracts";
import { isLoopbackHost } from "@sow/policy";

/**
 * Assert that `addr` is a loopback bind address. Refuses `0.0.0.0` / `::`
 * (all-interfaces), any LAN / public IP, a hostname, and the loopback-suffix
 * spoof. Returns `ok({ addr })` on a loopback address, else
 * `err(failure("validation_rejected", "non-loopback bind refused"))`.
 *
 * FAIL-CLOSED: `addr` is `string | undefined`; a missing / empty address ⇒ refuse.
 * §16: never throws.
 */
export function assertLoopbackBind(
  addr: string | undefined,
): Result<{ addr: string }, FailureVariant> {
  if (typeof addr !== "string") return refused();
  const host = addr.trim().toLowerCase();
  if (host.length === 0) return refused();
  if (!isLoopbackHost(host)) return refused();
  return ok({ addr: host });
}

function refused(): Result<{ addr: string }, FailureVariant> {
  return err(failure("validation_rejected", "non-loopback bind refused"));
}
