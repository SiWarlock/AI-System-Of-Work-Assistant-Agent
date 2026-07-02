// 10.7 — last-run bookkeeping service (LIFE-5) over the @sow/db
// ScheduleBookkeepingRepository + injected Clock.
//
// Ungated Vitest: no Temporal server, no real DB. The service is clock-injected
// over an in-memory fake repository. It REUSES the pure @sow/workflows clock
// logic (advanceBookkeeping/computeElapsed/hasElapsed) so a missed-occurrence
// catch-up (LIFE-2) stays correct across an NTP correction on wake (LIFE-5):
// persisted, survives restart, single source schedules read; a BACKWARD NTP jump
// never double-fires or skips. §16: never throws across the boundary.

import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err } from "@sow/contracts";
import type {
  DbError,
  DbResult,
  ScheduleBookkeepingRecord,
  ScheduleBookkeepingRepository,
} from "@sow/db";
import type { Clock } from "@sow/workflows/ports/operational";
import {
  createLastRunService,
  createScheduleStoreAdapter,
} from "../src/lifecycle/last-run";

// ── an in-memory fake ScheduleBookkeepingRepository (not_found on a miss) ──────
function fakeRepo(): ScheduleBookkeepingRepository & {
  rows: Map<string, ScheduleBookkeepingRecord>;
} {
  const rows = new Map<string, ScheduleBookkeepingRecord>();
  return {
    rows,
    getBookkeeping(scheduleId: string): DbResult<ScheduleBookkeepingRecord> {
      const row = rows.get(scheduleId);
      return Promise.resolve(
        row ? ok(row) : err<DbError>({ code: "not_found", message: scheduleId }),
      );
    },
    put(bookkeeping: ScheduleBookkeepingRecord): DbResult<void> {
      rows.set(bookkeeping.scheduleId, bookkeeping);
      return Promise.resolve(ok(undefined));
    },
  };
}

// A repo whose reads/writes fail — to prove a store fault folds to a typed error.
function faultyRepo(): ScheduleBookkeepingRepository {
  const fault: DbError = { code: "unavailable", message: "db down" };
  return {
    getBookkeeping: () => Promise.resolve(err(fault)),
    put: () => Promise.resolve(err(fault)),
  };
}

// ── a controllable fake Clock exposing wall + monotonic + a stable epoch ──────
interface FakeClock extends Clock {
  wallMs: number;
  monoMs: number;
  epoch: string;
}
function fakeClock(startWallIso: string, startMono: number, epoch: string): FakeClock {
  const c: FakeClock = {
    wallMs: Date.parse(startWallIso),
    monoMs: startMono,
    epoch,
    now(): string {
      return new Date(c.wallMs).toISOString();
    },
    monotonicMs(): number {
      return c.monoMs;
    },
    monotonicEpoch(): string {
      return c.epoch;
    },
  };
  return c;
}

const SCHED = "life-daily-backup";

describe("last-run service — round-trip through the store (LIFE-5)", () => {
  it("getLastRun on an empty store → ok(undefined) (a miss is not an error)", async () => {
    const svc = createLastRunService(fakeRepo(), fakeClock("2026-07-01T00:00:00.000Z", 1000, "boot-1"));
    const r = await svc.getLastRun(SCHED);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBeUndefined();
  });

  it("recordRun then getLastRun round-trips both wall + monotonic readings", async () => {
    const repo = fakeRepo();
    const clock = fakeClock("2026-07-01T00:00:00.000Z", 5000, "boot-1");
    const svc = createLastRunService(repo, clock);

    const w = await svc.recordRun(SCHED);
    expect(isOk(w)).toBe(true);

    const r = await svc.getLastRun(SCHED);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toBeDefined();
      expect(r.value?.scheduleId).toBe(SCHED);
      expect(r.value?.lastRunWall).toBe("2026-07-01T00:00:00.000Z");
      expect(r.value?.lastRunMonotonicMs).toBe(5000);
      expect(r.value?.lastRunMonotonicEpoch).toBe("boot-1");
    }
    // The value durably persisted in the store (single source schedules read).
    expect(repo.rows.get(SCHED)?.lastRunMonotonicMs).toBe(5000);
  });

  it("a store fault on read folds to a typed error (never throws, §16)", async () => {
    const svc = createLastRunService(faultyRepo(), fakeClock("2026-07-01T00:00:00.000Z", 1, "boot-1"));
    const r = await svc.getLastRun(SCHED);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("unavailable");
  });

  it("a store fault on write folds to a typed error (never throws, §16)", async () => {
    const svc = createLastRunService(faultyRepo(), fakeClock("2026-07-01T00:00:00.000Z", 1, "boot-1"));
    const r = await svc.recordRun(SCHED);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("unavailable");
  });
});

