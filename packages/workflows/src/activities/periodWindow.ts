// @sow/workflows — task 7.11 ACTIVITY: compute the CLOCK-JUMP-SAFE review window.
//
// This is the seam that makes the period review PERIOD-WINDOWED and distinct from
// the daily brief (BRF-1): the weekly/monthly review reasons over a bounded
// [windowStart, windowEnd] span — the period's meetings/decisions/commitments,
// the project-progress deltas, and the recurring-blocker detection all scope to
// this window. Getting the window wrong (a naive wall subtraction) would either
// balloon the window across a forward NTP/DST jump (re-reviewing months of data in
// one "weekly" run) or invert it across a backward jump — so the window MUST be
// derived from the CLOCK-JUMP-SAFE elapsed bookkeeping (the 7.2 `computeElapsed`
// helper, monotonic-preferred + clamped ≥ 0), NEVER `now - lastRun` on two wall
// clocks (LIFE-5).
//
// PURE + deterministic + workflow-safe: imports NOTHING from @temporalio, NOTHING
// from node:crypto, and calls NO Date.now()/Math.random(). The single time source
// is the INJECTED Clock. Although it lives under src/activities (a sibling of the
// 7.6 buildOutputs / 7.10 buildGclProjection activities), it needs NO node:crypto —
// it is pure window arithmetic — so the driver could call it directly OR through an
// activity port; the tests exercise it directly.
//
// §16: total + never throws — an unparseable / degenerate input yields a
// zero-width window ending at the clock reading (fail-closed to "review nothing new"
// rather than crash or invert).
import type { Clock, ScheduleBookkeeping } from "../ports/operational";
import { computeElapsed } from "../runtime/clock";

/** The review cadence. Drives the window label + (with the interval) its span. */
export type ReviewPeriod = "weekly" | "monthly";

/**
 * The computed, clock-jump-safe review window. `windowEnd` is the collapse point
 * (the clock's current wall reading — the moment the review is being produced).
 * `windowStart` is `windowEnd − elapsed` where elapsed is the JUMP-SAFE measurement
 * (monotonic-preferred, clamped ≥ 0). `period` echoes the cadence. INVARIANT:
 * `windowStart <= windowEnd` always (a backward jump clamps elapsed to 0, never
 * inverting the window). `elapsedMs` is the exact jump-safe span (≥ 0); `source`
 * names which clock produced it (monotonic when comparable, else wall).
 */
export interface ReviewWindow {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly period: ReviewPeriod;
  readonly elapsedMs: number;
  readonly source: "monotonic" | "wall";
}

/** Options for {@link computeReviewWindow}: the cadence + its nominal interval. */
export interface ComputeReviewWindowOptions {
  readonly period: ReviewPeriod;
  /**
   * The nominal cadence interval in ms (a week / ~a month). It CAPS the window
   * span: even if the jump-safe elapsed somehow exceeds the interval (a genuinely
   * late run inside the catch-up window), a single "weekly" review still reasons
   * over AT MOST one nominal interval of history — the collapsed catch-up (LIFE-2)
   * handles the missed occurrences; the window never balloons. Non-positive ⇒ the
   * cap is ignored (the raw jump-safe elapsed is used).
   */
  readonly intervalMs: number;
}

/** Parse an ISO timestamp to epoch-ms; NaN for an unparseable value. */
function epochMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Compute the clock-jump-safe review window from the schedule's durable
 * bookkeeping + the injected clock.
 *
 * `windowEnd` = the clock's current wall reading (the collapse point).
 * `windowStart` = `windowEnd − span`, where `span` is the JUMP-SAFE elapsed
 * (`computeElapsed`, monotonic-preferred + clamped ≥ 0) CAPPED at the nominal
 * interval. Because the span is jump-safe and clamped:
 *   • a FORWARD wall/NTP jump cannot inflate the window past one interval — the
 *     monotonic delta bounds it (the wall gap is ignored);
 *   • a BACKWARD wall jump cannot invert the window — elapsed clamps to 0, so
 *     `windowStart === windowEnd` (a zero-width window; nothing new to review).
 *
 * Pure + total — never throws. If the clock reading is unparseable the window
 * degenerates to a zero-width window at the (raw) clock string.
 */
export function computeReviewWindow(
  bookkeeping: ScheduleBookkeeping,
  clock: Clock,
  opts: ComputeReviewWindowOptions,
): ReviewWindow {
  const nowIso = clock.now();
  const endMs = epochMs(nowIso);

  // Jump-safe elapsed since the last run (monotonic-preferred; clamped ≥ 0).
  const elapsed = computeElapsed(bookkeeping, clock);

  // Cap the span at the nominal interval so a single review never balloons past
  // one period of history (the collapsed catch-up handles missed occurrences).
  const cap = opts.intervalMs > 0 ? opts.intervalMs : Number.POSITIVE_INFINITY;
  const spanMs = Math.min(elapsed.elapsedMs, cap);

  // Degenerate / unparseable clock → zero-width window at the raw reading (total).
  if (!Number.isFinite(endMs)) {
    return {
      windowStart: nowIso,
      windowEnd: nowIso,
      period: opts.period,
      elapsedMs: 0,
      source: elapsed.source,
    };
  }

  const startMs = endMs - spanMs;
  return {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: nowIso,
    period: opts.period,
    elapsedMs: spanMs,
    source: elapsed.source,
  };
}
