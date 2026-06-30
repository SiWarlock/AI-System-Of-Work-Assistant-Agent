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

export const approvals = sqliteTable("approvals", {
  id: text().$type<Approval["id"]>().primaryKey(),
  actionRef: text().$type<Approval["actionRef"]>().notNull(),
  status: text().$type<Approval["status"]>().notNull(),
  actor: text().notNull(),
  channel: text().$type<Approval["channel"]>().notNull(),
  payloadHash: text().notNull(),
  // Optional model fields → nullable. snoozeUntil meaningful only while deferred
  // (contract `.refine`); expiresAt is the auto-expiry instant. Both ISO-8601.
  snoozeUntil: text(),
  expiresAt: text(),
});
