// SignedProvenanceStamp seam model (task 1.7(WT), §6/§12). The HMAC-signed
// frontmatter sub-shape KnowledgeWriter writes at the atomic commit (§6
// write-through invariant (iii) "signed provenance"). Serve-time content
// rebinding makes a copied/forged stamp fail; the only writer that may stamp it
// is KnowledgeWriter (safety rule 1 — one writer / no hidden brain), pinned here
// by `writerActor = z.literal("KnowledgeWriter")`. The stamp survives
// `gbrain import` into the `pages.frontmatter` JSONB column (gbrain strips only
// `slug:`) — a downstream durability note, not a contract constraint here.
// Zod is the single source of truth: the TS type is the explicit interface
// below (see TS4023 note), the JSON Schema is generated via `emitJsonSchema`.
// PURE — imports only foundation primitives.
import { z } from "zod";
import { RevisionIdSchema, MdContentShaSchema } from "../primitives/zod-brands";
import type { RevisionId, MdContentSha } from "../primitives/zod-brands";

/** Stable JSON-Schema `$id` for the schema registry. */
export const SIGNED_PROVENANCE_STAMP_SCHEMA_ID = "sow:signed-provenance-stamp" as const;

// Explicit output interface + annotation: the inferred type would otherwise
// force the declaration emitter to name `ids.ts`'s module-private `__brand`
// symbol (TS4023) via the `RevisionId`/`MdContentSha` brands — the same
// workaround `egress-policy.ts` / `shared-shapes.ts` use. A nameable
// `SignedProvenanceStamp` type sidesteps that; `.strict()` runtime rejection of
// unknown keys and the `writerActor` literal are unaffected.
export interface SignedProvenanceStamp {
  kwRevision: RevisionId;
  // arch_gap: originPath shape (vault-relative path, optionally region-suffixed)
  // is unspecified upstream — modeled as an open non-empty string.
  originPath: string;
  mdContentSha: MdContentSha;
  writerActor: "KnowledgeWriter";
  // arch_gap: sourceEventRef shape (the originating event reference, e.g.
  // meeting/ingestion id) is unspecified upstream — open non-empty string.
  sourceEventRef: string;
  committedAt: string;
  // arch_gap: sig is "HMAC over (workspaceId, factIdentity, originPath,
  // mdContentSha)" rendered as hex (scheme v2 — the volatile kwRevision is NOT
  // bound; see knowledge-writer/provenance-stamp.ts header for why). kwRevision
  // remains a stored-but-UNSIGNED informational field. The encoding/length is not
  // pinned upstream — modeled as an open non-empty string (NOT a closed regex).
  sig: string;
}

interface SignedProvenanceStampInput {
  kwRevision: string;
  originPath: string;
  mdContentSha: string;
  writerActor: "KnowledgeWriter";
  sourceEventRef: string;
  committedAt: string;
  sig: string;
}

export const SignedProvenanceStampSchema: z.ZodType<
  SignedProvenanceStamp,
  z.ZodTypeDef,
  SignedProvenanceStampInput
> = z
  .object({
    kwRevision: RevisionIdSchema,
    originPath: z.string().min(1),
    mdContentSha: MdContentShaSchema,
    // One-writer invariant at the contract surface: any non-"KnowledgeWriter"
    // actor is rejected by the schema gate (safety rule 1).
    writerActor: z.literal("KnowledgeWriter"),
    sourceEventRef: z.string().min(1),
    committedAt: z.string().datetime(),
    sig: z.string().min(1),
  })
  .strict();
