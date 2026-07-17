// 1.15 — canonical VALID seam fixtures (DATA). One per Appendix-A contract (27
// models). Each is a typed literal that compiles against the contract type AND
// parses under its Zod schema / passes the 1.2 candidate-data gate. These are the
// shared seam fixtures every downstream track's RED outlines import.
//
// PURE DATA — no clock/random/I-O, so snapshots/replay stay stable. Branded leaf
// values use `as <Brand>` casts (brands are runtime-plain strings; the cast keeps
// each fixture a static literal rather than a constructor call). Imports are
// RELATIVE (a fixtures module inside @sow/contracts never self-imports the barrel)
// and type-only for types (verbatimModuleSyntax).
import type { WorkspaceId, AgentJobId, ActionId, PlanId, SourceId, ApprovalId, WorkflowId, AuditId } from "../primitives/ids";
import type { ProcessorId, ToolId } from "../primitives/enums";
import type { Capability, RevisionId, ProposalId, ReportId, BrainId, ProjectId, FactIdentity, MdContentSha } from "../primitives/zod-brands";
import type { AgentExtractionCandidate } from "../models/agent-extraction";
import type { ToolPolicy } from "../models/tool-policy";
import type { EgressPolicy } from "../models/egress-policy";
import type { ProviderRoute } from "../models/provider-route";
import type { ProviderProfile } from "../models/provider-profile";
import type { ProviderMatrix } from "../models/provider-matrix";
import type { Workspace } from "../models/workspace";
import type { AgentJob } from "../models/agent-job";
import type { KnowledgeMutationPlan } from "../models/knowledge-mutation-plan";
import type { ProposedAction } from "../models/proposed-action";
import type { Project } from "../models/project";
import type { ExternalWriteEnvelope } from "../models/external-write-envelope";
import type { WriteReceipt } from "../models/write-receipt";
import type { SourceEnvelope } from "../models/source-envelope";
import type { GclProjection } from "../models/gcl-projection";
import type { Approval } from "../models/approval";
import type { AuditRecord } from "../models/audit-record";
import type { WorkflowRunRef } from "../models/workflow-run-ref";
import type { HealthItem } from "../models/health-item";
import type { NotebookMapping } from "../models/notebook-mapping";
import type { SemanticFact } from "../models/semantic-fact";
import type { FactProvenance } from "../models/fact-provenance";
import type { SignedProvenanceStamp } from "../models/signed-provenance-stamp";
import type { ParityReport } from "../models/parity-report";
import type { Divergence } from "../models/divergence";
import type { QuarantineRecord } from "../models/quarantine-record";
import type { GBrainProposedFact } from "../models/gbrain-proposed-fact";
import type { GbrainReadGrant } from "../models/gbrain-read-grant";
import type { GbrainPin } from "../models/gbrain-pin";
import type { ConformanceResult } from "../provider/conformance-result";

// ── Deterministic literal constants (no clock/random) ────────────────────────
/** 64-char lowercase-hex (sha256-shaped) for `MdContentSha`. */
const SHA256_HEX = "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d";
/** 40-char lowercase-hex git SHA for `GbrainPin.gbrainSha`. */
const GIT_SHA40 = "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d";
/** Fixed RFC3339 instant — deterministic, never `Date.now()`. */
const T0 = "2026-06-30T12:00:00Z";

// ── 1. ToolPolicy ────────────────────────────────────────────────────────────
export const validToolPolicy: ToolPolicy = {
  mode: "read_only",
  allowedTools: ["read.file" as ToolId],
  deniedTools: [],
  allowsMutating: false,
};

// ── 2. EgressPolicy ──────────────────────────────────────────────────────────
export const validEgressPolicy: EgressPolicy = {
  workspaceId: "ws-egress-001" as WorkspaceId,
  allowedProcessors: ["proc.anthropic" as ProcessorId],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
};

// ── 3. ProviderRoute (provider branch) ───────────────────────────────────────
export const validProviderRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

