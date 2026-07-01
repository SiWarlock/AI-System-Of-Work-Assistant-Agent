// Operational-store schema — PG-CORE MIRROR of the gcl-projections domain (Unit 2.1,
// §4/§5/§6/§11). PARALLEL dialect of `../gcl-projections.ts`: persists GclProjection
// (frozen Appendix-A model) — the unit the GCL Visibility Gate (REQ-F-005 / WS-8)
// emits as the SINGLE cross-workspace read path. IDENTICAL column names + portable
// types (text; sanitizedPayload/sourceRefs as one `json` column each), composite PK
// over EXISTING (workspaceId, projectionType, visibilityLevel) — adds NO column,
// parity holds — for the both-dialect repository contract suite (REQ-D-003).
//
// SAFETY (workspace isolation, rule 4 / §6 WS-8): the table stores ONLY the model's
// named columns; the no-raw-content shape gate is the contract's `.refine`. REQ-S-003:
// no secret column.
import { json, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { GclProjection } from "@sow/contracts";

export const gclProjections = pgTable(
  "gcl_projections",
  {
    workspaceId: text().$type<GclProjection["workspaceId"]>().notNull(),
    visibilityLevel: text().$type<GclProjection["visibilityLevel"]>().notNull(),
    projectionType: text().notNull(),
    sanitizedPayload: json().$type<GclProjection["sanitizedPayload"]>().notNull(),
    sourceRefs: json().$type<GclProjection["sourceRefs"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.projectionType, t.visibilityLevel] }),
  }),
);
