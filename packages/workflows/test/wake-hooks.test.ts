// spec(§9, LIFE-6) — slice 7.3 WAKE / power-resume hooks.
//
// On a wake/power-resume event the durability spine must DRAIN the held outbox
// work (a mid-flight external activity that crashed is retried IDEMPOTENTLY, never
// leaving a partial uncommitted side effect). This slice ships two pieces:
//   • planWake — a PURE decision: given a wake event, decide WHETHER to drain
//     (and how many entries to sweep). No @temporalio, no Date.now().
//   • runWakeDrain — the ACTIVITY wrapper: when planWake says drain, call
//     drainOutbox (the §8 replay-safe drain) with the injected deps. drainOutbox
//     re-drives each held entry through the Tool-Gateway pipeline, so a crashed
//     activity re-drives with NO duplicate external write.
import { describe, it, expect, vi } from "vitest";
import { planWake, runWakeDrain } from "../src/runtime/wakeHooks";
import type { WakeEvent, WakeDrainDeps } from "../src/runtime/wakeHooks";
import { ok } from "@sow/contracts";
import type { OutboxRepository, OutboxEntry } from "@sow/integrations";
import type { DbResult } from "../src/ports/operational";

function makeOutbox(entries: OutboxEntry[]): OutboxRepository {
  const store = new Map(entries.map((e) => [e.outboxId, e] as const));
  return {
    enqueue: vi.fn((e: OutboxEntry): DbResult<OutboxEntry> => Promise.resolve(ok(e))),
    get: vi.fn(
      (id: string): DbResult<OutboxEntry> =>
        Promise.resolve(ok(store.get(id)!)),
    ),
    getByIdempotencyKey: vi.fn(
      (): DbResult<OutboxEntry> => Promise.resolve(ok(entries[0]!)),
    ),
    listDue: vi.fn((): DbResult<OutboxEntry[]> => Promise.resolve(ok([...store.values()]))),
    update: vi.fn(
      (e: OutboxEntry): DbResult<OutboxEntry> => {
        store.set(e.outboxId, e);
        return Promise.resolve(ok(e));
      },
    ),
  };
}

describe("spec(§9, LIFE-6) planWake — decides to drain on a wake event", () => {
  it("returns shouldDrain for a power-resume wake", () => {
    const event: WakeEvent = { reason: "power_resume", now: "2026-07-02T09:00:00.000Z" };
    const decision = planWake(event, { limit: 50 });
    expect(decision.shouldDrain).toBe(true);
    expect(decision.limit).toBe(50);
    expect(decision.now).toBe("2026-07-02T09:00:00.000Z");
  });

  it("returns shouldDrain for a network-reconnect wake", () => {
    const event: WakeEvent = { reason: "network_reconnect", now: "2026-07-02T09:00:00.000Z" };
    expect(planWake(event, { limit: 10 }).shouldDrain).toBe(true);
  });

  it("clamps a non-positive limit to a safe default (never a zero-width sweep that drops held work)", () => {
    const event: WakeEvent = { reason: "power_resume", now: "2026-07-02T09:00:00.000Z" };
    const decision = planWake(event, { limit: 0 });
    expect(decision.limit).toBeGreaterThan(0);
  });
});

describe("spec(§8, LIFE-6) runWakeDrain — wake triggers a replay-safe outbox drain", () => {
  const heldEntry: OutboxEntry = {
    outboxId: "ob-1",
    actionRef: "action-1",
    workspaceId: "ws-1",
    targetSystem: "todoist",
    canonicalObjectKey: "todoist:task:1",
    idempotencyKey: "idem-1",
    payloadHash: "hash-1",
    status: "retry_queued",
    payload: { title: "held task" },
    attempts: 1,
    enqueuedAt: "2026-07-02T08:00:00.000Z",
    nextAttemptAt: "2026-07-02T08:30:00.000Z",
    updatedAt: "2026-07-02T08:00:00.000Z",
  };

  function makeDrainDeps(outbox: OutboxRepository, adapterCreate: ReturnType<typeof vi.fn>): WakeDrainDeps {
    return {
      outbox,
      drainDeps: {
        gatewayDeps: {
          adapter: {
            targetSystem: "todoist" as OutboxEntry["targetSystem"] as never,
            existenceCheck: vi.fn(() => Promise.resolve(ok(null))),
            create: adapterCreate,
            update: vi.fn(() => Promise.resolve(ok({ externalObjectId: "x", recordedAt: "t" }))),
          } as never,
          receiptStore: {
            getByIdempotencyKey: vi.fn(() => Promise.resolve(undefined)),
            getByCanonicalObjectKey: vi.fn(() => Promise.resolve(undefined)),
            reserve: vi.fn(() => Promise.resolve({ kind: "reserved" })),
            release: vi.fn(() => Promise.resolve()),
            put: vi.fn(() => Promise.resolve()),
          } as never,
          requireApproval: () => ({ requiresApproval: false }),
          recordPendingApproval: () => Promise.resolve(ok(undefined)),
          isApproved: () => Promise.resolve(true),
          audit: () => Promise.resolve(),
          clock: () => "2026-07-02T09:00:00.000Z",
        },
        now: "2026-07-02T09:00:00.000Z",
        limit: 50,
        backoffCfg: { baseMs: 1000, maxMs: 60000, maxAttempts: 5 },
        clock: () => "2026-07-02T09:00:00.000Z",
      },
    };
  }

  it("calls drainOutbox and re-drives the held entry (a crashed activity is retried)", async () => {
    const outbox = makeOutbox([heldEntry]);
    const adapterCreate = vi.fn(() =>
      Promise.resolve(ok({ externalObjectId: "ext-1", recordedAt: "2026-07-02T09:00:00.000Z" })),
    );
    const event: WakeEvent = { reason: "power_resume", now: "2026-07-02T09:00:00.000Z" };

    const res = await runWakeDrain(event, makeDrainDeps(outbox, adapterCreate));
    expect(res.drained).toBe(1);
    expect(outbox.listDue).toHaveBeenCalled();
    expect(adapterCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-create a held entry that already has a receipt (idempotent re-drive, no duplicate)", async () => {
    const outbox = makeOutbox([heldEntry]);
    // adapter.create should never fire because the receiptStore returns an existing receipt.
    const adapterCreate = vi.fn(() =>
      Promise.resolve(ok({ externalObjectId: "ext-1", recordedAt: "2026-07-02T09:00:00.000Z" })),
    );
    const deps = makeDrainDeps(outbox, adapterCreate);
    // Override the receiptStore to report a prior receipt (crash-after-commit).
    (deps.drainDeps.gatewayDeps.receiptStore as unknown as {
      getByIdempotencyKey: ReturnType<typeof vi.fn>;
    }).getByIdempotencyKey = vi.fn(() =>
      Promise.resolve({
        idempotencyKey: "idem-1",
        canonicalObjectKey: "todoist:task:1",
        targetSystem: "todoist",
        payloadHash: "hash-1",
        receipt: { externalObjectId: "ext-prior", recordedAt: "2026-07-02T08:00:00.000Z" },
        recordedAt: "2026-07-02T08:00:00.000Z",
      }),
    );

    const event: WakeEvent = { reason: "power_resume", now: "2026-07-02T09:00:00.000Z" };
    const res = await runWakeDrain(event, deps);
    expect(res.reused).toBe(1);
    expect(adapterCreate).not.toHaveBeenCalled();
  });
});
