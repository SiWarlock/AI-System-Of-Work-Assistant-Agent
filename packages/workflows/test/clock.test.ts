// 7.2 — clock-jump-safe last-run bookkeeping (LIFE-5).
//
// The runtime NEVER subtracts two wall clocks to decide "has the interval
// elapsed?": an NTP step or DST correction on wake can move the wall clock
// FORWARD (would skip a due run under a naive comparison) or BACKWARD (would make
// `now < lastRun`, a naive subtraction going negative — which could re-fire or
// starve). The bookkeeping carries an OPTIONAL monotonic reading + its EPOCH; the
// monotonic delta is used ONLY when both readings exist AND the epochs match (same
// process/boot) — a monotonic clock resets on restart, so a stored reading from a
// prior epoch is not comparable. Otherwise wall-clock is the fallback. These are
// PURE functions over an INJECTED FakeClock — no Date.now().
import { describe, it, expect } from "vitest";
import { FakeClock } from "./support/fakes";
import type { ScheduleBookkeeping } from "../src/ports/operational";
import {
  computeElapsed,
  advanceBookkeeping,
  hasElapsed,
} from "../src/runtime/clock";

const ID = "sched-1";
const BOOT = "boot-1"; // FakeClock's default epoch

describe("computeElapsed — monotonic preferred over wall", () => {
  it("uses the monotonic delta when both readings + epochs match", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      lastRunMonotonicEpoch: BOOT,
    };
    // Wall moved backward by 5s (NTP correction) but monotonic advanced 10s.
    const clock = new FakeClock({
      now: "2026-06-30T23:59:55.000Z",
      monotonicMs: 11_000,
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("monotonic");
    expect(r.elapsedMs).toBe(10_000); // 11_000 − 1_000, wall jump ignored.
  });

  it("falls back to the wall delta on the first run (no stored monotonic)", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      // no lastRunMonotonicMs — first run after a cold start
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:00:30.000Z",
      monotonicMs: 999_999,
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("wall");
    expect(r.elapsedMs).toBe(30_000);
  });

  it("falls back to the wall delta when the clock exposes no monotonic source", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 5_000,
      lastRunMonotonicEpoch: BOOT,
    };
    // A wall-only clock: monotonicMs (and monotonicEpoch) are undefined.
    const wallOnly = {
      now: (): string => "2026-07-01T00:00:20.000Z",
    };
    const r = computeElapsed(bk, wallOnly);
    expect(r.source).toBe("wall");
    expect(r.elapsedMs).toBe(20_000);
  });
});

describe("computeElapsed — cross-restart epoch guard (LIFE-5)", () => {
  it("across a RESTART epoch, uses the WALL delta — never the stale monotonic (which would starve)", () => {
    // FINDING 8: a durably-persisted monotonic reading (1000) from boot-A is
    // compared to a fresh monotonic (50) from boot-B after a restart. The naive
    // delta 50 − 1000 = −950 would clamp to 0 → the schedule STARVES (never
    // fires). With the epoch guard, computeElapsed must fall back to the wall
    // delta instead.
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      lastRunMonotonicEpoch: "boot-A",
    };
    // Restart: new boot epoch, monotonic clock reset low; wall advanced 90s.
    const clock = new FakeClock({
      now: "2026-07-01T00:01:30.000Z",
      monotonicMs: 50,
      monotonicEpoch: "boot-B",
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("wall"); // NOT monotonic — epochs differ
    expect(r.elapsedMs).toBe(90_000); // wall delta, not the clamped-to-0 stale monotonic
  });

  it("SAME epoch still uses the monotonic delta", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      lastRunMonotonicEpoch: "boot-A",
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:01:30.000Z",
      monotonicMs: 4_000,
      monotonicEpoch: "boot-A",
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("monotonic");
    expect(r.elapsedMs).toBe(3_000);
  });

  it("bookkeeping with NO stored epoch cannot take the monotonic path (falls to wall)", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      // no lastRunMonotonicEpoch — a legacy/partial record: not comparable
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:00:20.000Z",
      monotonicMs: 11_000,
      monotonicEpoch: BOOT,
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("wall");
    expect(r.elapsedMs).toBe(20_000);
  });
});

