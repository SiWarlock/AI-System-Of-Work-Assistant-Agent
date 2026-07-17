// @sow/providers — the candidate-data schema gate (§7 task 5.5, REQ-S-006).
//
// Provider/runtime output is CANDIDATE DATA until it passes THIS composed gate.
// The composition is load-bearing — NEVER ajv alone (LESSONS §3: zod-to-json-schema
// drops `.refine`, so the ajv structural gate accepts records the model's Zod
// schema forbids). In fixed order the gate applies:
//
//   1. ajv structural gate   — @sow/domain `validate(output, job.outputSchemaId)`
//   2. model Zod `.parse`    — the `.refine`/cross-field layer ajv dropped
//   3. no-inference (opt.)    — REQ-F-017: unstated owners/dates are NOT fabricated
//   4. normalize             — validated value → a KnowledgeMutationPlan / ProposedAction CANDIDATE
//   5. §3 universal rules    — scoped-mutation / external-write-key presence over the candidate
//   6. tool-policy           — a read_only job's mutating-action output is REJECTED (bullet 4)
//
// It emits ONLY a candidate (never applied). A rejection short-circuits with a
// typed, redaction-safe `GateDeny` and NO side effect. If no model parser is
// registered for the schema id, the gate FAILS CLOSED rather than fall back to
// ajv-alone.
//
// STRICT SIDE-EFFECT RULE (safety): zero import of any write-adapter package
// (KnowledgeWriter, Tool Gateway, Markdown, GBrain); no I/O. PURE except the
// injected pieces. Never throws across a boundary (§16).
import { err, ok, isErr } from "@sow/contracts";
import type { AgentJob, Result } from "@sow/contracts";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { validate, ruleScopedMutation, ruleExternalWriteKeys } from "@sow/domain";
import { buildAuditSignal } from "@sow/policy";
import type { AuditSignal } from "@sow/policy";
import type { AgentResult } from "../ports/agent-result";
import type { SchemaGate, GateResult, GateDeny, GateProceed, BrokerCandidate } from "./broker";
import {
  bySchemaIdNormalizer,
  enforceToolPolicyOnCandidate,
  type OutputNormalizer,
} from "./output-normalizer";

const GATE_ACTOR = "broker:schema-gate" as const;
const GATE_MARKER = "broker:schema-gate-decision" as const;

/**
 * Minimal structural interface for the model's Zod-style parser — the layer whose
 * `.refine`/cross-field checks ajv drops. Any Zod schema satisfies it; kept
 * structural so this module does not hard-depend on the zod runtime type.
 */
export interface ModelParser {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: unknown } | { readonly success: false; readonly error: unknown };
}

/** A no-inference view (REQ-F-017): validate the parsed output does not fabricate
 * unstated owners/dates. Returns a typed rejection list; the gate NEVER coerces to
 * satisfy the schema. Optional — the concrete meeting.close field shape is §9/
 * Phase-7 arch_gap, so it is injected rather than hardcoded here. */
export type NoInferenceView = (
  job: AgentJob,
  validatedOutput: unknown,
) => Result<unknown, readonly { readonly field: string; readonly code: string }[]>;

export interface SchemaGateConfig {
  /** The ajv registry the structural gate runs against (defaults to the built-in). */
  readonly registry?: SchemaRegistry;
  /** Per-schema-id model parsers — the Zod `.refine` layer ajv drops. Required:
   * a schema id with no parser fails closed (no ajv-alone validation). */
  readonly modelSchemas: Readonly<Record<string, ModelParser>>;
  /** Validated output → candidate mapping (defaults to `bySchemaIdNormalizer`). */
  readonly normalizer?: OutputNormalizer;
  /** Optional REQ-F-017 no-inference check over the parsed output. */
  readonly noInference?: NoInferenceView;
}

/**
 * Build the broker's injected `SchemaGate` (see ./broker) over the composition
 * config. Pure factory (no I/O of its own). The returned gate runs the fixed
 * composition and returns a `GateResult<BrokerCandidate>` — never throws.
 */
