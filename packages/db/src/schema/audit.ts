// Operational-store schema — audit domain (Unit 1.14, §4/§16).
//
// PERSISTS: AuditRecord (frozen Appendix-A model). The operational audit-trail
// record.
//
// CLASSIFICATION: OPERATIONAL TRUTH — APPEND-ONLY (the audit log is never
// updated or deleted in place; corrections are new records). Not rebuildable
// (§4 / §16 Backup & Recovery).
//
// REDACTION (§16, load-bearing): there is NO raw-content column. `payloadHash`
// references the payload by hash only; `beforeSummary` / `afterSummary` are
// human-readable SUMMARIES, never raw before/after content. A record can pass
// through the redaction layer without leaking secrets or raw Employer-Work
// content. REQ-S-003: no secret column.
//
// PARITY (REQ-D-002): column-name set MUST equal AuditRecord's frozen top-level
// field-name set: { actor, event, refs, payloadHash, beforeSummary,
// afterSummary, timestamps }. `refs` (string[]) and `timestamps`
// ({occurredAt, recordedAt?}) are each stored as ONE json column NAMED by the
// top-level field.
//
// arch_gap (PK): AuditRecord carries NO `id` field (per Appendix A) and no
// single field is a natural primary key, so this table declares NO explicit
// primary key — SQLite's implicit `rowid` provides per-row identity for the
// append-only log. Adding a surrogate `id` column would BREAK column parity;
// flagged for §4 (a surrogate audit id, if wanted, must be added to the
// AuditRecord contract first, in the same round).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AuditRecord } from "@sow/contracts";

export const auditRecords = sqliteTable("audit", {
  actor: text().notNull(),
  event: text().notNull(),
  // Nested/array fields → one json column each, NAMED by the top-level field.
  refs: text({ mode: "json" }).$type<AuditRecord["refs"]>().notNull(),
  payloadHash: text().notNull(),
  beforeSummary: text().notNull(),
  afterSummary: text().notNull(),
  timestamps: text({ mode: "json" }).$type<AuditRecord["timestamps"]>().notNull(),
  // OPTIONAL WS-8 scope attribution (the §9.5 recent-changes projector groups + filters by it).
  // NULLABLE (no .notNull()) — mirrors the frozen model's optional field: some control-plane audit
  // events are global (no workspaceId in scope). No sentinel/default needed on an append-only log
  // (contrast the approvals 0001 NOT-NULL sentinel) — legacy rows are honestly NULL (unscoped).
  workspaceId: text(),
});