describe("computeElapsed — BACKWARD jump never yields negative elapsed", () => {
  it("clamps a backward wall jump to 0 elapsed (no double-fire, no negative)", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      // no monotonic: forced onto the wall path
    };
    // Wall moved BACKWARD 10s relative to lastRun.
    const clock = new FakeClock({ now: "2026-06-30T23:59:50.000Z" });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("wall");
    expect(r.elapsedMs).toBe(0); // clamped, never −10_000
  });

  it("clamps a backward MONOTONIC reading to 0 (defensive; monotonic should not go back)", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 10_000,
      lastRunMonotonicEpoch: BOOT,
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:01:00.000Z",
      monotonicMs: 4_000, // below stored — defensive clamp (same epoch)
    });
    const r = computeElapsed(bk, clock);
    expect(r.source).toBe("monotonic");
    expect(r.elapsedMs).toBe(0);
  });
});

describe("hasElapsed — the predicate the schedule logic uses", () => {
  it("FORWARD jump does NOT skip: a real elapsed interval fires", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 1_000,
      lastRunMonotonicEpoch: BOOT,
    };
    // Monotonic advanced 60s (a full interval); a forward wall jump is irrelevant.
    const clock = new FakeClock({
      now: "2026-07-01T02:00:00.000Z", // wall jumped forward 2h
      monotonicMs: 61_000,
    });
    expect(hasElapsed(bk, clock, 60_000)).toBe(true);
  });

  it("BACKWARD jump does NOT re-fire: elapsed stays below interval", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 100_000,
      lastRunMonotonicEpoch: BOOT,
    };
    // Wall jumped backward; monotonic barely moved (2s) — NOT a full interval.
    const clock = new FakeClock({
      now: "2026-06-30T20:00:00.000Z",
      monotonicMs: 102_000,
    });
    expect(hasElapsed(bk, clock, 60_000)).toBe(false);
  });

  it("returns true exactly at the interval boundary", () => {
    const bk: ScheduleBookkeeping = {
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 0,
      lastRunMonotonicEpoch: BOOT,
    };
    const clock = new FakeClock({
      now: "2026-07-01T00:01:00.000Z",
      monotonicMs: 60_000,
    });
    expect(hasElapsed(bk, clock, 60_000)).toBe(true);
  });
});

describe("advanceBookkeeping — records wall + monotonic + epoch readings", () => {
  it("captures the current wall + monotonic + epoch reading for the schedule", () => {
    const clock = new FakeClock({
      now: "2026-07-01T00:05:00.000Z",
      monotonicMs: 300_000,
      monotonicEpoch: "boot-A",
    });
    const next = advanceBookkeeping(ID, clock);
    expect(next).toEqual({
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:05:00.000Z",
      lastRunMonotonicMs: 300_000,
      lastRunMonotonicEpoch: "boot-A",
    });
  });

  it("round-trips: a record advanced under an epoch is monotonic-comparable within that epoch", () => {
    const clock = new FakeClock({
      now: "2026-07-01T00:00:00.000Z",
      monotonicMs: 1_000,
      monotonicEpoch: "boot-Z",
    });
    const bk = advanceBookkeeping(ID, clock);
    clock.setNow("2026-07-01T00:05:00.000Z");
    clock.setMonotonicMs(4_000);
    const r = computeElapsed(bk, clock); // same epoch → monotonic
    expect(r.source).toBe("monotonic");
    expect(r.elapsedMs).toBe(3_000);
  });

  it("omits monotonic + epoch fields when the clock exposes no monotonic source", () => {
    const wallOnly = { now: (): string => "2026-07-01T00:05:00.000Z" };
    const next = advanceBookkeeping(ID, wallOnly);
    expect(next).toEqual({
      scheduleId: ID,
      lastRunWall: "2026-07-01T00:05:00.000Z",
    });
    expect("lastRunMonotonicMs" in next).toBe(false);
    expect("lastRunMonotonicEpoch" in next).toBe(false);
  });

  it("is deterministic — repeated calls at the same clock reading are identical", () => {
    const clock = new FakeClock({
      now: "2026-07-01T00:05:00.000Z",
      monotonicMs: 300_000,
    });
    expect(advanceBookkeeping(ID, clock)).toEqual(advanceBookkeeping(ID, clock));
  });
});
