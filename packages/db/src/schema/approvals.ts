// Operational-store schema — approvals domain (Unit 1.14, §4/§9/§10/§11).
//
// PERSISTS: Approval (frozen Appendix-A model). The approval-inbox record that
// gates an external action (Mac + Telegram), transitioning
// pending→approve|edit|reject|defer|expire EXACTLY ONCE (REQ-F-012).
//
// CLASSIFICATION: OPERATIONAL TRUTH — append-on-create, then TOMBSTONE via
// TERMINAL STATUS (approved|edited|rejected|expired are terminal; a tombstone is
// represented by the model's own `status`, NOT a separate column, so column
// parity holds). Not rebuildable (§4 / §16 Backup & Recovery).
//
// PARITY (REQ-D-002): column-name set MUST equal Approval's frozen top-level
// field-name set. `snoozeUntil` / `expiresAt` are the model's optional fields →
// nullable columns; the `snooze ⇔ deferred` coupling is the contract's `.refine`
// and is re-asserted at the candidate-data gate, not here.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header);
// portable types only. REQ-S-003: no secret column (payload is referenced by
// hash only — `payloadHash`, never the raw payload).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Approval } from "@sow/contracts";

/**
 * Sentinel workspace value backfilled onto legacy pending rows when the `workspaceId`
 * column is added (a NOT NULL column needs a DEFAULT to ALTER a populated table). It is
 * a NON-workspace value that never equals any real workspace id, so the §9.8
 * `listByStatusAndWorkspace` equality filter FAIL-CLOSED-EXCLUDES legacy rows from every
 * inbox (they surface in none, never leak into one). It passes `WorkspaceIdSchema`
 * (minLength ≥ 1) so read-back never crashes. Shared by both dialect schemas + the 0001
 * migrations. NEVER backfill a REAL workspace id (would leak legacy rows into that inbox).
 */
export const UNASSIGNED_WORKSPACE = "__unassigned__" as const;

/**
 * §13.10a backfill default for the `subjectKind` discriminator: every legacy approval
 * predates the Copilot semantic-write bridge and IS an external write, so the additive
 * NOT NULL column defaults to `external_action` — a SEMANTICALLY CORRECT backfill (not a
 * mere sentinel like UNASSIGNED_WORKSPACE). Shared by both dialect schemas + the 0003
 * migrations.
 */
export const DEFAULT_SUBJECT_KIND = "external_action" as const;

export const approvals = sqliteTable("approvals", {
  id: text().$type<Approval["id"]>().primaryKey(),
  // §13.10a — actionRef is now OPTIONAL on the model (present iff subjectKind ===
  // "external_action"; a semantic_mutation card carries a `planRef` instead), so the
  // column is NULLABLE (no `.notNull()`). The indexed-access `$type` keeps the branded
  // alias NAMEABLE (a `NonNullable<>` wrapper unwraps it → TS4023 on the exported table).
  actionRef: text().$type<Approval["actionRef"]>(),
  // §13.10a — the pending-KMP ref (present iff subjectKind === "semantic_mutation"). Nullable.
  planRef: text().$type<Approval["planRef"]>(),
  // §13.10a — the SUBJECT discriminator (external_action | semantic_mutation). NOT NULL +
  // semantically-correct default so the additive ALTER backfills legacy rows to external_action.
  subjectKind: text()
    .$type<Approval["subjectKind"]>()
    .notNull()
    .default(DEFAULT_SUBJECT_KIND),
  // WS-4 inbox-scope attribution (frozen Approval field). NOT NULL + sentinel default so
  // the additive ALTER succeeds on a populated table; every write site supplies a real id.
  workspaceId: text()
    .$type<Approval["workspaceId"]>()
    .notNull()
    .default(UNASSIGNED_WORKSPACE as Approval["workspaceId"]),
  status: text().$type<Approval["status"]>().notNull(),
  actor: text().notNull(),
  channel: text().$type<Approval["channel"]>().notNull(),
  payloadHash: text().notNull(),
  // Optional model fields → nullable. snoozeUntil meaningful only while deferred
  // (contract `.refine`); expiresAt is the auto-expiry instant. Both ISO-8601.
  snoozeUntil: text(),
  expiresAt: text(),
});
