// Operational-store schema — PG-CORE MIRROR of workspace config (Unit 2.1, §4).
//
// PARALLEL dialect of `../workspace-config.ts`: `drizzle-orm/pg-core` definition with
// the IDENTICAL column-name set + portable types (text; nested aggregates as ONE
// `json` column each, NAMED by the top-level field) so the both-dialect repository
// contract suite (REQ-D-003) runs against Postgres (PGlite / pg). Column-name parity
// across both dialects is frozen by `operational-schema.test.ts`.
//
// REQ-S-003: NO secret column — Workspace carries none by construction.
import { json, pgTable, text } from "drizzle-orm/pg-core";
import type { Workspace } from "@sow/contracts";

export const workspaceConfig = pgTable("workspace_config", {
  id: text().$type<Workspace["id"]>().primaryKey(),
  name: text().notNull(),
  type: text().$type<Workspace["type"]>().notNull(),
  dataOwner: text().$type<Workspace["dataOwner"]>().notNull(),
  markdownRepoPath: text().notNull(),
  gbrainBrainId: text().$type<Workspace["gbrainBrainId"]>().notNull(),
  defaultVisibility: text().$type<Workspace["defaultVisibility"]>().notNull(),
  // Nested aggregates → one json column each, NAMED by the top-level field.
  //
  // Task 9.36 — DELIBERATELY typed `unknown`, not `Workspace["egressPolicy"]`/`["providerMatrix"]`.
  // Mirrors the sqlite schema's note verbatim (behavioral parity, REQ-D-003): a `.$type<T>()` overlay
  // is compile-time-only and does not validate the JSON column's parsed bytes, so typing it as the
  // frozen model type made every SELECT already "structurally" a `Workspace` — the read boundary's
  // casts were decorative, not causal. `unknown` forces `parseStoredWorkspace` to be the ONLY way out.
  egressPolicy: json().notNull(),
  providerMatrix: json().notNull(),
});
