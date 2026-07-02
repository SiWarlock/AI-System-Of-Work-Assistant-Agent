// 7.2 — durable schedule registration (LIFE-2/LIFE-5 spine). A registration maps
// a scheduleId → the recurring workflow trigger, and its last-run bookkeeping
// persists via the injected ScheduleStore (NEVER in Temporal history). Both
// operations are IDEMPOTENT across restarts: re-registering the same schedule
// after a process bounce reuses the existing durable bookkeeping (no reset, no
// double-register); advancing the last run twice with the same clock reading is a
// no-op the second time. Typed Result — never throws across the boundary (§16).
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { FakeClock, InMemoryScheduleStore } from "./support/fakes";
import { createScheduleRegistry } from "../src/runtime/schedule";

const ID = "digest-daily";

describe("register — idempotent across restarts", () => {
  it("registers a novel schedule and seeds its durable bookkeeping", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock({
      now: "2026-07-01T00:00:00.000Z",
      monotonicMs: 1_000,
    });
    const reg = createScheduleRegistry({ store, clock });

    const r = await reg.register(ID, "schedule");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value).toEqual({ scheduleId: ID, trigger: "schedule" });
    }
    // Durable bookkeeping now exists for the schedule.
    const bk = await store.getBookkeeping(ID);
    expect(bk?.scheduleId).toBe(ID);
    expect(bk?.lastRunWall).toBe("2026-07-01T00:00:00.000Z");
    expect(bk?.lastRunMonotonicMs).toBe(1_000);
  });

  it("re-registering after a restart REUSES existing bookkeeping (no reset)", async () => {
    const store = new InMemoryScheduleStore();
    // Simulate a prior run's durable state already persisted.
    await store.put({
      scheduleId: ID,
      lastRunWall: "2026-06-30T09:00:00.000Z",
      lastRunMonotonicMs: 42,
    });
    // Restart: a FRESH clock (monotonic reset to 0) — must NOT clobber lastRun.
    const clock = new FakeClock({
      now: "2026-07-01T12:00:00.000Z",
      monotonicMs: 0,
    });
    const reg = createScheduleRegistry({ store, clock });

    const r = await reg.register(ID, "schedule");
    expect(isOk(r)).toBe(true);
    // Bookkeeping is UNCHANGED — the prior last-run survives the restart.
    const bk = await store.getBookkeeping(ID);
    expect(bk).toEqual({
      scheduleId: ID,
      lastRunWall: "2026-06-30T09:00:00.000Z",
      lastRunMonotonicMs: 42,
    });
  });

  it("re-registering with a DIFFERENT trigger for the same id is a conflict (typed err)", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock();
    const reg = createScheduleRegistry({ store, clock });

    const first = await reg.register(ID, "schedule");
    expect(isOk(first)).toBe(true);

    const second = await reg.register(ID, "connector_event");
    expect(isErr(second)).toBe(true);
    if (isErr(second)) {
      expect(second.error.code).toBe("trigger_conflict");
    }
  });

  it("re-registering with the SAME trigger is an idempotent success", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock();
    const reg = createScheduleRegistry({ store, clock });

    const first = await reg.register(ID, "schedule");
    const second = await reg.register(ID, "schedule");
    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value).toEqual({ scheduleId: ID, trigger: "schedule" });
    }
  });
});

describe("advance — idempotent last-run advance across restarts", () => {
  it("advances the durable last-run to the current clock reading", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock({
      now: "2026-07-01T00:00:00.000Z",
      monotonicMs: 0,
    });
    const reg = createScheduleRegistry({ store, clock });
    await reg.register(ID, "schedule");

    clock.setNow("2026-07-01T01:00:00.000Z");
    clock.setMonotonicMs(3_600_000);
    const r = await reg.advance(ID);
    expect(isOk(r)).toBe(true);

    const bk = await store.getBookkeeping(ID);
    expect(bk).toEqual({
      scheduleId: ID,
      lastRunWall: "2026-07-01T01:00:00.000Z",
      lastRunMonotonicMs: 3_600_000,
      // advanceBookkeeping now also records the monotonic EPOCH (LIFE-5 cross-
      // restart guard) so a future computeElapsed knows whether the reading is
      // still comparable. FakeClock's default epoch is "boot-1".
      lastRunMonotonicEpoch: "boot-1",
    });
  });

  it("advancing an UNREGISTERED schedule is a typed not_registered err", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock();
    const reg = createScheduleRegistry({ store, clock });

    const r = await reg.advance("never-registered");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("not_registered");
    }
  });

  it("advancing twice at the SAME clock reading is idempotent (no drift)", async () => {
    const store = new InMemoryScheduleStore();
    const clock = new FakeClock({
      now: "2026-07-01T02:00:00.000Z",
      monotonicMs: 7_200_000,
    });
    const reg = createScheduleRegistry({ store, clock });
    await reg.register(ID, "schedule");
    // Clock frozen at a later reading; advance twice.
    clock.setNow("2026-07-01T03:00:00.000Z");
    clock.setMonotonicMs(10_800_000);

    const a = await reg.advance(ID);
    const bkAfterFirst = await store.getBookkeeping(ID);
    const b = await reg.advance(ID);
    const bkAfterSecond = await store.getBookkeeping(ID);

    expect(isOk(a)).toBe(true);
    expect(isOk(b)).toBe(true);
    expect(bkAfterSecond).toEqual(bkAfterFirst); // second advance is a no-op
  });

  it("survives a restart: a new registry over the SAME store keeps advancing", async () => {
    const store = new InMemoryScheduleStore();
    const clock1 = new FakeClock({
      now: "2026-07-01T00:00:00.000Z",
      monotonicMs: 0,
    });
    const reg1 = createScheduleRegistry({ store, clock: clock1 });
    await reg1.register(ID, "schedule");

    // Restart: fresh registry + fresh clock over the SAME durable store.
    const clock2 = new FakeClock({
      now: "2026-07-01T06:00:00.000Z",
      monotonicMs: 0, // monotonic reset by the restart
    });
    const reg2 = createScheduleRegistry({ store, clock: clock2 });
    // Re-register (idempotent) then advance.
    await reg2.register(ID, "schedule");
    const r = await reg2.advance(ID);
    expect(isOk(r)).toBe(true);

    const bk = await store.getBookkeeping(ID);
    expect(bk?.lastRunWall).toBe("2026-07-01T06:00:00.000Z");
    expect(bk?.lastRunMonotonicMs).toBe(0);
  });
});
