// Operational-store schema — PG-CORE MIRROR of the parity-reports domain (§4 / §6 / §12 / §16,
// task 11.1). PARALLEL dialect of `../parity-reports.ts`: the durable serve-time `ParityReport`
// store the Knowledge-layer serving-gate coverage leg reads. IDENTICAL column names + portable
// types (text; the full `ParityReport` as one `json` `payload` column), `reportId` PRIMARY KEY —
// adds NO column, parity holds — for the both-dialect repository contract suite (REQ-D-003).
//
// The `reportId` PK is the exactly-once identity (first-write-wins on a duplicate; never two rows
// for one report id). NOT rebuildable (§4 / §16). `workspaceId` + `reconciledAtRevision` are the
// serve-time query key; `recordedAt` is store-side "latest" ordering metadata (not a contract field).
//
// REQ-S-003 / §16: no secret column — a `ParityReport` is fact counts + a schema version +
// `Divergence[]` (identities + content hashes, never raw content); redaction-safe.
import { json, pgTable, text } from "drizzle-orm/pg-core";

export const parityReports = pgTable("parity_reports", {
  // The report id — the store IDENTITY + exactly-once PK.
  reportId: text().primaryKey(),
  // The reconciled workspace — half the serve-time query key.
  workspaceId: text().notNull(),
  // The Markdown revision this reconciliation was scoped to — the other half of the query key.
  reconciledAtRevision: text().notNull(),
  // Store-side "latest" ordering (ISO-8601, caller-supplied) — not a contract field.
  recordedAt: text().notNull(),
  // The full serialized `ParityReport` — one json column (candidate data on read-back).
  payload: json().notNull(),
});
