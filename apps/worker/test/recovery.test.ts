// 10.4c — in-flight RECOVERY on (re)start (LIFE-3, §6, §8, safety rule 3).
//
// Ungated Vitest: no Temporal server, no network. On recovery the worker replans
// the re-entered run via the PURE planResume (LIFE-3) and re-drives each pending
// external side effect through the §8 external-write ENVELOPE REUSE
// (reuseExternalWriteOnResume) — reusing the SAME envelope (idempotencyKey +
// canonicalObjectKey + payloadHash). The gateway's stored-receipt replay gate
// guarantees a side effect interrupted by a crash is NOT duplicated on recovery:
// a receipt already recorded ⇒ 'reused' ⇒ adapter.create is NEVER called again
// (safety rule 3). The two load-bearing guarantees pinned here:
//   • recovery replay reuses the receipt → ZERO duplicate external write, and is
//     idempotent + re-drivable across repeated crashes (create called once total).
//   • a FAILURE to recover (torn commit / held write) surfaces a typed HealthItem
//     (worker_down, via createHealthSurface) rather than silently dropping the run.

import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
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
import type { Clock } from "@sow/workflows/ports/operational";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "../src/health/surface";
import {
  recoverRun,
  type RecoverInput,
  type RecoverableWrite,
} from "../src/lifecycle/recovery";

const NOW = "2026-07-02T00:00:00.000Z";
const TS: TargetSystem = "todoist" as TargetSystem;

const fixedClock: Clock = { now: () => NOW };

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

// In-memory ReceiptStore mirroring the §8 gateway fakes.
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
    create: vi.fn((): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-new", recordedAt: NOW })),
    ),
    update: vi.fn((): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-upd", recordedAt: NOW })),
    ),
    ...overrides,
  };
}

function makeHealthSurface(): {
  surface: ReturnType<typeof createHealthSurface>;
  rows: Map<string, SurfacedHealthItem>;
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
  return { surface: createHealthSurface(store), rows };
}

function makeInput(args: {
  adapter: TargetWriteAdapter;
  receiptStore: ReceiptStore;
  writes: RecoverableWrite[];
  ledger?: RecoverInput["resume"]["ledger"];
  surface: ReturnType<typeof createHealthSurface>;
}): RecoverInput {
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
      clock: fixedClock,
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

describe("recoverRun — envelope reuse ⇒ NO duplicate external write (safety rule 3)", () => {
  it("re-drives an uncommitted write exactly once when no receipt exists yet", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: makeEnvelope("a"), action: makeAction("a") },
    ];
    const r = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.recovered).toBe(true);
    expect(r.value.reused).toBe(0);
    expect(r.value.created).toBe(1);
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("REUSES a stored receipt and NEVER calls create again (crash-interrupted write not duplicated)", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const env = makeEnvelope("b");
    // Simulate: the write COMMITTED before the crash — its receipt is durable.
    const priorReceipt: WriteReceipt = { externalObjectId: "ext-prior", recordedAt: "2026-07-01T00:00:00.000Z" };
    store.seed({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: priorReceipt,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: env, action: makeAction("b") }];

    const r = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.recovered).toBe(true);
    expect(r.value.reused).toBe(1);
    expect(r.value.created).toBe(0);
    // THE safety-rule-3 assertion: no second external write on recovery.
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("is idempotent + re-drivable across REPEATED crashes — create called once total over two recoveries", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: makeEnvelope("c"), action: makeAction("c") },
    ];
    const first = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    // second recovery (a repeated crash re-drives the same run against the SAME store)
    const second = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));

    expect(isOk(first) && first.value.created).toBe(1);
    expect(isOk(second) && second.value.reused).toBe(1);
    expect(isOk(second) && second.value.created).toBe(0);
    // exactly one create across BOTH recovery drives — never leaves a partial/dup.
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("re-drives MULTIPLE pending writes, each exactly once", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: makeEnvelope("d1"), action: makeAction("d1") },
      { stepId: "s2", envelope: makeEnvelope("d2"), action: makeAction("d2") },
    ];
    const r = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(2);
    expect(adapter.create).toHaveBeenCalledTimes(2);
  });
});

