// 1.15 — shared seam contract-test fixtures barrel + typed registry (DATA).
//
// Re-exports the canonical VALID instances (one per Appendix-A contract) and the
// per-rule INVALID instances, plus a typed `FIXTURES` registry that pairs each
// fixture with its claimed validity label and the gate tier that adjudicates it.
// The label==verdict META-TEST lives in @sow/domain (contracts must NOT depend on
// @sow/domain), so this module stays pure DATA — no validators imported here.
export * from "./valid";
export * from "./invalid";

import {
  validAgentExtractionCandidate,
  validToolPolicy,
  validEgressPolicy,
  validProviderRoute,
  validProviderProfile,
  validProviderMatrix,
  validWorkspace,
  validAgentJob,
  validKnowledgeMutationPlan,
  validProposedAction,
  validWriteReceipt,
  validExternalWriteEnvelope,
  validSourceEnvelope,
  validGclProjection,
  validApproval,
  validAuditRecord,
  validProject,
  validWorkflowRunRef,
  validHealthItem,
  validNotebookMapping,
  validSemanticFact,
  validFactProvenance,
  validSignedProvenanceStamp,
  validDivergence,
  validParityReport,
  validQuarantineRecord,
  validGBrainProposedFact,
  validGbrainReadGrant,
  validGbrainPin,
  validConformanceResult,
} from "./valid";
import {
  invalidToolPolicyMutatingReadOnly,
  invalidEgressPolicyAckWithoutTimestamp,
  invalidKnowledgeMutationPlanEmptySourceRefs,
  invalidProviderMatrixRouteNotAllowed,
  invalidProposedActionMissingKeys,
  invalidGclProjectionMissingVisibility,
  invalidProviderProfileInlineSecret,
  invalidSignedProvenanceStampWrongWriter,
  invalidGbrainReadGrantGenerationOn,
  invalidNoInferenceUnbackedFields,
} from "./invalid";

/**
 * Which validation tier adjudicates a fixture:
 *  - `schema_gate` — the 1.2 ajv candidate-data gate (structural).
 *  - `refine`      — only the authoritative Zod schema (cross-field `.refine()`),
 *                    since `zod-to-json-schema` drops refines (the ajv gate passes).
 *  - `no_inference`— the 1.11 `validateNoInference` (no registered schema).
 */
export type FixtureGate = "schema_gate" | "refine" | "no_inference";

/** One registry entry: the model name, its registered schema `$id` (null for the
 * no-inference fixture), the instance, its claimed validity label, and — for
 * invalid fixtures — the gate tier that rejects it. */
export interface FixtureEntry {
  readonly model: string;
  readonly schemaId: string | null;
  readonly instance: unknown;
  readonly valid: boolean;
  readonly rejectedBy?: FixtureGate;
}

/** The shared fixture registry: every entry carries its claimed validity label,
 * pinned honest against the gate by the @sow/domain meta-test. */
