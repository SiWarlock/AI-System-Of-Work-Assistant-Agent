// Operational-store schema — the cross-workspace-LINK store (task 14.7, §4/§5/§6).
//
// PERSISTS: CrossWorkspaceLinkRow — the durable owner-approval record that is the SINGLE
// SANCTIONED WS-8 cross-workspace read input (safety rule 4). An APPROVED link authorizes
// reader-workspace `fromWorkspaceId` (A) to blend ONLY the sanitized, scoped slice of source-
// workspace `toWorkspaceId` (B) — never raw content, never anything outside `scope`. It is a
// db-owned DTO (contracts primitives only), NOT a frozen Appendix-A model, so it is NOT in the
// column-parity / operational-schema snapshot guards.
//
// SAFETY (workspace isolation, rule 4 / §5 WS-8): the (fromWorkspaceId, toWorkspaceId) pair is the
// IMMUTABLE isolation anchor + the `scope` (scopeProjectionType, scopeVisibilityLevel) bounds what
// crosses — both enforced at the COMPOSITION layer (createCrossWorkspaceLink's get-before-create
// tuple-immutability guard + non-empty-scope guard, worker Lesson 30). The link carries its OWN
// `status` (pending|approved|revoked) — NOT an Approval.subjectKind, so the frozen Appendix-A
// Approval enum is untouched. `scope*` columns are NOT NULL (a scopeless link — which would
// read-match all of B — is structurally + composition-level unrepresentable). REQ-S-003: no secret.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header). text/integer only;
// approvedAt/revokedAt are NULLABLE (unset until the transition stamps them).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { CrossWorkspaceLinkRow } from "../repositories/interfaces";

export const crossWorkspaceLink = sqliteTable("cross_workspace_link", {
  // Synthetic link id — the registry PRIMARY KEY.
  linkId: text().$type<CrossWorkspaceLinkRow["linkId"]>().primaryKey(),
  // The READER (workspace A) — the directional authorization SOURCE side of an approved read.
  fromWorkspaceId: text().$type<CrossWorkspaceLinkRow["fromWorkspaceId"]>().notNull(),
  // The SOURCE (workspace B) — whose sanitized slice A may read once approved.
  toWorkspaceId: text().$type<CrossWorkspaceLinkRow["toWorkspaceId"]>().notNull(),
  // The bounded scope selector — what slice of B crosses (NOT NULL: a scopeless link is invalid).
  scopeProjectionType: text().$type<CrossWorkspaceLinkRow["scopeProjectionType"]>().notNull(),
  scopeVisibilityLevel: text().$type<CrossWorkspaceLinkRow["scopeVisibilityLevel"]>().notNull(),
  // Owner-approval status — the link's OWN field (never Approval.subjectKind).
  status: text().$type<CrossWorkspaceLinkRow["status"]>().notNull(),
  createdAt: text().$type<CrossWorkspaceLinkRow["createdAt"]>().notNull(),
  // Stamped only at the matching transition — nullable until then.
  approvedAt: text().$type<CrossWorkspaceLinkRow["approvedAt"]>(),
  revokedAt: text().$type<CrossWorkspaceLinkRow["revokedAt"]>(),
});
