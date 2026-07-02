// Operational-store schema — health-items domain (Phase-10 / OBS-1 / OBS-2 /
// §10.3). PERSISTS the System-Health item store (the concrete table behind the
// Phase-7 in-memory `HealthItemStore` fake). One DISTINCT item per dedupe key
// ((failureClass, subjectRef) per §10.3) with a lifecycle (open → acknowledged →
// resolved), audit-linked, deduped.
//
// The frozen `HealthItem` seam model's columns are stored 1:1 (all string fields:
// id, failureClass, severity, message, auditRef, openedAt, state, resolvedAt?,
// parityReportRef?, factIdentity?) PLUS four persistence-only DEDUPE columns not
// part of the model:
//   - dedupeKey  — the §10.3 identity ((failureClass, subjectRef)); the PK, so a
//                  repeat failure of the SAME class UPSERTs the existing row rather
//                  than spawning a duplicate item.
//   - subjectRef — the dedupe subject (kept alongside for query/inspection).
//   - lastSeen   — refreshed on every dedupe hit (drives most-recent-first listing).
//   - occurrenceCount — incremented on every dedupe hit (how many times the class
//                  has recurred since `openedAt`).
//
// CLASSIFICATION: OPERATIONAL TRUTH — MUTABLE (lifecycle + dedupe upsert), NOT
// rebuildable (a lost item drops an open failure's audit-linked history). NOT
// parity-checked — the row is HealthItem + dedupe bookkeeping, not a 1:1 mirror
// of one Appendix-A model (mirrors the write_receipts/outbox pattern).
//
// REQ-S-003 / §16: no secret column. `message` is a redaction-safe summary
// (never raw content); auditRef/parityReportRef/factIdentity are opaque refs.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const healthItems = sqliteTable("health_items", {
  // §10.3 dedupe identity ((failureClass, subjectRef)) — the PK, so a repeat
  // failure of the SAME class upserts THIS row (no duplicate item).
  dedupeKey: text().primaryKey(),
  // The dedupe subject, retained alongside the derived key for inspection.
  subjectRef: text().notNull(),
  // --- the frozen HealthItem model columns (all strings) ---
  id: text().notNull(),
  failureClass: text().notNull(),
  // arch_gap: severity is an OPEN string upstream (no closed warn/error/critical set).
  severity: text().notNull(),
  message: text().notNull(),
  auditRef: text().notNull(),
  openedAt: text().notNull(),
  state: text().notNull(),
  // Present IFF state === 'resolved' (§10.3 lifecycle; enforced by the model's refine).
  resolvedAt: text(),
  // Links a parity_defect / rebuild_divergence item to its ParityReport (§12).
  parityReportRef: text(),
  // Pins the offending fact for those classes.
  factIdentity: text(),
  // --- dedupe bookkeeping (persistence-only; not in the model) ---
  // Refreshed on every dedupe hit; drives most-recently-seen-first listing.
  lastSeen: text().notNull(),
  // Incremented on every dedupe hit (recurrences since openedAt).
  occurrenceCount: integer().notNull(),
});
