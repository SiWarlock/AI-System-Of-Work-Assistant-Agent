// Operational-store schema — read-models domain (Unit 1.14, §4/§16).
//
// PERSISTS: dashboard / UI read models — denormalized projections the §10/§11
// surfaces query (e.g. System Health rollups, workflow run summaries, queue/
// outbox depth, approval backlog counts).
//
// CLASSIFICATION: REBUILDABLE (§4 boundaries / §16 Backup & Recovery). A read
// model can be dropped and rebuilt entirely from operational truth (event log,
// audit, approvals, outbox, cursors, provider state) + canonical Markdown — so
// it is explicitly NOT operational truth and is NOT covered by the operational
// backup requirement. `rebuiltAt` records the rebuild watermark.
//
// NOT parity-checked: read models are denormalized aggregates, not 1:1 mirrors
// of a frozen Appendix-A model. NOTE: typed `HealthItem`s are OPERATIONAL TRUTH
// (§16), NOT a rebuildable read model — they do not belong here, and the
// Unit-1.14 file list provides no HealthItem domain file, so HealthItem
// persistence is OUT OF SCOPE for this unit (FLAGGED for §4).
//
// REQ-S-003: no secret column. §16: read-model `data` is summary/metadata only.
//
// KEY: the logical key is (readModelKey, workspaceId), but workspaceId is
// NULLABLE (some read models are global) and SQLite permits NULLs in a composite
// PRIMARY KEY — a nullable PK member is a smell, so no explicit primary key is
// declared here (SQLite's implicit rowid provides row identity). Uniqueness over
// (readModelKey, workspaceId) is enforced at the Phase-2 migration/index layer
// (OUT OF SCOPE here) — FLAGGED.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const readModels = sqliteTable("read_models", {
  // Read-model kind discriminator (e.g. "system_health", "workflow_runs").
  readModelKey: text().notNull(),
  // Nullable: some read models are global (not workspace-scoped).
  workspaceId: text(),
  // Denormalized projection payload (rebuildable; summary/metadata only).
  data: text({ mode: "json" }).notNull(),
  rebuiltAt: text().notNull(),
});
