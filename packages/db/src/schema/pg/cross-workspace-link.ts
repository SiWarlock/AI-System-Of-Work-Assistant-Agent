// Postgres mirror of the cross-workspace-link store (task 14.7, §4/§5/§6).
// IDENTICAL column-name set to the SQLite table (forbidden-#2 — one contract, both dialects).
// See the SQLite `schema/cross-workspace-link.ts` header for classification + the WS-8 safety /
// immutable-anchor / non-null-scope notes. approvedAt/revokedAt are NULLABLE (unset until stamped).
import { pgTable, text } from "drizzle-orm/pg-core";
import type { CrossWorkspaceLinkRow } from "../../repositories/interfaces";

export const crossWorkspaceLink = pgTable("cross_workspace_link", {
  linkId: text().$type<CrossWorkspaceLinkRow["linkId"]>().primaryKey(),
  fromWorkspaceId: text().$type<CrossWorkspaceLinkRow["fromWorkspaceId"]>().notNull(),
  toWorkspaceId: text().$type<CrossWorkspaceLinkRow["toWorkspaceId"]>().notNull(),
  scopeProjectionType: text().$type<CrossWorkspaceLinkRow["scopeProjectionType"]>().notNull(),
  scopeVisibilityLevel: text().$type<CrossWorkspaceLinkRow["scopeVisibilityLevel"]>().notNull(),
  status: text().$type<CrossWorkspaceLinkRow["status"]>().notNull(),
  createdAt: text().$type<CrossWorkspaceLinkRow["createdAt"]>().notNull(),
  approvedAt: text().$type<CrossWorkspaceLinkRow["approvedAt"]>(),
  revokedAt: text().$type<CrossWorkspaceLinkRow["revokedAt"]>(),
});
