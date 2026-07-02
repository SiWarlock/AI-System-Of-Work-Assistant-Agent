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
import { ok, err, type Result, type FailureVariant, failure } from "@sow/contracts";

/**
 * True iff `host` is a loopback host literal: `localhost`, `::1` (and its long
 * form), or an address in the IPv4 127.0.0.0/8 range. The EXACT four-octet match
 * on the 127-range rejects the suffix-spoof `127.0.0.1.attacker.com` (extra
 * labels ⇒ no match); `localhost` must be exact so `localhost.evil.com` fails.
 */
function isLoopbackAddr(host: string): boolean {
  if (host === "localhost") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const m = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m === null) return false;
  return m.slice(1).every((oct) => {
    const n = Number(oct);
    return n >= 0 && n <= 255;
  });
}

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
  if (!isLoopbackAddr(host)) return refused();
  return ok({ addr: host });
}

function refused(): Result<{ addr: string }, FailureVariant> {
  return err(failure("validation_rejected", "non-loopback bind refused"));
}