export const FIXTURES: readonly FixtureEntry[] = [
  // ── VALID — one per Appendix-A contract (27) ──────────────────────────────
  { model: "ToolPolicy", schemaId: "sow:tool-policy", instance: validToolPolicy, valid: true },
  { model: "EgressPolicy", schemaId: "sow:egress-policy", instance: validEgressPolicy, valid: true },
  { model: "ProviderRoute", schemaId: "sow:provider-route", instance: validProviderRoute, valid: true },
  { model: "ProviderProfile", schemaId: "sow:provider-profile", instance: validProviderProfile, valid: true },
  { model: "ProviderMatrix", schemaId: "sow:provider-matrix", instance: validProviderMatrix, valid: true },
  { model: "Workspace", schemaId: "sow:workspace", instance: validWorkspace, valid: true },
  { model: "AgentJob", schemaId: "sow:agent-job", instance: validAgentJob, valid: true },
  { model: "KnowledgeMutationPlan", schemaId: "sow:knowledge-mutation-plan", instance: validKnowledgeMutationPlan, valid: true },
  { model: "ProposedAction", schemaId: "sow:proposed-action", instance: validProposedAction, valid: true },
  { model: "ExternalWriteEnvelope", schemaId: "sow:external-write-envelope", instance: validExternalWriteEnvelope, valid: true },
  { model: "WriteReceipt", schemaId: "sow:write-receipt", instance: validWriteReceipt, valid: true },
  { model: "SourceEnvelope", schemaId: "sow:source-envelope", instance: validSourceEnvelope, valid: true },
  { model: "GclProjection", schemaId: "sow:gcl-projection", instance: validGclProjection, valid: true },
  { model: "Approval", schemaId: "sow:approval", instance: validApproval, valid: true },
  { model: "AuditRecord", schemaId: "sow:audit-record", instance: validAuditRecord, valid: true },
  { model: "Project", schemaId: "sow:project", instance: validProject, valid: true },
  { model: "WorkflowRunRef", schemaId: "sow:workflow-run-ref", instance: validWorkflowRunRef, valid: true },
  { model: "HealthItem", schemaId: "sow:health-item", instance: validHealthItem, valid: true },
  { model: "NotebookMapping", schemaId: "sow:notebook-mapping", instance: validNotebookMapping, valid: true },
  { model: "SemanticFact", schemaId: "sow:semantic-fact", instance: validSemanticFact, valid: true },
  { model: "FactProvenance", schemaId: "sow:fact-provenance", instance: validFactProvenance, valid: true },
  { model: "SignedProvenanceStamp", schemaId: "sow:signed-provenance-stamp", instance: validSignedProvenanceStamp, valid: true },
  { model: "ParityReport", schemaId: "sow:parity-report", instance: validParityReport, valid: true },
  { model: "Divergence", schemaId: "sow:divergence", instance: validDivergence, valid: true },
  { model: "QuarantineRecord", schemaId: "sow:quarantine-record", instance: validQuarantineRecord, valid: true },
  { model: "GBrainProposedFact", schemaId: "sow:gbrain-proposed-fact", instance: validGBrainProposedFact, valid: true },
  { model: "GbrainReadGrant", schemaId: "sow:gbrain-read-grant", instance: validGbrainReadGrant, valid: true },
  { model: "GbrainPin", schemaId: "sow:gbrain-pin", instance: validGbrainPin, valid: true },
  { model: "ConformanceResult", schemaId: "sow:conformance-result", instance: validConformanceResult, valid: true },
  { model: "AgentExtractionCandidate", schemaId: "sow:agent-extraction", instance: validAgentExtractionCandidate, valid: true },

  // ── INVALID — one per pinned rejection rule ───────────────────────────────
  { model: "ToolPolicy", schemaId: "sow:tool-policy", instance: invalidToolPolicyMutatingReadOnly, valid: false, rejectedBy: "refine" },
  { model: "EgressPolicy", schemaId: "sow:egress-policy", instance: invalidEgressPolicyAckWithoutTimestamp, valid: false, rejectedBy: "refine" },
  { model: "KnowledgeMutationPlan", schemaId: "sow:knowledge-mutation-plan", instance: invalidKnowledgeMutationPlanEmptySourceRefs, valid: false, rejectedBy: "refine" },
  { model: "ProviderMatrix", schemaId: "sow:provider-matrix", instance: invalidProviderMatrixRouteNotAllowed, valid: false, rejectedBy: "refine" },
  { model: "ProposedAction", schemaId: "sow:proposed-action", instance: invalidProposedActionMissingKeys, valid: false, rejectedBy: "schema_gate" },
  { model: "GclProjection", schemaId: "sow:gcl-projection", instance: invalidGclProjectionMissingVisibility, valid: false, rejectedBy: "schema_gate" },
  { model: "ProviderProfile", schemaId: "sow:provider-profile", instance: invalidProviderProfileInlineSecret, valid: false, rejectedBy: "schema_gate" },
  { model: "SignedProvenanceStamp", schemaId: "sow:signed-provenance-stamp", instance: invalidSignedProvenanceStampWrongWriter, valid: false, rejectedBy: "schema_gate" },
  { model: "GbrainReadGrant", schemaId: "sow:gbrain-read-grant", instance: invalidGbrainReadGrantGenerationOn, valid: false, rejectedBy: "schema_gate" },
  { model: "ExtractionField", schemaId: null, instance: invalidNoInferenceUnbackedFields, valid: false, rejectedBy: "no_inference" },
];
