// Postgres mirror of the durable typed-Task rollup index table (task 13.15, §4/§6).
// IDENTICAL column-name set to the SQLite table (forbidden-pattern #2 — one contract, both dialects);
// all-scalar columns (no json). See the SQLite `schema/task.ts` header for classification + rule-1 notes.
import { pgTable, text } from "drizzle-orm/pg-core";
import type { TaskRow } from "../../repositories/interfaces";

export const task = pgTable("task", {
  taskId: text().$type<TaskRow["taskId"]>().primaryKey(),
  workspaceId: text().$type<TaskRow["workspaceId"]>().notNull(),
  projectId: text().$type<TaskRow["projectId"]>(),
  title: text().notNull(),
  status: text().$type<TaskRow["status"]>().notNull(),
  priority: text().$type<TaskRow["priority"]>(),
  dueDate: text(),
});