// ── 4. ProviderProfile (no inline secret) ────────────────────────────────────
export const validProviderProfile: ProviderProfile = {
  provider: "claude",
  endpoint: "https://api.anthropic.com",
  model: "claude-opus-4",
  capabilities: ["meeting.close" as Capability],
  egressClass: "cloud",
  costCaps: { maxCostUsd: 5, maxRuntimeSeconds: 120 },
  conformanceStatus: "passing",
};

// ── 5. ProviderMatrix (route provider ∈ allowedProviders) ────────────────────
export const validProviderMatrix: ProviderMatrix = {
  workspaceId: "ws-matrix-001" as WorkspaceId,
  allowedProviders: ["claude"],
  capabilityDefaults: { "meeting.close": validProviderRoute } as ProviderMatrix["capabilityDefaults"],
  rawCloudEgressEnabled: true,
};

// ── 6. Workspace (id ≡ embedded workspaceIds) ────────────────────────────────
const WORKSPACE_FIXTURE_ID = "ws-001" as WorkspaceId;
export const validWorkspace: Workspace = {
  id: WORKSPACE_FIXTURE_ID,
  name: "Acme API",
  type: "employer_work",
  dataOwner: "employer",
  markdownRepoPath: "/vault/acme",
  gbrainBrainId: "brain-acme" as BrainId,
  defaultVisibility: "isolated",
  egressPolicy: {
    workspaceId: WORKSPACE_FIXTURE_ID,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WORKSPACE_FIXTURE_ID,
    allowedProviders: ["claude"],
    capabilityDefaults: {},
    rawCloudEgressEnabled: false,
  },
};

// ── 7. AgentJob ──────────────────────────────────────────────────────────────
export const validAgentJob: AgentJob = {
  id: "job-001" as AgentJobId,
  workflowRunId: "wf-001" as WorkflowId,
  workspaceId: "ws-001" as WorkspaceId,
  capability: "meeting.close" as Capability,
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: validToolPolicy,
  providerRoute: validProviderRoute,
  trustLevel: "trusted",
  carriesRawContent: false,
  maxRuntimeSeconds: 300,
  maxCostUsd: 5,
  idempotencyKey: "idem-job-001",
};

// ── 7b. ConformanceResult (task 5.10 — passing cloud provider pair) ──────────
export const validConformanceResult: ConformanceResult = {
  subjectKind: "provider",
  subjectId: "openrouter",
  capability: "meeting.close" as Capability,
  model: "anthropic/claude-haiku-4.5",
  egressClass: "cloud",
  status: "passing",
  checkedAt: T0,
};

// ── 8. KnowledgeMutationPlan (non-empty sourceRefs) ──────────────────────────
export const validKnowledgeMutationPlan: KnowledgeMutationPlan = {
  planId: "plan-001" as PlanId,
  workspaceId: "ws-001" as WorkspaceId,
  sourceRefs: [{ sourceId: "src-001" as SourceId }],
  creates: [],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.9,
  requiresApproval: true,
  provenanceOrigin: "meeting_close",
};

// ── 9. ProposedAction (both external-write keys present) ──────────────────────
export const validProposedAction: ProposedAction = {
  actionId: "act-001" as ActionId,
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:acme-followup",
  payload: { title: "Follow up with Acme" },
  approvalPolicy: "requires_approval",
  idempotencyKey: "idem-act-001",
};

// ── 10. WriteReceipt ─────────────────────────────────────────────────────────
export const validWriteReceipt: WriteReceipt = {
  externalObjectId: "drive-file-abc123",
  externalUrl: "https://drive.google.com/file/d/abc123",
  recordedAt: T0,
  rawRef: "raw:req:1",
};

// ── 11. ExternalWriteEnvelope (linkage-consistent with validProposedAction) ──
export const validExternalWriteEnvelope: ExternalWriteEnvelope = {
  actionId: "act-001" as ActionId,
  targetSystem: "todoist",
  canonicalObjectKey: "todoist:task:acme-followup",
  idempotencyKey: "idem-act-001",
  preconditions: ["not_exists"],
  payloadHash: "sha256:deadbeef",
  approvalId: "appr-001" as ApprovalId,
  writeReceipt: validWriteReceipt,
};

