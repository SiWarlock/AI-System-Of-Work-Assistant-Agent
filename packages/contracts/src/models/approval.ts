// Approval seam model (task 1.9, §3/§9/§10/§11). The approval-inbox record that
// gates an external action: a pending action is surfaced as a Mac + Telegram
// card and transitions approve/edit/reject/defer/expire exactly once (REQ-F-012,
// §9). Zod is the single source of truth: the TS type is the inferred shape
// (hand-declared as an interface only to dodge the TS4023 declaration-emit issue
// branded ids cause — see below), the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import { ApprovalIdSchema, ActionIdSchema } from "../primitives/zod-brands";
import { approvalStatusSchema, channelSchema } from "./shared-enums";
import type { ApprovalId, ActionId } from "../primitives/ids";
import type { ApprovalStatus, Channel } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const APPROVAL_SCHEMA_ID = "sow:approval" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts` / `shared-shapes.ts`
// use. A nameable `Approval` type sidesteps that; `.strict()` runtime rejection
// of unknown keys and the `.refine()` invariant are unaffected.
export interface Approval {
  id: ApprovalId;
  actionRef: ActionId;
  status: ApprovalStatus;
  // arch_gap: the approving-actor identity shape (user vs. agent vs. service
  // principal namespace) is unspecified upstream (§9/§10/§11) — modeled as an
  // open non-empty string until the actor taxonomy is named.
  actor: string;
  channel: Channel;
  // arch_gap: payloadHash algorithm/encoding is unspecified upstream (§8/§9 name
  // only "payload hash") — modeled as an open non-empty string (spec-implied:
  // an opaque content hash of the action payload) until the format is fixed.
  payloadHash: string;
  snoozeUntil?: string;
  expiresAt?: string;
}

interface ApprovalInput {
  id: string;
  actionRef: string;
  status: ApprovalStatus;
  actor: string;
  channel: Channel;
  payloadHash: string;
  snoozeUntil?: string;
  expiresAt?: string;
}

export const ApprovalSchema: z.ZodType<Approval, z.ZodTypeDef, ApprovalInput> = z
  .object({
    id: ApprovalIdSchema,
    actionRef: ActionIdSchema,
    status: approvalStatusSchema,
    actor: z.string().min(1),
    channel: channelSchema,
    payloadHash: z.string().min(1),
    // §9: a deferred item re-surfaces after a snooze (default 24h); snoozeUntil
    // is that re-surface instant and auto-expiry is captured by expiresAt.
    snoozeUntil: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  // Conditional coupling (one-directional, NOT iff): a snooze re-surface time is
  // meaningful ONLY while deferred. A non-deferred status carrying snoozeUntil is
  // a contradictory record. A deferred approval MAY omit snoozeUntil (the default
  // window applies), so the reverse direction is intentionally unconstrained.
  .refine((a) => a.status === "deferred" || a.snoozeUntil === undefined, {
    message: 'snoozeUntil may be present only when status === "deferred"',
    path: ["snoozeUntil"],
  });