describe("recoverRun — a failed recovery surfaces a HealthItem, never silently drops the run", () => {
  it("a HELD write (unreachable existence probe) → NOT recovered, worker_down health item raised", async () => {
    const adapter = makeAdapter({
      existenceCheck: vi.fn(() =>
        Promise.resolve(err<AdapterError>({ code: "unreachable", message: "vendor down" })),
      ),
    });
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: makeEnvelope("e"), action: makeAction("e") },
    ];
    const r = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // fail-closed: no create was attempted on a held write …
    expect(adapter.create).not.toHaveBeenCalled();
    // … and the run did NOT vanish — recovery reports it unrecovered …
    expect(r.value.recovered).toBe(false);
    // … and surfaced a persistent worker_down health item (never silent drop).
    expect(r.value.healthItem?.failureClass).toBe("worker_down");
    const persisted = await surface.surface.list();
    expect(isOk(persisted)).toBe(true);
    if (!isOk(persisted)) return;
    expect(persisted.value.some((i) => i.item.failureClass === "worker_down")).toBe(true);
  });

  it("INDEPENDENT later external_write steps STILL drive when an earlier one is HELD (external writes have no inter-step dependency; §6 kind-ordering only)", async () => {
    // Two independent external_write steps. Step s1's existence probe is unreachable
    // (fails CLOSED → held); step s2 is fully re-drivable. Per §6/resume.ts, among
    // external_write steps relative position is NOT load-bearing (each reuses its own
    // §8 envelope + receipt) — so s2 MUST still be driven this pass, not left undriven
    // behind s1's hold. The run still reports unrecovered (s1 held) and surfaces a
    // health item, but the independent s2 write is not needlessly stranded.
    const envA = makeEnvelope("held-1"); // s1 — will be held
    const envB = makeEnvelope("indep-2"); // s2 — independent, drivable
    const adapter = makeAdapter({
      // Existence probe is unreachable ONLY for s1's object key; s2 probes cleanly.
      existenceCheck: vi.fn((key: string) =>
        key === envA.canonicalObjectKey
          ? Promise.resolve(err<AdapterError>({ code: "unreachable", message: "vendor down" }))
          : Promise.resolve(ok<ExistingObject | null>(null)),
      ),
    });
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const writes: RecoverableWrite[] = [
      { stepId: "s1", envelope: envA, action: { ...makeAction("held-1"), canonicalObjectKey: envA.canonicalObjectKey } },
      { stepId: "s2", envelope: envB, action: { ...makeAction("indep-2"), canonicalObjectKey: envB.canonicalObjectKey } },
    ];
    const r = await recoverRun(makeInput({ adapter, receiptStore: store, writes, surface: surface.surface }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;

    // The independent s2 write WAS driven this pass — exactly one create for it …
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(r.value.created).toBe(1);
    // … while s1's held write issued NO create (fail-closed).
    // The run is reported UNRECOVERED (s1 could not be driven) …
    expect(r.value.recovered).toBe(false);
    // … and surfaces a worker_down health item naming the held step (never silent drop).
    expect(r.value.healthItem?.failureClass).toBe("worker_down");
    expect(r.value.healthItem?.message).toContain("s1");
    const persisted = await surface.surface.list();
    expect(isOk(persisted)).toBe(true);
    if (!isOk(persisted)) return;
    expect(persisted.value.some((i) => i.item.failureClass === "worker_down")).toBe(true);
  });

  it("a TORN COMMIT (ledger says committed but no receipt) is unrecoverable → worker_down health item, no re-drive", async () => {
    const adapter = makeAdapter();
    const store = new FakeReceiptStore();
    const surface = makeHealthSurface();
    const env = makeEnvelope("f");
    const writes: RecoverableWrite[] = [{ stepId: "s1", envelope: env, action: makeAction("f") }];
    // ledger records s1 committed but WITHOUT a receipt → planResume returns unrecoverable.
    const ledger: RecoverInput["resume"]["ledger"] = [
      { stepId: "s1", receipt: { kind: "missing" } },
    ];
    const r = await recoverRun(
      makeInput({ adapter, receiptStore: store, writes, ledger, surface: surface.surface }),
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.recovered).toBe(false);
    // a torn commit is NOT re-driven (never re-commits a side effect)
    expect(adapter.create).not.toHaveBeenCalled();
    expect(r.value.healthItem?.failureClass).toBe("worker_down");
  });
});
