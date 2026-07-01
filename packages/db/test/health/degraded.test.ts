// Unit 2.8 — DB-unavailable DEGRADED mode (RED-first).
//
// §4 failure mode + §16 error-handling convention: when the operational DB is
// unavailable the store layer NEVER throws an opaque error across the boundary.
// Instead it (a) surfaces a distinct, audit-linked System Health item for the
// DB-unavailable class (§16 OBS-2), (b) QUEUES operations where possible rather
// than dropping them (a typed pending-queue result) and does NOT crash-loop on
// repeated unavailability (the item dedupes by failure class), and (c) returns a
// typed Result on EVERY path — nothing fails silently. Recovery drains the queue
// and resolves the health item.
import { describe, expect, it } from "vitest";
import { HealthItemSchema, isErr, isOk, type HealthItem } from "@sow/contracts";
import {
  DegradedModeController,
  DB_UNAVAILABLE_FAILURE_CLASS,
  type DegradedModeDeps,
} from "../../src/health/degraded-mode";

// Deterministic deps so the emitted HealthItem id / auditRef / openedAt are
// stable and assertable (the controller is allowed I/O — §4 db package — but the
// test pins the contract surface, not the wall clock).
function fixedDeps(): DegradedModeDeps {
  return {
    now: () => "2026-06-30T00:00:00.000Z",
    newHealthItemId: () => "health-db-unavailable-1",
    newAuditRef: () => "audit-degraded-1",
  };
}

interface WritePayload {
  readonly table: string;
  readonly row: number;
}

describe("DegradedModeController — DB-unavailable degraded mode (2.8)", () => {
  it("unavailable → degraded + audit-linked HealthItem emitted + op queued", () => {
    const c = new DegradedModeController(fixedDeps());
    expect(c.availability()).toBe("available");

    const res = c.onDbConnectionFailure<WritePayload>(new Error("ECONNREFUSED"), {
      opId: "op-1",
      kind: "outbox.enqueue",
      queueable: true,
      payload: { table: "outboxes", row: 1 },
    });

    expect(isOk(res)).toBe(true);
    if (!isOk(res)) throw new Error("expected ok");
    const t = res.value;

    // (a) distinct, audit-linked System Health item for the DB-unavailable class
    expect(t.availability).toBe("degraded");
    expect(t.healthItem.failureClass).toBe(DB_UNAVAILABLE_FAILURE_CLASS);
    expect(t.healthItem.state).toBe("open");
    expect(t.healthItem.auditRef).toBe("audit-degraded-1");
    expect(t.healthItem.message.length).toBeGreaterThan(0);

    // (b) the op was queued, not dropped — typed pending-queue result
    expect(t.queue.queued).toBe(true);
    if (!t.queue.queued) throw new Error("expected queued");
    expect(t.queue.entry.payload).toEqual({ table: "outboxes", row: 1 });

    // probe surface reflects degraded state + queue depth
    expect(c.availability()).toBe("degraded");
    expect(c.pending()).toHaveLength(1);
    expect(c.currentHealthItem()?.id).toBe("health-db-unavailable-1");
  });

  it("the emitted HealthItem is a valid @sow/contracts HealthItem", () => {
    const c = new DegradedModeController(fixedDeps());
    const res = c.enterDegraded(new Error("db gone"));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) throw new Error("expected ok");
    const item: HealthItem = res.value;
    expect(HealthItemSchema.safeParse(item).success).toBe(true);
  });

  it("queues where POSSIBLE: a non-queueable op surfaces health but is not queued", () => {
    const c = new DegradedModeController(fixedDeps());
    const res = c.onDbConnectionFailure(new Error("down"), {
      opId: "read-1",
      kind: "event-log.readSince",
      queueable: false,
      payload: { afterEventId: null },
    });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.availability).toBe("degraded");
    expect(res.value.queue.queued).toBe(false);
    if (res.value.queue.queued) throw new Error("expected NOT queued");
    expect(res.value.queue.reason).toBe("not_queueable");
    expect(c.pending()).toHaveLength(0);
    // health still surfaced — nothing fails silently
    expect(c.currentHealthItem()).not.toBeNull();
  });

  it("repeated DB-unavailable dedupes the item (no crash-loop, no duplicate health item)", () => {
    const c = new DegradedModeController(fixedDeps());
    const a = c.onDbConnectionFailure<WritePayload>(new Error("x"), {
      opId: "op-1",
      kind: "outbox.enqueue",
      queueable: true,
      payload: { table: "outboxes", row: 1 },
    });
    const b = c.onDbConnectionFailure<WritePayload>(new Error("y"), {
      opId: "op-2",
      kind: "outbox.enqueue",
      queueable: true,
      payload: { table: "outboxes", row: 2 },
    });
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) throw new Error("expected ok");
    // same persistent item across repeated failures (deduped by failure class)
    expect(a.value.healthItem.id).toBe(b.value.healthItem.id);
    // both ops queued — neither dropped
    expect(c.pending()).toHaveLength(2);
  });

  it("recovery drains the queue (FIFO) and resolves the health item", () => {
    const c = new DegradedModeController(fixedDeps());
    c.onDbConnectionFailure<WritePayload>(new Error("x"), {
      opId: "op-1",
      kind: "outbox.enqueue",
      queueable: true,
      payload: { table: "outboxes", row: 1 },
    });
    c.onDbConnectionFailure<WritePayload>(new Error("y"), {
      opId: "op-2",
      kind: "audit.append",
      queueable: true,
      payload: { table: "audit", row: 2 },
    });
    expect(c.pending()).toHaveLength(2);

    const rec = c.recover();
    expect(isOk(rec)).toBe(true);
    if (!isOk(rec)) throw new Error("expected ok");
    const drain = rec.value;

    expect(drain.availability).toBe("available");
    expect(drain.drained.map((e) => e.opId)).toEqual(["op-1", "op-2"]);
    expect(drain.resolvedHealthItem.state).toBe("resolved");
    expect(drain.resolvedHealthItem.resolvedAt).toBeDefined();

    // store is back to normal
    expect(c.availability()).toBe("available");
    expect(c.pending()).toHaveLength(0);
    expect(c.currentHealthItem()).toBeNull();
  });

  it("nothing fails silently: recover() while available returns a typed err, not a throw", () => {
    const c = new DegradedModeController(fixedDeps());
    const rec = c.recover();
    expect(isErr(rec)).toBe(true);
    if (!isErr(rec)) throw new Error("expected err");
    expect(typeof rec.error.code).toBe("string");
    expect(rec.error.message.length).toBeGreaterThan(0);
  });
});
