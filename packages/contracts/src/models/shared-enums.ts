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
] as const;
export const provenanceOriginSchema = z.enum(ProvenanceOrigin);
export type ProvenanceOrigin = z.infer<typeof provenanceOriginSchema>;

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
