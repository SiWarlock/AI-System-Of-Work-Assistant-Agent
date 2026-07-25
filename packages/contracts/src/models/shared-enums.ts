// Shared z.enum schemas + inferred types (Phase-1 contract freeze). Authored
// ONCE here so every model IMPORTS these enum schemas and the literal sets never
// drift. Reused enums wrap the const tuples already declared in
// `../primitives/enums` (the single source of those literal sets); new enums
// declare their const tuple + `z.enum` + inferred type together. PURE.
import { z } from "zod";
import {
  WorkspaceType,
  DataOwner,
  VisibilityLevel,
  EgressClass,
  ProviderId,
} from "../primitives/enums";

// ── Reused enums (tuples from ../primitives/enums; types already exported there) ──
export const WorkspaceTypeSchema = z.enum(WorkspaceType);
export const DataOwnerSchema = z.enum(DataOwner);
export const VisibilityLevelSchema = z.enum(VisibilityLevel);
export const EgressClassSchema = z.enum(EgressClass);
export const ProviderIdSchema = z.enum(ProviderId);

// ── New enums (const tuple + z.enum + inferred type) ─────────────────────────

export const ProvenanceOrigin = [
  "human",
  "meeting_close",
  "ingestion",
  "gbrain_proposal",
  "parity_remediation",
  // §13.5 — the typed Project origins: `project_capture` for a Copilot/ingest "capture this as a project"
  // mutation, `project_sync` for the projectSync workflow's derived mutations (closes the
  // deterministicProgress arch_gap that otherwise defaults a project-sync KMP to "ingestion").
  "project_capture",
  "project_sync",
  // §13.10a — the Copilot SEMANTIC-WRITE bridge: a KnowledgeMutationPlan the Copilot PROPOSED (model supplies
  // intent → server derives the validated plan). Distinguishes a human-gated Copilot proposal in the §6
  // Knowledge-Mutation machine; the plan is recorded pending in §9.8 Approvals and committed by KnowledgeWriter
  // ONLY on owner approval (never a direct/auto write — safety rules 1+2).
  "copilot_propose",
] as const;
export const provenanceOriginSchema = z.enum(ProvenanceOrigin);
export type ProvenanceOrigin = z.infer<typeof provenanceOriginSchema>;

// §13.5 — the typed Project lifecycle (the 7th domain state machine's alphabet). A project moves
// idea → planning → active, may pause, and ends done (completed) or archived (shelved/abandoned); done +
// archived are terminal. This enum is the SINGLE source of truth the `packages/domain` project state machine
// statically asserts equivalence against (mirrors ApprovalStatus ↔ the approval machine).
export const ProjectLifecycleState = [
  "idea",
  "planning",
  "active",
  "paused",
  "done",
  "archived",
] as const;
export const projectLifecycleStateSchema = z.enum(ProjectLifecycleState);
export type ProjectLifecycleState = z.infer<typeof projectLifecycleStateSchema>;

// §13.15 — the typed Task lifecycle (a simple closed status enum, NOT an 8th domain state machine:
// no transition invariant is named, so a state machine would be a heavier frozen commitment than
// the model needs). A task is `todo` → `in_progress` (may be `blocked`) and ends `done` or `cancelled`.
export const TaskLifecycle = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export const taskLifecycleSchema = z.enum(TaskLifecycle);
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;

// §13.15 — the typed Task PRIORITY vocabulary. A CLOSED enum (not a numeric scale — numbers invite
// inference + are harder to validate). Priority is OPTIONAL on Task and is NEVER inferred: absent ⇒
// the unset/TBD state (REQ-F-017), only owner-set or explicitly extracted-with-evidence.
export const Priority = ["p0", "p1", "p2", "p3"] as const;
export const prioritySchema = z.enum(Priority);
export type Priority = z.infer<typeof prioritySchema>;

export const TargetSystem = [
  "calendar",
  "todoist",
  "linear",
  "asana",
  "drive",
  "github",
  "telegram",
] as const;
export const targetSystemSchema = z.enum(TargetSystem);
export type TargetSystem = z.infer<typeof targetSystemSchema>;

export const ApprovalStatus = [
  "pending",
  "approved",
  "edited",
  "rejected",
  "deferred",
  "expired",
] as const;
export const approvalStatusSchema = z.enum(ApprovalStatus);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const Channel = ["mac", "telegram"] as const;
export const channelSchema = z.enum(Channel);
export type Channel = z.infer<typeof channelSchema>;

// §13.10a — an Approval's SUBJECT discriminator: WHAT kind of thing this pending §9.8 card gates.
// The inbox originally gated only EXTERNAL writes (a §8 ProposedAction, referenced by
// `Approval.actionRef`); the Copilot semantic-write bridge adds SEMANTIC mutations (a
// KnowledgeMutationPlan, referenced by `Approval.planRef`). `subjectKind` is the discriminator the
// on-approval executor routes off — external_action → the Tool Gateway envelope, semantic_mutation →
// KnowledgeWriter — and the desktop renders the matching card. The Approval contract's refine binds
// each kind to EXACTLY its matching ref (see approval.ts), so a mis-routed card is unrepresentable.
export const ApprovalSubjectKind = ["external_action", "semantic_mutation"] as const;
export const approvalSubjectKindSchema = z.enum(ApprovalSubjectKind);
export type ApprovalSubjectKind = z.infer<typeof approvalSubjectKindSchema>;

