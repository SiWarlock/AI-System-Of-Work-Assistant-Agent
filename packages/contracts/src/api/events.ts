// Push-stream event catalog (task 8.2, §10 push stream). The discriminated
// StreamEvent union the §10 tRPC push stream carries to the renderer — one
// variant per EventName class, each pairing the class with its UI-safe payload.
// SECURITY-CRITICAL: the payloads are the standalone UI-safe projections (see
// `./ui-safe`), so a StreamEvent can only ever carry a UI-safe shape — never a
// secret, Keychain ref, raw content, prompt, or AgentResult.logs.
//
// Every event carries `seq` (monotonic per-stream cursor, per the Phase-0 API
// spike) + `eventId` (the tRPC `tracked()` resume id) so a resumed subscription
// can replay from the last-seen id and detect a gap.
//
// PURE — no @trpc import (the initTRPC router is built in apps/worker later; this
// only freezes the shared event + UI-safe TYPES). Reuses EventName from the
// single const-union catalog so the class set never drifts from `../events/catalog`.
import { z } from "zod";
import { EventName } from "../events/catalog";
import {
  UiSafeApprovalSchema,
  UiSafeHealthItemSchema,
  UiSafeWorkflowRunRefSchema,
  UiSafeDashboardCardSchema,
} from "./ui-safe";
import type {
  UiSafeApproval,
  UiSafeHealthItem,
  UiSafeWorkflowRunRef,
  UiSafeDashboardCard,
} from "./ui-safe";

// ── Shared envelope fields (every stream event carries these) ────────────────
interface StreamEventEnvelope {
  // Monotonic per-stream sequence (Phase-0 API spike): lets the renderer detect
  // a dropped event (a gap in seq) independently of the resume id.
  seq: number;
  // The tRPC `tracked()` resume id — a resumed subscription replays from here.
  eventId: string;
}

// ── Per-class variants (discriminant `name` + matching UI-safe payload) ──────
export interface WorkflowStatusEvent extends StreamEventEnvelope {
  name: "workflow.status";
  payload: UiSafeWorkflowRunRef;
}
export interface ApprovalUpdateEvent extends StreamEventEnvelope {
  name: "approval.update";
  payload: UiSafeApproval;
}
export interface SystemHealthEvent extends StreamEventEnvelope {
  name: "system.health";
  payload: UiSafeHealthItem;
}
export interface ReadModelChangeEvent extends StreamEventEnvelope {
  name: "read_model.change";
  payload: UiSafeDashboardCard;
}

// The discriminated union over the 4 EventName classes.
export type StreamEvent =
  | WorkflowStatusEvent
  | ApprovalUpdateEvent
  | SystemHealthEvent
  | ReadModelChangeEvent;

// ── Runtime schema ───────────────────────────────────────────────────────────
// Zod-discriminated on `name`; each branch pins its matching UI-safe payload.
// The shared envelope fields are spread into each branch (discriminatedUnion
// requires the discriminant to live on each object schema).
const seqSchema = z.number().int();
const eventIdSchema = z.string().min(1);

export const streamEventSchema: z.ZodType<StreamEvent> = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("workflow.status"),
      seq: seqSchema,
      eventId: eventIdSchema,
      payload: UiSafeWorkflowRunRefSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("approval.update"),
      seq: seqSchema,
      eventId: eventIdSchema,
      payload: UiSafeApprovalSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("system.health"),
      seq: seqSchema,
      eventId: eventIdSchema,
      payload: UiSafeHealthItemSchema,
    })
    .strict(),
  z
    .object({
      name: z.literal("read_model.change"),
      seq: seqSchema,
      eventId: eventIdSchema,
      payload: UiSafeDashboardCardSchema,
    })
    .strict(),
]) as z.ZodType<StreamEvent>;

// The set of event names the StreamEvent union covers — derived from the single
// EventName catalog so it is exactly the §10 push-stream class set.
export const STREAM_EVENT_NAMES: readonly EventName[] = EventName;
