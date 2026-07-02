// 10.4 — worker-side single-instance lease RE-ACQUIRE on (re)start (LIFE-1).
//
// This is the WIRING layer over the LIFE-1 PURE lease DECISION that already exists
// in ../lease/instanceLease (decideLease). It binds the durable @sow/db
// InstanceLeaseRepository to the @sow/workflows InstanceLeaseStore PORT that the
// pure decision consults, so that on (re)start the worker re-acquires the single-
// active-instance lease against the REAL operational store.
//
// THE LOAD-BEARING GUARANTEE (single owner): if a LIVE instance already holds a
// valid (unexpired, higher-or-equal generation) lease, the re-acquiring worker does
// NOT double-run — decideLease returns the 'passive' action, so there are never two
// owners of the operational store / GBrain files (no split-brain). A store fault
// fails CLOSED to passive (never a risky acquire). Never throws across the boundary
// (§16): every method returns a typed Result / a fail-closed verdict.
//
// The repo→port adapter mirrors the last-run.ts ScheduleBookkeeping adapter (a
// @sow/db repo cannot import @sow/workflows, so this worker-layer bridge is where
// the two meet). @sow/db is Promise<Result<T, DbError>>; the InstanceLeaseStore port
// is Promise<T | undefined> for get and Promise<boolean> for compareAndSet — a read
// miss / any read fault → undefined (fail-closed "no lease"), a CAS fault → false
// (fail-closed "lost race" → the pure decision routes it to passive).

import { ok, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { InstanceLeaseRepository, LeaseRecordRow } from "@sow/db";
import type {
  InstanceLeaseStore,
  LeaseRecord,
} from "@sow/workflows/ports/operational";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";
import {
  decideLease,
  type LeaseDecision,
  type LeaseDecisionError,
} from "../lease/instanceLease";

// ── (1) @sow/db repo → @sow/workflows InstanceLeaseStore PORT adapter ──────────

// The @sow/db `LeaseRecordRow` and the @sow/workflows `LeaseRecord` port DTO are
// STRUCTURALLY identical (same field set: taskQueue/ownerId/acquiredAt/expiresAt/
// generation) — this is the documented worker-layer adaptation point.

/**
 * Adapt the @sow/db {@link InstanceLeaseRepository} onto the @sow/workflows
 * {@link InstanceLeaseStore} port that the pure {@link decideLease} consults.
 *
 * • `get`: a `not_found` miss OR any read fault → `undefined` (a missing lease is
 *   "no lease" here; the fail-closed decision treats it as an acquire candidate).
 * • `compareAndSet`: forwards the CAS verdict; a store FAULT is folded to `false`
 *   (fail-closed "lost race"). The port cannot express a typed failure, and a CAS
 *   fault must NEVER be read as a win — so it resolves to a lost race, which the
 *   pure decision routes to the safe 'passive' outcome (no double-run on a fault).
 */
export function createLeaseStoreAdapter(
  repo: InstanceLeaseRepository,
): InstanceLeaseStore {
  return {
    async get(taskQueue: string): Promise<LeaseRecord | undefined> {
      const r = await repo.get(taskQueue);
      if (isErr(r)) return undefined; // not_found (or any read fault) → "no lease"
      return r.value;
    },
    async compareAndSet(
      expected: LeaseRecord | undefined,
      next: LeaseRecord,
    ): Promise<boolean> {
      const r = await repo.compareAndSet(
        expected as LeaseRecordRow | undefined,
        next as LeaseRecordRow,
      );
      // A store fault fails CLOSED to `false`: a fault is never a win, and the pure
      // decision maps a `false` CAS to 'lost_race' → passive (no risky acquire).
      if (isErr(r)) return false;
      return r.value;
    },
  };
}

// ── (2) the lease RE-ACQUIRE service ──────────────────────────────────────────

/** Inputs to a re-acquire (clock injected via `now`; no Date.now()). */
export interface ReacquireInput {
  readonly taskQueue: SowTaskQueue;
  /** This worker instance's stable owner id. */
  readonly ownerId: string;
  /** The injected wall-clock reading (ISO-8601) — NEVER Date.now(). */
  readonly now: string;
  /** Lease time-to-live in milliseconds; the new expiry = now + ttl. */
  readonly leaseTtlMs: number;
}

/**
 * The outcome of a re-acquire. `mayProcess` is the single boolean the supervisor
 * gates on: it is TRUE only for an 'acquire' / 'reacquire' (this worker holds the
 * lease) and FALSE for 'passive' (another live owner holds it, or a fault degraded
 * us) — so a `mayProcess: false` worker never touches the operational store.
 * `next` is the lease record we wrote (absent for passive — we wrote nothing).
 */
export interface ReacquireOutcome {
  readonly action: LeaseDecision["action"];
  readonly mayProcess: boolean;
  readonly next?: LeaseRecord;
}

/**
 * Re-acquire the single-active-instance lease on (re)start. Reads the currently-
 * stored lease through the @sow/db repo, then drives the PURE {@link decideLease}
 * over the adapter. Returns a typed Result whose `mayProcess` gate refuses a second
 * owner while a valid lease is held (LIFE-1 single owner). Never throws (§16).
 *
 * Fail-closed: a store fault surfaces as `ok({ action: 'passive', mayProcess: false })`
 * — the worker stands down rather than risk a double-run. (decideLease already folds
 * a CAS fault to a typed err; we normalize BOTH the read-miss-as-acquire path and the
 * fault-as-passive path to a single `ReacquireOutcome` the supervisor reads.)
 */
export async function reacquireLease(
  input: ReacquireInput,
  repo: InstanceLeaseRepository,
): Promise<Result<ReacquireOutcome, LeaseDecisionError>> {
  const store = createLeaseStoreAdapter(repo);

  // Read the current lease (miss/fault → undefined = "no lease"). This is the
  // `expected` the pure decision hands to the atomic compareAndSet, so a concurrent
  // writer that changed the store since this read loses the CAS (→ passive).
  const current = await store.get(input.taskQueue);

  const decision = await decideLease(
    {
      taskQueue: input.taskQueue,
      ownerId: input.ownerId,
      now: input.now,
      leaseTtlMs: input.leaseTtlMs,
      current,
    },
    store,
  );

  if (isErr(decision)) {
    // A lost race / store fault is fail-closed: the decision's `action` is always
    // 'passive'. Surface it as a NON-error outcome the supervisor gates on — the
    // worker stands down (mayProcess:false), never a throw, never a double-run.
    return ok({ action: decision.error.action, mayProcess: false });
  }

  const { action, next } = decision.value;
  const mayProcess = action !== "passive";
  return ok(
    next === undefined ? { action, mayProcess } : { action, mayProcess, next },
  );
}
