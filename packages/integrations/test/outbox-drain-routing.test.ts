// @sow/integrations — task 21.4a: drainOutbox TARGET-ROUTED dispatch (the
// unrouted-sentinel hole).
//
// Since the 21.1/21.2 write-adapter registry landed, the LIVE dispatch path no
// longer calls `dispatchExternalWrite` directly with a real per-vendor adapter —
// it routes through `dispatchRouted(registry, env, action, deps)`, and the
// composition root's `ExternalWriteDeps.adapter` is deliberately the fail-closed
// `createUnroutedWriteAdapter()` sentinel (every op REJECTS) so a dispatch that
// bypasses the registry is caught, never silently mis-routed to whatever adapter
// happens to sit on `deps.adapter`. Before this slice, `drainOutbox` called
// `dispatchExternalWrite` directly — exactly such a bypass — so every re-driven
// held entry hit the sentinel and was folded into a TERMINAL `rejected` status on
// the very first drain pass.
//
// This suite pins the fix: `DrainDeps.dispatch` is an OPTIONAL injectable seam.
// Bound, the drain re-drives through it (so it can share the SAME routing
// decision as the live path — the worker binds `dispatchRouted` here). Absent,
// the drain falls back to the pre-21.4 `dispatchExternalWrite` call, byte-
// equivalent to before. See `outbox-drain.test.ts` for the un-routed-scenario
// suite this one is additive to — none of its 10 cases are touched here.
import { describe, it, expect, vi } from "vitest";
import type { Result, WriteReceipt, ProposedAction, ExternalWriteEnvelope, TargetSystem } from "@sow/contracts";
import { ok, isOk } from "@sow/contracts";
import { drainOutbox } from "../src/tools/outbox-drain";
import { holdWrite } from "../src/tools/outbox";
import type { TargetWriteAdapter, ExistingObject, AdapterError } from "../src/tools/adapter-port";
import { dispatchExternalWrite, type ExternalWriteDeps, type ExternalWriteResult } from "../src/tools/gateway";
import { createUnroutedWriteAdapter } from "../src/tools/write-adapter-registry";
import { nextDelayMs, EXHAUSTED, type BackoffConfig } from "../src/connectors/backoff";
import {
  InMemoryOutbox,
  InMemoryReceiptStore,
  makeEnvelope,
  makeProposedAction,
  makeWriteReceipt,
  makeOutboxEntry,
} from "./support/fakes";

const clock = (): string => "2026-07-01T00:00:00.000Z";
const backoffCfg: BackoffConfig = { baseMs: 1000, maxMs: 60000, maxAttempts: 5 };

