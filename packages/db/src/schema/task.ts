// Operational-store schema — durable typed-Task rollup index (task 13.15, §4/§6).
//
// PERSISTS: TaskRow — the DERIVED operational rollup index (mutable) the 13.16 priority/due-ranked
// read-model producer reads. It is NOT a frozen Appendix-A contract model (it is a db-owned rollup
// DTO, the sibling of project-registry), so it is NOT in the column-parity/operational-schema snapshot
// guards (those cover the original 10 frozen-model tables only).
//
// RULE 1 (one-writer): this is a ROLLUP INDEX, never a second Task writer — the canonical Task
// (Markdown frontmatter) stays KnowledgeWriter-owned. The producer path writes ONLY this row (no KW).
//
// DIALECT/portability: SQLite single-source (see project-registry.ts header) — ONLY text/scalar columns,
// NO pg-only types. `projectId`/`priority`/`dueDate` are nullable (⇒ unset; priority NEVER inferred).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TaskRow } from "../repositories/interfaces";

export const task = sqliteTable("task", {
  // Globally-unique task id — the rollup PRIMARY KEY.
  taskId: text().$type<TaskRow["taskId"]>().primaryKey(),
  // The BOUND workspace (WS-2) — server-resolved, never caller-set.
  workspaceId: text().$type<TaskRow["workspaceId"]>().notNull(),
  // Optional owning-project binding (nullable ⇒ none).
  projectId: text().$type<TaskRow["projectId"]>(),
  title: text().notNull(),
  status: text().$type<TaskRow["status"]>().notNull(),
  // Optional priority (nullable ⇒ unset — NEVER inferred, REQ-F-017).
  priority: text().$type<TaskRow["priority"]>(),
  // Optional ISO-8601 due date (nullable ⇒ none).
  dueDate: text(),
});
