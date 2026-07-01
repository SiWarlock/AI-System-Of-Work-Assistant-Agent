// Operational-store schema — PG-CORE MIRROR of the audit domain (Unit 2.1, §4/§16).
// PARALLEL dialect of `../audit.ts`: persists AuditRecord (frozen Appendix-A model),
// append-only, IDENTICAL column names + portable types (text; `refs`/`timestamps` as
// one `json` column each) for the both-dialect repository contract suite (REQ-D-003).
//
// REDACTION (§16): NO raw-content column — `payloadHash` references by hash only;
// before/after are SUMMARIES. REQ-S-003: no secret column.
//
// PK: AuditRecord carries no `id` and no natural single-field key, so (matching the
// sqlite mirror) NO explicit primary key is declared — adding a surrogate id would
// break column parity; Postgres provides per-row identity via the system ctid /
// (and the Phase-2 migration may add an index, out of scope here).
import { json, pgTable, text } from "drizzle-orm/pg-core";
import type { AuditRecord } from "@sow/contracts";

export const auditRecords = pgTable("audit", {
  actor: text().notNull(),
  event: text().notNull(),
  // Nested/array fields → one json column each, NAMED by the top-level field.
  refs: json().$type<AuditRecord["refs"]>().notNull(),
  payloadHash: text().notNull(),
  beforeSummary: text().notNull(),
  afterSummary: text().notNull(),
  timestamps: json().$type<AuditRecord["timestamps"]>().notNull(),
});
