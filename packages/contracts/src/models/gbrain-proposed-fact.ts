// GBrainProposedFact seam model (task WT, §6/§7). The candidate unit on the
// PROPOSE-ONLY generative path (§6 (vi)): a gbrain-generated fact reaches
// canonical state ONLY via `GBrainProposedFact` → JSON-Schema + no-inference gate
// → `KnowledgeMutationPlan` (`provenanceOrigin='gbrain_proposal'`) → KnowledgeWriter
// → Markdown. It is candidate data (safety rule 2): nothing is written until it
// passes the schema gate. Its evidence MUST cite already-canonical Markdown / an
// ingested `SourceEnvelope` span — the proposal's own scratch origin is
// inadmissible (§6 (vi)), enforced by `CanonicalSourceRefSchema`'s `kind` enum.
// Zod is the single source of truth: the TS type is `z.infer` (surfaced as the
// explicit `GBrainProposedFact` interface), the JSON Schema is generated via
// `emitJsonSchema`. PURE — imports only foundation primitives + shared shapes/enums.
import { z } from "zod";
import { ProposalIdSchema, WorkspaceIdSchema } from "../primitives/zod-brands";
import { factKindSchema, generatedBySchema } from "./shared-enums";
import { CanonicalSourceRefSchema } from "./shared-shapes";
import type { ProposalId } from "../primitives/zod-brands";
import type { WorkspaceId } from "../primitives/ids";
import type { FactKind, GeneratedBy } from "./shared-enums";
import type { CanonicalSourceRef } from "./shared-shapes";

/** Stable JSON-Schema `$id` for the schema registry. */
export const GBRAIN_PROPOSED_FACT_SCHEMA_ID = "sow:gbrain-proposed-fact" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) via the branded `ProposalId` / `WorkspaceId`. A nameable
// `GBrainProposedFact` type sidesteps that (the same workaround `egress-policy.ts`
// and `shared-shapes.ts`'s `SourceRef` use); `.strict()` runtime rejection of
// unknown keys is unaffected.
export interface GBrainProposedFact {
  proposalId: ProposalId;
  workspaceId: WorkspaceId;
  // Closed enum: page|link|timeline|tag|frontmatter_value (the SemanticFact kinds).
  factKind: FactKind;
  // arch_gap: proposedContent's shape is UNSPECIFIED upstream (Appendix A names
  // only the field). Modeled as an OPEN record (a required object, open inner
  // keys) rather than inventing a per-factKind closed shape; the precise body /
  // link / timeline / tag payload firms up with the §6/Phase-4 KnowledgeWriter
  // mutation primitives.
  proposedContent: Record<string, unknown>;
  // Each ref MUST point at already-canonical Markdown OR an ingested
  // `SourceEnvelope` span — scratch origin is inadmissible (§6 (vi)), enforced
  // by `CanonicalSourceRefSchema.kind`. Non-empty: a generative proposal with no
  // cited evidence is precisely the "invented fact" the no-inference rule
  // (REQ-F-017) / candidate-data gate (safety rule 2) forbids.
  evidenceRefs: CanonicalSourceRef[];
  // Generator self-reported confidence ∈ [0,1].
  confidence: number;
  // Closed enum: synthesis|dream|patterns|minion (the generative producers).
  generatedBy: GeneratedBy;
  // Human-in-the-loop gate. Defaults ON — a proposal requires approval before it
  // can become a `KnowledgeMutationPlan` (§6 (vi) propose-only path).
  requiresApproval: boolean;
}

// `requiresApproval` carries a `.default(true)`, so it is OPTIONAL on the parse
// INPUT but always PRESENT on the output. `CanonicalSourceRef` carries no branded
// fields, so its input shape equals its output shape.
interface GBrainProposedFactInput {
  proposalId: string;
  workspaceId: string;
  factKind: FactKind;
  proposedContent: Record<string, unknown>;
  evidenceRefs: CanonicalSourceRef[];
  confidence: number;
  generatedBy: GeneratedBy;
  requiresApproval?: boolean;
}

export const GBrainProposedFactSchema: z.ZodType<
  GBrainProposedFact,
  z.ZodTypeDef,
  GBrainProposedFactInput
> = z
  .object({
    proposalId: ProposalIdSchema,
    workspaceId: WorkspaceIdSchema,
    factKind: factKindSchema,
    proposedContent: z.record(z.string(), z.unknown()),
    // Non-empty (§6 (vi): "evidence must cite already-canonical Markdown / an
    // ingested SourceEnvelope"); `kind` enum rejects scratch/unmaterialized origins.
    evidenceRefs: z.array(CanonicalSourceRefSchema).min(1),
    confidence: z.number().min(0).max(1),
    generatedBy: generatedBySchema,
    requiresApproval: z.boolean().default(true),
  })
  .strict();
