// Postgres mirror of the durable typed-Project registry table (task 14.6, §4/§6).
// IDENTICAL column-name set to the SQLite table (forbidden-pattern #2 — one contract,
// both dialects); `json()` (pg-core) instead of `text({ mode: "json" })`. See the
// SQLite `schema/project-registry.ts` header for classification + rule-1 notes.
import { json, pgTable, text } from "drizzle-orm/pg-core";
import type { ProjectRegistryRow } from "../../repositories/interfaces";

export const projectRegistry = pgTable("project_registry", {
  projectId: text().$type<ProjectRegistryRow["projectId"]>().primaryKey(),
  workspaceId: text().$type<ProjectRegistryRow["workspaceId"]>().notNull(),
  planPath: text(),
  progressProviders: json().$type<ProjectRegistryRow["progressProviders"]>().notNull(),
  aliases: json().$type<ProjectRegistryRow["aliases"]>(),
  title: text().notNull(),
  slug: text().notNull(),
  lifecycleState: text().$type<ProjectRegistryRow["lifecycleState"]>().notNull(),
});
