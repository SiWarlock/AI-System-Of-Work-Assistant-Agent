// Operational-store schema — PG-CORE MIRROR of the GBRAIN SYNC OUTBOX domain
// (task 19.1, §6/§16). PARALLEL dialect of `../gbrain-sync-outbox.ts` — see that
// module's header for the full rationale (why this is a NEW table, distinct from
// the §8/§9 external-write outbox). IDENTICAL column names + portable types for
// the both-dialect repository contract suite (REQ-D-003) and the schema↔migration
// coverage detector (task 24.39/24.43 — every migration-created table must be
// declared in this barrel).
//
// REQ-S-003 / §16: no secret column, no raw-content column.
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const gbrainSyncOutbox = pgTable("gbrain_sync_outbox", {
  outboxId: text().primaryKey(),
  workspaceId: text().notNull(),
  revisionId: text().notNull(),
  planId: text().notNull(),
  status: text().notNull(),
  attempts: integer().notNull(),
  auditRef: text().notNull(),
  sourceEventRef: text(),
  enqueuedAt: text().notNull(),
  lastAttemptAt: text(),
  lastError: text(),
});
