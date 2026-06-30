// EgressPolicy seam model (task 1.3, §3/§5). Gates the Employer-Work raw-content
// egress control (safety rule 5 / REQ §16.5-PRD). The §5 egress-veto predicate
// is a pure function of an AgentJob's trust fields + this policy. Zod is the
// single source of truth: the TS type is `z.infer`, the JSON Schema is generated
// via `emitJsonSchema`. PURE — imports only foundation primitives.
import { z } from "zod";
import { WorkspaceIdSchema, ProcessorIdSchema } from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { ProcessorId } from "../primitives/enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const EGRESS_POLICY_SCHEMA_ID = "sow:egress-policy" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) — the same workaround `shared-shapes.ts`'s `SourceRef` uses.
// A nameable `EgressPolicy` type sidesteps that; `.strict()` runtime rejection
// of unknown keys and the `.refine()` invariant are unaffected.
export interface EgressPolicy {
  workspaceId: WorkspaceId;
  allowedProcessors: ProcessorId[];
  rawContentAllowedProcessors: ProcessorId[];
  employerRawEgressAcknowledged: boolean;
  acknowledgedAt?: string;
}

interface EgressPolicyInput {
  workspaceId: string;
  allowedProcessors: string[];
  rawContentAllowedProcessors: string[];
  employerRawEgressAcknowledged: boolean;
  acknowledgedAt?: string;
}

// A *processor* is any external recipient of content (a cloud LLM endpoint,
// OpenRouter — its OWN processor, NOT an OpenAI alias — Drive/NotebookLM). Local
// Ollama/LM Studio are non-egress and are never required processors. The
// concrete processor catalog is unspecified upstream (ProcessorId is an open
// branded string — arch_gap recorded on the ProcessorId primitive itself).
export const EgressPolicySchema: z.ZodType<EgressPolicy, z.ZodTypeDef, EgressPolicyInput> = z
  .object({
    workspaceId: WorkspaceIdSchema,
    allowedProcessors: z.array(ProcessorIdSchema),
    rawContentAllowedProcessors: z.array(ProcessorIdSchema),
    employerRawEgressAcknowledged: z.boolean(),
    acknowledgedAt: z.string().datetime().optional(),
  })
  .strict()
  // Conditional coupling: an acknowledgment timestamp exists IFF the raw-egress
  // acknowledgment is ON. Acknowledged-without-timestamp leaves the audit trail
  // incomplete; timestamp-without-acknowledgment is a contradictory record.
  .refine(
    (p) => (p.acknowledgedAt !== undefined) === (p.employerRawEgressAcknowledged === true),
    {
      message:
        "acknowledgedAt must be present IFF employerRawEgressAcknowledged === true",
      path: ["acknowledgedAt"],
    },
  );
