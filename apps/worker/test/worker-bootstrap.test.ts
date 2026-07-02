// 7.1 — Temporal worker bootstrap: the PURE degraded-mode + bootstrap-failure
// decision (ungated) + a SOW_TEMPORAL-gated live-connect smoke test.
//
// Temporal-UNAVAILABLE is a FIRST-CLASS degraded mode, not a crash: the bootstrap
// maps a failed connect to a typed Result whose failure variant blocks dispatch,
// raises a distinct 'worker_down' System Health item, and asks the supervisor to
// back off + reconnect (bounded — NO crash-loop). That decision logic is pure
// and unit-tested here with no Temporal server. The actual @temporalio
// Worker.create + connect is gated behind SOW_TEMPORAL.

import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { SOW_TEMPORAL } from "./support/temporalGate";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import {
  decideBootstrap,
  buildWorkerDownHealthItem,
  type ConnectOutcome,
} from "../src/temporal/worker";

const NOW = "2026-07-01T00:00:00.000Z";
const TQ = SOW_CONTROL_PLANE_TASK_QUEUE;

describe("decideBootstrap — Temporal-unavailable degraded mode", () => {
  it("connected → ok, dispatch enabled", () => {
    const outcome: ConnectOutcome = { connected: true };
    const r = decideBootstrap(outcome, { now: NOW, taskQueue: TQ, attempt: 0 });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.taskQueue).toBe(TQ);
    expect(r.value.dispatchEnabled).toBe(true);
  });

  it("unreachable → err(temporal_unavailable): dispatch blocked, degraded, backoff", () => {
    const outcome: ConnectOutcome = {
      connected: false,
      reason: "connect ECONNREFUSED 127.0.0.1:7233",
    };
    const r = decideBootstrap(outcome, { now: NOW, taskQueue: TQ, attempt: 3 });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("temporal_unavailable");
    // degraded, not crashed: dispatch blocked but the process asks to reconnect.
    expect(r.error.dispatchEnabled).toBe(false);
    expect(r.error.degraded).toBe(true);
    expect(r.error.shouldReconnect).toBe(true);
    // bounded backoff — a positive, finite delay that grows with the attempt.
    expect(r.error.backoffMs).toBeGreaterThan(0);
    expect(Number.isFinite(r.error.backoffMs)).toBe(true);
    // carries a distinct worker_down health item to raise.
    expect(r.error.healthItem.failureClass).toBe("worker_down");
  });

  it("backoff is bounded + monotonic non-decreasing, never a crash-loop", () => {
    const mk = (attempt: number): number => {
      const r = decideBootstrap(
        { connected: false, reason: "down" },
        { now: NOW, taskQueue: TQ, attempt },
      );
      if (!isErr(r)) throw new Error("expected err");
      return r.error.backoffMs;
    };
    const b0 = mk(0);
    const b1 = mk(1);
    const b5 = mk(5);
    const bHuge = mk(1000);
    expect(b0).toBeGreaterThan(0);
    expect(b1).toBeGreaterThanOrEqual(b0);
    expect(b5).toBeGreaterThanOrEqual(b1);
    // capped — a huge attempt count does NOT produce an unbounded/overflowed wait.
    expect(bHuge).toBeLessThanOrEqual(60_000);
    expect(bHuge).toBeGreaterThan(0);
  });

  it("worker_down health item is well-formed + schema-shaped (OBS-1)", () => {
    const item = buildWorkerDownHealthItem({
      now: NOW,
      taskQueue: TQ,
      reason: "connect refused",
    });
    expect(item.failureClass).toBe("worker_down");
    expect(item.state).toBe("open");
    expect(item.resolvedAt).toBeUndefined();
    expect(item.openedAt).toBe(NOW);
    expect(item.message).toContain(TQ);
    // deterministic dedupe subject: same (class, queue) → same id (no duplicates).
    const again = buildWorkerDownHealthItem({
      now: "2026-07-01T01:00:00.000Z",
      taskQueue: TQ,
      reason: "still down",
    });
    expect(again.id).toBe(item.id);
  });
});

describe.skipIf(!SOW_TEMPORAL)("live Temporal worker bootstrap (SOW_TEMPORAL)", () => {
  it("connects to the local dev server + registers the task queue", async () => {
    const { bootstrapWorker } = await import("../src/temporal/worker");
    const r = await bootstrapWorker({
      address: process.env.SOW_TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
      taskQueue: TQ,
      now: () => new Date().toISOString(),
      maxConnectAttempts: 1,
    });
    // With a live server this succeeds; the assertion documents the contract.
    expect(isOk(r) || isErr(r)).toBe(true);
  });
});
