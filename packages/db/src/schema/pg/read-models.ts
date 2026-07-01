// Operational-store schema — PG-CORE MIRROR of the read-models domain (Unit 2.1,
// §4/§16). PARALLEL dialect of `../read-models.ts`: denormalized dashboard/UI read
// models — REBUILDABLE projections, NOT operational truth (§4 / §16). IDENTICAL
// column names + portable types (text; `data` as one `json` column) for the
// both-dialect repository contract suite (REQ-D-003).
//
// KEY: logical key is (readModelKey, workspaceId) but workspaceId is NULLABLE (some
// read models are global), so — matching the sqlite mirror — NO explicit primary key
// is declared (uniqueness is enforced at the Phase-2 migration/index layer).
//
// REQ-S-003: no secret column. §16: `data` is summary/metadata only.
import { json, pgTable, text } from "drizzle-orm/pg-core";

export const readModels = pgTable("read_models", {
  // Read-model kind discriminator (e.g. "system_health", "workflow_runs").
  readModelKey: text().notNull(),
  // Nullable: some read models are global (not workspace-scoped).
  workspaceId: text(),
  // Denormalized projection payload (rebuildable; summary/metadata only).
  data: json().notNull(),
  rebuiltAt: text().notNull(),
});
