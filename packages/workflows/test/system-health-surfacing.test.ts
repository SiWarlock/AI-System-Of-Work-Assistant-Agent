// spec(§9 / §16) — slice 7.5 System-Health SURFACING orchestration.
//
// This is the FAILURE SINK every later §9 workflow (7.6–7.18) routes through:
// NOTHING fails silently (§16). Every cross-subsystem workflow failure is routed
// to the retry/write-outbox AND/OR a HealthItem — at least one, never neither. It
// also exposes read-model PROJECTIONS (last/next/failed run status, queue/outbox
// depth, blocked write-throughs) for §10/§11 to render.
//
// PURE + injected: over an in-memory HealthItemStore + OutboxSink + a FakeClock.
// No Temporal server, no real DB, no Date.now(). Every path returns a typed
// Result — never throws (§16).
import { describe, it, expect } from "vitest";
import { isOk, isErr, auditId } from "@sow/contracts";
import type { HealthItem } from "@sow/contracts";
import type { OutboxEntry } from "../src/ports/operational";
import {
  surfaceWorkflowFailure,
  projectSystemHealth,
} from "../src/workflows/systemHealthSurfacing";
import type { OutboxSink } from "../src/workflows/systemHealthSurfacing";
import { FakeClock, InMemoryHealthItemStore } from "./support/fakes";

const T0 = "2026-07-01T00:00:00.000Z";

// --- a minimal in-memory OutboxSink (records retry enqueues) ---------------
class InMemoryOutboxSink implements OutboxSink {
  readonly entries: OutboxEntry[] = [];
  enqueueRetry(entry: OutboxEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

function makeOutboxEntry(partial: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: "ob-1",
    actionRef: "action-1",
    workspaceId: "ws-1",
    targetSystem: "gcal",
    canonicalObjectKey: "gcal:event:abc",
    idempotencyKey: "idem-1",
    payloadHash: "hash-1",
    status: "pending",
    attempts: 1,
    enqueuedAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

describe("spec(§16) surfaceWorkflowFailure — nothing fails silently (outbox OR health, never neither)", () => {
  it("a RETRYABLE failure carrying a retry entry routes to the OUTBOX", async () => {
    const health = new InMemoryHealthItemStore();
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });

    const res = await surfaceWorkflowFailure(
      {
        failureClass: "write_through_failed",
        subjectRef: "gcal:event:abc",
        message: "target unreachable",
        auditRef: auditId("audit-1"),
        retry: makeOutboxEntry(),
      },
      { health, outbox, clock },
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // Routed to the outbox for retry.
    expect(res.value.routedToOutbox).toBe(true);
    expect(outbox.entries).toHaveLength(1);
    // AND surfaced a health item (blocked write-throughs are operator-visible).
    expect(res.value.routedToHealth).toBe(true);
    expect((await health.list())).toHaveLength(1);
  });

  it("a NON-retryable failure (no retry entry) still surfaces a HealthItem — never silent", async () => {
    const health = new InMemoryHealthItemStore();
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });

    const res = await surfaceWorkflowFailure(
      {
        failureClass: "schema_rejection",
        subjectRef: "candidate-1",
        message: "rejected by candidate gate",
        auditRef: auditId("audit-1"),
      },
      { health, outbox, clock },
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.routedToOutbox).toBe(false);
    expect(outbox.entries).toHaveLength(0);
    // The failure is NOT silent: a health item exists.
    expect(res.value.routedToHealth).toBe(true);
    expect((await health.list())).toHaveLength(1);
  });

  it("INVARIANT: every failure routes to outbox OR health — at least one is always true", async () => {
    const health = new InMemoryHealthItemStore();
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });

    const res = await surfaceWorkflowFailure(
      {
        failureClass: "budget_breach",
        subjectRef: "job-1",
        message: "budget breached",
        auditRef: auditId("audit-1"),
      },
      { health, outbox, clock },
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.routedToOutbox || res.value.routedToHealth).toBe(true);
  });

  it("uses the injected clock for the surfaced item's openedAt (no Date.now())", async () => {
    const health = new InMemoryHealthItemStore();
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });
    await surfaceWorkflowFailure(
      {
        failureClass: "connector_unreachable",
        subjectRef: "connector-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health, outbox, clock },
    );
    const items = await health.list();
    expect(items).toHaveLength(1);
    expect((items[0] as HealthItem).openedAt).toBe(T0);
  });

  it("dedupes on recurrence: a repeated failure updates the item, still one health item", async () => {
    const health = new InMemoryHealthItemStore();
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });
    const input = {
      failureClass: "connector_unreachable" as const,
      subjectRef: "connector-1",
      message: "down",
      auditRef: auditId("audit-1"),
    };
    await surfaceWorkflowFailure(input, { health, outbox, clock });
    await surfaceWorkflowFailure(input, { health, outbox, clock });
    expect((await health.list())).toHaveLength(1);
  });

  it("returns a typed err (never throws) when the health store rejects", async () => {
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });
    const failingHealth = {
      getByDedupeKey(): Promise<HealthItem | undefined> {
        return Promise.resolve(undefined);
      },
      put(): Promise<void> {
        return Promise.reject(new Error("db down"));
      },
      list(): Promise<HealthItem[]> {
        return Promise.resolve([]);
      },
    };
    const res = await surfaceWorkflowFailure(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health: failingHealth, outbox, clock },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("surface_failed");
  });

  // R2 restore (24.73 census): a health-store READ fault (the dedupe lookup) and a
  // WRITE fault (the persist) previously rendered as ONE indistinguishable sentence
  // (a bare `(${code})`, both `persist_failed`). The operator — the PRIMARY consumer
  // of this sink — cannot act on "surface_failed" alone: a full disk, a closed
  // connection, and a bad-shape candidate call for different responses. Restored:
  // the two arms must render DIFFERENT messages.
  it("a READ fault (dedupe lookup) and a WRITE fault (persist) render DIFFERENTLY diagnosable messages", async () => {
    const outbox = new InMemoryOutboxSink();
    const clock = new FakeClock({ now: T0 });

    const readFaultHealth = {
      getByDedupeKey(): Promise<HealthItem | undefined> {
        return Promise.reject(new Error("connection closed"));
      },
      put(): Promise<void> {
        throw new Error("unreachable: put must not be called after a read fault");
      },
      list(): Promise<HealthItem[]> {
        return Promise.resolve([]);
      },
    };
    const writeFaultHealth = {
      getByDedupeKey(): Promise<HealthItem | undefined> {
        return Promise.resolve(undefined);
      },
      put(): Promise<void> {
        return Promise.reject(new Error("disk full"));
      },
      list(): Promise<HealthItem[]> {
        return Promise.resolve([]);
      },
    };

    const readRes = await surfaceWorkflowFailure(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health: readFaultHealth, outbox, clock },
    );
    const writeRes = await surfaceWorkflowFailure(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health: writeFaultHealth, outbox, clock },
    );

    expect(isErr(readRes)).toBe(true);
    expect(isErr(writeRes)).toBe(true);
    if (!isErr(readRes) || !isErr(writeRes)) return;

    // Both share the same closed `code` (every consumer switches on it)…
    expect(readRes.error.code).toBe("surface_failed");
    expect(writeRes.error.code).toBe("surface_failed");
    // …but the MESSAGE — what an operator actually reads — must differ: a read
    // fault is not a write fault. Mutation-kill: a collapse back to a bare
    // `(${code})` (or any other shared string) fails this.
    expect(readRes.error.message).not.toBe(writeRes.error.message);
    expect(readRes.error.message).toContain("failed to read the current health item");
    expect(writeRes.error.message).toContain("failed to persist the health item");

    // No raw cause ever crosses (rule 7 stays intact — only the safe fixed
    // message strings, never the thrown Error object's stack/detail).
    expect(JSON.stringify(readRes)).not.toContain("connection closed");
    expect(JSON.stringify(writeRes)).not.toContain("disk full");
  });
});

