// 7.2 — collapsed catch-up (LIFE-2). When a worker was asleep/down across
// MULTIPLE recurrences, catch-up must fire the recurring workflow EXACTLY ONCE
// within the catch-up window — never once per missed occurrence (a thundering
// herd). Occurrences OLDER than the window are DROPPED as 'missed' and RECORDED
// (surfaced later as a 'missed_or_late_schedule' health class), NOT silently
// replayed. `collapsedNextRun` is PURE + TOTAL (no throw, no clock read — inputs
// only). Time is expressed in ISO strings + ms deltas the caller derives from an
// injected clock upstream.
import { describe, it, expect } from "vitest";
import {
  collapsedNextRun,
  collapsedNextRunFromClock,
  MAX_MISSED_RECORDED,
} from "../src/runtime/catchUpWindow";
import { FakeClock } from "./support/fakes";
import type { ScheduleBookkeeping } from "../src/ports/operational";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("collapsedNextRun — multiple missed occurrences collapse to ONE run", () => {
  it("collapses 5 missed hourly occurrences into a single next run at now", () => {
    // lastRun 5h ago, hourly cadence, generous window ⇒ 5 occurrences are due.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.collapsed).toBe(true);
    // Exactly ONE run — scheduled at now (the collapse point), not 5 runs.
    expect(r.nextRun).toBe("2026-07-01T05:00:00.000Z");
    // No occurrence exceeded the 24h window, so nothing is dropped.
    expect(r.missed).toEqual([]);
    expect(r.droppedCount).toBe(0);
    expect(r.droppedCount).toBe(0);
  });

  it("records occurrences OLDER than the window as dropped 'missed', not replayed", () => {
    // lastRun 5h ago, hourly, but window is only 2h: occurrences at +1h,+2h,+3h
    // are older than (now − 2h) and must be dropped+recorded; +4h,+5h are inside.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 2 * HOUR,
    });
    expect(r.collapsed).toBe(true);
    expect(r.nextRun).toBe("2026-07-01T05:00:00.000Z");
    // Occurrences before (now − 2h = 03:00) are dropped: 01:00, 02:00, 03:00.
    // (03:00 is exactly the window edge — treated as inside; see boundary test.)
    expect(r.missed).toEqual([
      "2026-07-01T01:00:00.000Z",
      "2026-07-01T02:00:00.000Z",
    ]);
    expect(r.droppedCount).toBe(2);
  });
});

describe("collapsedNextRun — exactly-once semantics", () => {
  it("a SINGLE due occurrence runs once (no collapse flag) with no missed", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T01:00:30.000Z", // just past the first hourly tick
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.collapsed).toBe(false); // only one occurrence — nothing collapsed
    expect(r.nextRun).toBe("2026-07-01T01:00:30.000Z");
    expect(r.missed).toEqual([]);
  });

  it("NO occurrence is due yet ⇒ no run, no missed (nextRun is null)", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T00:30:00.000Z", // half an interval in
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.collapsed).toBe(false);
    expect(r.nextRun).toBeNull();
    expect(r.missed).toEqual([]);
  });

  it("ALL due occurrences older than the window ⇒ no run, all recorded missed", () => {
    // lastRun at 00:00, hourly ⇒ occurrences at 01:00…05:00; now is 05:30 with a
    // tiny 1-min window ⇒ even the latest occurrence (05:00) is 30min stale, so
    // every occurrence is outside the window: we do NOT fire, just record.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:30:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: MIN, // 1-minute window; latest occurrence (05:00) is 30min old
    });
    expect(r.collapsed).toBe(false);
    expect(r.nextRun).toBeNull(); // nothing catchable within a 1-min window
    expect(r.missed).toEqual([
      "2026-07-01T01:00:00.000Z",
      "2026-07-01T02:00:00.000Z",
      "2026-07-01T03:00:00.000Z",
      "2026-07-01T04:00:00.000Z",
      "2026-07-01T05:00:00.000Z",
    ]);
    expect(r.droppedCount).toBe(5);
  });
});