describe("last-run service — hasElapsed is monotonic-jump-safe (LIFE-5)", () => {
  it("elapsed measured on the MONOTONIC delta, immune to a wall jump", async () => {
    const repo = fakeRepo();
    const clock = fakeClock("2026-07-01T00:00:00.000Z", 10_000, "boot-1");
    const svc = createLastRunService(repo, clock);
    await svc.recordRun(SCHED); // lastRun mono = 10_000

    // Advance monotonic by 60s; wall unchanged. 60s ≥ 60s interval → elapsed.
    clock.monoMs = 70_000;
    const r = await svc.hasElapsedSince(SCHED, 60_000);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(true);
  });

  it("a BACKWARD wall jump does NOT re-fire (elapsed clamps ≥ 0, stays < interval)", async () => {
    const repo = fakeRepo();
    const clock = fakeClock("2026-07-01T12:00:00.000Z", 100_000, "boot-1");
    const svc = createLastRunService(repo, clock);
    await svc.recordRun(SCHED); // mono = 100_000

    // NTP correction: wall jumps BACKWARD an hour; monotonic barely moved (+500ms).
    clock.wallMs = Date.parse("2026-07-01T11:00:00.000Z");
    clock.monoMs = 100_500;
    const r = await svc.hasElapsedSince(SCHED, 60_000);
    expect(isOk(r)).toBe(true);
    // Only 500ms of REAL (monotonic) time elapsed → NOT due → no double-fire.
    if (isOk(r)) expect(r.value).toBe(false);
  });

  it("computeElapsedSince returns 0 elapsed for a never-run schedule (no bookkeeping)", async () => {
    const svc = createLastRunService(fakeRepo(), fakeClock("2026-07-01T00:00:00.000Z", 1, "boot-1"));
    const r = await svc.hasElapsedSince(SCHED, 1); // never run → not "elapsed since last run"
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(false);
  });

  it("a persisted PRIOR-EPOCH monotonic reading is ignored on restart (cross-restart guard)", async () => {
    const repo = fakeRepo();
    // Record under boot-1 at a large monotonic reading.
    const boot1 = fakeClock("2026-07-01T00:00:00.000Z", 900_000, "boot-1");
    await createLastRunService(repo, boot1).recordRun(SCHED);

    // A fresh process (boot-2) — monotonic clock RESET to a small reading. The
    // stored boot-1 reading (900_000) must NOT be subtracted from a fresh 1_000
    // (that would starve). computeElapsed falls back to the WALL delta.
    const boot2 = fakeClock("2026-07-01T01:00:00.000Z", 1_000, "boot-2");
    const svc = createLastRunService(repo, boot2);
    const r = await svc.hasElapsedSince(SCHED, 60_000); // 1h of wall elapsed
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(true);
  });
});

describe("createScheduleStoreAdapter — @sow/db repo → @sow/workflows ScheduleStore port", () => {
  it("getBookkeeping folds not_found → undefined; put upserts", async () => {
    const repo = fakeRepo();
    const store = createScheduleStoreAdapter(repo);

    expect(await store.getBookkeeping(SCHED)).toBeUndefined();

    await store.put({
      scheduleId: SCHED,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 42,
      lastRunMonotonicEpoch: "boot-1",
    });
    const got = await store.getBookkeeping(SCHED);
    expect(got?.lastRunMonotonicMs).toBe(42);
    expect(got?.lastRunMonotonicEpoch).toBe("boot-1");
  });
});
