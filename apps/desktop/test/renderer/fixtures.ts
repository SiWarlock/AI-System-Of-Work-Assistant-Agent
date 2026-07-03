import {
  approvalStatusSchema,
  channelSchema,
  healthStateSchema,
  failureClassSchema,
  streamEventSchema,
  type StreamEvent,
} from "@sow/contracts";

// Real enum members pulled off the frozen schemas, so fixtures are genuinely
// schema-valid (they round-trip through streamEventSchema.parse below).
const status = approvalStatusSchema.options[0];
const channel = channelSchema.options[0];
const healthState = healthStateSchema.options[0];
const failureClass = failureClassSchema.options[0];
const ISO = "2026-07-03T00:00:00.000Z";

export function approvalEvent(seq: number, eventId: string, id = "app-1"): StreamEvent {
  return streamEventSchema.parse({
    name: "approval.update",
    seq,
    eventId,
    payload: { id, actionRef: "act-1", status, channel },
  });
}

export function healthEvent(seq: number, eventId: string, id = "h-1"): StreamEvent {
  return streamEventSchema.parse({
    name: "system.health",
    seq,
    eventId,
    payload: { id, failureClass, severity: "warning", state: healthState, openedAt: ISO },
  });
}

export function workflowEvent(seq: number, eventId: string, workflowId = "wf-1"): StreamEvent {
  return streamEventSchema.parse({
    name: "workflow.status",
    seq,
    eventId,
    payload: { workflowId, trigger: "manual", state: "running", idempotencyKey: "idem-1" },
  });
}

export function cardEvent(seq: number, eventId: string, cardId = "card-1"): StreamEvent {
  return streamEventSchema.parse({
    name: "read_model.change",
    seq,
    eventId,
    payload: { cardId, kind: "approvals", title: "Approvals", status: "ok", count: 3, updatedAt: ISO },
  });
}
