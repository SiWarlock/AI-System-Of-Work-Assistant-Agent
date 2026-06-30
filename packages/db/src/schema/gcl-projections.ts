// Operational-store schema — GCL projections domain (Unit 1.14, §4/§5/§6/§11).
//
// PERSISTS: GclProjection (frozen Appendix-A model). The unit the GCL Visibility
// Gate (REQ-F-005 / WS-8) emits as the SINGLE cross-workspace read path — a
// sanitized, visibility-scoped view of one workspace's facts, never raw content.
//
// CLASSIFICATION: derived projection. The GCL DB is the queryable master (§6);
// projections are REBUILDABLE from the GCL identity map + the source facts they
// cite (`sourceRefs`), so this table is treated as a rebuildable derived view,
// not append-only operational truth.
//
// SAFETY (workspace isolation, rule 4 / §6 WS-8): the table stores ONLY the
// model's named columns. `sanitizedPayload` is a json column whose raw-content
// shape gate (no rawContent/body/content keys) is the contract's `.refine`,
// re-asserted at the candidate-data gate before any write — no raw-content
// column exists here by construction. REQ-S-003: no secret column.
//
// PARITY (REQ-D-002): column-name set MUST equal GclProjection's frozen
// top-level field-name set: { workspaceId, visibilityLevel, projectionType,
// sanitizedPayload, sourceRefs }. `sanitizedPayload` (record) and `sourceRefs`
// (SourceRef[]) are each stored as ONE json column NAMED by the top-level field.
//
// PK: composite over EXISTING columns (workspaceId, projectionType,
// visibilityLevel) — one projection per workspace × type × visibility level.
// Composite PK adds NO column, so parity holds (no surrogate id).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { GclProjection } from "@sow/contracts";

export const gclProjections = sqliteTable(
  "gcl_projections",
  {
    workspaceId: text().$type<GclProjection["workspaceId"]>().notNull(),
    visibilityLevel: text().$type<GclProjection["visibilityLevel"]>().notNull(),
    projectionType: text().notNull(),
    sanitizedPayload: text({ mode: "json" }).$type<GclProjection["sanitizedPayload"]>().notNull(),
    sourceRefs: text({ mode: "json" }).$type<GclProjection["sourceRefs"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.projectionType, t.visibilityLevel] }),
  }),
);