// ── 12. SourceEnvelope ───────────────────────────────────────────────────────
export const validSourceEnvelope: SourceEnvelope = {
  sourceId: "src-001" as SourceId,
  workspaceId: "ws-001" as WorkspaceId,
  origin: "https://www.youtube.com/watch?v=abc123",
  contentHash: "sha256:source-abc",
  type: "youtube_video",
  sensitivity: "normal",
  routingHints: { workspaceHint: "acme" },
};

// ── 13. GclProjection (sanitized — no raw-content-shaped keys) ────────────────
export const validGclProjection: GclProjection = {
  workspaceId: "ws-001" as WorkspaceId,
  visibilityLevel: "coordination",
  projectionType: "calendar_busy",
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as SourceId }],
};

// ── 14. Approval (pending — no snoozeUntil) ──────────────────────────────────
export const validApproval: Approval = {
  id: "appr-001" as ApprovalId,
  actionRef: "act-001" as ActionId,
  subjectKind: "external_action",
  workspaceId: "ws-001" as WorkspaceId,
  status: "pending",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "sha256:approval-abc",
};

// ── 15. AuditRecord (summaries only — no raw content) ────────────────────────
export const validAuditRecord: AuditRecord = {
  actor: "KnowledgeWriter",
  event: "knowledge.committed",
  refs: ["plan-001"],
  payloadHash: "sha256:audit-abc",
  beforeSummary: "no prior note",
  afterSummary: "note created at acme/auth.md",
  timestamps: { occurredAt: T0 },
};

// ── Project (§13.5) ──────────────────────────────────────────────────────────
export const validProject: Project = {
  id: "proj-001" as ProjectId,
  workspaceId: "ws-employer" as WorkspaceId,
  slug: "employer-work/projects/auth-redesign",
  title: "Auth redesign",
  lifecycleState: "active",
  timeline: [
    { state: "idea", eventTime: T0, transactionTime: T0 },
    { state: "planning", eventTime: T0, transactionTime: T0 },
    { state: "active", eventTime: T0, transactionTime: T0 },
  ],
  provenanceOrigin: "project_capture",
};

// ── 16. WorkflowRunRef ───────────────────────────────────────────────────────
export const validWorkflowRunRef: WorkflowRunRef = {
  workflowId: "wf-001" as WorkflowId,
  trigger: "schedule",
  state: "running",
  idempotencyKey: "idem-wf-001",
  auditRefs: ["audit-001" as AuditId],
};

// ── 17. HealthItem (open — no resolvedAt) ────────────────────────────────────
export const validHealthItem: HealthItem = {
  id: "health-001",
  failureClass: "parity_defect",
  severity: "error",
  message: "DB-only fact detected during reconciliation",
  auditRef: "audit-001" as AuditId,
  openedAt: T0,
  state: "open",
};

// ── 18. NotebookMapping (all five managed docs) ──────────────────────────────
export const validNotebookMapping: NotebookMapping = {
  projectId: "proj-001",
  notebookKey: "nb-acme",
  driveFolderId: "drive-folder-1",
  managedDocIds: {
    "00_brief": "doc-00",
    "01_decisions": "doc-01",
    "02_meetings": "doc-02",
    "03_research": "doc-03",
    "04_open_questions": "doc-04",
  },
};

// ── 19. SemanticFact (identity prefix agrees with factKind) ──────────────────
export const validSemanticFact: SemanticFact = {
  factIdentity: "page:acme/auth" as FactIdentity,
  factKind: "page",
  workspaceId: "ws-001" as WorkspaceId,
  mdContentSha: SHA256_HEX as MdContentSha,
  revisionId: "rev-001" as RevisionId,
};

// ── 20. FactProvenance ───────────────────────────────────────────────────────
export const validFactProvenance: FactProvenance = {
  origin: "markdown",
  kwRevision: "rev-001" as RevisionId,
  originPath: "acme/auth.md",
  mdContentSha: SHA256_HEX as MdContentSha,
  stampSig: "hmac-abc",
};

