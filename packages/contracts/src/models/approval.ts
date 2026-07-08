// Approval seam model (task 1.9, §3/§9/§10/§11). The approval-inbox record that
// gates an external action: a pending action is surfaced as a Mac + Telegram
// card and transitions approve/edit/reject/defer/expire exactly once (REQ-F-012,
// §9). Zod is the single source of truth: the TS type is the inferred shape
// (hand-declared as an interface only to dodge the TS4023 declaration-emit issue
// branded ids cause — see below), the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared enums.
import { z } from "zod";
import { ApprovalIdSchema, ActionIdSchema, PlanIdSchema, WorkspaceIdSchema } from "../primitives/zod-brands";
import { approvalStatusSchema, approvalSubjectKindSchema, channelSchema } from "./shared-enums";
import type { ApprovalId, ActionId, PlanId, WorkspaceId } from "../primitives/ids";
import type { ApprovalStatus, ApprovalSubjectKind, Channel } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const APPROVAL_SCHEMA_ID = "sow:approval" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts` / `shared-shapes.ts`
// use. A nameable `Approval` type sidesteps that; `.strict()` runtime rejection
// of unknown keys and the `.refine()` invariant are unaffected.
export interface Approval {
  id: ApprovalId;
  // §13.10a — the pending card's SUBJECT is EXACTLY ONE of these two refs, matching
  // `subjectKind` (enforced by the refine below, so a mis-routed card is
  // unrepresentable):
  //   • `actionRef` — an §8 ProposedAction (an EXTERNAL write). Present iff
  //     subjectKind === "external_action". (Was the sole, required ref pre-§13.10a.)
  //   • `planRef`   — a §6 KnowledgeMutationPlan in the pending-KMP store (a SEMANTIC
  //     Markdown mutation the Copilot proposed). Present iff subjectKind ===
  //     "semantic_mutation".
  actionRef?: ActionId;
  planRef?: PlanId;
  // §13.10a — the SUBJECT discriminator. The on-approval executor routes off this:
  // external_action → the Tool Gateway external-write envelope; semantic_mutation →
  // KnowledgeWriter (safety rules 1+2 — committed ONLY on owner approval, never a
  // direct/auto write). See `shared-enums.ts` ApprovalSubjectKind.
  subjectKind: ApprovalSubjectKind;
  // WS-4/WS-7 scoped-before-surface: the BOUND/AUTHORIZED workspace this pending
  // action belongs to (set at record time from ApprovalFlowContext.workspaceId /
  // the server-bound Copilot sink workspaceId — never a client/model value). The
  // §9.8 inbox filters on this so a workspace inbox surfaces ONLY its own cards;
  // the branded schema rejects empty/whitespace (fail-closed).
  workspaceId: WorkspaceId;
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
  actionRef?: string;
  planRef?: string;
  subjectKind: ApprovalSubjectKind;
  workspaceId: string;
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
    // §13.10a — both subject refs are structurally OPTIONAL; the refine below binds
    // EXACTLY ONE of them to `subjectKind` (structural optionality + a semantic
    // refine is the Lesson §3 composition — ajv sees both optional, the Zod parse
    // enforces the exclusivity). Empty/whitespace is still rejected when present.
    actionRef: ActionIdSchema.optional(),
    planRef: PlanIdSchema.optional(),
    subjectKind: approvalSubjectKindSchema,
    workspaceId: WorkspaceIdSchema,
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
  })
  // §13.10a — the SUBJECT invariant (biconditional, since subjectKind is a 2-value
  // enum): EXACTLY the matching ref is present.
  //   external_action  ⇔  actionRef present ∧ planRef absent
  //   semantic_mutation ⇔ planRef present ∧ actionRef absent
  // The on-approval executor routes off `subjectKind` and reads the matching ref;
  // a card with the wrong ref (or both, or neither) is a mis-routed write, so the
  // contract makes it unrepresentable (fail-closed — reject at the candidate gate).
  .refine(
    (a) =>
      a.subjectKind === "external_action"
        ? a.actionRef !== undefined && a.planRef === undefined
        : a.planRef !== undefined && a.actionRef === undefined,
    {
      message:
        "subject ref must match subjectKind (external_action ⇒ actionRef only; semantic_mutation ⇒ planRef only)",
      path: ["subjectKind"],
    },
  );