describe("collapsedNextRun — window boundary + totality", () => {
  it("an occurrence EXACTLY at the window edge (now − window) is inside (catchable)", () => {
    // window = 3h ⇒ edge = 02:00; the 02:00 occurrence is inside, 01:00 dropped.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 3 * HOUR,
    });
    expect(r.nextRun).toBe("2026-07-01T05:00:00.000Z");
    expect(r.missed).toEqual([
      "2026-07-01T01:00:00.000Z",
    ]);
    expect(r.droppedCount).toBe(1);
  });

  it("is total: a zero/negative interval yields no run + no missed (no divide-by-zero, no throw)", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: 0,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.collapsed).toBe(false);
    expect(r.nextRun).toBeNull();
    expect(r.missed).toEqual([]);
  });

  it("is total: now BEFORE lastRun (backward clock) yields no run + no missed", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T05:00:00.000Z",
      now: "2026-07-01T00:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.collapsed).toBe(false);
    expect(r.nextRun).toBeNull();
    expect(r.missed).toEqual([]);
  });

  it("caps the enumerated 'missed' list so a huge gap stays bounded (no OOM) while droppedCount stays exact", () => {
    // lastRun ~a year ago at 1-second cadence is ~31M occurrences. The function
    // must stay total + bounded: it collapses to a SINGLE run, records the
    // outside-window occurrences as 'missed' but CAPS that enumerated list, and
    // reports the exact total dropped via droppedCount (summary, not enumeration).
    const r = collapsedNextRun({
      lastRun: "2025-07-01T00:00:00.000Z",
      now: "2026-07-01T00:00:00.000Z",
      intervalMs: 1_000,
      catchUpWindowMs: 5_000, // only the last few seconds are catchable
    });
    expect(r.collapsed).toBe(true);
    expect(r.nextRun).toBe("2026-07-01T00:00:00.000Z");
    // The enumerated list is capped (never ~31M entries)…
    expect(r.missed.length).toBeLessThanOrEqual(MAX_MISSED_RECORDED);
    // …but the exact count of dropped-as-stale occurrences is still reported.
    // 2025-07-01→2026-07-01 is 365 days → 365*86400 due ticks at 1s cadence. With
    // an INCLUSIVE 5s window (edge = now−5s), the 6 most-recent occurrences
    // (now−5s … now) are inside and collapse (not "missed"), so
    // dropped = total_due − 6.
    const totalDue = 365 * 24 * 60 * 60; // seconds in the span (1s cadence)
    expect(r.droppedCount).toBe(totalDue - 6);
  });
});

describe("collapsedNextRun — non-positive catch-up window is INERT (FINDING 7)", () => {
  it("a ZERO window fires NOTHING even at an occurrence boundary", () => {
    // A due occurrence sits exactly at `now` (edge = now − 0 = now), which the old
    // code treated as inside → a spurious catch-up run. The contract says a
    // non-positive window means nothing is catchable.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 0,
    });
    expect(r.nextRun).toBeNull();
    expect(r.collapsed).toBe(false);
    expect(r.missed).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });

  it("a NEGATIVE window is likewise INERT", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: -HOUR,
    });
    expect(r.nextRun).toBeNull();
    expect(r.collapsed).toBe(false);
    expect(r.missed).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });
});

describe("collapsedNextRunFromClock — jump-safe elapsed drives the decision (FINDING 5)", () => {
  it("a forward WALL jump across a restart does NOT inflate dueCount into a spurious multi-collapse", () => {
    // Bookkeeping recorded under boot-A; a restart (boot-B) resets the monotonic
    // clock, so computeElapsed falls back to the WALL delta — but the wall itself
    // has ALSO taken a forward NTP jump of ~1 year. Naive `now − lastRun` would be
    // ~1 year → thousands of collapsed hourly occurrences. The jump-safe elapsed
    // (clamped wall delta since the recorded lastRunWall) is the true measure; here
    // lastRunWall was itself just before `now`, so only a small, real gap elapsed.
    //
    // Concretely: lastRunWall is 90s before `now`, so only ONE hourly-ish tick is
    // due — no phantom multi-collapse. We use a 1-minute interval to make exactly
    // ONE occurrence due over the real 90s gap.
    const bk: ScheduleBookkeeping = {
      scheduleId: "sched-1",
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      lastRunMonotonicEpoch: "boot-A",
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:01:30.000Z", // 90s after lastRunWall
      monotonicMs: 50, // reset low after restart — must NOT be compared to 1_000
      monotonicEpoch: "boot-B",
    });
    const r = collapsedNextRunFromClock(bk, clock, {
      intervalMs: MIN,
      catchUpWindowMs: 24 * HOUR,
    });
    // 90s / 60s = 1 due occurrence → single run, NOT collapsed.
    expect(r.nextRun).toBe("2026-07-01T00:01:30.000Z");
    expect(r.collapsed).toBe(false);
    expect(r.droppedCount).toBe(0);
  });

  it("within a single epoch, the monotonic gap collapses the correct number of ticks", () => {
    // Same epoch: computeElapsed uses the monotonic delta (5 minutes) → 5 due
    // 1-minute ticks collapse to one run.
    const bk: ScheduleBookkeeping = {
      scheduleId: "sched-1",
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 0,
      lastRunMonotonicEpoch: "boot-A",
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:05:00.000Z",
      monotonicMs: 5 * MIN,
      monotonicEpoch: "boot-A",
    });
    const r = collapsedNextRunFromClock(bk, clock, {
      intervalMs: MIN,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.nextRun).toBe("2026-07-01T00:05:00.000Z");
    expect(r.collapsed).toBe(true); // 5 ticks folded in
  });

  it("honors the non-positive-window INERT rule through the integrated entry", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: "sched-1",
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 0,
      lastRunMonotonicEpoch: "boot-A",
    };
    const clock = new FakeClock({
      now: "2026-07-01T05:00:00.000Z",
      monotonicMs: 5 * HOUR,
      monotonicEpoch: "boot-A",
    });
    const r = collapsedNextRunFromClock(bk, clock, {
      intervalMs: HOUR,
      catchUpWindowMs: 0,
    });
    expect(r.nextRun).toBeNull();
    expect(r.collapsed).toBe(false);
  });
});
