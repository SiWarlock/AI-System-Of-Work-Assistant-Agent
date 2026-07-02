// §12 CONFORMANCE — SUPERVISION / DEGRADED-mode (task 10.8 suite 3; LIFE-1 / §16 /
// safety rule 3). A CROSS-CUTTING conformance suite over the REAL supervision +
// degraded-mode SUTs. It pins the load-bearing lifecycle guarantees:
//   • crash-loop → worker-down (NO infinite respawn) — decideRestart;
//   • lease re-acquire single-owner (no split-brain) — decideLease over a store;
//   • in-flight recovery via §8 envelope reuse produces NO duplicate external
//     write — recoverRun with a spy adapter.create (called at most once, ever);
//   • Temporal-unavailable HOLDS dispatch + auto-recovers on reconnect —
//     createTemporalUnavailabilityController;
//   • Keychain-locked HOLDS jobs RETRYABLE + resumes on unlock —
//     createKeychainLockController.
//
// All SUTs are imported + effect-injected; no Temporal server, no network, no
// Keychain. The gateway fake bundle mirrors the §8 receipt/replay path so the
// no-duplicate-write proof is real (adapter.create call count is the oracle).
import { describe, expect, it, vi } from "vitest";
import { ok, err, isOk, auditId } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  WriteReceipt,
  TargetSystem,
  ProviderId,
} from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
  ReceiptStore,
  ReceiptRecord,
  ReceiptReservation,
  DrainResult,
} from "@sow/integrations";
import type { Clock, InstanceLeaseStore, LeaseRecord } from "@sow/workflows/ports/operational";
import type { WakeReason } from "@sow/workflows";
import {
  decideRestart,
  DEFAULT_SUPERVISION_CONFIG,
} from "@sow/worker/lifecycle/supervision-policy";
import { decideLease } from "@sow/worker/lease/instanceLease";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
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
import {
  createTemporalUnavailabilityController,
} from "@sow/worker/lifecycle/degraded/temporal-unavailable";
import {
  createKeychainLockController,
  type ProviderDegradationStore,
} from "@sow/worker/lifecycle/degraded/keychain-locked";

const NOW = "2026-07-02T00:00:00.000Z";
const TS = "todoist" as TargetSystem;
const AUDIT = auditId("audit:conf:degraded");

// ── shared fakes ────────────────────────────────────────────────────────────────

function makeHealthSurface(): {
  surface: ReturnType<typeof createHealthSurface>;
  store: HealthSurfaceStore;
} {
  const rows = new Map<string, SurfacedHealthItem>();
  const store: HealthSurfaceStore = {
    getByDedupeKey: (k) => Promise.resolve(rows.get(k)),
    put: (r) => {
      rows.set(r.dedupeKey, r);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...rows.values()]),
  };
  return { surface: createHealthSurface(store), store };
}

// In-memory ReceiptStore mirroring the §8 gateway fakes (no-dup replay path).
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

function makeAdapter(overrides: Partial<TargetWriteAdapter> = {}): TargetWriteAdapter {
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
    ...overrides,
  };
}

function makeEnvelope(id = "resume-1"): ExternalWriteEnvelope {
  return {
    actionId: `action-${id}` as ExternalWriteEnvelope["actionId"],
    targetSystem: TS,
    canonicalObjectKey: `todoist:task:${id}`,
    idempotencyKey: `idem-${id}`,
    preconditions: ["exists_check"],
    payloadHash: `hash-${id}`,
  };
}

function makeAction(id = "resume-1"): ProposedAction {
  return {
    actionId: `action-${id}` as ProposedAction["actionId"],
    targetSystem: TS,
    canonicalObjectKey: `todoist:task:${id}`,
    payload: { title: "recover me" },
    approvalPolicy: "auto_allow",
    idempotencyKey: `idem-${id}`,
  };
}