// A configurable fake adapter that records how many times create() is invoked —
// mirrors outbox-drain.test.ts's own local helper (not shared beyond fakes.ts;
// each suite keeps its own minimal fixture, matching the existing pattern).
function makeAdapter(opts: {
  existence?: Result<ExistingObject | null, AdapterError>;
  create?: Result<WriteReceipt, AdapterError>;
  createCalls: { n: number };
}): TargetWriteAdapter {
  return {
    targetSystem: "todoist",
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
  targetSystem: TargetSystem = "drive",
): Promise<void> {
  await holdWrite(
    {
      env: makeEnvelope({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}`, targetSystem }),
      action: makeProposedAction({ idempotencyKey, canonicalObjectKey: `cok_${idempotencyKey}`, targetSystem }),
      reason: "unreachable",
      workspaceId: "employer-work",
    },
    outbox,
    { clock, outboxId: () => outboxId },
  );
}

describe("drainOutbox — 21.4a target-routed dispatch", () => {
  it("a held entry is re-driven through the INJECTED routed dispatch, not the unrouted sentinel", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_routed", "outbox_routed", "todoist");

    // `gatewayDeps.adapter` is the SAME fail-closed sentinel the composition root
    // binds — if the drain ever fell back to calling it directly (the pre-fix
    // bypass), every op on it rejects. The injected `dispatch` below simulates
    // the live `dispatchRouted` path: it ignores the sentinel entirely and
    // returns as though it routed to the real per-vendor todoist adapter.
    const routedReceipt = makeWriteReceipt({ externalObjectId: "ext_todoist_routed" });
    const dispatch = vi.fn(
      async (
        _env: ExternalWriteEnvelope,
        _action: ProposedAction,
        _deps: ExternalWriteDeps,
      ): Promise<ExternalWriteResult> => ({ status: "created", receipt: routedReceipt }),
    );

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(createUnroutedWriteAdapter(), receiptStore),
      // 24.50 (PKG-INT-2, landed after this test was authored): DrainDeps.workspaceId is REQUIRED —
      // every caller must state its scope so a cross-workspace redrive is unrepresentable. These
      // fixtures all persist `workspaceId: "employer-work"`, so binding the drain to that workspace
      // keeps each case exercising ROUTING, not the workspace skip path (counts.skipped stays 0).
      workspaceId: "employer-work",
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [calledEnv, calledAction] = dispatch.mock.calls[0]!;
    expect(calledEnv).toEqual(
      expect.objectContaining({
        targetSystem: "todoist",
        idempotencyKey: "idem_routed",
        canonicalObjectKey: "cok_idem_routed",
        // `preconditions` exists ONLY on `ExternalWriteEnvelope` (never on
        // `ProposedAction`) — asserting it here (in the FIRST positional arg)
        // discriminates the (env, action) call order, not just shared keys.
        preconditions: ["exists_check"],
      }),
    );
    expect(calledAction).toEqual(
      expect.objectContaining({
        targetSystem: "todoist",
        idempotencyKey: "idem_routed",
        // `approvalPolicy` exists ONLY on `ProposedAction` — asserting it here
        // (in the SECOND positional arg) discriminates the call order.
        approvalPolicy: expect.any(String),
      }),
    );

    // `skipped: 0` is load-bearing here, not bookkeeping: it proves the workspace bind above did NOT
    // divert these entries to the 24.50 skip path, so this case still exercises ROUTING.
    expect(result).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 0 });

    const entry = await outbox.get("outbox_routed");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    // NOT "rejected" — the pre-fix defect folded every re-driven held entry into
    // the sentinel's rejection, killing it terminally on the first drain pass.
    expect(entry.value.status).toBe("receipt_recorded");
    expect(entry.value.writeReceipt).toEqual(routedReceipt);
  });

  it("omitting dispatch is byte-equivalent — the default is dispatchExternalWrite", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_default", "outbox_default");

    const createCalls = { n: 0 };
    const adapter = makeAdapter({ createCalls });
    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(adapter, receiptStore),
      // 24.50 (PKG-INT-2, landed after this test was authored): DrainDeps.workspaceId is REQUIRED —
      // every caller must state its scope so a cross-workspace redrive is unrepresentable. These
      // fixtures all persist `workspaceId: "employer-work"`, so binding the drain to that workspace
      // keeps each case exercising ROUTING, not the workspace skip path (counts.skipped stays 0).
      workspaceId: "employer-work",
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      // `dispatch` intentionally omitted — must fall back to dispatchExternalWrite.
    });

    expect(createCalls.n).toBe(1);
    // `skipped: 0` is load-bearing here, not bookkeeping: it proves the workspace bind above did NOT
    // divert these entries to the 24.50 skip path, so this case still exercises ROUTING.
    expect(result).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 0 });

    const entry = await outbox.get("outbox_default");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });

  it("a replay of the same idempotencyKey returns reused and issues no second create", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();

    // Two DUE entries sharing the SAME idempotencyKey + canonicalObjectKey —
    // seeded directly via `outbox.enqueue` (not `holdWrite`, whose own replay
    // gate on idempotencyKey would collapse this to a single entry). Models two
    // outbox rows that both point at the same logical external object landing in
    // the SAME drain pass.
    const shared = {
      idempotencyKey: "idem_dup",
      canonicalObjectKey: "cok_dup",
      targetSystem: "todoist",
      payloadHash: "sha256:deadbeef",
      status: "retry_queued",
      attempts: 0,
      enqueuedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    } as const;
    await outbox.enqueue(makeOutboxEntry({ outboxId: "outbox_dup_1", ...shared }));
    await outbox.enqueue(makeOutboxEntry({ outboxId: "outbox_dup_2", ...shared }));

    const createCalls = { n: 0 };
    const routedAdapter = makeAdapter({ createCalls });
    // The RAW `gatewayDeps.adapter` is the fail-closed SENTINEL — if the drain
    // ever bypassed the injected `dispatch` (the pre-fix defect), every op on it
    // rejects and none of the assertions below would hold. `dispatch` mirrors
    // the real `dispatchRouted`: it overrides the sentinel with the routed
    // (working) adapter and delegates to the real `dispatchExternalWrite`
    // pipeline — so this proves the seam is genuinely INVOKED per-entry, wired
    // to the real pipeline, still enforces safety rule 3 (zero duplicate
    // external writes) across TWO due entries drained in one pass.
    const dispatch = vi.fn(
      (env: ExternalWriteEnvelope, action: ProposedAction, deps: ExternalWriteDeps): Promise<ExternalWriteResult> =>
        dispatchExternalWrite(env, action, { ...deps, adapter: routedAdapter }),
    );

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(createUnroutedWriteAdapter(), receiptStore),
      // 24.50 (PKG-INT-2, landed after this test was authored): DrainDeps.workspaceId is REQUIRED —
      // every caller must state its scope so a cross-workspace redrive is unrepresentable. These
      // fixtures all persist `workspaceId: "employer-work"`, so binding the drain to that workspace
      // keeps each case exercising ROUTING, not the workspace skip path (counts.skipped stays 0).
      workspaceId: "employer-work",
      now: "2026-07-01T00:00:00.000Z",
      limit: 100,
      backoffCfg,
      clock,
      dispatch,
    });

    // Called once per due entry — proves the seam is exercised for BOTH, not
    // just the first.
    expect(dispatch).toHaveBeenCalledTimes(2);
    // The first entry processed creates + records the receipt; the second
    // (same idempotencyKey) hits the replay gate — create fires AT MOST once
    // across both.
    expect(createCalls.n).toBeLessThanOrEqual(1);
    expect(createCalls.n).toBe(1);
    expect(result.drained).toBe(1);
    expect(result.reused).toBe(1);
    expect(result.held).toBe(0);
    expect(result.failed).toBe(0);

    const e1 = await outbox.get("outbox_dup_1");
    const e2 = await outbox.get("outbox_dup_2");
    expect(isOk(e1)).toBe(true);
    expect(isOk(e2)).toBe(true);
    if (!isOk(e1) || !isOk(e2)) return;
    expect(e1.value.status).toBe("receipt_recorded");
    expect(e2.value.status).toBe("receipt_recorded");
  });

  it("a routed dispatch that returns held re-holds with a bumped attempt count and a bounded nextAttemptAt", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_held_routed", "outbox_held_routed");

    const dispatch = vi.fn(
      async (
        _env: ExternalWriteEnvelope,
        _action: ProposedAction,
        _deps: ExternalWriteDeps,
      ): Promise<ExternalWriteResult> => ({ status: "held", reason: "vendor unreachable" }),
    );
    // Explicit deterministic jitter — no `Math.random()` must be reachable.
    const jitter = (base: number): number => base + 111;

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(createUnroutedWriteAdapter(), receiptStore),
      // 24.50 (PKG-INT-2, landed after this test was authored): DrainDeps.workspaceId is REQUIRED —
      // every caller must state its scope so a cross-workspace redrive is unrepresentable. These
      // fixtures all persist `workspaceId: "employer-work"`, so binding the drain to that workspace
      // keeps each case exercising ROUTING, not the workspace skip path (counts.skipped stays 0).
      workspaceId: "employer-work",
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      dispatch,
      jitter,
    });

    // Proves the "held" outcome came from the INJECTED dispatch, not from the
    // sentinel's own existence-check fault coincidentally also mapping to held.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.held).toBe(1);
    expect(result.drained).toBe(0);

    const entry = await outbox.get("outbox_held_routed");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.attempts).toBe(1);
    expect(["proposed", "retry_queued"]).toContain(entry.value.status);

    const expectedDelay = nextDelayMs(1, backoffCfg, jitter);
    const expectedDelayMs = expectedDelay === EXHAUSTED ? backoffCfg.maxMs : expectedDelay;
    const expectedNextAttemptAt = new Date(new Date(clock()).getTime() + expectedDelayMs).toISOString();
    expect(entry.value.nextAttemptAt).toBe(expectedNextAttemptAt);
  });

  it("an unregistered targetSystem fails closed as rejected, never a silent drop", async () => {
    const outbox = new InMemoryOutbox();
    const receiptStore = new InMemoryReceiptStore();
    await seedHeld(outbox, "idem_unreg", "outbox_unreg");

    const updateSpy = vi.spyOn(outbox, "update");
    const dispatch = vi.fn(
      async (
        _env: ExternalWriteEnvelope,
        _action: ProposedAction,
        _deps: ExternalWriteDeps,
      ): Promise<ExternalWriteResult> => ({
        status: "rejected",
        reason: "unregistered target system: no write adapter registered",
      }),
    );

    const result = await drainOutbox(outbox, {
      gatewayDeps: makeGatewayDeps(createUnroutedWriteAdapter(), receiptStore),
      // 24.50 (PKG-INT-2, landed after this test was authored): DrainDeps.workspaceId is REQUIRED —
      // every caller must state its scope so a cross-workspace redrive is unrepresentable. These
      // fixtures all persist `workspaceId: "employer-work"`, so binding the drain to that workspace
      // keeps each case exercising ROUTING, not the workspace skip path (counts.skipped stays 0).
      workspaceId: "employer-work",
      now: clock(),
      limit: 100,
      backoffCfg,
      clock,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
    expect(result.drained).toBe(0);
    expect(result.held).toBe(0);
    // Never a silent drop: outbox.update was called (a rejected outcome is
    // persisted, typed — not dropped without a trace).
    expect(updateSpy).toHaveBeenCalledTimes(1);

    const entry = await outbox.get("outbox_unreg");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("rejected");
  });
});
