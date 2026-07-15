// Operational-store schema — durable typed-Project registry (task 14.6, §4/§6).
//
// PERSISTS: ProjectRegistryRow — the OPERATIONAL resolution index (mutable) that the
// production ResolveRegistryPort resolves a projectRef/alias against. It is NOT a
// frozen Appendix-A contract model (Q1: it stays a db-owned DTO mapped to the
// `@sow/workflows` ProjectRegistryEntry at the worker port boundary), so it is NOT in
// the column-parity/operational-schema snapshot guards (those cover the original 10
// frozen-model tables only).
//
// RULE 1 (one-writer): this is a RESOLUTION INDEX, never a second Project writer — the
// canonical Project (Markdown frontmatter) stays KnowledgeWriter-owned. The creation
// path writes ONLY this row (no KW / Markdown).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header) — ONLY
// text/integer/text(json), NO pg-only types. `progressProviders` (array) + `aliases`
// (array, nullable) are each stored as ONE json column NAMED by the field.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ProjectRegistryRow } from "../repositories/interfaces";

export const projectRegistry = sqliteTable("project_registry", {
  // Globally-unique project id — the registry PRIMARY KEY.
  projectId: text().$type<ProjectRegistryRow["projectId"]>().primaryKey(),
  // The BOUND workspace (WS-2) — server-resolved, never caller-set.
  workspaceId: text().$type<ProjectRegistryRow["workspaceId"]>().notNull(),
  // Optional canonical status-doc path (nullable ⇒ absent).
  planPath: text(),
  // External progress providers → one json column (empty [] ⇒ plan-only).
  progressProviders: text({ mode: "json" }).$type<ProjectRegistryRow["progressProviders"]>().notNull(),
  // Aliases → one json column (nullable ⇒ none).
  aliases: text({ mode: "json" }).$type<ProjectRegistryRow["aliases"]>(),
  title: text().notNull(),
  slug: text().notNull(),
  lifecycleState: text().$type<ProjectRegistryRow["lifecycleState"]>().notNull(),
});