export const ConformanceStatus = ["unknown", "passing", "failing", "disabled"] as const;
export const conformanceStatusSchema = z.enum(ConformanceStatus);
export type ConformanceStatus = z.infer<typeof conformanceStatusSchema>;

export const HealthState = ["open", "acknowledged", "resolved"] as const;
export const healthStateSchema = z.enum(HealthState);
export type HealthState = z.infer<typeof healthStateSchema>;

export const FailureClass = [
  "connector_unreachable",
  "write_through_failed",
  "budget_breach",
  "missed_or_late_schedule",
  "schema_rejection",
  "worker_down",
  "parity_defect",
  "conflict_review",
  "sync_lagging",
  "rebuild_divergence",
  // §16 C-enum (make-it-real, 2026-07-11): dedicated members for the terminal
  // SECURITY / POLICY / EGRESS / ISOLATION causes the C-fix (77c717e) mapped to
  // least-wrong interims. ADDITIVE — every member above is unchanged (no rename/remove).
  //   • security_violation — a content-safety / secret-scan / injection fail-closed
  //     (ING-7 untrusted-content attack, KnowledgeWriter secret_found).
  //   • policy_denial      — a policy/admission refusal (ING-7 mutating-tool at admission).
  //   • egress_denied      — an egress-policy veto (safety rule 5; the egress_status precedent).
  //   • isolation_breach   — a workspace-isolation refusal (WS-4 ownership_violation).
  "security_violation",
  "policy_denial",
  "egress_denied",
  "isolation_breach",
  // 13.15 (2026-07-25): four dedicated OPERATIONAL members. ADDITIVE — every member above is
  // unchanged (no rename/remove). Each is semantically DISTINCT from the nearest existing member:
  //   • db_unavailable              — the §4 operational store is unreachable (degraded-mode.ts
  //     currently maps this to the least-wrong `worker_down`, an infra/supervision class).
  //   • provider_routing_unavailable — no eligible ModelProvider route (fail-closed no-provider;
  //     the broker already emits this literal, see broker.ts NO_ELIGIBLE_PROVIDER_HEALTH_CLASS).
  //   • outbox_blocked              — the external-write outbox is gated/held (a §8 pre-dispatch
  //     hold — NOT a write attempt that errored).
  //   • write_through_blocked       — a PRECONDITION/gate HOLDS the write-through (distinct from
  //     `write_through_failed`, where the write ATTEMPT errored; blocked = never attempted).
  "db_unavailable",
  "provider_routing_unavailable",
  "outbox_blocked",
  "write_through_blocked",
] as const;
export const failureClassSchema = z.enum(FailureClass);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const FactKind = ["page", "link", "timeline", "tag", "frontmatter_value"] as const;
export const factKindSchema = z.enum(FactKind);
export type FactKind = z.infer<typeof factKindSchema>;

export const FactProvenanceOrigin = [
  "markdown",
  "frontmatter",
  "db_only",
  "generative_unmaterialized",
] as const;
export const factProvenanceOriginSchema = z.enum(FactProvenanceOrigin);
export type FactProvenanceOrigin = z.infer<typeof factProvenanceOriginSchema>;

export const GbrainLinkSource = ["markdown", "frontmatter", "manual"] as const;
export const gbrainLinkSourceSchema = z.enum(GbrainLinkSource);
export type GbrainLinkSource = z.infer<typeof gbrainLinkSourceSchema>;

export const GeneratedBy = ["synthesis", "dream", "patterns", "minion"] as const;
export const generatedBySchema = z.enum(GeneratedBy);
export type GeneratedBy = z.infer<typeof generatedBySchema>;

export const DivergenceClass = [
  "db_only",
  "unstamped",
  "content_mismatch",
  "md_only",
  "edge_db_only",
  "edge_md_only",
  "stale_revision",
] as const;
export const divergenceClassSchema = z.enum(DivergenceClass);
export type DivergenceClass = z.infer<typeof divergenceClassSchema>;

export const SeverityFloor = ["hard", "soft"] as const;
export const severityFloorSchema = z.enum(SeverityFloor);
export type SeverityFloor = z.infer<typeof severityFloorSchema>;

export const Remediation = ["resync", "materialize", "purge", "review"] as const;
export const remediationSchema = z.enum(Remediation);
export type Remediation = z.infer<typeof remediationSchema>;

export const RemediationState = [
  "pending",
  "materializing",
  "materialized",
  "purged",
  "dismissed",
] as const;
export const remediationStateSchema = z.enum(RemediationState);
export type RemediationState = z.infer<typeof remediationStateSchema>;

export const TrustLevel = ["trusted", "untrusted"] as const;
export const trustLevelSchema = z.enum(TrustLevel);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

export const GbrainAllowedOp = [
  "search",
  "graph",
  "timeline",
  "schema_read",
  "health",
  "contained_synthesis",
] as const;
export const gbrainAllowedOpSchema = z.enum(GbrainAllowedOp);
export type GbrainAllowedOp = z.infer<typeof gbrainAllowedOpSchema>;
