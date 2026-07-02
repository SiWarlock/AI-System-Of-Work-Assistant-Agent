// 10.7 — persisted monotonic last-run bookkeeping service (LIFE-5).
//
// This is the WIRING layer over the LIFE-5 PURE logic that already exists in
// @sow/workflows/runtime/clock (advanceBookkeeping / computeElapsed / hasElapsed).
// It does NOT reinvent the clock-jump math — it binds the durable @sow/db
// `ScheduleBookkeepingRepository` + the injected `Clock` to that pure core so a
// missed-occurrence catch-up (LIFE-2, consumed by §9 schedules) stays correct
// across an NTP correction on wake (LIFE-5): the last-run readings PERSIST, survive
// restart, and are the single source schedules read. A BACKWARD NTP/wall jump can
// never double-fire (elapsed clamps ≥ 0) or skip (monotonic is preferred within a
// boot epoch; a prior-boot reading is ignored, falling back to the wall reading).
//
// Two exports:
//   • createScheduleStoreAdapter — adapts the @sow/db repo onto the @sow/workflows
//     `ScheduleStore` PORT (Promise-based, a miss = undefined). @sow/db must NOT
//     import @sow/workflows, so this worker-layer bridge is where the two meet
//     (mirrors the WriteReceiptRepository → ReceiptStore adapter pattern).
//   • createLastRunService — the bookkeeping SERVICE: getLastRun / recordRun /
//     hasElapsedSince, returning a typed Result over the @sow/db `DbError` set so a
//     genuine store fault surfaces (fail-closed) while a lookup MISS is ok(undefined).
//
// §16: never throws across the boundary — every method returns a typed Result and
// folds a store `DbError` into it. Clock-injected: no Date.now() here.

import { ok, err, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  DbError,
  ScheduleBookkeepingRecord,
  ScheduleBookkeepingRepository,
} from "@sow/db";
import type {
  Clock,
  ScheduleBookkeeping,
  ScheduleStore,
} from "@sow/workflows/ports/operational";
import {
  advanceBookkeeping,
  computeElapsed,
  hasElapsed,
  type ElapsedMeasurement,
} from "@sow/workflows/runtime/clock";

// ── (1) @sow/db repo → @sow/workflows ScheduleStore PORT adapter ──────────────

// The @sow/db `ScheduleBookkeepingRecord` and the @sow/workflows `ScheduleBookkeeping`
// port DTO are STRUCTURALLY identical (same field set, same optionality) — this is
// the documented worker-layer adaptation point. A miss is `not_found` in the repo,
// `undefined` in the port.

/**
 * Adapt the @sow/db {@link ScheduleBookkeepingRepository} onto the @sow/workflows
 * {@link ScheduleStore} port that the pure runtime/schedule logic consults. On a
 * `getBookkeeping` miss (`not_found`) OR any read fault, returns `undefined` (a
 * lookup miss is not an error at this seam; the fail-closed schedule logic treats
 * a missing bookkeeping as "first run"). `put` upserts; a write fault rejects so
 * a lost last-run write cannot be silently swallowed (a lost row re-fires/starves).
 */
export function createScheduleStoreAdapter(
  repo: ScheduleBookkeepingRepository,
): ScheduleStore {
  return {
    async getBookkeeping(scheduleId: string): Promise<ScheduleBookkeeping | undefined> {
      const r = await repo.getBookkeeping(scheduleId);
      if (isErr(r)) return undefined; // not_found (or any read fault) → miss
      return r.value;
    },
    async put(bookkeeping: ScheduleBookkeeping): Promise<void> {
      const r = await repo.put(bookkeeping);
      if (isErr(r)) {
        // The ScheduleStore port cannot express a typed failure; a lost last-run
        // write is safety-bearing (re-fire/starve), so surface it as a rejection
        // rather than silently succeed. Callers above this seam are fail-closed.
        throw new Error(`schedule bookkeeping put failed: ${r.error.message}`);
      }
    },
  };
}

