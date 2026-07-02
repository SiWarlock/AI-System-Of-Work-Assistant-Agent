// Push-stream event catalog contract test (task 8.2, §10 push stream). Freezes
// the discriminated StreamEvent union over the 4 EventName classes + its Zod
// schema: covers exactly the 4 classes, validates one sample per class, and
// rejects an unknown event name. PURE — no @trpc import (the initTRPC router is
// built in apps/worker later; this only freezes the shared event TYPES).
import { describe, expect, it } from "vitest";
import { EventName } from "../../src/events/catalog";
import { streamEventSchema, STREAM_EVENT_NAMES } from "../../src/api/events";

// One valid sample StreamEvent per EventName class (matching UI-safe payload).
const SAMPLES = {
  "workflow.status": {
    name: "workflow.status",
    seq: 1,
    eventId: "evt-1",
    payload: {
      workflowId: "wf-1",
      trigger: "schedule",
      state: "running",
      idempotencyKey: "wf-1:2026-06-30",
    },
  },
  "approval.update": {
    name: "approval.update",
    seq: 2,
    eventId: "evt-2",
    payload: {
      id: "approval-1",
      actionRef: "action-1",
      status: "pending",
      channel: "mac",
    },
  },
  "system.health": {
    name: "system.health",
    seq: 3,
    eventId: "evt-3",
    payload: {
      id: "health-1",
      failureClass: "worker_down",
      severity: "critical",
      state: "open",
      openedAt: "2026-06-30T00:00:00.000Z",
    },
  },
  "read_model.change": {
    name: "read_model.change",
    seq: 4,
    eventId: "evt-4",
    payload: {
      cardId: "card-1",
      kind: "approvals",
      title: "Pending approvals",
      status: "ok",
      count: 3,
      updatedAt: "2026-06-30T00:00:00.000Z",
    },
  },
} as const;

describe("StreamEvent push-stream union — spec(§10 push stream)", () => {
  // ── Coverage: the union covers EXACTLY the 4 EventName classes ───────────────
  it("covers exactly the 4 EventName classes (no more, no fewer)", () => {
    expect([...STREAM_EVENT_NAMES].sort()).toEqual([...EventName].sort());
  });

  // ── One valid sample per class validates ────────────────────────────────────
  for (const name of EventName) {
    it(`streamEventSchema validates a "${name}" sample`, () => {
      const res = streamEventSchema.safeParse(SAMPLES[name]);
      expect(res.success).toBe(true);
    });
  }

  // ── Rejects an unknown event name (discriminant is closed) ───────────────────
  it("rejects an unknown event name", () => {
    const bad = streamEventSchema.safeParse({
      name: "secret.leak",
      seq: 1,
      eventId: "evt-x",
      payload: {},
    });
    expect(bad.success).toBe(false);
  });

  // ── seq + eventId envelope fields are required + typed ───────────────────────
  it("rejects a missing seq (monotonic per-stream cursor required)", () => {
    const { seq: _seq, ...rest } = SAMPLES["workflow.status"];
    expect(streamEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-integer seq", () => {
    expect(
      streamEventSchema.safeParse({ ...SAMPLES["workflow.status"], seq: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a missing eventId (tracked() resume id required)", () => {
    const { eventId: _eventId, ...rest } = SAMPLES["approval.update"];
    expect(streamEventSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty eventId", () => {
    expect(
      streamEventSchema.safeParse({ ...SAMPLES["approval.update"], eventId: "" }).success,
    ).toBe(false);
  });

  // ── Discriminant coupling: a class must carry its matching payload shape ─────
  it("rejects a class carrying the wrong payload shape (workflow.status w/ approval payload)", () => {
    const bad = streamEventSchema.safeParse({
      name: "workflow.status",
      seq: 1,
      eventId: "evt-1",
      payload: SAMPLES["approval.update"].payload,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown key inside a payload (UI-safe payloads are strict)", () => {
    const bad = streamEventSchema.safeParse({
      ...SAMPLES["system.health"],
      payload: { ...SAMPLES["system.health"].payload, message: "raw" },
    });
    expect(bad.success).toBe(false);
  });
});
