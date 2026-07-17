// @sow/providers — output normalization + tool-policy enforcement (§7 task 5.5).
//
// After the candidate-data gate (./schema-gate) proves provider/runtime output
// against the capability schema, THIS module maps the validated value into a
// broker CANDIDATE — a KnowledgeMutationPlan or ProposedAction — and enforces the
// tool-policy invariant over it (bullet 4: a read_only job whose output implies a
// mutating external action is REJECTED, never silently coerced).
//
// STRICT SIDE-EFFECT RULE (safety, load-bearing): this module returns DATA ONLY.
// It performs NO I/O and imports NO write-adapter package (KnowledgeWriter, Tool
// Gateway, Markdown, GBrain) — a candidate is a proposal the broker hands on, not
// a write. The architectural import test in test/ pins the zero-import surface.
// PURE + total; never throws across a boundary (§16) — typed Result outcomes only.
import { ok, err } from "@sow/contracts";
import type {
  AgentJob,
  KnowledgeMutationPlan,
  ProposedAction,
  AgentExtractionCandidate,
  Result,
} from "@sow/contracts";
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  PROPOSED_ACTION_SCHEMA_ID,
  AGENT_EXTRACTION_SCHEMA_ID,
} from "@sow/contracts";

// Re-export the candidate type so the normalizer's callers/tests have one import
// site; the canonical definition lives on ./broker (the pipeline owner).
export type { BrokerCandidate } from "./broker";
import type { BrokerCandidate } from "./broker";

/** Enumerable normalization failure codes (no thrown strings, §16). */
export type NormalizationFailureCode = "unnormalizable" | "tool_policy_violation";

export interface NormalizationFailure {
  readonly code: NormalizationFailureCode;
  readonly message: string;
  /** Offending field/kind names, when applicable. */
  readonly fields?: readonly string[];
}

export type NormalizationResult = Result<BrokerCandidate, NormalizationFailure>;

/**
 * Maps a VALIDATED candidate output (already through the ajv + Zod gate) into a
 * broker CANDIDATE. Shape-mapping only — it does NOT re-validate and it never
 * performs I/O. Injected into the schema gate so capability→candidate mapping can
 * evolve (concrete capability output schemas are §9/Phase-7 arch_gap) without
 * touching the gate's composition order.
 */
export type OutputNormalizer = (job: AgentJob, validatedOutput: unknown) => NormalizationResult;

/**
 * The default normalizer: pick the candidate kind from the job's `outputSchemaId`.
 * A capability whose output schema is the KnowledgeMutationPlan contract emits a
 * `knowledge_mutation_plan` candidate; the ProposedAction contract emits a
 * `proposed_action`. Any other (non-candidate-shaped) schema id is `unnormalizable`
 * — the broker has no candidate envelope to emit, so it fails closed rather than
 * guessing. The value is passed through UNCHANGED (no coercion — REQ-F-017).
 */
export function bySchemaIdNormalizer(): OutputNormalizer {
  return (job, validatedOutput) => {
    switch (job.outputSchemaId) {
      case KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID:
        return ok({
          kind: "knowledge_mutation_plan",
          plan: validatedOutput as KnowledgeMutationPlan,
        });
      case PROPOSED_ACTION_SCHEMA_ID:
        return ok({
          kind: "proposed_action",
          action: validatedOutput as ProposedAction,
        });
      case AGENT_EXTRACTION_SCHEMA_ID:
        // CP-2/GATE-1: the evidence-bearing extraction candidate. The value is the
        // schema gate's already-Zod-PARSED object (locked #3), passed through
        // UNCHANGED so per-field `evidenceRef` survives to `validateNoInference`.
        return ok({
          kind: "agent_extraction",
          extraction: validatedOutput as AgentExtractionCandidate,
        });
      default:
        return err({
          code: "unnormalizable",
          message: `no candidate mapping for outputSchemaId '${job.outputSchemaId}'`,
          fields: ["outputSchemaId"],
        });
    }
  };
}

/**
 * Does the candidate imply a MUTATING EXTERNAL action? A `proposed_action` is a
 * Tool-Gateway external-write proposal — always mutating. A KnowledgeMutationPlan
 * implies one only when it carries `externalActionProposals`; its Markdown
 * mutations are applied by KnowledgeWriter (the one writer), which is NOT a
 * ToolPolicy-governed mutating tool. Pure predicate.
 */
export function candidateImpliesMutatingAction(candidate: BrokerCandidate): boolean {
  if (candidate.kind === "proposed_action") return true;
  // An agent_extraction (CP-2) is a pre-KMP intermediate with NO external action of
  // its own — the worker reconstructs it into a KnowledgeMutationPlan downstream,
  // where §3 universal rules + tool-policy re-apply. It never implies a mutation here.
  if (candidate.kind === "agent_extraction") return false;
  return candidate.plan.externalActionProposals.length > 0;
}

/**
 * Does the job's ToolPolicy FORBID mutation? `read_only ⇒ !allowsMutating`, and a
 * `scoped_write` policy that does not admit mutation also forbids it — so the
 * single load-bearing signal is `!allowsMutating`. Pure.
 */
export function toolPolicyForbidsMutation(job: AgentJob): boolean {
  return job.toolPolicy.allowsMutating === false;
}

/**
 * Enforce the tool-policy invariant over an emitted candidate (5.5 bullet 4): if
 * the job forbids mutation but the candidate implies a mutating external action,
 * REJECT it (`tool_policy_violation`) — never silently coerce/strip the action to
 * fit the policy. Otherwise the candidate passes through by the SAME reference (no
 * rebuild → the no-inference guarantee holds structurally). Pure; never throws.
 */
export function enforceToolPolicyOnCandidate(
  job: AgentJob,
  candidate: BrokerCandidate,
): NormalizationResult {
  if (toolPolicyForbidsMutation(job) && candidateImpliesMutatingAction(candidate)) {
    return err({
      code: "tool_policy_violation",
      message:
        "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced",
      fields: candidate.kind === "proposed_action" ? ["action"] : ["externalActionProposals"],
    });
  }
  return ok(candidate);
}
