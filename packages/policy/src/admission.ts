// §5 ING-7 untrusted-content admission gate (safety rule 6 / hard denial #3) +
// the candidate-data GATE COMPOSITION (discharges LESSONS.md §3) + the
// WRITE_ADAPTER_OUTSIDE_GATEWAY declared denial (safety rule 3 / hard denial #4).
// REQ-S-001.
//
// PURE — no clock, network, or randomness. Every cross-subsystem outcome is a
// typed `PolicyDecision`, never a thrown error (§16). FAIL-CLOSED: malformed /
// unclassified input ⇒ DENY. REDACTION-SAFE: audit signals carry refs / codes
// only, never raw candidate content.
import type { AgentJob, ToolId } from "@sow/contracts";
import { AgentJobSchema, AGENT_JOB_SCHEMA_ID, isOk } from "@sow/contracts";
import { validate } from "@sow/domain";
import { admitsMutating } from "./tool-policy";
import {
  allowDecision,
  denyDecision,
  type PolicyDecision,
} from "./decision";
import {
  buildAuditSignal,
  POLICY_DENIAL_HEALTH_CLASS,
  type AuditSignal,
} from "./audit-signal";

const ADMISSION_ACTOR = "policy:admission" as const;

/**
 * Untrusted classification is fail-closed: only an EXPLICIT `'trusted'` is
 * trusted. Anything else — `'untrusted'` or an unrecognized value — is treated
 * as untrusted content.
 */
function isTrusted(job: AgentJob): boolean {
  return job.trustLevel === "trusted";
}

/**
 * ING-7 admission predicate (safety rule 6). Runs at JOB ADMISSION — BEFORE
 * provider selection / running / egress. Untrusted content carrying a
 * mutation-capable ToolPolicy is a HARD REJECT (not a silent downgrade): the job
 * declared a mutating tool and must be refused. A rejection carries a health
 * signal (operational visibility); an admission carries an allow signal. Pure.
 */
export function admitJob(
  job: AgentJob,
  isMutatingTool?: (t: ToolId) => boolean,
): PolicyDecision<AgentJob> {
  const refs: readonly string[] = [job.id, job.workspaceId];
  if (!isTrusted(job) && admitsMutating(job.toolPolicy, isMutatingTool)) {
    const audit: AuditSignal = buildAuditSignal({
      actor: ADMISSION_ACTOR,
      event: "job.admission.rejected",
      refs,
      payloadHash: job.idempotencyKey,
      beforeSummary: "candidate agent job (untrusted content)",
      afterSummary: "admission rejected: untrusted content declares a mutating tool policy",
      denialCode: "UNTRUSTED_CONTENT_MUTATING_TOOL",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    });
    return denyDecision(
      "UNTRUSTED_CONTENT_MUTATING_TOOL",
      "ING-7: an untrusted-content job may not carry a mutating tool policy (read-only only)",
      audit,
    );
  }
  const audit: AuditSignal = buildAuditSignal({
    actor: ADMISSION_ACTOR,
    event: "job.admission.allowed",
    refs,
    payloadHash: job.idempotencyKey,
    beforeSummary: "candidate agent job",
    afterSummary: "admission allowed: ING-7 predicate satisfied",
  });
  return allowDecision(job, audit);
}

/**
 * THE GATE COMPOSITION (discharges LESSONS.md §3 / the Phase-1 FINDING): ajv's
 * `validate()` is STRUCTURAL-only — `zod-to-json-schema` drops `.refine`, so ajv
 * ADMITS an embedded read_only ToolPolicy with `allowsMutating: true`. The whole
 * candidate-data gate is therefore composed IN ORDER:
 *
 *   (1) `validate(candidate, AGENT_JOB_SCHEMA_ID)` — ajv structural gate;
 *   (2) `AgentJobSchema.parse(candidate)` — the Zod `.refine` layer ajv drops
 *       (catches read_only + allowsMutating:true, provider-route exclusivity, …);
 *   (3) `admitJob(parsed, …)` — the ING-7 predicate.
 *
 * Any step failing ⇒ DENY (MALFORMED_POLICY_INPUT for 1/2,
 * UNTRUSTED_CONTENT_MUTATING_TOOL for 3). `validate()` is NEVER treated as the
 * whole gate. Pure; never throws (the Zod parse is caught and mapped). Audit
 * signals reference only the schema id — never the raw candidate.
 */
export function admitCandidateJob(
  candidate: unknown,
  isMutatingTool?: (t: ToolId) => boolean,
): PolicyDecision<AgentJob> {
  // (1) ajv structural gate.
  if (!isOk(validate(candidate, AGENT_JOB_SCHEMA_ID))) {
    return denyMalformed("candidate failed ajv structural validation (stage 1)");
  }
  // (2) Zod refine layer — the cross-field invariants ajv drops.
  const parsed = AgentJobSchema.safeParse(candidate);
  if (!parsed.success) {
    return denyMalformed("candidate failed Zod refinement (stage 2)");
  }
  // (3) ING-7 admission predicate.
  return admitJob(parsed.data, isMutatingTool);
}

function denyMalformed(afterSummary: string): PolicyDecision<AgentJob> {
  const audit: AuditSignal = buildAuditSignal({
    actor: ADMISSION_ACTOR,
    event: "job.admission.malformed",
    // No raw candidate content in refs — only the referential schema id.
    refs: [AGENT_JOB_SCHEMA_ID],
    payloadHash: "candidate:unvalidated",
    beforeSummary: "candidate agent job",
    afterSummary,
    denialCode: "MALFORMED_POLICY_INPUT",
    healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
  });
  return denyDecision(
    "MALFORMED_POLICY_INPUT",
    "candidate agent job failed the composed candidate-data gate",
    audit,
  );
}

/**
 * Hard denial #4 (safety rule 3, external-write envelope). The PRIMARY runtime
 * mechanism is import-direction (§2.5): only the Tool Gateway / KnowledgeWriter
 * import write adapters. This function is the DECLARED policy denial for a
 * detected violation — it invents no runtime token; the caller supplies the
 * offending `adapterRef` (a module ref, never content/credentials). Pure.
 */
export function denyWriteAdapterOutsideGateway(ctx: {
  adapterRef: string;
}): PolicyDecision<never> {
  const audit: AuditSignal = buildAuditSignal({
    actor: "policy:import-guard",
    event: "write_adapter.outside_gateway.denied",
    refs: [ctx.adapterRef],
    payloadHash: ctx.adapterRef,
    beforeSummary: "write adapter referenced outside the Tool Gateway / KnowledgeWriter",
    afterSummary: "denied: only the Tool Gateway / KnowledgeWriter may import write adapters",
    denialCode: "WRITE_ADAPTER_OUTSIDE_GATEWAY",
    healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
  });
  return denyDecision(
    "WRITE_ADAPTER_OUTSIDE_GATEWAY",
    "a write adapter was used outside the Tool Gateway / KnowledgeWriter import boundary",
    audit,
  );
}
