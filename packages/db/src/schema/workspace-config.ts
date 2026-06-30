// Operational-store schema — workspace config domain (Unit 1.14, §4).
//
// DIALECT (single-source decision, FLAGGED for §4 review): tables here are
// authored in `drizzle-orm/sqlite-core` (SQLite is the V1 default, §13) using
// ONLY portable column types — text / integer, booleans as integer(boolean),
// timestamps as text(ISO), nested/JSON-shaped values as text(json). NO pg-only
// types (jsonb/uuid/serial). The pg-core mirror, migrations, and the
// both-dialect repository CONTRACT SUITE are §4 / Phase-2 / worker (REQ-D-003) —
// OUT OF SCOPE here.
//
// PERSISTS: Workspace (frozen Appendix-A model, §3/§6). Operational state —
// MUTABLE (the owner edits governance posture), NOT append-only, NOT a
// rebuildable read model: workspace config is operational truth.
//
// PARITY (REQ-D-002): the column-name set MUST equal Workspace's frozen
// top-level field-name set (`column-parity.test.ts`). The two nested aggregates
// (`egressPolicy`, `providerMatrix`) are each stored as ONE json column NAMED by
// the top-level field, so top-level parity holds without flattening the nested
// shape (whose structure stays frozen by the contract / its checked-in schema).
//
// REQ-S-003: NO secret column — provider/connector secrets are Keychain
// references resolved through SecretsPort; Workspace carries none by construction.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Workspace } from "@sow/contracts";

export const workspaceConfig = sqliteTable("workspace_config", {
  id: text().$type<Workspace["id"]>().primaryKey(),
  name: text().notNull(),
  type: text().$type<Workspace["type"]>().notNull(),
  dataOwner: text().$type<Workspace["dataOwner"]>().notNull(),
  markdownRepoPath: text().notNull(),
  gbrainBrainId: text().$type<Workspace["gbrainBrainId"]>().notNull(),
  defaultVisibility: text().$type<Workspace["defaultVisibility"]>().notNull(),
  // Nested aggregates → one json column each, NAMED by the top-level field.
  egressPolicy: text({ mode: "json" }).$type<Workspace["egressPolicy"]>().notNull(),
  providerMatrix: text({ mode: "json" }).$type<Workspace["providerMatrix"]>().notNull(),
});
