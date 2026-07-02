// spec(§8, §20.1, LIFE-3) — slice 7.3 external-write-ENVELOPE REUSE on resume.
//
// The ACTIVITY re-drives an external side effect through the §8 Tool Gateway
// (dispatchExternalWrite from @sow/integrations) REUSING THE SAME
// ExternalWriteEnvelope (idempotencyKey + canonicalObjectKey + payloadHash). The
// gateway's stored-receipt replay gate + mandatory pre-write existence check
// guarantee a re-driven step performs NO duplicate external write: when a receipt
// for the envelope already exists the gateway returns `reused` and adapter.create
// is NEVER called again — mirroring the Phase-6 replay guarantee.
//
// This is an ACTIVITY (activities/**): it MAY use adapters. All gateway deps are
// INJECTED (a fake TargetWriteAdapter + an in-memory ReceiptStore) so the test
// needs no Temporal server and no network.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  WriteReceipt,
  TargetSystem,
} from "@sow/contracts";
import { reuseExternalWriteOnResume } from "../src/activities/envelopeReuse";
import type { EnvelopeReuseDeps } from "../src/activities/envelopeReuse";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "@sow/integrations";
import type { ReceiptStore, ReceiptRecord, ReceiptReservation } from "@sow/integrations";

const TS: TargetSystem = "todoist" as TargetSystem;

function makeEnvelope(): ExternalWriteEnvelope {
  return {
    actionId: "action-1" as ExternalWriteEnvelope["actionId"],
    targetSystem: TS,
    canonicalObjectKey: "todoist:task:resume-1",
    idempotencyKey: "idem-resume-1",
    preconditions: ["exists_check"],
    payloadHash: "hash-abc",
  };
}

function makeAction(): ProposedAction {
  return {
    actionId: "action-1" as ProposedAction["actionId"],
    targetSystem: TS,
    canonicalObjectKey: "todoist:task:resume-1",
    payload: { title: "resume me" },
    approvalPolicy: "auto_allow",
    idempotencyKey: "idem-resume-1",
  };
}

// A minimal in-memory ReceiptStore for the reuse path (mirrors the gateway fakes).
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
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-new", recordedAt: "2026-07-02T00:00:00.000Z" })),
    ),
    update: vi.fn((): Promise<ReturnType<typeof ok<WriteReceipt>>> =>
      Promise.resolve(ok<WriteReceipt>({ externalObjectId: "ext-upd", recordedAt: "2026-07-02T00:00:00.000Z" })),
    ),
    ...overrides,
  };
}

function makeDeps(adapter: TargetWriteAdapter, receiptStore: ReceiptStore): EnvelopeReuseDeps {
  return {
    gatewayDeps: {
      adapter,
      receiptStore,
      requireApproval: () => ({ requiresApproval: false }),
      recordPendingApproval: () => Promise.resolve(ok(undefined)),
      isApproved: () => Promise.resolve(true),
      audit: () => Promise.resolve(),
      clock: () => "2026-07-02T00:00:00.000Z",
    },
  };
}

describe("spec(§20.1) reuseExternalWriteOnResume — stored receipt → reused, NO second create", () => {
  it("returns 'reused' and NEVER calls adapter.create when a receipt exists for the envelope", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const priorReceipt: WriteReceipt = { externalObjectId: "ext-prior", recordedAt: "2026-07-01T00:00:00.000Z" };
    store.seed({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: priorReceipt,
      recordedAt: "2026-07-01T00:00:00.000Z",
    });
    const adapter = makeAdapter();

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("reused");
    expect(res.value.receipt.externalObjectId).toBe("ext-prior");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("issues exactly one create when NO receipt exists yet (first drive)", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter();

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across TWO resume drives — second drive reuses the first receipt, create called once total", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter();
    const deps = makeDeps(adapter, store);

    const first = await reuseExternalWriteOnResume(env, makeAction(), deps);
    const second = await reuseExternalWriteOnResume(env, makeAction(), deps);

    expect(first.ok && first.value.status).toBe("created");
    expect(second.ok && second.value.status).toBe("reused");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("returns a typed err (never throws) on a held gateway outcome (unreachable existence probe)", async () => {
    const env = makeEnvelope();
    const store = new FakeReceiptStore();
    const adapter = makeAdapter({
      existenceCheck: vi.fn(() =>
        Promise.resolve(err<AdapterError>({ code: "unreachable", message: "vendor down" })),
      ),
    });

    const res = await reuseExternalWriteOnResume(env, makeAction(), makeDeps(adapter, store));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("held");
    // no create was attempted on a held (fail-closed) outcome
    expect(adapter.create).not.toHaveBeenCalled();
  });
});