describe("spec(§10/§11) projectSystemHealth — read-model projection shape", () => {
  it("projects last/next/failed run status, queue + outbox depth, blocked write-throughs, open health items", () => {
    const projection = projectSystemHealth({
      runs: [
        { workflowId: "wf-1", state: "completed", trigger: "schedule", lastRunAt: T0 },
        { workflowId: "wf-2", state: "failed", trigger: "connector_event", lastRunAt: T0 },
        { workflowId: "wf-3", state: "running", trigger: "owner_action" },
      ],
      queueDepth: 3,
      outboxDepth: 2,
      blockedWriteThroughs: 1,
      healthItems: [
        {
          id: "connector_unreachable|c-1",
          failureClass: "connector_unreachable",
          severity: "warn",
          message: "down",
          auditRef: auditId("audit-1"),
          openedAt: T0,
          state: "open",
        },
        {
          id: "budget_breach|j-1",
          failureClass: "budget_breach",
          severity: "error",
          message: "over",
          auditRef: auditId("audit-2"),
          openedAt: T0,
          state: "resolved",
          resolvedAt: T0,
        },
      ],
      nextScheduledRunAt: "2026-07-02T00:00:00.000Z",
    });

    // Run status rollup.
    expect(projection.runCounts.completed).toBe(1);
    expect(projection.runCounts.failed).toBe(1);
    expect(projection.runCounts.running).toBe(1);
    expect(projection.failedRuns.map((r) => r.workflowId)).toEqual(["wf-2"]);

    // Depths surfaced verbatim.
    expect(projection.queueDepth).toBe(3);
    expect(projection.outboxDepth).toBe(2);
    expect(projection.blockedWriteThroughs).toBe(1);

    // Only OPEN/acknowledged (unresolved) health items count as active.
    expect(projection.openHealthItemCount).toBe(1);

    // Next scheduled run surfaced.
    expect(projection.nextScheduledRunAt).toBe("2026-07-02T00:00:00.000Z");
  });

  it("is defensive with empty inputs (all-zero, no failed runs)", () => {
    const projection = projectSystemHealth({
      runs: [],
      queueDepth: 0,
      outboxDepth: 0,
      blockedWriteThroughs: 0,
      healthItems: [],
    });
    expect(projection.runCounts.completed).toBe(0);
    expect(projection.failedRuns).toEqual([]);
    expect(projection.openHealthItemCount).toBe(0);
    expect(projection.queueDepth).toBe(0);
    expect(projection.nextScheduledRunAt).toBeUndefined();
  });

  it("counts acknowledged items as still-active (only resolved clears an item)", () => {
    const projection = projectSystemHealth({
      runs: [],
      queueDepth: 0,
      outboxDepth: 0,
      blockedWriteThroughs: 0,
      healthItems: [
        {
          id: "x|1",
          failureClass: "worker_down",
          severity: "error",
          message: "m",
          auditRef: auditId("a"),
          openedAt: T0,
          state: "acknowledged",
        },
      ],
    });
    expect(projection.openHealthItemCount).toBe(1);
  });
});
