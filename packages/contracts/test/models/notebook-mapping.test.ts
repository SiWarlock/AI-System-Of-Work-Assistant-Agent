// NotebookMapping contract test (task seam(§8), §8/§9). RED-first schema-snapshot
// freeze + behavior + nested-shape invariant coverage. Maps a project to its
// Drive-backed NotebookLM managed-doc pack (00–04). PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  NotebookMappingSchema,
  NOTEBOOK_MAPPING_SCHEMA_ID,
} from "../../src/models/notebook-mapping";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A fully-populated valid mapping: all three top-level identifiers + the
// complete five-slot managed-doc pack.
const validMapping = {
  projectId: "proj-acme-redesign",
  notebookKey: "acme-redesign",
  driveFolderId: "drive-folder-abc123",
  managedDocIds: {
    "00_brief": "doc-brief-001",
    "01_decisions": "doc-decisions-002",
    "02_meetings": "doc-meetings-003",
    "03_research": "doc-research-004",
    "04_open_questions": "doc-oq-005",
  },
};

describe("NotebookMapping contract — spec(§8/§9)", () => {
  // ── Frozen top-level field-name set (the spec, hand-authored in __snapshots__) ─
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(NotebookMappingSchema, NOTEBOOK_MAPPING_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("notebook-mapping"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ──
  // The nested managedDocIds shape (exactly the five keys) is frozen TRANSITIVELY
  // through this checked-in schema.json, not by the top-level field-name set.
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/notebook-mapping.schema.json", import.meta.url),
      emitJsonSchema(NotebookMappingSchema, NOTEBOOK_MAPPING_SCHEMA_ID),
    );
  });

  // ── Behaviors ───────────────────────────────────────────────────────────────
  it("accepts a fully-populated valid mapping (all 5 managed-doc slots present)", () => {
    expect(NotebookMappingSchema.safeParse(validMapping).success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty projectId (non-empty string)", () => {
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, projectId: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty notebookKey (non-empty string)", () => {
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, notebookKey: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty driveFolderId (non-empty string)", () => {
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, driveFolderId: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required top-level field (managedDocIds)", () => {
    const { managedDocIds: _omit, ...withoutDocs } = validMapping;
    const bad = NotebookMappingSchema.safeParse(withoutDocs);
    expect(bad.success).toBe(false);
  });

  it("rejects managedDocIds that is not an object", () => {
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, managedDocIds: "doc-id" });
    expect(bad.success).toBe(false);
  });

  // ── Nested invariant: managedDocIds has EXACTLY the five named slots ──────────
  // Structurally enforced (nested `.strict()` object + five required keys), not a
  // `.refine`. Passing direction: the "fully-populated valid mapping" test above.
  // Failing directions — a missing slot AND an extra slot:
  it("rejects managedDocIds missing one of the five named slots (04_open_questions)", () => {
    const { "04_open_questions": _omit, ...incomplete } = validMapping.managedDocIds;
    const bad = NotebookMappingSchema.safeParse({ ...validMapping, managedDocIds: incomplete });
    expect(bad.success).toBe(false);
  });

  it("rejects managedDocIds carrying an extra slot beyond the five (.strict)", () => {
    const bad = NotebookMappingSchema.safeParse({
      ...validMapping,
      managedDocIds: { ...validMapping.managedDocIds, "05_appendix": "doc-extra-006" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty managed-doc id inside the pack (non-empty string)", () => {
    const bad = NotebookMappingSchema.safeParse({
      ...validMapping,
      managedDocIds: { ...validMapping.managedDocIds, "00_brief": "" },
    });
    expect(bad.success).toBe(false);
  });
});
