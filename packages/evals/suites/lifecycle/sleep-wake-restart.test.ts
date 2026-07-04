// spec(§20.1 "Sleep-through-brief & resume" · LIFE-2/LIFE-5 · §8 · REQ-NF-006) — task 12.19.
//
// §20.1 acceptance suite — the durable-schedule WAKE half of "Sleep-through-brief
// & resume" (safety rule 3, no-duplicate-external-write). It drives the REAL pure
// runtime — @sow/workflows/runtime/catchUpWindow (collapsedNextRun /
// collapsedNextRunFromClock) for the schedule catch-up, and @sow/worker's REAL
// §8 envelope-reuse recovery (recoverRun) for the in-flight resume — and scores the
// SLEEP_THROUGH_BRIEF_RESUME criterion through the EVAL-1 runner (task 12.1).
//
// DoD honesty: SLEEP_THROUGH_BRIEF_RESUME is requiresRealIntegration=FALSE — the
// deterministic lifecycle logic (collapse math, jump-safe elapsed, receipt reuse)
// IS the real path, so a fixture-driven measurement is DoD-VALID here (contrast the
// egress-ack suite, which requires a real provider and therefore reports dodValid
// false from a mock). The runner enforces this via `dodValid`.
//
// Acceptance bullets exercised (§20.1 / task 12.19):
//  (a) durable schedules run each MISSED occurrence exactly ONCE, COLLAPSED, on wake
//      within the catch-up window (collapse = MAX; multiple missed → one run at now);
//      catch-up runs on PERSISTED last-run bookkeeping (monotonic where available),
//      NOT naive wall-clock — so it survives an NTP BACKWARD correction / a restart.
//  (b) an in-flight workflow resumes after restart/sleep and REUSES the §8
//      external-write envelope so NO external side effect is duplicated — the
//      idempotency-key/receipt reuse semantics of the ports (adapter.create is never
//      called again for an already-committed write).
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  WriteReceipt,
  TargetSystem,
} from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
  ReceiptStore,
  ReceiptRecord,
  ReceiptReservation,
} from "@sow/integrations";
import type { Clock, ScheduleBookkeeping } from "@sow/workflows/ports/operational";
import {
  collapsedNextRun,
  collapsedNextRunFromClock,
} from "@sow/workflows/runtime/catchUpWindow";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "@sow/worker/health/surface";
import {
  recoverRun,
  type RecoverInput,
  type RecoverableWrite,
} from "@sow/worker/lifecycle/recovery";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const MIN = 60_000;
const HOUR = 60 * MIN;

// ── a deterministic injected clock (no Date.now / Math.random) ─────────────────
// Mirrors the @sow/workflows FakeClock: mutable wall + monotonic + boot epoch so a
// test can simulate an NTP backward wall jump (move `now` back while monotonic
// keeps rising in the SAME epoch) OR a restart (a NEW epoch invalidates a stored
// monotonic reading, forcing the wall fallback).
class FakeClock implements Clock {
  constructor(
    private readonly nowIso: string,
    private readonly mono: number,
    private readonly epoch: string,
  ) {}
  now(): string {
    return this.nowIso;
  }
  monotonicMs(): number {
    return this.mono;
  }
  monotonicEpoch(): string {
    return this.epoch;
  }
}

// ── (a) durable-schedule wake: collapse missed occurrences to ONE run ───────────

describe("§20.1 sleep-through — MISSED schedule occurrences collapse to ONE run on wake", () => {
  it("multiple missed occurrences collapse (=MAX) to a SINGLE run at now, not one-per-occurrence", () => {
    // Slept 5h across an hourly schedule; a generous window catches them all.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    // Exactly ONE run (no thundering herd), collapsed at the MAX point = now.
    expect(r.collapsed).toBe(true);
    expect(r.nextRun).toBe("2026-07-01T05:00:00.000Z");
    expect(r.missed).toEqual([]);
    expect(r.droppedCount).toBe(0);
  });

  it("occurrences OLDER than the window are recorded ONCE as missed, not replayed", () => {
    // 5h slept, hourly, but only a 2h catch-up window: the 01:00/02:00 ticks are
    // stale (dropped+recorded), the 03:00+ ticks collapse into one run at now.
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T05:00:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 2 * HOUR,
    });
    expect(r.nextRun).toBe("2026-07-01T05:00:00.000Z"); // still exactly one run
    expect(r.collapsed).toBe(true);
    expect(r.missed).toEqual([
      "2026-07-01T01:00:00.000Z",
      "2026-07-01T02:00:00.000Z",
    ]);
    expect(r.droppedCount).toBe(2); // surfaced, not silently replayed
  });
});

