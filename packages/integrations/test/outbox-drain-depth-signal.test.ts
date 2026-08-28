// @sow/integrations — task 24.8 / REQ-NF-006: outbox DEPTH reaches System Health
// from the path that actually runs.
//
// ⛔ THE DEFECT. `outboxHealth` existed, was tested, and had exactly one caller:
// `holdWrite`. Holds are dormant until `§ARM-21`, so in production the probe never
// ran — while Phase 6's acceptance text asserted "Outbox depth and blocked
// write-throughs surface as a persistent, audit-linked System Health item (OBS-2)"
// as DELIVERED. A capability that exists and is never invoked is the shape this
// round has now found five times.
//
// The DRAIN is the path that runs (drain-on-wake, bound at the composition root) and
// it already lists the due set every pass — so the depth is in hand. It now
// classifies it through the SAME pure verdict `outboxHealth` uses, so there is one
// definition of "breach" rather than two that can drift.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import { drainOutbox, type DrainDeps } from "../src/tools/outbox-drain";
import { classifyOutboxDepth, type OutboxHealthProbe } from "../src/tools/outbox";
import type { OutboxRepository, OutboxEntry } from "../src/ports/persistence";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import { InMemoryReceiptStore } from "./support/fakes";

const NOW = "2026-07-01T00:00:00.000Z";

function entry(i: number): OutboxEntry {
  return {
    id: `ob-${i}`,
    workspaceId: "ws-1",
    actionRef: `act-${i}`,
    targetSystem: "drive",
    canonicalObjectKey: `cok-${i}`,
    idempotencyKey: `idem-${i}`,
    payloadHash: `hash-${i}`,
    payload: {},
    status: "retry_queued",
    attempts: 0,
    enqueuedAt: NOW,
    updatedAt: NOW,
  } as unknown as OutboxEntry;
}

/** An outbox with `n` due entries, or one whose `listDue` faults. */
function outboxWith(n: number, faulting = false): OutboxRepository {
  return {
    listDue: async () => (faulting ? err({ code: "unavailable", message: "db down" }) : ok(Array.from({ length: n }, (_, i) => entry(i)))),
    enqueue: async (e) => ok(e),
    update: async (e) => ok(e),
    get: async () => err({ code: "not_found", message: "no" }),
  } as unknown as OutboxRepository;
}

function drainDeps(over: Partial<DrainDeps> = {}): DrainDeps {
  const gatewayDeps = {
    adapter: {
      targetSystem: "drive",
      existenceCheck: async () => ok(null),
      create: async () => ok({ externalObjectId: "x", recordedAt: NOW }),
      update: async () => ok({ externalObjectId: "x", recordedAt: NOW }),
    },
    receiptStore: new InMemoryReceiptStore(),
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock: () => NOW,
  } as unknown as ExternalWriteDeps;
  return {
    gatewayDeps,
    workspaceId: "ws-1",
    now: NOW,
    limit: 100,
    clock: () => NOW,
    // Required by the re-hold path (`computeNextAttemptAt`); a held outcome without
    // it throws inside the backoff rather than re-holding.
    backoffCfg: { baseMs: 1000, maxMs: 60_000, maxAttempts: 5 },
    ...over,
  } as DrainDeps;
}

describe("classifyOutboxDepth — the shared pure verdict", () => {
  it("at or below the threshold is ok; above it breaches with an outbox_blocked signal", () => {
    expect(classifyOutboxDepth(5, 5)).toEqual({ kind: "ok" });
    const breach = classifyOutboxDepth(6, 5);
    expect(breach.kind).toBe("breach");
    if (breach.kind !== "breach") return;
    expect(breach.signal.failureClass).toBe("outbox_blocked");
    expect(breach.signal.subjectRef).toBe("outbox");
    expect(breach.signal.message).toContain("6");
  });
});

describe("drainOutbox — the depth signal reaches the sink (24.8)", () => {
  it("a backlog over the threshold reports a BREACH, once per pass", async () => {
    const seen: OutboxHealthProbe[] = [];
    await drainOutbox(
      outboxWith(9),
      drainDeps({ health: { depthThreshold: 5, sink: (p) => seen.push(p) } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("breach");
  });

  it("a queue at or below the threshold reports `ok` — the sink hears every pass, not only bad ones", async () => {
    const seen: OutboxHealthProbe[] = [];
    await drainOutbox(outboxWith(2), drainDeps({ health: { depthThreshold: 5, sink: (p) => seen.push(p) } }));
    expect(seen).toEqual([{ kind: "ok" }]);
  });

  it("a store fault reports `probe_failed`, NOT silence", async () => {
    // Silence would be indistinguishable from a healthy empty queue — the exact
    // ambiguity the tri-state exists to remove.
    const seen: OutboxHealthProbe[] = [];
    await drainOutbox(
      outboxWith(0, true),
      drainDeps({ health: { depthThreshold: 5, sink: (p) => seen.push(p) } }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("probe_failed");
    if (seen[0]?.kind !== "probe_failed") return;
    // Rule 7: a FIXED literal, never the store's raw error text.
    expect(seen[0].reason).not.toContain("db down");
  });

  it("the signal is emitted BEFORE any dispatch — a backlog surfaces even if the drain then fails", async () => {
    const order: string[] = [];
    await drainOutbox(
      outboxWith(9),
      drainDeps({
        health: { depthThreshold: 5, sink: () => order.push("health") },
        dispatch: async () => {
          order.push("dispatch");
          return { status: "held", reason: "still down" };
        },
      }),
    );
    expect(order[0]).toBe("health");
  });

  it("a THROWING sink never fails the drain — health must not break the write path", async () => {
    const res = await drainOutbox(
      outboxWith(9),
      drainDeps({
        health: {
          depthThreshold: 5,
          sink: () => {
            throw new Error("sink exploded");
          },
        },
        dispatch: async () => ({ status: "reused", receipt: { externalObjectId: "x", recordedAt: NOW } }),
      }),
    );
    expect(res.reused).toBe(9);
  });

  it("DORMANCY: no health bound ⇒ no probe, byte-identical to before the field existed", async () => {
    const res = await drainOutbox(
      outboxWith(3),
      drainDeps({ dispatch: async () => ({ status: "reused", receipt: { externalObjectId: "x", recordedAt: NOW } }) }),
    );
    expect(res.reused).toBe(3);
  });
});
