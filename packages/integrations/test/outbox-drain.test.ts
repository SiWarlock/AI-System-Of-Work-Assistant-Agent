// @sow/integrations — slice 6.5 WRITE OUTBOX: replay-safe drain (test-first).
//
// On reconnect/wake, `drainOutbox` lists due entries (OutboxRepository.listDue)
// and re-drives each through the SAME 6.2 dispatchExternalWrite pipeline — so the
// mandatory pre-write existence check + stored-receipt replay gate make a re-driven
// held write produce NO duplicate external action (§20.1). The drain:
//   • REPLAY-SAFE — an entry whose receipt already exists ⇒ reused; adapter.create
//     is NEVER called a second time.
//   • CRASH MID-DRAIN — re-running the drain over a partially-drained set
//     double-applies nothing (an already-receipt_recorded entry is a no-op).
//   • BOUNDED BACKOFF — a still-unreachable entry is re-held with a bumped attempt
//     count + a nextAttemptAt computed from the injected backoff (never spins).
//   • Returns { drained, reused, held, failed } counts.
//   • Is callable as the §9 workflow entry-point (a clean deps-injected signature).
import { describe, it, expect } from "vitest";
import type { Result, WriteReceipt } from "@sow/contracts";
import { ok, err, isOk } from "@sow/contracts";
import { drainOutbox } from "../src/tools/outbox-drain";
import { holdWrite } from "../src/tools/outbox";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import {
  InMemoryOutbox,
  InMemoryReceiptStore,
  makeEnvelope,
  makeProposedAction,
  makeWriteReceipt,
  makeReceiptRecord,
} from "./support/fakes";

const clock = (): string => "2026-07-01T00:00:00.000Z";
const backoffCfg = { baseMs: 1000, maxMs: 60000, maxAttempts: 5 };

// A configurable fake adapter that records how many times create() is invoked.
function makeAdapter(opts: {
  existence?: Result<ExistingObject | null, AdapterError>;
  create?: Result<WriteReceipt, AdapterError>;
  createCalls: { n: number };
}): TargetWriteAdapter {
  return {
    targetSystem: "drive",
    async existenceCheck(): Promise<Result<ExistingObject | null, AdapterError>> {
      return opts.existence ?? ok(null);
    },
    async create(): Promise<Result<WriteReceipt, AdapterError>> {
      opts.createCalls.n += 1;
      return opts.create ?? ok(makeWriteReceipt({ externalObjectId: "ext_created" }));
    },
    async update(): Promise<Result<WriteReceipt, AdapterError>> {
      return ok(makeWriteReceipt());
    },
  };
}

// Build the gateway deps the drain re-drives each entry through. Auto-allow (no
// approval) so the drain reaches the existence/create stage.
function makeGatewayDeps(
  adapter: TargetWriteAdapter,
  receiptStore: InMemoryReceiptStore,
): ExternalWriteDeps {
  return {
    adapter,
    receiptStore,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock,
  };
}

async function seedHeld(
  outbox: InMemoryOutbox,
  idempotencyKey: string,
  outboxId: string,
): Promise<void> {
  await holdWrite(
    {
      env: makeEnvelope({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}` }),
      action: makeProposedAction({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}` }),
      reason: "unreachable",
      workspaceId: "employer-work",
    },
    outbox,
    { clock, outboxId: () => outboxId },
  );
}