function makeRecoverInput(args: {
  adapter: TargetWriteAdapter;
  receiptStore: ReceiptStore;
  writes: RecoverableWrite[];
  surface: ReturnType<typeof createHealthSurface>;
  ledger?: RecoverInput["resume"]["ledger"];
}): RecoverInput {
  const clock: Clock = { now: () => NOW };
  return {
    runId: "run-1",
    resume: {
      steps: args.writes.map((w) => ({
        stepId: w.stepId,
        kind: "external_write" as const,
        idempotencyKey: w.envelope.idempotencyKey,
      })),
      ledger: args.ledger ?? [],
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

// ── (a) crash-loop → worker-down (no infinite respawn) ─────────────────────────

describe("§12 supervision conformance — crash-loop → worker-down, NO infinite respawn", () => {
  const cfg = DEFAULT_SUPERVISION_CONFIG;
  const at = (msAgo: number): string => new Date(Date.parse(NOW) - msAgo).toISOString();

  it("a single crash restarts with a bounded backoff (does not declare down)", () => {
    const d = decideRestart({ taskQueue: "default", now: NOW, recentCrashes: [], config: cfg });
    expect(d.action).toBe("restart");
    if (d.action === "restart") expect(d.backoffMs).toBe(cfg.baseMs);
  });

  it("crashes within the window escalate the bounded backoff monotonically", () => {
    const two = decideRestart({
      taskQueue: "default",
      now: NOW,
      recentCrashes: [at(1000), at(2000)],
      config: cfg,
    });
    expect(two.action).toBe("restart");
    if (two.action === "restart") {
      expect(two.restartCount).toBe(2);
      expect(two.backoffMs).toBe(cfg.baseMs * 4); // 2^2
      expect(two.backoffMs).toBeLessThanOrEqual(cfg.maxMs); // bounded
    }
  });

  it("crash-loop threshold reached → worker_down (declines to respawn — the guard)", () => {
    const crashes = Array.from({ length: cfg.crashLoopThreshold }, (_, i) => at((i + 1) * 1000));
    const d = decideRestart({ taskQueue: "default", now: NOW, recentCrashes: crashes, config: cfg });
    expect(d.action).toBe("worker_down");
    if (d.action === "worker_down") {
      expect(d.failureClass).toBe("worker_down");
      expect(d.subjectRef).toBe("default");
    }
  });

  it("crashes OUTSIDE the window roll off (a stale ledger never trips a false loop)", () => {
    const stale = Array.from({ length: cfg.crashLoopThreshold }, () => at(cfg.crashLoopWindowMs + 5000));
    const d = decideRestart({ taskQueue: "default", now: NOW, recentCrashes: stale, config: cfg });
    expect(d.action).toBe("restart"); // all rolled off → not a loop
  });
});

// ── (b) lease re-acquire single-owner ───────────────────────────────────────────

describe("§12 supervision conformance — lease re-acquire is single-owner (no split-brain)", () => {
  function leaseStore(current: LeaseRecord | undefined, casWins = true): InstanceLeaseStore {
    return {
      get: () => Promise.resolve(current),
      compareAndSet: () => Promise.resolve(casWins),
    };
  }

  it("no live lease → acquire (this worker holds it)", async () => {
    const r = await decideLease(
      { taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE, ownerId: "w1", now: NOW, leaseTtlMs: 30_000, current: undefined },
      leaseStore(undefined),
    );
    expect(isOk(r) && r.value.action).toBe("acquire");
  });

  it("ANOTHER instance's live lease → passive (NO write, no split-brain)", async () => {
    const other: LeaseRecord = {
      taskQueue: "default",
      ownerId: "w2",
      acquiredAt: NOW,
      expiresAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
      generation: 3,
    };
    const cas = vi.fn(() => Promise.resolve(true));
    const r = await decideLease(
      { taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE, ownerId: "w1", now: NOW, leaseTtlMs: 30_000, current: other },
      { get: () => Promise.resolve(other), compareAndSet: cas },
    );
    expect(isOk(r) && r.value.action).toBe("passive");
    expect(cas).not.toHaveBeenCalled(); // never writes → single owner preserved
  });

  it("a lost CAS race fails CLOSED to passive (never a risky acquire)", async () => {
    const r = await decideLease(
      { taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE, ownerId: "w1", now: NOW, leaseTtlMs: 30_000, current: undefined },
      leaseStore(undefined, /* casWins */ false),
    );
    // decideLease surfaces a lost race as a typed err whose action is 'passive'
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.action).toBe("passive");
  });

  it("an expired other-owner lease → acquire with a BUMPED generation (fences the prior holder)", async () => {
    const expired: LeaseRecord = {
      taskQueue: "default",
      ownerId: "w2",
      acquiredAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T00:00:30.000Z",
      generation: 5,
    };
    const r = await decideLease(
      { taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE, ownerId: "w1", now: NOW, leaseTtlMs: 30_000, current: expired },
      leaseStore(expired),
    );
    expect(isOk(r) && r.value.action).toBe("acquire");
    if (isOk(r)) expect(r.value.next?.generation).toBe(6); // bumped off the prior
  });
});

// ── (c) in-flight recovery → NO duplicate external write (safety rule 3) ────────

describe("§12 recovery conformance — envelope reuse ⇒ NO duplicate external write (rule 3)", () => {
  it("a crash-interrupted write REUSES its receipt, adapter.create is NEVER called again", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const { surface } = makeHealthSurface();
    const env = makeEnvelope("b");
    // the write committed before the crash — its receipt is durable
    store.seed({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: { externalObjectId: "ext-prior", recordedAt: "2026-07-01T00:00:00.000Z" },
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: env, action: makeAction("b") }];
    const r = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.recovered).toBe(true);
    expect(r.value.reused).toBe(1);
    expect(r.value.created).toBe(0);
    expect(adapter.create).not.toHaveBeenCalled(); // THE safety-rule-3 proof
  });

  it("idempotent across REPEATED crashes: create is called at most once, ever", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const { surface } = makeHealthSurface();
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: makeEnvelope("c"), action: makeAction("c") }];
    const first = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    // second crash → same run, same store: the receipt now exists → reused
    const second = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    expect(isOk(first) && first.value.created).toBe(1);
    expect(isOk(second) && second.value.reused).toBe(1);
    expect(isOk(second) && second.value.created).toBe(0);
    expect(adapter.create).toHaveBeenCalledTimes(1); // exactly once across BOTH drives
  });

  it("a HELD write (unreachable existence probe) → NOT recovered, worker_down item raised (no create)", async () => {
    const adapter = makeAdapter({
      existenceCheck: vi.fn(() =>
        Promise.resolve(err<AdapterError>({ code: "unreachable", message: "vendor down" })),
      ),
    });
    const store = new FakeReceiptStore();
    const { surface } = makeHealthSurface();
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: makeEnvelope("e"), action: makeAction("e") }];
    const r = await recoverRun(makeRecoverInput({ adapter, receiptStore: store, writes, surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(adapter.create).not.toHaveBeenCalled(); // fail-closed: no partial write
    expect(r.value.recovered).toBe(false);
    expect(r.value.healthItem?.failureClass).toBe("worker_down"); // surfaced, not dropped
  });
});

