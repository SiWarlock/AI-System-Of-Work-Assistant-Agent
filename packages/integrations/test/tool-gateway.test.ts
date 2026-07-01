// Slice 6.2 — dispatchExternalWrite: the ONLY external-write entry (the
// no-duplicate-write invariant core). Adversarial pins for the FIXED-ORDER
// pipeline: candidate-gate → approval → pre-write existence check → create →
// store receipt + audit + safe log; conflict/unreachable are typed holds, never
// blind overwrites/silent drops.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WriteReceipt, AuditRecord } from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import type { SafeToolWriteLog } from "../src/redaction/gateway-log-redaction";
import {
  dispatchExternalWrite,
  type ExternalWriteDeps,
  type GatewayApprovalDecision,
} from "../src/tools/gateway";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import {
  InMemoryReceiptStore,
  makeProposedAction,
  makeWriteReceipt,
} from "./support/fakes";

// --- test doubles ------------------------------------------------------------

interface AdapterSpies {
  adapter: TargetWriteAdapter;
  createCalls: () => number;
}

function makeAdapter(opts: {
  existence?: () => Promise<Result<ExistingObject | null, AdapterError>>;
  create?: () => Promise<Result<WriteReceipt, AdapterError>>;
}): AdapterSpies {
  const create = vi.fn(
    opts.create ?? (async () => ok(makeWriteReceipt({ externalObjectId: "ext_created" }))),
  );
  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: vi.fn(opts.existence ?? (async () => ok(null))),
    create,
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
  return { adapter, createCalls: () => create.mock.calls.length };
}

// Approval decision helpers (mirror the policy PolicyDecision.value shape the
// gateway reads: `{ requiresApproval, card? }`).
const autoAllow = (): GatewayApprovalDecision => ({ requiresApproval: false });
const needsApproval = (): GatewayApprovalDecision => ({
  requiresApproval: true,
  card: {
    channels: ["mac"],
    visibilityLevel: "isolated",
    snoozeDefaultHours: 24,
    autoExpireDefaultDays: 7,
  },
});

const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

interface Harness {
  deps: ExternalWriteDeps;
  spies: AdapterSpies;
  store: InMemoryReceiptStore;
  audits: AuditRecord[];
  logs: SafeToolWriteLog[];
  pendingRecorded: number;
}

function makeHarness(overrides: {
  existence?: () => Promise<Result<ExistingObject | null, AdapterError>>;
  create?: () => Promise<Result<WriteReceipt, AdapterError>>;
  requireApproval?: () => GatewayApprovalDecision;
  isApproved?: () => Promise<boolean>;
} = {}): Harness {
  const spies = makeAdapter({ existence: overrides.existence, create: overrides.create });
  const store = new InMemoryReceiptStore();
  const audits: AuditRecord[] = [];
  const logs: SafeToolWriteLog[] = [];
  const harness: Harness = {
    spies,
    store,
    audits,
    logs,
    pendingRecorded: 0,
    deps: {
      adapter: spies.adapter,
      receiptStore: store,
      requireApproval: overrides.requireApproval ?? autoAllow,
      recordPendingApproval: async () => {
        harness.pendingRecorded += 1;
        return ok(undefined);
      },
      isApproved: overrides.isApproved ?? (async () => false),
      audit: async (rec: AuditRecord) => {
        audits.push(rec);
      },
      clock: FIXED_CLOCK,
      logSink: (rec: SafeToolWriteLog) => {
        logs.push(rec);
      },
    },
  };
  return harness;
}

function envFor(action = makeProposedAction()) {
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return built.value;
}

// --- tests -------------------------------------------------------------------

describe("dispatchExternalWrite — REPLAY (no duplicate write)", () => {
  it("same idempotencyKey twice → first 'created', second 'reused', create called EXACTLY once", async () => {
    const action = makeProposedAction({
      idempotencyKey: "idem_replay",
      canonicalObjectKey: "cok_replay",
    });
    const env = envFor(action);
    const h = makeHarness();

    const first = await dispatchExternalWrite(env, action, h.deps);
    expect(first.status).toBe("created");
    if (first.status === "created") expect(first.receipt.externalObjectId).toBe("ext_created");

    const second = await dispatchExternalWrite(env, action, h.deps);
    expect(second.status).toBe("reused");
    if (second.status === "reused") {
      expect(second.receipt.externalObjectId).toBe("ext_created");
    }

    expect(h.spies.createCalls()).toBe(1);
  });
});