describe("drainOutbox — reconnect drain", () => {
  it("drains a held entry back online: create is issued once, receipt recorded, entry terminal", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_drain", "outbox_drain");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(createCalls.n).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.reused).toBe(0);

    // The entry advanced to a terminal receipt_recorded status.
    const entry = await outbox.get("outbox_drain");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
    expect(entry.value.writeReceipt).toBeDefined();
  });

  it("REPLAY-SAFE: draining an entry whose receipt already exists → reused, adapter.create NEVER called", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_replay", "outbox_replay");

    // A receipt already exists under this idempotencyKey (a prior successful write).
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_replay",
        canonicalObjectKey: "cok_idem_replay",
        receipt: makeWriteReceipt({ externalObjectId: "ext_prior" }),
      }),
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(createCalls.n).toBe(0); // NO duplicate external action
    expect(result.reused).toBe(1);
    expect(result.drained).toBe(0);

    const entry = await outbox.get("outbox_replay");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });

  it("CRASH MID-DRAIN: re-running drain over a partially-drained set double-applies nothing", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_c1", "outbox_c1");
    await seedHeld(outbox, "idem_c2", "outbox_c2");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const deps = {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    };

    // First drain: both go online, 2 creates.
    const first = await drainOutbox(outbox, deps);
    expect(createCalls.n).toBe(2);
    expect(first.drained).toBe(2);

    // Simulate a crash-and-restart: re-run the SAME drain. The two entries are now
    // terminal (receipt_recorded) → listDue excludes them → zero re-drive, zero
    // new creates. Nothing is double-applied.
    const second = await drainOutbox(outbox, deps);
    expect(createCalls.n).toBe(2); // unchanged
    expect(second.drained).toBe(0);
    expect(second.reused).toBe(0);
  });

  it("CRASH MID-DRAIN (receipt landed, entry not yet advanced): re-drive reuses receipt, no second create", async () => {
    // Model a crash AFTER the external create + receipt persist but BEFORE the
    // outbox entry was marked terminal. The entry is still due; re-driving it must
    // hit the stored receipt (replay gate) → reused, never a second create.
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_partial", "outbox_partial");
    // Receipt persisted under the entry's idempotencyKey (the create already ran).
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_partial",
        canonicalObjectKey: "cok_idem_partial",
        receipt: makeWriteReceipt({ externalObjectId: "ext_committed" }),
      }),
    );

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(createCalls.n).toBe(0);
    expect(result.reused).toBe(1);
    const entry = await outbox.get("outbox_partial");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });

  it("STILL UNREACHABLE: a held entry that stays down is re-held (non-terminal) with bumped attempts + backoff, never dropped", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_down", "outbox_down");

    const createCalls = { n: 0 };
    // existenceCheck faults 'unreachable' → dispatch returns { status:'held' }.
    const adapter = makeAdapter({
      existence: err<AdapterError>({ code: "unreachable", message: "still down" }),
      createCalls,
    });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(createCalls.n).toBe(0);
    expect(result.held).toBe(1);
    expect(result.drained).toBe(0);

    const entry = await outbox.get("outbox_down");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    // Still non-terminal (never expired/dropped), attempts bumped, backoff set.
    expect(["proposed", "retry_queued"]).toContain(entry.value.status);
    expect(entry.value.attempts).toBe(1);
    expect(entry.value.nextAttemptAt).toBeDefined();
    // Still due on a future listDue (once its backoff elapses) — not silently lost.
    const due = await outbox.listDue("2026-07-01T10:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (!isOk(due)) return;
    expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_down");
  });

  it("REJECTED: a vendor-rejected re-drive marks the entry terminal-rejected (typed, never a silent drop)", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_rej", "outbox_rej");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({
      create: err<AdapterError>({ code: "rejected", message: "vendor refused" }),
      createCalls,
    });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(result.failed).toBe(1);
    const entry = await outbox.get("outbox_rej");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("rejected");
  });

  it("returns { drained, reused, held, failed } and drives entries through the SAME dispatch pipeline", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_mix_ok", "outbox_mix_ok");
    await seedHeld(outbox, "idem_mix_reused", "outbox_mix_reused");
    await receiptStore.put(
      makeReceiptRecord({
        idempotencyKey: "idem_mix_reused",
        canonicalObjectKey: "cok_idem_mix_reused",
      }),
    );

    const createCalls = { n: 0 };
    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async () => ok(null),
      create: async () => {
        createCalls.n += 1;
        return ok(makeWriteReceipt({ externalObjectId: "ext_ok" }));
      },
      update: async () => ok(makeWriteReceipt()),
    };

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
    });

    expect(result.drained).toBe(1);
    expect(result.reused).toBe(1);
    expect(result.held).toBe(0);
    expect(result.failed).toBe(0);
    expect(createCalls.n).toBe(1); // only the novel one hit create
  });
});
