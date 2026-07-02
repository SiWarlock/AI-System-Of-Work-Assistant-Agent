// @sow/workflows — 7.2 runtime: collapsed catch-up (LIFE-2).
//
// PURE + deterministic + workflow-safe: imports NOTHING from @temporalio, NOTHING
// from node:crypto, and reads NO clock (all time arrives as inputs). It answers a
// single question a durable schedule asks on wake: "the worker was asleep/down
// across possibly-many recurrences — what do I run NOW, and what do I record as
// missed?"
//
// LIFE-2 contract:
//   • Multiple missed occurrences COLLAPSE to a SINGLE next run within the
//     catch-up window — never once-per-missed-occurrence (a thundering herd on
//     wake). The single run is scheduled at `now` (the collapse point).
//   • Occurrences OLDER than the catch-up window (before `now − catchUpWindowMs`)
//     are DROPPED as 'missed' and RECORDED — surfaced later as the
//     'missed_or_late_schedule' health class — NOT silently replayed.
//   • TOTAL: no throw, no divide-by-zero, and BOUNDED work even for a year-long
//     gap at a 1-second cadence (≈31M ticks). The dropped-as-stale set is
//     summarized by an exact `droppedCount` and an enumerated-but-CAPPED `missed`
//     list (`MAX_MISSED_RECORDED`) so the return value never balloons.
//
// Boundary rule: an occurrence EXACTLY at the window edge (`now − window`) is
// INSIDE the window (catchable), matching "≥ interval elapsed" in clock.ts.

import type { Clock, ScheduleBookkeeping } from "../ports/operational";
import { computeElapsed } from "./clock";

/** Cap on the number of stale occurrences ENUMERATED into `missed` (droppedCount stays exact). */
export const MAX_MISSED_RECORDED = 100;

/** Inputs to a catch-up decision — all time as ISO strings + ms deltas (no clock read). */
export interface CatchUpInput {
  /** ISO timestamp of the schedule's last successful run. */
  readonly lastRun: string;
  /** ISO timestamp of "now" (the wake point) — supplied by the caller's injected clock. */
  readonly now: string;
  /** Recurrence cadence in ms. A non-positive value is inert (no run, no missed). */
  readonly intervalMs: number;
  /** How far back a missed occurrence is still catchable, in ms. Non-positive ⇒ nothing catchable. */
  readonly catchUpWindowMs: number;
  /** Reserved: when true the caller measured the gap on a monotonic source (does not change the math here). */
  readonly monotonic?: boolean;
  /**
   * A jump-safe elapsed-ms measurement (from clock.ts `computeElapsed`) to drive
   * the decision math INSTEAD of the naive wall subtraction (`now − lastRun`).
   * When provided, `dueCount` and the window/dropped math are derived from THIS
   * elapsed value — so a forward wall/NTP jump cannot inflate `dueCount` into a
   * spurious catch-up run (LIFE-5). The `nextRun` collapse point stays `now`; the
   * missed-occurrence display timestamps may still be wall-derived. Absent ⇒ the
   * naive wall subtraction is used (the no-override fallback).
   */
  readonly elapsedMsOverride?: number;
}

/** The catch-up verdict. */
export interface CatchUpResult {
  /** The single collapsed next run (ISO), or null when nothing is catchable. */
  readonly nextRun: string | null;
  /** True IFF MORE THAN ONE due occurrence was collapsed into the single run. */
  readonly collapsed: boolean;
  /** Stale occurrences (older than the window), enumerated newest-first but CAPPED at MAX_MISSED_RECORDED. */
  readonly missed: readonly string[];
  /** EXACT count of stale (dropped) occurrences — the summary behind the capped `missed` list. */
  readonly droppedCount: number;
}

const INERT: CatchUpResult = {
  nextRun: null,
  collapsed: false,
  missed: [],
  droppedCount: 0,
};

/** Parse an ISO timestamp to epoch-ms; NaN if unparseable. */
function epochMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Decide the single collapsed next run + the recorded-missed set for a durable
 * schedule waking after a gap. See the module header for the full LIFE-2
 * contract. Pure + total + bounded.
 */
