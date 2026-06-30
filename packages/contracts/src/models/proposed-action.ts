// ProposedAction seam model (task 1.7, §3/§8/§9). The §8 Tool-Gateway external-
// write proposal: the candidate side effect that the Approval/Tool-Gateway path
// turns into an ExternalWriteEnvelope. Honors the §3 universal external-write
// rule (safety rule 3): every external write carries a non-empty
// `canonicalObjectKey` (pre-write existence-check key) AND `idempotencyKey`
// (replay-dedupe key). Zod is the single source of truth: the TS type is
// `z.infer`-equivalent, the JSON Schema is generated via `emitJsonSchema`.
// PURE — imports only foundation primitives/enums.
import { z } from "zod";
import { ActionIdSchema } from "../primitives/zod-brands";
import { targetSystemSchema, type TargetSystem } from "./shared-enums";
import type { ActionId } from "../primitives/ids";

/** Stable JSON-Schema `$id` for the schema registry. */
export const PROPOSED_ACTION_SCHEMA_ID = "sow:proposed-action" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts` / `shared-shapes.ts`'s
// `SourceRef` use because `actionId` is branded. A nameable `ProposedAction`
// type sidesteps that; `.strict()` runtime rejection of unknown keys is
// unaffected.
export interface ProposedAction {
  actionId: ActionId;
  targetSystem: TargetSystem;
  canonicalObjectKey: string;
  // arch_gap: ProposedAction.payload shape unspecified upstream (varies per
  // targetSystem connector) — spec-implied minimal shape is an open object map.
  payload: Record<string, unknown>;
  // arch_gap: approvalPolicy taxonomy unspecified upstream (§9 finalization
  // defers the requiresApproval/auto policy set — IMPLEMENTATION_PLAN.md 6.x) —
  // modeled as an open non-empty string, NOT a closed enum.
  approvalPolicy: string;
  idempotencyKey: string;
}

interface ProposedActionInput {
  actionId: string;
  targetSystem: TargetSystem;
  canonicalObjectKey: string;
  payload: Record<string, unknown>;
  approvalPolicy: string;
  idempotencyKey: string;
}

export const ProposedActionSchema: z.ZodType<
  ProposedAction,
  z.ZodTypeDef,
  ProposedActionInput
> = z
  .object({
    actionId: ActionIdSchema,
    // Closed external-target set (§8 connector catalog).
    targetSystem: targetSystemSchema,
    // Universal external-write rule (§3 / safety rule 3): both keys required,
    // non-empty. canonicalObjectKey gates the pre-write existence check;
    // idempotencyKey gates replay dedupe.
    canonicalObjectKey: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    approvalPolicy: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();