describe("dispatchExternalWrite — EXISTENCE HIT (live vendor)", () => {
  it("a canonicalObjectKey already present at the vendor → 'reused', create NEVER called", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const object: ExistingObject = {
      externalObjectId: "ext_preexisting",
      externalUrl: "https://drive/preexisting",
    };
    const h = makeHarness({ existence: async () => ok(object) });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("reused");
    if (res.status === "reused") {
      expect(res.receipt.externalObjectId).toBe("ext_preexisting");
    }
    expect(h.spies.createCalls()).toBe(0);
  });

  it("a live existence-probe FAULT holds (never creates on an unreachable probe)", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      existence: async () => err<AdapterError>({ code: "unreachable", message: "probe down" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("held");
    expect(h.spies.createCalls()).toBe(0);
  });
});

describe("dispatchExternalWrite — APPROVAL enforcement", () => {
  it("an action requiring approval → 'approval_pending', create NEVER called, PENDING recorded", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({ requireApproval: needsApproval, isApproved: async () => false });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("approval_pending");
    expect(h.spies.createCalls()).toBe(0);
    expect(h.pendingRecorded).toBe(1);
    // NEVER ran the existence probe past the approval gate.
    expect(h.spies.adapter.existenceCheck).not.toHaveBeenCalled();
  });

  it("after approval (isApproved true) → 'created'", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({ requireApproval: needsApproval, isApproved: async () => true });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("created");
    expect(h.spies.createCalls()).toBe(1);
    expect(h.pendingRecorded).toBe(0);
  });
});

describe("dispatchExternalWrite — AUDIT / REDACTION (no raw payload)", () => {
  it("the AuditRecord + the safe log carry NO raw payload — only payloadHash / refs / summaries", async () => {
    const secret = "super-secret-title-value";
    const action = makeProposedAction({ payload: { title: secret, body: "raw-body" } });
    const env = envFor(action);
    const h = makeHarness();

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("created");

    expect(h.audits).toHaveLength(1);
    const audit = h.audits[0]!;
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain(secret);
    expect(auditJson).not.toContain("raw-body");
    expect(audit.payloadHash).toBe(env.payloadHash);
    // beforeSummary/afterSummary are summaries, and there is no raw-content field.
    expect(typeof audit.beforeSummary).toBe("string");
    expect(typeof audit.afterSummary).toBe("string");

    expect(h.logs).toHaveLength(1);
    const logJson = JSON.stringify(h.logs[0]!);
    expect(logJson).not.toContain(secret);
    expect(logJson).not.toContain("raw-body");
  });
});

describe("dispatchExternalWrite — CONFLICT / UNREACHABLE", () => {
  it("adapter 'conflict' on create → typed conflict, NO overwrite (update never called)", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "conflict", message: "version clash" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("conflict");
    expect(h.spies.adapter.update).not.toHaveBeenCalled();
    // A conflict must NOT persist a receipt (nothing committed).
    expect(h.store.size()).toBe(0);
  });

  it("adapter 'unreachable' on create → 'held' (the outbox-hold signal for 6.5)", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "unreachable", message: "target down" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("held");
    expect(h.store.size()).toBe(0);
  });

  it("adapter 'rejected' on create → typed 'rejected', nothing persisted", async () => {
    const action = makeProposedAction();
    const env = envFor(action);
    const h = makeHarness({
      create: async () => err<AdapterError>({ code: "rejected", message: "bad request" }),
    });

    const res = await dispatchExternalWrite(env, action, h.deps);
    expect(res.status).toBe("rejected");
    expect(h.store.size()).toBe(0);
  });
});

describe("dispatchExternalWrite — candidate-gate linkage", () => {
  it("an envelope whose linkage does NOT match the action is rejected before any side effect", async () => {
    const action = makeProposedAction({ canonicalObjectKey: "cok_a", idempotencyKey: "idem_a" });
    // Build a valid envelope, then dispatch it against a DIFFERENT action.
    const env = envFor(action);
    const otherAction = makeProposedAction({
      canonicalObjectKey: "cok_b",
      idempotencyKey: "idem_b",
    });
    const h = makeHarness();

    const res = await dispatchExternalWrite(env, otherAction, h.deps);
    expect(res.status).toBe("rejected");
    expect(h.spies.createCalls()).toBe(0);
    expect(h.spies.adapter.existenceCheck).not.toHaveBeenCalled();
  });
});
