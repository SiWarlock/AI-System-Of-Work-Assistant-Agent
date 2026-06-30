// NotebookMapping seam model (task seam(§8), §8/§9). Maps one project to its
// Drive-backed NotebookLM managed-doc pack — the five 00–04 docs that the
// `notebooklm.sync` capability upserts through the Tool Gateway / NotebookPort
// (REQ-I-004 / NLM-2; direct NotebookLM API is V1.1/spike-gated, §15). Zod is
// the single source of truth: the TS type is `z.infer`, the JSON Schema is
// generated via `emitJsonSchema`. PURE — imports only zod (no brands: see the
// projectId arch_gap below).
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const NOTEBOOK_MAPPING_SCHEMA_ID = "sow:notebook-mapping" as const;

// arch_gap: no ProjectId brand is defined upstream. Appendix A names `projectId`
// as a bare identifier with no declared taxonomy/format, so it is modeled as an
// OPEN non-empty string (not a brand, not a closed enum) until the project-id
// contract is named. Same posture for `notebookKey` and the Drive ids, which are
// likewise opaque external identifiers — all trimmed-non-empty strings.
//
// arch_gap: managed-doc id optionality BEFORE the docs are created is unspecified
// upstream. Appendix A lists the five 00–04 slots as plain Drive-doc-id strings
// with no pre-creation sentinel, so each is modeled as a REQUIRED non-empty
// string — a NotebookMapping exists only once its docs do; a partial/uncreated
// pack is a different (unspecified) lifecycle state, not a half-filled mapping.
//
// The pack is an inline nested `.strict()` object with EXACTLY the five named
// slots: `.strict()` rejects any extra slot and the five required keys reject a
// missing one (00 Brief / 01 Decisions / 02 Meeting Digest / 03 Research /
// 04 Open Questions, per ARCHITECTURE.md §8). The nested shape is frozen
// transitively through the parent model's checked-in schema.json.
export const NotebookMappingSchema = z
  .object({
    projectId: z.string().min(1),
    notebookKey: z.string().min(1),
    driveFolderId: z.string().min(1),
    managedDocIds: z
      .object({
        "00_brief": z.string().min(1),
        "01_decisions": z.string().min(1),
        "02_meetings": z.string().min(1),
        "03_research": z.string().min(1),
        "04_open_questions": z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type NotebookMapping = z.infer<typeof NotebookMappingSchema>;
