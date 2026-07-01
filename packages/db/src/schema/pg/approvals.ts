// Operational-store schema — PG-CORE MIRROR of the approvals domain (Unit 2.1,
// §4/§9/§10/§11). PARALLEL dialect of `../approvals.ts`: persists Approval (frozen
// Appendix-A model), IDENTICAL column names + portable types (text; optional model
// fields → nullable columns) for the both-dialect repository contract suite
// (REQ-D-003).
//
// REQ-S-003: no secret column (payload referenced by hash only — `payloadHash`).
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Approval } from "@sow/contracts";

export const approvals = pgTable("approvals", {
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
