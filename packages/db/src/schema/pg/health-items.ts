// Operational-store schema — PG-CORE MIRROR of the health-items domain (Phase-10 /
// OBS-1 / OBS-2 / §10.3). PARALLEL dialect of `../health-items.ts`: the System-Health
// item store (one DISTINCT item per §10.3 dedupe key, lifecycle + audit-linked).
// IDENTICAL column-name surface + portable types (text; integer for occurrenceCount)
// — adds NO column, parity holds — for the both-dialect repository contract suite
// (REQ-D-003).
//
// The frozen HealthItem model columns are stored 1:1 PLUS the four persistence-only
// dedupe columns (dedupeKey PK / subjectRef / lastSeen / occurrenceCount).
//
// REQ-S-003 / §16: no secret column — `message` is a redaction-safe summary.
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const healthItems = pgTable("health_items", {
  // §10.3 dedupe identity — the PK (a repeat failure of the SAME class upserts).
  dedupeKey: text().primaryKey(),
  subjectRef: text().notNull(),
  // --- the frozen HealthItem model columns (all strings) ---
  id: text().notNull(),
  failureClass: text().notNull(),
  severity: text().notNull(),
  message: text().notNull(),
  auditRef: text().notNull(),
  openedAt: text().notNull(),
  state: text().notNull(),
  resolvedAt: text(),
  parityReportRef: text(),
  factIdentity: text(),
  // --- dedupe bookkeeping (persistence-only; not in the model) ---
  lastSeen: text().notNull(),
  occurrenceCount: integer().notNull(),
});