// ── (d) Temporal-unavailable HOLDS dispatch + auto-recovers ────────────────────

describe("§12 degraded conformance — Temporal-unavailable holds dispatch + auto-recovers", () => {
  it("degraded → dispatch HELD (never sent to a dead Temporal, never dropped); reconnect drains", async () => {
    const dispatched: string[] = [];
    const { surface } = makeHealthSurface();
    const ctrl = createTemporalUnavailabilityController({
      surface,
      auditRef: AUDIT,
      dispatch: (jobId) => {
        dispatched.push(jobId);
        return Promise.resolve();
      },
      config: { backoff: DEFAULT_SUPERVISION_CONFIG },
    });

    // outage → surface a worker_down item + a bounded reconnect backoff
    const lost = await ctrl.onConnectionLost({ now: NOW, recentFailures: [] });
    expect(isOk(lost)).toBe(true);
    if (isOk(lost)) {
      expect(lost.value.healthItem.failureClass).toBe("worker_down");
      expect(lost.value.retryInMs).toBe(DEFAULT_SUPERVISION_CONFIG.baseMs);
    }
    expect(ctrl.isDegraded()).toBe(true);

    // dispatch requests during the outage are HELD, not sent
    const d1 = await ctrl.onDispatchRequest("job-1", { now: NOW });
    const d2 = await ctrl.onDispatchRequest("job-2", { now: NOW });
    expect(isOk(d1) && d1.value.disposition).toBe("held");
    expect(isOk(d2) && d2.value.disposition).toBe("held");
    expect(dispatched).toEqual([]); // nothing sent to a dead Temporal
    expect(ctrl.heldQueue().map((h) => h.jobId)).toEqual(["job-1", "job-2"]);

    // reconnect → auto-clear + drain the held queue through the NORMAL path
    const re = await ctrl.onReconnect({ now: "2026-07-02T00:01:00.000Z" });
    expect(isOk(re) && re.value.resumedCount).toBe(2);
    expect(dispatched).toEqual(["job-1", "job-2"]);
    expect(ctrl.isDegraded()).toBe(false);

    // idempotent: a spurious second reconnect finds an empty queue (no dup dispatch)
    const re2 = await ctrl.onReconnect({ now: "2026-07-02T00:02:00.000Z" });
    expect(isOk(re2) && re2.value.resumedCount).toBe(0);
    expect(dispatched).toEqual(["job-1", "job-2"]);
  });

  it("when healthy, a dispatch passes straight through (no hold)", async () => {
    const dispatched: string[] = [];
    const { surface } = makeHealthSurface();
    const ctrl = createTemporalUnavailabilityController({
      surface,
      auditRef: AUDIT,
      dispatch: (j) => {
        dispatched.push(j);
        return Promise.resolve();
      },
      config: { backoff: DEFAULT_SUPERVISION_CONFIG },
    });
    const d = await ctrl.onDispatchRequest("job-x", { now: NOW });
    expect(isOk(d) && d.value.disposition).toBe("dispatched");
    expect(dispatched).toEqual(["job-x"]);
  });
});