describe("§20.1 sleep-through — catch-up runs on PERSISTED bookkeeping, not naive wall-clock", () => {
  it("survives an NTP BACKWARD correction: monotonic delta drives the collapse where wall would STARVE", () => {
    // Persisted bookkeeping: last run at wall 00:05, monotonic 0, boot-A.
    const bookkeeping: ScheduleBookkeeping = {
      scheduleId: "sched-daily-brief",
      lastRunWall: "2026-07-01T00:05:00.000Z",
      lastRunMonotonicMs: 0,
      lastRunMonotonicEpoch: "boot-A",
    };
    // On wake, an NTP step moved the WALL clock BACKWARD to 00:00 (now < lastRun),
    // but the monotonic clock kept rising 5min within the same boot epoch.
    const clock = new FakeClock("2026-07-01T00:00:00.000Z", 5 * MIN, "boot-A");

    // Naive wall subtraction (now − lastRun < 0) would fire NOTHING — starvation.
    const naive = collapsedNextRun({
      lastRun: bookkeeping.lastRunWall,
      now: clock.now(),
      intervalMs: MIN,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(naive.nextRun).toBeNull(); // backward wall → naive path starves

    // Jump-safe path uses the persisted MONOTONIC delta (5min ⇒ 5 due 1-min ticks)
    // → one collapsed run at the wall reading (the collapse point). No starve.
    const jumpSafe = collapsedNextRunFromClock(bookkeeping, clock, {
      intervalMs: MIN,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(jumpSafe.nextRun).toBe("2026-07-01T00:00:00.000Z");
    expect(jumpSafe.collapsed).toBe(true);
    expect(jumpSafe.droppedCount).toBe(0);
  });

  it("across a RESTART the stale prior-epoch monotonic reading is ignored (wall fallback, no double-fire)", () => {
    // Bookkeeping recorded a huge monotonic reading under boot-A. After a restart
    // (boot-B) the monotonic clock reset — comparing the fresh small reading to the
    // stored large one would be garbage, so computeElapsed falls back to the WALL
    // delta. The wall shows the TRUE 5-min gap ⇒ 5 collapsed ticks, exactly once.
    const bookkeeping: ScheduleBookkeeping = {
      scheduleId: "sched-daily-brief",
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 9_000_000, // prior-epoch reading — must NOT be compared
      lastRunMonotonicEpoch: "boot-A",
    };
    const clock = new FakeClock("2026-07-01T00:05:00.000Z", 12, "boot-B"); // fresh boot
    const r = collapsedNextRunFromClock(bookkeeping, clock, {
      intervalMs: MIN,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.nextRun).toBe("2026-07-01T00:05:00.000Z");
    expect(r.collapsed).toBe(true); // 5 wall-derived ticks folded into one
  });

  it("nothing due yet ⇒ no spurious run (a short nap under one interval)", () => {
    const r = collapsedNextRun({
      lastRun: "2026-07-01T00:00:00.000Z",
      now: "2026-07-01T00:30:00.000Z",
      intervalMs: HOUR,
      catchUpWindowMs: 24 * HOUR,
    });
    expect(r.nextRun).toBeNull();
    expect(r.collapsed).toBe(false);
  });
});

// ── (b) in-flight resume: §8 envelope reuse ⇒ NO duplicate external write ────────

const TS = "todoist" as TargetSystem;
const NOW = "2026-07-02T00:00:00.000Z";

function makeHealthSurface(): ReturnType<typeof createHealthSurface> {
  const rows = new Map<string, SurfacedHealthItem>();
  const store: HealthSurfaceStore = {
    getByDedupeKey: (k) => Promise.resolve(rows.get(k)),
    put: (row) => {
      rows.set(row.dedupeKey, row);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...rows.values()]),
  };
  return createHealthSurface(store);
}

// In-memory ReceiptStore mirroring the §8 gateway path (the no-dup replay oracle).
class FakeReceiptStore implements ReceiptStore {
  private byIdem = new Map<string, ReceiptRecord>();
  private byObj = new Map<string, ReceiptRecord>();
  seed(record: ReceiptRecord): void {
    this.byIdem.set(record.idempotencyKey, record);
    this.byObj.set(`${record.targetSystem}::${record.canonicalObjectKey}`, record);
  }
  getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined> {
    return Promise.resolve(this.byIdem.get(k));
  }
  getByCanonicalObjectKey(t: TargetSystem, k: string): Promise<ReceiptRecord | undefined> {
    return Promise.resolve(this.byObj.get(`${t}::${k}`));
  }
  reserve(t: TargetSystem, k: string): Promise<ReceiptReservation> {
    const existing = this.byObj.get(`${t}::${k}`);
    if (existing !== undefined) return Promise.resolve({ kind: "committed", record: existing });
    return Promise.resolve({ kind: "reserved" });
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
  put(r: ReceiptRecord): Promise<void> {
    this.seed(r);
    return Promise.resolve();
  }
}

function makeAdapter(): TargetWriteAdapter {
  return {
    targetSystem: TS,
    existenceCheck: vi.fn(
      (): Promise<ReturnType<typeof ok<ExistingObject | null>> | ReturnType<typeof err<AdapterError>>> =>
        Promise.resolve(ok<ExistingObject | null>(null)),
    ),
    create: vi.fn(
      (): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
        Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-new", recordedAt: NOW })),
    ),
    update: vi.fn(
      (): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
        Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-upd", recordedAt: NOW })),
    ),
  };
}

function makeEnvelope(id: string): ExternalWriteEnvelope {
  return {
    actionId: `action-${id}` as ExternalWriteEnvelope["actionId"],
    targetSystem: TS,
    canonicalObjectKey: `todoist:task:${id}`,
    idempotencyKey: `idem-${id}`,
    preconditions: ["exists_check"],
    payloadHash: `hash-${id}`,
  };
}

function makeAction(id: string): ProposedAction {
  return {
    actionId: `action-${id}` as ProposedAction["actionId"],
    targetSystem: TS,
    canonicalObjectKey: `todoist:task:${id}`,
    payload: { title: "resume me" },
    approvalPolicy: "auto_allow",
    idempotencyKey: `idem-${id}`,
  };
}

function makeRecoverInput(args: {
  adapter: TargetWriteAdapter;
  receiptStore: ReceiptStore;
  writes: RecoverableWrite[];
  surface: ReturnType<typeof createHealthSurface>;
}): RecoverInput {
  const clock: Clock = { now: () => NOW };
  return {
    runId: "run-brief-1",
    resume: {
      steps: args.writes.map((w) => ({
        stepId: w.stepId,
        kind: "external_write" as const,
        idempotencyKey: w.envelope.idempotencyKey,
      })),
      ledger: [],
    },
    writes: args.writes,
    deps: {
      clock,
      healthSurface: args.surface,
      envelopeReuse: {
        gatewayDeps: {
          adapter: args.adapter,
          receiptStore: args.receiptStore,
          requireApproval: () => ({ requiresApproval: false }),
          recordPendingApproval: () => Promise.resolve(ok(undefined)),
          isApproved: () => Promise.resolve(true),
          audit: () => Promise.resolve(),
          clock: () => NOW,
        },
      },
    },
  };
}

describe("§20.1 sleep-through — an in-flight write RESUMES via §8 envelope reuse (no duplicate side effect)", () => {
  it("a write that COMMITTED before the crash reuses its receipt — adapter.create is never called again", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const env = makeEnvelope("brief");
    // the external write committed just before sleep/crash — its receipt is durable
    store.seed({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: { externalObjectId: "ext-prior", recordedAt: "2026-07-01T00:00:00.000Z" },
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: env, action: makeAction("brief") }];
    const r = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recovered).toBe(true);
    expect(r.value.reused).toBe(1);
    expect(r.value.created).toBe(0);
    expect(adapter.create).not.toHaveBeenCalled(); // safety-rule-3: zero duplicate write
  });

  it("idempotent across REPEATED crash/resume cycles — create is called at most ONCE, ever", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: makeEnvelope("loop"), action: makeAction("loop") },
    ];
    const first = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    // a second sleep/crash resumes the SAME run against the SAME store → receipt reused
    const second = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    expect(first.ok && first.value.created).toBe(1);
    expect(second.ok && second.value.reused).toBe(1);
    expect(second.ok && second.value.created).toBe(0);
    expect(adapter.create).toHaveBeenCalledTimes(1); // exactly once across BOTH resumes
  });
});

// ── EVAL-1 runner integration (task 12.1) ──────────────────────────────────────

describe("§20.1 EVAL-1 — SLEEP_THROUGH_BRIEF_RESUME scores DoD-passing from the deterministic path", () => {
  it("the criterion is NOT real-integration-gated (deterministic lifecycle logic IS the real path)", () => {
    expect(criterionById("SLEEP_THROUGH_BRIEF_RESUME")?.requiresRealIntegration).toBe(false);
  });

  it("gate holds ⇒ functionalPass AND dodPass (fixture-driven is DoD-valid here)", () => {
    const out = scoreById({
      criterionId: "SLEEP_THROUGH_BRIEF_RESUME",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true); // requiresRealIntegration=false ⇒ mock is honest
    expect(out.dodPass).toBe(true);
  });
});
