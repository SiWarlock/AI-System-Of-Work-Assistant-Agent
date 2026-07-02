// @sow/workflows — task 7.9: the deferred-approval SNOOZE TIMER (PURE).
//
// This is the clock-injected, LIFE-5-safe decision logic for the NON-TERMINAL
// `deferred` approval state: given a deferred Approval (its `snoozeUntil`
// re-surface instant + `expiresAt` auto-expiry instant) and the injected Clock,
// decide whether the deferred item should
//   • re-surface to `pending` (the snooze window elapsed), or
//   • auto-expire to `expired` (the expiry window elapsed — an expired approval
//     can NEVER later be approved), or
//   • keep sleeping (neither window elapsed yet).
//
// ★ PURITY (root CLAUDE.md): this module imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). Time arrives ONLY through the
// injected {@link Clock}. It is therefore Vitest-unit-testable with a FakeClock and
// safe to call from the pure driver.
//
// ★ LIFE-5 (root CLAUDE.md safety-rule spirit / operational.ts Clock doc): the
// deferred windows are compared against a DURABLE WALL-CLOCK instant
// (`snoozeUntil`/`expiresAt` are ISO strings persisted on the Approval record),
// NOT a monotonic delta — a monotonic reading is only comparable WITHIN one
// process epoch, and a deferred approval sleeps ACROSS process restarts (up to 7d
// by default). Comparing a persisted monotonic reading from a prior boot to a
// fresh one is the LIFE-5 cross-restart starve/double-fire trap. The durable ISO
// instant is epoch-independent, so the wall comparison is the correct + safe basis
// for a long-lived deferred timer. Expiry is checked BEFORE re-surface so a
// deferred item whose BOTH windows elapsed expires (fail-closed) rather than
// re-surfacing into a stale pending card.
//
// §16 error convention: total function — never throws; a malformed/absent instant
// is handled by falling back to the configured default window relative to a
// REFERENCE instant the caller supplies (the deferral instant), so a record with
// no explicit window still has a well-defined lifecycle.
import type { Approval } from "@sow/contracts";
import { APPROVAL_DEFAULTS } from "@sow/domain";
import type { Clock } from "../ports/operational";

/**
 * The configurable deferred-lifecycle windows (LIFE-5). Defaults come straight
 * from the domain `APPROVAL_DEFAULTS` (snooze 24h, expiry 7d) — the timer never
 * invents its own numbers. A caller may narrow them per-approval.
 */
export interface SnoozeConfig {
  readonly snoozeMs: number;
  readonly expiryMs: number;
}

/** The default deferred windows, sourced from the domain (snooze 24h, expiry 7d). */
export const DEFAULT_SNOOZE_CONFIG: SnoozeConfig = {
  snoozeMs: APPROVAL_DEFAULTS.snoozeMs,
  expiryMs: APPROVAL_DEFAULTS.expiryMs,
};

/**
 * The decision the timer reaches for a deferred approval:
 *   • `resurface` — the snooze window elapsed (deferred → pending): show the card again.
 *   • `expire`    — the expiry window elapsed (deferred → expired): fail-closed, gone.
 *   • `sleep`     — neither window elapsed: the deferred item stays parked.
 */
export type SnoozeDecision = "resurface" | "expire" | "sleep";

/**
 * Compute the absolute deferred windows for an approval. `deferredAt` is the
 * REFERENCE instant the deferral happened at (the caller supplies the durable
 * deferral wall-clock reading). `snoozeUntil`/`expiresAt` on the record take
 * precedence when present + parseable; otherwise the windows are derived as
 * `deferredAt + snoozeMs` / `deferredAt + expiryMs` (LIFE-5: a durable ISO basis,
 * never a monotonic one). Returns epoch-millis instants.
 */
export interface DeferredWindows {
  readonly snoozeUntilMs: number;
  readonly expiresAtMs: number;
}

/** Parse an ISO instant to epoch-millis; `undefined` when absent or unparseable. */
function parseIsoMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Resolve the deferred windows for an approval, from its explicit
 * `snoozeUntil`/`expiresAt` when present, else derived from `deferredAt` + the
 * config windows. PURE (Date.parse on a fixed ISO string is deterministic and
 * clock-free — it reads NO current time). Never throws.
 */
export function resolveDeferredWindows(
  approval: Pick<Approval, "snoozeUntil" | "expiresAt">,
  deferredAt: string,
  config: SnoozeConfig = DEFAULT_SNOOZE_CONFIG,
): DeferredWindows {
  const baseMs = parseIsoMs(deferredAt) ?? 0;
  const snoozeUntilMs =
    parseIsoMs(approval.snoozeUntil) ?? baseMs + config.snoozeMs;
  const expiresAtMs = parseIsoMs(approval.expiresAt) ?? baseMs + config.expiryMs;
  return { snoozeUntilMs, expiresAtMs };
}

/**
 * Decide what to do with a DEFERRED approval at the current (injected) wall-clock
 * instant. LIFE-5-safe: the comparison basis is the durable ISO wall instant, not
 * a monotonic delta (a deferred item can sleep across process restarts, where a
 * monotonic reading resets — see the module header). EXPIRY is checked FIRST so a
 * deferred item whose expiry window ALSO elapsed expires (fail-closed) rather than
 * re-surfacing into a stale card — an expired approval can never later be approved.
 *
 * @param approval   the deferred approval (its snoozeUntil/expiresAt, when set).
 * @param deferredAt the durable wall-clock instant the deferral happened at (the
 *                   window reference when the record carries no explicit windows).
 * @param clock      the injected time source (never Date.now()).
 * @param config     the deferred windows (defaults to the domain 24h/7d).
 */
export function evaluateDeferred(
  approval: Pick<Approval, "snoozeUntil" | "expiresAt">,
  deferredAt: string,
  clock: Clock,
  config: SnoozeConfig = DEFAULT_SNOOZE_CONFIG,
): SnoozeDecision {
  const nowMs = parseIsoMs(clock.now());
  // Defensive: an unreadable clock reading cannot justify a re-surface or expiry
  // (both are durable side effects) — keep sleeping (fail-safe, never fail-open).
  if (nowMs === undefined) return "sleep";

  const { snoozeUntilMs, expiresAtMs } = resolveDeferredWindows(
    approval,
    deferredAt,
    config,
  );

  // EXPIRY WINS (fail-closed): once the expiry instant is reached the approval is
  // gone — never re-surface it into a stale pending card. `expired` is terminal;
  // an expired approval can NEVER later be approved (enforced downstream by the
  // approvalMachine's empty `expired` edge list + the apply port's `expired` code).
  if (nowMs >= expiresAtMs) return "expire";

  // Snooze window elapsed (but not yet expired): re-surface to pending.
  if (nowMs >= snoozeUntilMs) return "resurface";

  // Still within the snooze window: stay parked.
  return "sleep";
}

/**
 * Convenience predicate: has the deferred approval's EXPIRY window elapsed at the
 * injected clock's current instant? Used by the driver to fail-close an
 * approve-after-expiry attempt (an expired approval can never later be approved).
 */
export function isExpired(
  approval: Pick<Approval, "expiresAt">,
  deferredAt: string,
  clock: Clock,
  config: SnoozeConfig = DEFAULT_SNOOZE_CONFIG,
): boolean {
  const nowMs = parseIsoMs(clock.now());
  if (nowMs === undefined) return false;
  const expiresAtMs =
    parseIsoMs(approval.expiresAt) ?? (parseIsoMs(deferredAt) ?? 0) + config.expiryMs;
  return nowMs >= expiresAtMs;
}