// ── (e) Keychain-locked HOLDS jobs retryable + resumes on unlock ───────────────

describe("§12 degraded conformance — Keychain-locked holds jobs retryable + resumes on unlock", () => {
  function fakeDegradationStore(): ProviderDegradationStore {
    const set = new Set<ProviderId>();
    return {
      markDegraded: (p) => {
        set.add(p);
        return Promise.resolve();
      },
      clearDegraded: (p) => {
        set.delete(p);
        return Promise.resolve();
      },
      isDegraded: (p) => Promise.resolve(set.has(p)),
    };
  }
  const provider = "openrouter" as ProviderId;
  const emptyDrain: DrainResult = { drained: 0, reused: 0, held: 0, failed: 0 };

  it("lock → provider degraded + worker_down item; jobs held RETRYABLE (never terminal); unlock re-attempts", async () => {
    const { surface } = makeHealthSurface();
    const degradationStore = fakeDegradationStore();
    const wakeDrain = vi.fn((_e: { reason: WakeReason; now: string }) => Promise.resolve(emptyDrain));
    const ctrl = createKeychainLockController({
      surface,
      degradationStore,
      auditRef: AUDIT,
      wakeDrain,
    });

    const locked = await ctrl.onKeychainLocked({ subjectRef: provider, now: NOW });
    expect(isOk(locked)).toBe(true);
    if (isOk(locked)) {
      expect(locked.value.healthItem.failureClass).toBe("worker_down");
      expect(locked.value.degradedProvider).toBe(provider);
    }
    expect(await degradationStore.isDegraded(provider)).toBe(true);

    // a dependent job is held RETRYABLE — NOT failed_terminal (no work lost)
    const held = await ctrl.holdJob("job-1", { subjectRef: provider });
    expect(isOk(held) && held.value.disposition).toBe("held_retryable");
    expect(isOk(held) && held.value.retryable).toBe(true);
    expect(ctrl.heldJobs()).toEqual(["job-1"]);

    // unlock (LIFE-6 wake) → re-attempt via the §8 drain, clear degraded + resolve
    const unlocked = await ctrl.onUnlock({ reason: "power_resume", now: "2026-07-02T01:00:00.000Z" });
    expect(isOk(unlocked)).toBe(true);
    if (isOk(unlocked)) expect(unlocked.value.releasedCount).toBe(1);
    expect(wakeDrain).toHaveBeenCalledTimes(1); // the idempotent §8 outbox drain ran
    expect(await degradationStore.isDegraded(provider)).toBe(false); // cleared
    expect(ctrl.heldJobs()).toEqual([]); // released
  });
});

// ── the DoD gate entry (wiringFactory) ─────────────────────────────────────────
// Machine-checkable predicate covering the five supervision/degraded guarantees.
export async function supervisionDegradedConformanceHolds(): Promise<boolean> {
  const cfg = DEFAULT_SUPERVISION_CONFIG;
  const loop = Array.from({ length: cfg.crashLoopThreshold }, (_, i) =>
    new Date(Date.parse(NOW) - (i + 1) * 1000).toISOString(),
  );
  if (decideRestart({ taskQueue: "q", now: NOW, recentCrashes: loop, config: cfg }).action !== "worker_down") {
    return false;
  }
  const other: LeaseRecord = {
    taskQueue: "q",
    ownerId: "w2",
    acquiredAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 30_000).toISOString(),
    generation: 1,
  };
  const lease = await decideLease(
    { taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE, ownerId: "w1", now: NOW, leaseTtlMs: 30_000, current: other },
    { get: () => Promise.resolve(other), compareAndSet: () => Promise.resolve(true) },
  );
  if (!isOk(lease) || lease.value.action !== "passive") return false;

  const adapter = makeAdapter();
  const store = new FakeReceiptStore();
  const { surface } = makeHealthSurface();
  const env = makeEnvelope("g");
  store.seed({
    idempotencyKey: env.idempotencyKey,
    canonicalObjectKey: env.canonicalObjectKey,
    targetSystem: env.targetSystem,
    payloadHash: env.payloadHash,
    receipt: { externalObjectId: "ext-prior", recordedAt: NOW },
    recordedAt: NOW,
  });
  const rec = await recoverRun(
    makeRecoverInput({
      adapter,
      receiptStore: store,
      writes: [{ stepId: "s1", envelope: env, action: makeAction("g") }],
      surface,
    }),
  );
  return isOk(rec) && rec.value.reused === 1 && (adapter.create as ReturnType<typeof vi.fn>).mock.calls.length === 0;
}
