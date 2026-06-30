// WorkflowRunRef seam model (task 1.9, §3/§9). The control-plane handle that
// ties a workflow execution to its idempotency key + audit trail: every workflow
// run is recorded as one of these so replay reuses the run (idempotency) and the
// run's side effects are traceable back through `auditRefs` (§3/§9). Zod is the
// single source of truth: the TS type is `z.infer` (surfaced as the explicit
// `WorkflowRunRef` interface), the JSON Schema is generated via `emitJsonSchema`.
// PURE — imports only foundation primitives.
import { z } from "zod";
import { WorkflowIdSchema, AuditIdSchema } from "../primitives/zod-brands";
import type { WorkflowId, AuditId } from "../primitives/ids";

/** Stable JSON-Schema `$id` for the schema registry. */
export const WORKFLOW_RUN_REF_SCHEMA_ID = "sow:workflow-run-ref" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `egress-policy.ts`/`semantic-fact.ts`
// use. A nameable `WorkflowRunRef` type sidesteps that; `.strict()` runtime
// rejection of unknown keys is unaffected.
export interface WorkflowRunRef {
  workflowId: WorkflowId;
  // arch_gap: the `trigger` taxonomy (schedule | manual | event | …) is defined
  // by the §9 workflow/state-machine contract, not here; an OPEN non-empty string
  // until §9 names the closed set — NEVER guess a closed enum upstream.
  trigger: string;
  // arch_gap: the `state` taxonomy is the §9 state machines' concern (the 6 state
  // machines live in §9, not this seam); an OPEN non-empty string here.
  state: string;
  idempotencyKey: string;
  auditRefs: AuditId[];
}

interface WorkflowRunRefInput {
  workflowId: string;
  trigger: string;
  state: string;
  idempotencyKey: string;
  auditRefs: string[];
}

export const WorkflowRunRefSchema: z.ZodType<
  WorkflowRunRef,
  z.ZodTypeDef,
  WorkflowRunRefInput
> = z
  .object({
    workflowId: WorkflowIdSchema,
    // Open §9 strings — non-empty, but the value taxonomy is unspecified here.
    trigger: z.string().min(1),
    state: z.string().min(1),
    // Idempotency key: required + non-empty. Replay matches an existing run by
    // this key (§3/§9), so a blank key would collapse distinct runs.
    idempotencyKey: z.string().min(1),
    auditRefs: z.array(AuditIdSchema),
  })
  .strict();