export function collapsedNextRun(input: CatchUpInput): CatchUpResult {
  const { lastRun, now, intervalMs, catchUpWindowMs, elapsedMsOverride } = input;

  // --- totality guards ---
  if (!(intervalMs > 0)) return INERT; // zero/negative/NaN cadence: inert
  if (!(catchUpWindowMs > 0)) return INERT; // non-positive window: nothing catchable
  const lastMs = epochMs(lastRun);
  const wallNowMs = epochMs(now);
  if (!Number.isFinite(lastMs) || !Number.isFinite(wallNowMs)) return INERT;

  // The elapsed span the decision math runs on. With a jump-safe override we use
  // an EFFECTIVE now = lastRun + elapsed (so a forward wall jump cannot inflate
  // dueCount); without one we fall back to the naive wall span. The window edge +
  // the missed-occurrence display timestamps are derived from lastMs + k*interval,
  // so they stay stable regardless of which span produced dueCount.
  const effectiveNowMs =
    elapsedMsOverride !== undefined && Number.isFinite(elapsedMsOverride)
      ? lastMs + (elapsedMsOverride > 0 ? elapsedMsOverride : 0)
      : wallNowMs;
  const nowMs = effectiveNowMs;
  if (nowMs <= lastMs) return INERT; // now before/at lastRun (backward clock): nothing due

  // Number of due occurrences: the k where lastRun + k*interval ≤ now, k ≥ 1.
  // (Integer division — bounded, no per-tick loop.)
  const dueCount = Math.floor((nowMs - lastMs) / intervalMs);
  if (dueCount <= 0) return INERT; // not even one interval elapsed yet

  // The window edge: occurrences at or after this are INSIDE (catchable).
  const windowMs = catchUpWindowMs > 0 ? catchUpWindowMs : 0;
  const edgeMs = nowMs - windowMs;

  // The k-th due occurrence time is lastMs + k*interval, for k = 1..dueCount.
  // "Inside the window" ⇔ occurrenceMs ≥ edgeMs. Solve for the smallest k inside:
  //   lastMs + k*interval ≥ edgeMs  ⇒  k ≥ (edgeMs − lastMs)/interval.
  const firstInsideK = Math.max(1, Math.ceil((edgeMs - lastMs) / intervalMs));
  // Occurrences inside the window are k in [firstInsideK, dueCount].
  const insideCount = Math.max(0, dueCount - firstInsideK + 1);
  // Stale (dropped) occurrences are k in [1, firstInsideK − 1].
  const droppedCount = firstInsideK - 1;

  // Enumerate the stale set newest-first, CAPPED — droppedCount stays exact above.
  const missed: string[] = [];
  const cap = Math.min(droppedCount, MAX_MISSED_RECORDED);
  // Newest stale occurrence is k = firstInsideK − 1, going down to k = firstInsideK − cap.
  for (let i = 0; i < cap; i++) {
    const k = droppedCount - i; // firstInsideK-1, firstInsideK-2, …
    missed.push(new Date(lastMs + k * intervalMs).toISOString());
  }
  // Record oldest-first for a stable, human-readable chronology.
  missed.reverse();

  if (insideCount <= 0) {
    // Everything catchable is stale — do NOT fire; just record the misses.
    return { nextRun: null, collapsed: false, missed, droppedCount };
  }

  // One collapsed run at `now`; `collapsed` iff more than one occurrence folded in.
  return {
    nextRun: now,
    collapsed: insideCount > 1,
    missed,
    droppedCount,
  };
}

/**
 * The LIFE-5-correct integrated catch-up entry callers use. It measures the
 * elapsed gap with the JUMP-SAFE `computeElapsed` (which prefers the monotonic
 * delta within a single boot epoch and falls back to the clamped wall delta
 * across a restart) and feeds that as `elapsedMsOverride` into `collapsedNextRun`
 * — so a forward wall/NTP jump cannot inflate `dueCount` into a spurious
 * (phantom-collapsed) run. `now` is the clock's current wall reading (the collapse
 * point) and `lastRun` is the bookkeeping's wall reading (for the missed-display
 * timestamps). Pure + total.
 */
export function collapsedNextRunFromClock(
  bookkeeping: ScheduleBookkeeping,
  clock: Clock,
  opts: { intervalMs: number; catchUpWindowMs: number },
): CatchUpResult {
  const elapsed = computeElapsed(bookkeeping, clock);
  return collapsedNextRun({
    lastRun: bookkeeping.lastRunWall,
    now: clock.now(),
    intervalMs: opts.intervalMs,
    catchUpWindowMs: opts.catchUpWindowMs,
    elapsedMsOverride: elapsed.elapsedMs,
  });
}
