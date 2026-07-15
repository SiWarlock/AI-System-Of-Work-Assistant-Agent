// Postgres mirror of the per-workspace connector-instance config table (task 14.2, §4/§8).
// IDENTICAL column-name set to the SQLite table (forbidden-#2 — one contract, both dialects).
// All flat scalar columns (no json). See the SQLite `schema/connector-instance.ts` header for
// classification + the rule-7 tokenRef-reference-only note.
import { pgTable, text } from "drizzle-orm/pg-core";
import type { ConnectorInstanceRow } from "../../repositories/interfaces";

export const connectorInstance = pgTable("connector_instance", {
  instanceId: text().$type<ConnectorInstanceRow["instanceId"]>().primaryKey(),
  connectorId: text().notNull(),
  workspaceId: text().$type<ConnectorInstanceRow["workspaceId"]>().notNull(),
  tokenRef: text().notNull(),
  state: text().$type<ConnectorInstanceRow["state"]>().notNull(),
  cadence: text().notNull(),
});
