// @sow/workflows — 7.2 runtime: clock-jump-safe last-run bookkeeping (LIFE-5).
//
// PURE + deterministic + workflow-safe: imports NOTHING from @temporalio, NOTHING
// from node:crypto, and calls NO Date.now()/Math.random(). The single time source
// is the INJECTED Clock (src/ports/operational.ts) — `now()` gives an ISO wall
// reading, the OPTIONAL `monotonicMs()` gives a jump-immune reading.
//
// WHY monotonic-preferred: a schedule decides "has the interval elapsed since the
// last run?" on wake. If it subtracts two WALL clocks, an NTP step or DST
// correction that moved the wall clock FORWARD would make it skip a due run, and a
// BACKWARD jump would make `now < lastRun` — a naive subtraction going negative,
// which could re-fire (double-fire) or starve. So elapsed time is measured on the
// MONOTONIC delta when both the stored bookkeeping AND the clock expose it, and
// the wall reading is used only for display / the first-run fallback. Elapsed is
// CLAMPED to ≥ 0 so no backward jump ever yields a negative that fools downstream.
import type { Clock, ScheduleBookkeeping } from "../ports/operational";

/** Which time source produced an elapsed measurement. */
export type ElapsedSource = "monotonic" | "wall";

/** A clock-jump-safe elapsed-time measurement. `elapsedMs` is always ≥ 0. */
export interface ElapsedMeasurement {
  readonly elapsedMs: number;
  readonly source: ElapsedSource;
}

/** Read the clock's monotonic source if it exposes one (optional port method). */
function readMonotonic(clock: Clock): number | undefined {
  return typeof clock.monotonicMs === "function"
    ? clock.monotonicMs()
    : undefined;
}

/** Parse an ISO timestamp to epoch-ms; NaN for an unparseable value. */
function epochMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Elapsed time since a schedule's last run, measured jump-safely.
 *
 * Uses the MONOTONIC delta when BOTH the bookkeeping carries `lastRunMonotonicMs`
 * AND the clock exposes `monotonicMs()` — immune to any wall-clock jump. Otherwise
 * falls back to the WALL delta (first run after a cold start, or a wall-only
 * clock). The result is CLAMPED to ≥ 0: a backward jump on either source yields 0
 * elapsed, never a negative value. Pure + total.
 */
export function computeElapsed(
  bookkeeping: ScheduleBookkeeping,
  clock: Clock,
): ElapsedMeasurement {
  const nowMono = readMonotonic(clock);
  const lastMono = bookkeeping.lastRunMonotonicMs;
  // The monotonic delta is comparable ONLY within a single process/boot epoch.
  // A monotonic clock RESETS on restart/reboot, so a durably-persisted reading
  // from a PRIOR epoch is garbage relative to a fresh one: subtracting them would
  // starve (negative delta → clamp 0 → never fires) or double-fire (a small fresh
  // reading minus a large stored one, or vice-versa). So use the monotonic path
  // only when BOTH readings exist AND the clock exposes an epoch AND that epoch
  // matches the epoch captured in the bookkeeping. Otherwise fall back to the
  // wall delta (clamped ≥ 0). (LIFE-5 cross-restart guard.)
  const nowEpoch =
    typeof clock.monotonicEpoch === "function" ? clock.monotonicEpoch() : undefined;
  const lastEpoch = bookkeeping.lastRunMonotonicEpoch;
  if (
    nowMono !== undefined &&
    lastMono !== undefined &&
    nowEpoch !== undefined &&
    nowEpoch === lastEpoch
  ) {
    const delta = nowMono - lastMono;
    return { elapsedMs: delta > 0 ? delta : 0, source: "monotonic" };
  }
  const delta = epochMs(clock.now()) - epochMs(bookkeeping.lastRunWall);
  return { elapsedMs: Number.isFinite(delta) && delta > 0 ? delta : 0, source: "wall" };
}

/**
 * The predicate the schedule logic uses: has at least `intervalMs` elapsed since
 * the last run, measured jump-safely? A FORWARD wall jump cannot skip a real
 * elapsed interval (monotonic is preferred); a BACKWARD jump cannot re-fire
 * (elapsed clamps to ≥ 0, staying below the interval). True exactly at the
 * boundary (elapsed ≥ interval). Pure + total.
 */
export function hasElapsed(
  bookkeeping: ScheduleBookkeeping,
  clock: Clock,
  intervalMs: number,
): boolean {
  if (!(intervalMs > 0)) return false;
  return computeElapsed(bookkeeping, clock).elapsedMs >= intervalMs;
}

/**
 * Build the next bookkeeping record for a run at the clock's CURRENT reading.
 * Captures both the wall reading and the monotonic reading (when the clock
 * exposes one); omits `lastRunMonotonicMs` entirely for a wall-only clock so the
 * record stays a clean exactOptionalPropertyType-safe shape. Deterministic — the
 * output depends only on the clock reading and the scheduleId.
 */
export function advanceBookkeeping(
  scheduleId: string,
  clock: Clock,
): ScheduleBookkeeping {
  const mono = readMonotonic(clock);
  const base: ScheduleBookkeeping = {
    scheduleId,
    lastRunWall: clock.now(),
  };
  if (mono === undefined) return base;
  // Capture the monotonic EPOCH alongside the reading so a future computeElapsed
  // can tell whether the stored reading is still comparable (same process/boot).
  // A wall-only clock records neither; a monotonic clock with an epoch records
  // both. (If a clock exposed monotonicMs but no monotonicEpoch, the epoch is
  // omitted and computeElapsed will never take the monotonic path — safe.)
  const epoch =
    typeof clock.monotonicEpoch === "function" ? clock.monotonicEpoch() : undefined;
  return epoch === undefined
    ? { ...base, lastRunMonotonicMs: mono }
    : { ...base, lastRunMonotonicMs: mono, lastRunMonotonicEpoch: epoch };
}
