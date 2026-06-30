// FactProvenance seam model (task WT, §6/§12). The per-fact provenance descriptor
// that records WHERE a `SemanticFact` came from and its materialization state, so
// the GBrain write-through & divergence/parity layer (§6 invariants iii/iv/vii,
// §12 GO conditions) can classify it. `origin` is the materialization state; the
// stamp-bound fields (kwRevision/originPath/mdContentSha/stampSig) mirror the
// `SignedProvenanceStamp` KnowledgeWriter writes at commit; `gbrainLinkSource`
// mirrors the GBrain `links.link_source` column for edge facts. Zod is the single
// source of truth: the TS type is `z.infer` (surfaced as the explicit
// `FactProvenance` interface), the JSON Schema is generated via `emitJsonSchema`.
// PURE — imports only foundation primitives.
//
// DESCRIPTIVE, NOT PRESCRIPTIVE — no cross-field refine. FactProvenance must be
// able to REPRESENT the defect/adversarial states the parity layer is required to
// DETECT downstream: §12 #3's "borrowed-stamp" case is a `db_only` fact that
// CARRIES a (forged/borrowed) `stampSig`, and the `unstamped` divergence (§6 vii)
// is a `markdown` fact that LACKS one. A coupling invariant such as
// "stampSig present ⟹ origin ∈ {markdown,frontmatter}" would make those states
// unrepresentable — a latent contract bug — so it is intentionally absent. The
// only invariants here are field-level (required `origin`; the rest optional).
import { z } from "zod";
import { MdContentShaSchema, RevisionIdSchema } from "../primitives/zod-brands";
import { factProvenanceOriginSchema, gbrainLinkSourceSchema } from "./shared-enums";
import type { MdContentSha, RevisionId } from "../primitives/zod-brands";
import type { FactProvenanceOrigin, GbrainLinkSource } from "./shared-enums";

/** Stable JSON-Schema `$id` for the schema registry. */
export const FACT_PROVENANCE_SCHEMA_ID = "sow:fact-provenance" as const;

// Explicit output interface + annotation: the inferred type would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023) — the same workaround `egress-policy.ts`/`semantic-fact.ts` use (the
// branded `kwRevision`/`mdContentSha` fields trigger it). A nameable
// `FactProvenance` type sidesteps that; `.strict()` runtime rejection of unknown
// keys is unaffected.
export interface FactProvenance {
  origin: FactProvenanceOrigin;
  kwRevision?: RevisionId;
  originPath?: string;
  mdContentSha?: MdContentSha;
  stampSig?: string;
  // arch_gap: gbrainLinkSource only applies to EDGE facts (mirrors GBrain
  // `links.link_source`); for non-edge facts it is absent. The "absent vs explicit
  // null" distinction is preserved (Appendix A names `…|null` AND marks the field
  // optional) — null = an edge fact with an unrecorded source; absent = a non-edge
  // fact. The exact per-factKind applicability is unspecified upstream and is left
  // unconstrained here.
  gbrainLinkSource?: GbrainLinkSource | null;
}

interface FactProvenanceInput {
  origin: FactProvenanceOrigin;
  kwRevision?: string;
  originPath?: string;
  mdContentSha?: string;
  stampSig?: string;
  gbrainLinkSource?: GbrainLinkSource | null;
}

export const FactProvenanceSchema: z.ZodType<
  FactProvenance,
  z.ZodTypeDef,
  FactProvenanceInput
> = z
  .object({
    origin: factProvenanceOriginSchema,
    kwRevision: RevisionIdSchema.optional(),
    // arch_gap: originPath is the canonical Markdown path of the fact's home; its
    // precise path grammar is unspecified upstream — modeled as an open non-empty
    // string (an empty path is not a real location).
    originPath: z.string().min(1).optional(),
    mdContentSha: MdContentShaSchema.optional(),
    // arch_gap: stampSig is the `sig` portion of the SignedProvenanceStamp (HMAC
    // hex); its exact encoding is owned by the §6 stamp model — modeled as an open
    // non-empty string here.
    stampSig: z.string().min(1).optional(),
    gbrainLinkSource: gbrainLinkSourceSchema.nullable().optional(),
  })
  .strict();
