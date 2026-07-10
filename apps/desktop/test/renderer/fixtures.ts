import {
  approvalStatusSchema,
  channelSchema,
  healthStateSchema,
  failureClassSchema,
  streamEventSchema,
  type StreamEvent,
} from "@sow/contracts";
import type {
  UiSafeApproval,
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeRecentChange,
  UiSafeProjectDashboard,
  UiSafeIngestionItem,
} from "@sow/contracts/api/ui-safe";

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

// The UI-safe read-model shapes an initial query returns (same payloads the stream
// carries), for the hydrate reducers.
export function uiSafeCard(cardId = "card-1"): UiSafeDashboardCard {
  return { cardId, kind: "approvals", title: "Approvals", status: "ok", count: 3, updatedAt: ISO };
}

export function uiSafeApproval(
  id = "app-1",
  overrides: Partial<UiSafeApproval> = {},
): UiSafeApproval {
  return { id, actionRef: "act-1", status, channel, ...overrides };
}

export function uiSafeHealthItem(id = "h-1"): UiSafeHealthItem {
  return { id, failureClass, severity: "warning", state: healthState, openedAt: ISO };
}

export function uiSafeRecentChange(
  changeId = "chg-1",
  occurredAt: string = ISO,
): UiSafeRecentChange {
  return { changeId, kind: "commit", summary: "committed a.md rev 0c4", occurredAt };
}

export function uiSafeIngestionItem(
  sourceId = "src-1",
  overrides: Partial<UiSafeIngestionItem> = {},
): UiSafeIngestionItem {
  return { sourceId, type: "youtube_video", sensitivity: "personal", summary: "youtube_video", ...overrides };
}

export function uiSafeProjectDashboard(projectId = "prj-1"): UiSafeProjectDashboard {
  return {
    projectId,
    title: "Auth redesign",
    status: "in-progress",
    progress: { completedCount: 2, totalCount: 5, percentComplete: 40 },
    blockers: ["waiting on vendor SSO cert"],
    waitingItems: [],
    nextActions: ["wire the callback route"],
    evidenceRefs: ["src:plan-abc123"],
    docPack: [],
    updatedAt: ISO,
  };
}
