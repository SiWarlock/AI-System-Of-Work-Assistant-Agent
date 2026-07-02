// 7.1 — the PURE single-active-instance lease DECISION (LIFE-1).
//
// This module is the deterministic core of the single-active-instance lease: it
// decides whether THIS worker instance may process on a task queue, given the
// currently-stored lease and an INJECTED wall-clock reading. It imports NEITHER
// @temporalio NOR node:crypto, and calls NO Date.now()/Math.random() — the
// "now" is passed in — so it is Vitest-unit-testable with no Temporal server and
// safe to reason about deterministically.
//
// The decision performs the lease WRITE through the injected InstanceLeaseStore
// (an atomic compareAndSet), but takes no other I/O. Per §16 it NEVER throws
// across the boundary: it returns a typed Result whose failure set is closed and
// enumerable, and every failure carries the fail-CLOSED action ('passive') so a
// caller can never be told to process on an error.

import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  InstanceLeaseStore,
  LeaseRecord,
} from "@sow/workflows/ports/operational";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";

/** The three lease actions (LIFE-1). */
export type LeaseAction = "acquire" | "passive" | "reacquire";

/**
 * A successful lease decision. `action` tells the caller whether it may process:
 *   • 'acquire'   — no live lease existed; we wrote our record and hold it.
 *   • 'reacquire' — the live lease was already ours; we renewed it.
 *   • 'passive'   — another instance holds a live lease; we must NOT process.
 * `next` carries the record we wrote for 'acquire' / 'reacquire'; it is absent
 * for 'passive' (we wrote nothing — no split-brain).
 */
export interface LeaseDecision {
  readonly action: LeaseAction;
  readonly next?: LeaseRecord;
}

/**
 * The closed, enumerable failure set (§16). Every failure carries the
 * fail-closed `action: 'passive'` so a caller that ignores the code still never
 * processes on an error.
 *   • 'lost_race'   — compareAndSet returned false: another instance won the
 *                     acquire/renew race. Not an error condition per se, but a
 *                     non-acquire outcome the caller must treat as passive.
 *   • 'store_fault' — the InstanceLeaseStore rejected/threw. Fail closed.
 */
export type LeaseDecisionErrorCode = "lost_race" | "store_fault";

export interface LeaseDecisionError {
  readonly code: LeaseDecisionErrorCode;
  /** Always 'passive' — fail-closed: an error never authorizes processing. */
  readonly action: "passive";
  readonly message: string;
}

/** The pure inputs to a lease decision (LIFE-1). */
export interface LeaseDecisionInput {
  readonly taskQueue: SowTaskQueue;
  /** This worker instance's stable owner id. */
  readonly ownerId: string;
  /** The injected wall-clock reading (ISO-8601) — NEVER Date.now(). */
  readonly now: string;
  /** Lease time-to-live in milliseconds; the new expiry = now + ttl. */
  readonly leaseTtlMs: number;
  /**
   * The currently-stored lease as last read by the caller (or undefined for
   * "no lease"). It is the `expected` value for the atomic compareAndSet, so a
   * concurrent writer that changed the store since the read loses the CAS.
   */
  readonly current: LeaseRecord | undefined;
}

/** True IFF `record`'s expiry is at or before the injected `now`. */
function isExpired(record: LeaseRecord, now: string): boolean {
  // Compare parsed epoch millis; both are ISO strings. `<=` treats an
  // exactly-at-expiry lease as reclaimable (the fence is exclusive of holding).
  return Date.parse(record.expiresAt) <= Date.parse(now);
}

/**
 * The pure FENCING guard (LIFE-1). Returns `true` IFF `operationGeneration` is
 * strictly below `latestGeneration` — i.e. the operation was issued under a lease
 * generation older than the latest committed one, so its target MUST reject it.
 *
 * Every fenced side effect carries the `generation` it was ISSUED under (the
 * generation of the lease held at the time the operation was decided). Its target
 * rejects an operation whose generation is below the latest committed lease
 * generation. This closes the Mac-sleep split-brain window that TTL expiry alone
 * cannot: a prior holder paused mid-operation wakes after its lease TTL expired
 * and a NEW holder acquired (bumping the generation). The paused holder still
 * carries its OLD generation, so `isFencedStale(old, new) === true` and every one
 * of its in-flight effects is fenced out — even inside the TTL-expiry window,
 * where the CAS only stops it from RENEWING, not from ACTING.
 *
 * (The cross-operation enforcement wiring — threading the issued generation onto
 * each side effect and checking it at the target — is Phase 10; the token + this
 * guard land now.)
 */
export function isFencedStale(
  operationGeneration: number,
  latestGeneration: number,
): boolean {
  return operationGeneration < latestGeneration;
}

/**
 * Decide the lease for THIS instance (LIFE-1). Pure + clock-injected; performs
 * only the atomic compareAndSet write through `store`. Returns a typed Result;
 * never throws (§16). Fail-closed: any store fault or lost CAS resolves to a
 * 'passive' outcome — never a risky 'acquire'.
 *
 * Rules:
 *   • no current lease OR current expired → 'acquire' (CAS-write our record).
 *   • a current, UNEXPIRED lease owned by ANOTHER instance → 'passive'
 *     (do NOT process — no split-brain; no write).
 *   • our own current lease → 'reacquire' (renew via CAS).
 */
export async function decideLease(
  input: LeaseDecisionInput,
  store: InstanceLeaseStore,
): Promise<Result<LeaseDecision, LeaseDecisionError>> {
  const { taskQueue, ownerId, now, leaseTtlMs, current } = input;

  // Another instance holds a LIVE lease → stand down. No write; no split-brain.
  if (
    current !== undefined &&
    current.ownerId !== ownerId &&
    !isExpired(current, now)
  ) {
    return ok({ action: "passive" });
  }

  const ownsLive =
    current !== undefined &&
    current.ownerId === ownerId &&
    !isExpired(current, now);
  const action: LeaseAction = ownsLive ? "reacquire" : "acquire";

  const next: LeaseRecord = {
    taskQueue,
    ownerId,
    // Preserve the original acquire time on renewal; stamp fresh on acquire.
    acquiredAt: ownsLive && current ? current.acquiredAt : now,
    expiresAt: new Date(Date.parse(now) + leaseTtlMs).toISOString(),
    // Fencing token (LIFE-1): a fresh acquire (new holder — no live lease, an
    // expired lease, or another owner's expired lease) BUMPS the generation off
    // whatever was last committed; a reacquire (renew OUR OWN live lease)
    // PRESERVES it. So a paused prior holder always carries a generation below
    // the new holder's and is fenced out via isFencedStale.
    generation: ownsLive && current
      ? current.generation
      : (current?.generation ?? 0) + 1,
  };

  let won: boolean;
  try {
    won = await store.compareAndSet(current, next);
  } catch (cause) {
    // Fail closed: a store fault NEVER authorizes processing.
    return err({
      code: "store_fault",
      action: "passive",
      message: `lease store fault: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    });
  }

  if (!won) {
    // Another instance won the acquire/renew race between our read and our CAS.
    return err({
      code: "lost_race",
      action: "passive",
      message: `lost lease compareAndSet race on ${taskQueue}`,
    });
  }

  return ok({ action, next });
}
