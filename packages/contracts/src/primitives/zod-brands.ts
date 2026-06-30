// Zod schemas for branded IDs (Phase-1 contract freeze). Authored ONCE here so
// every model IMPORTS these brand schemas and nothing drifts. Each schema's
// `z.infer` EQUALS the corresponding `Branded<>` type — existing brands re-use
// the types from `./ids`; new brands define their `Branded<>` type here too.
//
// Idiom: a non-empty-after-trim string `.transform`ed to the brand. The transform
// changes only the OUTPUT type (the brand); the INPUT schema stays a plain
// `{ type:'string', minLength:1 }`, so `emitJsonSchema` produces a clean,
// self-contained JSON Schema with no `$ref`/`$defs`. PURE.
import { z } from "zod";
import type { Branded } from "./ids";
import type {
  WorkspaceId,
  AgentJobId,
  ActionId,
  PlanId,
  SourceId,
  ApprovalId,
  WorkflowId,
  AuditId,
} from "./ids";
import type { ProcessorId, ToolId } from "./enums";

/**
 * Branded-string schema factory: a trimmed-non-empty `string` whose parse OUTPUT
 * is the brand `B`. Rejects both empty and whitespace-only input; emits a clean
 * `{ type:'string', minLength:1 }` JSON Schema (the `refine`/`transform` add no
 * JSON-Schema keywords).
 */
const brandedIdSchema = <B extends string>(): z.ZodType<B, z.ZodTypeDef, string> =>
  z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, "empty/whitespace")
    .transform((s): B => s as B);

// ── Existing brands (types re-used from ./ids) ──────────────────────────────
export const WorkspaceIdSchema = brandedIdSchema<WorkspaceId>();
export const AgentJobIdSchema = brandedIdSchema<AgentJobId>();
export const ActionIdSchema = brandedIdSchema<ActionId>();
export const PlanIdSchema = brandedIdSchema<PlanId>();
export const SourceIdSchema = brandedIdSchema<SourceId>();
export const ApprovalIdSchema = brandedIdSchema<ApprovalId>();
export const WorkflowIdSchema = brandedIdSchema<WorkflowId>();
export const AuditIdSchema = brandedIdSchema<AuditId>();
export const ProcessorIdSchema = brandedIdSchema<ProcessorId>();
export const ToolIdSchema = brandedIdSchema<ToolId>();

// ── New brands (Branded<> type defined here + schema + inferred export) ──────
export type Capability = Branded<string, "Capability">;
export const CapabilitySchema = brandedIdSchema<Capability>();

export type RevisionId = Branded<string, "RevisionId">;
export const RevisionIdSchema = brandedIdSchema<RevisionId>();

export type ProposalId = Branded<string, "ProposalId">;
export const ProposalIdSchema = brandedIdSchema<ProposalId>();

export type ReportId = Branded<string, "ReportId">;
export const ReportIdSchema = brandedIdSchema<ReportId>();

export type BrainId = Branded<string, "BrainId">;
export const BrainIdSchema = brandedIdSchema<BrainId>();

// ── FactIdentity — content-INDEPENDENT structured identity (Appendix A) ──────
// Forms (lenient inner chars):
//   page:<slug>  |  link:<src>-><dst>:<field>  |  timeline:<page>:<seq>  |  tag:<page>:<tag>
export type FactIdentity = Branded<string, "FactIdentity">;
const FACT_IDENTITY_RE = /^(?:page:.+|link:.+->.+:.+|timeline:.+:.+|tag:.+:.+)$/;
export const FactIdentitySchema = z
  .string()
  .regex(FACT_IDENTITY_RE, "invalid fact identity")
  .transform((s): FactIdentity => s as FactIdentity);

/** Structured parts for building a `FactIdentity` string. */
export type FactIdentityParts =
  | { kind: "page"; slug: string }
  | { kind: "link"; src: string; dst: string; field: string }
  | { kind: "timeline"; page: string; seq: string | number }
  | { kind: "tag"; page: string; tag: string };

/** Builder: assemble (but do not validate) a `FactIdentity` from typed parts. */
export function factIdentity(parts: FactIdentityParts): FactIdentity {
  switch (parts.kind) {
    case "page":
      return `page:${parts.slug}` as FactIdentity;
    case "link":
      return `link:${parts.src}->${parts.dst}:${parts.field}` as FactIdentity;
    case "timeline":
      return `timeline:${parts.page}:${parts.seq}` as FactIdentity;
    case "tag":
      return `tag:${parts.page}:${parts.tag}` as FactIdentity;
  }
}

// ── MdContentSha — sha256 hex of normalized semantic content (Appendix A) ────
export type MdContentSha = Branded<string, "MdContentSha">;
export const MdContentShaSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "sha256 hex")
  .transform((s): MdContentSha => s as MdContentSha);
