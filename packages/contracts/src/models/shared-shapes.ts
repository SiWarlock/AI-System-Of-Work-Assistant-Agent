// Shared nested-only sub-shapes (Phase-1 contract freeze). These are NOT
// stand-alone seam models — they have NO independent schema-snapshot. They are
// reused as fields inside parent models and are frozen TRANSITIVELY through each
// parent model's `schema.json`. Authored ONCE here so parents IMPORT them and
// the nested shapes never drift. Every object is `.strict()` so a parent's
// schema gate rejects unknown nested keys. PURE.
import { z } from "zod";
import { SourceIdSchema } from "../primitives/zod-brands";
import type { SourceId } from "../primitives/ids";

// arch_gap: the ContextRef taxonomy (the closed set of `refKind` values + their
// `ref` formats) is unspecified in §9/runtime — typed as free strings until the
// runtime contract names it.
export const ContextRefSchema = z
  .object({
    refKind: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ContextRef = z.infer<typeof ContextRefSchema>;

// Explicit interface + annotation: the inferred ZodObject would otherwise force
// the declaration emitter to name `ids.ts`'s module-private `__brand` symbol
// (TS4023). A nameable `SourceRef` type sidesteps that; `.strict()` runtime
// rejection of unknown keys is unaffected.
export interface SourceRef {
  sourceId: SourceId;
  span?: string;
}
export const SourceRefSchema: z.ZodType<
  SourceRef,
  z.ZodTypeDef,
  { sourceId: string; span?: string }
> = z
  .object({
    sourceId: SourceIdSchema,
    span: z.string().min(1).optional(),
  })
  .strict();

// arch_gap: the KnowledgeWriter mutation primitives (NoteCreate/NotePatch/
// LinkMutation/FrontmatterPatch field-level contracts) are only sketched for
// §6/Phase-4 — the precise body/region/frontmatter shapes firm up there.
export const NoteCreateSchema = z
  .object({
    path: z.string().min(1),
    title: z.string().min(1).optional(),
    body: z.string(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NoteCreate = z.infer<typeof NoteCreateSchema>;

// KN-8: region-bounded patch — replaces a named region, never free-form file edits.
export const NotePatchSchema = z
  .object({
    path: z.string().min(1),
    regionId: z.string().min(1),
    newBody: z.string(),
  })
  .strict();
export type NotePatch = z.infer<typeof NotePatchSchema>;

export const LinkMutationSchema = z
  .object({
    op: z.enum(["add", "remove"]),
    srcPath: z.string().min(1),
    dstSlug: z.string().min(1),
    field: z.string().min(1).optional(),
  })
  .strict();
export type LinkMutation = z.infer<typeof LinkMutationSchema>;

export const FrontmatterPatchSchema = z
  .object({
    path: z.string().min(1),
    key: z.string().min(1),
    value: z.unknown(),
  })
  .strict();
export type FrontmatterPatch = z.infer<typeof FrontmatterPatchSchema>;

// Must reference already-canonical Markdown OR an ingested SourceEnvelope span;
// scratch / unmaterialized origins are inadmissible (Appendix A: GBrainProposedFact).
export const CanonicalSourceRefSchema = z
  .object({
    kind: z.enum(["markdown", "source_envelope"]),
    ref: z.string().min(1),
    span: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalSourceRef = z.infer<typeof CanonicalSourceRefSchema>;