export function createSchemaGate(config: SchemaGateConfig): SchemaGate {
  const normalizer = config.normalizer ?? bySchemaIdNormalizer();

  return (job: AgentJob, result: AgentResult): GateResult<BrokerCandidate> => {
    const schemaId = job.outputSchemaId;
    const candidateOutput = result.candidateOutput;

    // ── 1. ajv STRUCTURAL gate (REQ-S-006) ─────────────────────────────────────
    const structural =
      config.registry === undefined
        ? validate(candidateOutput, schemaId)
        : validate(candidateOutput, schemaId, config.registry);
    if (isErr(structural)) {
      return err(
        schemaDeny(
          job,
          `ajv structural gate rejected output against '${schemaId}' (${structural.error.code})`,
        ),
      );
    }

    // ── 2. model Zod .parse — the .refine layer ajv drops (NEVER ajv alone) ─────
    const parser = config.modelSchemas[schemaId];
    if (parser === undefined) {
      // Fail closed: without the model parser the composition is incomplete;
      // ajv-alone is explicitly insufficient (LESSONS §3).
      return err(
        schemaDeny(
          job,
          `no model parser registered for '${schemaId}'; refusing ajv-alone validation (LESSONS §3)`,
        ),
      );
    }
    const parsed = parser.safeParse(candidateOutput);
    if (!parsed.success) {
      return err(
        schemaDeny(job, `model schema parse rejected output against '${schemaId}' (Zod .refine/cross-field)`),
      );
    }
    const validated: unknown = parsed.data;

    // ── 3. no-inference (REQ-F-017), optional — reject, never coerce ────────────
    if (config.noInference !== undefined) {
      const ni = config.noInference(job, validated);
      if (isErr(ni)) {
        const fields = ni.error.map((r) => r.field).join(", ");
        return err(
          schemaDeny(job, `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${fields}]`),
        );
      }
    }

    // ── 4. normalize the validated value → a candidate (never applied) ──────────
    const normalized = normalizer(job, validated);
    if (isErr(normalized)) {
      return err(schemaDeny(job, `output not normalizable to a candidate: ${normalized.error.message}`));
    }
    const candidate: BrokerCandidate = normalized.value;

    // ── 5. §3 universal rules over the candidate ────────────────────────────────
    const uni = applyUniversalRules(candidate);
    if (isErr(uni)) {
      return err(schemaDeny(job, `§3 universal rule rejection (${uni.error})`));
    }

    // ── 6. tool-policy: read_only output implying mutation → reject (bullet 4) ──
    const tp = enforceToolPolicyOnCandidate(job, candidate);
    if (isErr(tp)) {
      return err(toolPolicyDeny(job, tp.error.message));
    }

    const proceed: GateProceed<BrokerCandidate> = {
      value: candidate,
      audit: acceptAudit(job, candidate),
    };
    return ok(proceed);
  };
}

// ── composition helpers (pure) ────────────────────────────────────────────────

/**
 * Apply the §3 universal rules that concern an emitted candidate: a
 * KnowledgeMutationPlan must be scoped (workspaceId + ≥1 sourceRef) and every
 * external-write proposal it carries must have its existence/dedupe keys; a bare
 * ProposedAction must carry those keys. Returns the failing rule's code on reject.
 */
function applyUniversalRules(candidate: BrokerCandidate): Result<BrokerCandidate, string> {
  if (candidate.kind === "knowledge_mutation_plan") {
    const scoped = ruleScopedMutation(candidate.plan);
    if (isErr(scoped)) return err(`${scoped.error.code}:${(scoped.error.fields ?? []).join("|")}`);
    for (const action of candidate.plan.externalActionProposals) {
      const keys = ruleExternalWriteKeys(action);
      if (isErr(keys)) return err(`${keys.error.code}:${(keys.error.fields ?? []).join("|")}`);
    }
    return ok(candidate);
  }
  if (candidate.kind === "agent_extraction") {
    // CP-2: no §3 universal rule applies to a pre-KMP extraction candidate — it carries
    // neither a scoped-mutation plan nor an external-write proposal. The worker
    // reconstructs it into a KnowledgeMutationPlan downstream, where these rules re-apply.
    return ok(candidate);
  }
  const keys = ruleExternalWriteKeys(candidate.action);
  if (isErr(keys)) return err(`${keys.error.code}:${(keys.error.fields ?? []).join("|")}`);
  return ok(candidate);
}

function jobRefs(job: AgentJob): readonly string[] {
  return [
    `ref:job:${job.id}`,
    `ref:workspace:${job.workspaceId}`,
    `ref:capability:${String(job.capability)}`,
    `ref:schema:${job.outputSchemaId}`,
  ];
}

/** A rejection at the candidate-data gate → `schema_rejected`, branch `rejected`,
 * not retryable (re-running the same output re-rejects). Redaction-safe: the
 * message names codes/schema ids only — never the candidate's raw content. */
function schemaDeny(job: AgentJob, message: string): GateDeny {
  return {
    reason: "schema_rejected",
    message,
    audit: gateAudit(job, "broker.schema_gate.rejected", `schema_rejected: ${message}`),
    branch: "rejected",
    retryable: false,
  };
}

/** A tool-policy violation in the output → `tool_policy_violation`, branch
 * `rejected`, not retryable. */
function toolPolicyDeny(job: AgentJob, message: string): GateDeny {
  return {
    reason: "tool_policy_violation",
    message,
    audit: gateAudit(job, "broker.schema_gate.tool_policy_violation", `tool_policy_violation: ${message}`),
    branch: "rejected",
    retryable: false,
  };
}

function acceptAudit(job: AgentJob, candidate: BrokerCandidate): AuditSignal {
  return gateAudit(
    job,
    "broker.schema_gate.validated",
    `schema_validated → ${candidate.kind} candidate emitted`,
  );
}

function gateAudit(job: AgentJob, event: string, afterSummary: string): AuditSignal {
  return buildAuditSignal({
    actor: GATE_ACTOR,
    event,
    refs: jobRefs(job),
    payloadHash: GATE_MARKER,
    beforeSummary: "provider output pending candidate-data gate",
    afterSummary,
  });
}