// ── 21. SignedProvenanceStamp (writerActor literal) ──────────────────────────
export const validSignedProvenanceStamp: SignedProvenanceStamp = {
  kwRevision: "rev-001" as RevisionId,
  originPath: "acme/auth.md",
  mdContentSha: SHA256_HEX as MdContentSha,
  writerActor: "KnowledgeWriter",
  sourceEventRef: "meeting:123",
  committedAt: T0,
  sig: "hmac-deadbeef",
};

// ── 22. Divergence (soft class — non-hard floor allowed) ─────────────────────
export const validDivergence: Divergence = {
  factIdentity: "page:acme/auth" as FactIdentity,
  divergenceClass: "content_mismatch",
  severityFloor: "soft",
  mdContentSha: SHA256_HEX as MdContentSha,
  dbContentHash: "db:hash:1",
  remediation: "resync",
};

// ── 23. ParityReport (cleanForServing with no hard divergence) ───────────────
export const validParityReport: ParityReport = {
  reportId: "report-001" as ReportId,
  workspaceId: "ws-001" as WorkspaceId,
  reconciledAtRevision: "rev-001" as RevisionId,
  gbrainSchemaVersion: 7,
  canonicalFactCount: 10,
  dbFactCount: 10,
  divergences: [],
  cleanForServing: true,
  coverageComplete: true,
};

// ── 24. QuarantineRecord ─────────────────────────────────────────────────────
export const validQuarantineRecord: QuarantineRecord = {
  factIdentity: "page:acme/auth" as FactIdentity,
  workspaceId: "ws-001" as WorkspaceId,
  divergenceRef: "div-001",
  divergenceClass: "db_only",
  capturedDbDigest: "db:digest:1",
  remediationState: "pending",
  healthItemId: "health-001",
  auditRef: "audit-001" as AuditId,
};

// ── 25. GBrainProposedFact (canonical evidence, ≥1 ref) ──────────────────────
export const validGBrainProposedFact: GBrainProposedFact = {
  proposalId: "prop-001" as ProposalId,
  workspaceId: "ws-001" as WorkspaceId,
  factKind: "page",
  proposedContent: { title: "New synthesized insight" },
  evidenceRefs: [{ kind: "markdown", ref: "acme/auth.md" }],
  confidence: 0.8,
  generatedBy: "synthesis",
  requiresApproval: true,
};

// ── 26. GbrainReadGrant (read-only, workspace-scoped, generation-off) ────────
export const validGbrainReadGrant: GbrainReadGrant = {
  workspaceId: "ws-001" as WorkspaceId,
  brainId: "brain-acme" as BrainId,
  transport: "http",
  scope: ["read"],
  tokenRef: "keychain:gbrain-token",
  allowedOps: ["search", "graph"],
  federationScope: "workspace_only",
  generativeCycleEnabled: false,
  pinnedSha: GIT_SHA40,
  indexSchemaVersion: 7,
};

// ── 27. GbrainPin ────────────────────────────────────────────────────────────
export const validGbrainPin: GbrainPin = {
  gbrainSha: GIT_SHA40,
  gbrainTag: "0.35.1.0",
  gbrainRepo: "https://github.com/example/gbrain",
  indexSchemaVersion: 7,
  validatedOn: "2026-06-30",
  validationRef: "docs/design/gbrain-write-through-divergence.md",
  writeThroughEnabled: false,
};

// ── 28. AgentExtractionCandidate (CP-1 / GATE-1 — evidence-bearing + clean) ─────
// `owner` is a concrete evidence-backed claim (survives validateNoInference);
// `dueDate` is the REQ-F-017 `TBD` park value (no evidenceRef needed). Schema-valid
// AND no-inference-clean, so it passes both the candidate-data gate and REQ-F-017.
export const validAgentExtractionCandidate: AgentExtractionCandidate = {
  fields: {
    owner: { value: "Alice", evidenceRef: "transcript#L12" },
    dueDate: { value: "TBD" },
  },
};