// ── (2) the last-run bookkeeping SERVICE ──────────────────────────────────────

/**
 * A durable last-run bookkeeping read (LIFE-5). `undefined` = the schedule has
 * never run (no persisted bookkeeping) — treated as "first run" by the catch-up
 * logic, not an error.
 */
export interface LastRunService {
  /** The last persisted bookkeeping for a schedule, or `undefined` if never run. */
  getLastRun(
    scheduleId: string,
  ): Promise<Result<ScheduleBookkeeping | undefined, DbError>>;
  /**
   * Persist a run at the clock's CURRENT reading (wall + monotonic + epoch via the
   * pure `advanceBookkeeping`). Idempotent-shaped upsert keyed on `scheduleId`.
   */
  recordRun(scheduleId: string): Promise<Result<ScheduleBookkeeping, DbError>>;
  /**
   * Clock-jump-safe elapsed measurement since the last run. A never-run schedule
   * yields 0 elapsed (`{ elapsedMs: 0 }`) — nothing has elapsed "since last run".
   */
  computeElapsedSince(
    scheduleId: string,
  ): Promise<Result<ElapsedMeasurement, DbError>>;
  /**
   * Has at least `intervalMs` of REAL time elapsed since the last run (LIFE-5)?
   * Measured monotonic-first within a boot epoch (immune to wall-clock jumps); a
   * backward jump clamps elapsed to ≥ 0 so it never re-fires. A never-run schedule
   * is `false` (there is no prior run to measure from).
   */
  hasElapsedSince(
    scheduleId: string,
    intervalMs: number,
  ): Promise<Result<boolean, DbError>>;
}

/**
 * Build the last-run bookkeeping service over a durable @sow/db
 * {@link ScheduleBookkeepingRepository} + an injected {@link Clock}. Reuses the
 * pure @sow/workflows clock logic for every time decision; the store is the single
 * durable source schedules read. Never throws across the boundary (§16).
 */
export function createLastRunService(
  repo: ScheduleBookkeepingRepository,
  clock: Clock,
): LastRunService {
  /** Read the persisted bookkeeping; `not_found` → ok(undefined), fault → err. */
  async function read(
    scheduleId: string,
  ): Promise<Result<ScheduleBookkeeping | undefined, DbError>> {
    const r = await repo.getBookkeeping(scheduleId);
    if (isErr(r)) {
      // A genuine MISS is not an error — fold it to ok(undefined). Any OTHER
      // DbError (unavailable, unknown, …) is a real fault and surfaces typed.
      if (r.error.code === "not_found") return ok(undefined);
      return err(r.error);
    }
    return ok(r.value);
  }

  return {
    getLastRun(scheduleId: string) {
      return read(scheduleId);
    },

    async recordRun(scheduleId: string) {
      // Build the next record from the clock's CURRENT reading (pure) …
      const next: ScheduleBookkeeping = advanceBookkeeping(scheduleId, clock);
      // … and persist it. The port DTO is structurally the @sow/db row.
      const w = await repo.put(next as ScheduleBookkeepingRecord);
      if (isErr(w)) return err(w.error);
      return ok(next);
    },

    async computeElapsedSince(scheduleId: string) {
      const r = await read(scheduleId);
      if (isErr(r)) return err(r.error);
      // No prior run → nothing has elapsed "since last run": 0 on the wall source.
      if (r.value === undefined) {
        return ok<ElapsedMeasurement>({ elapsedMs: 0, source: "wall" });
      }
      return ok(computeElapsed(r.value, clock));
    },

    async hasElapsedSince(scheduleId: string, intervalMs: number) {
      const r = await read(scheduleId);
      if (isErr(r)) return err(r.error);
      // No prior run → not "elapsed since last run" (there is no last run).
      if (r.value === undefined) return ok(false);
      return ok(hasElapsed(r.value, clock, intervalMs));
    },
  };
}
