// Operational-store schema — GBRAIN SYNC OUTBOX domain (task 19.1, §6/§16).
//
// PERSISTS: the durable, OPERATIONAL-TRUTH queue of post-commit GBrain re-index
// jobs (mirrors `packages/knowledge/src/knowledge-writer/sync-outbox.ts` — the
// `GbrainSyncOutboxStore` port). GBrain is a DERIVED store (Markdown is the only
// canonical semantic truth, REQ-D-001), but the SYNC OUTBOX itself is operational
// truth: a lost sync entry would silently drop a re-index and let the derived
// brain fall permanently behind the committed Markdown, so it is persisted and
// NOT rebuildable.
//
// arch_gap (sync-outbox.ts:14-23): a gbrain re-index is an INTERNAL derived-store
// refresh, not an external write, and has no write receipt — reusing the §8/§9
// external-write `OutboxRepository`/`outboxes.ts` envelope would conflate safety
// rule 3 with an internal refresh. This is therefore a NEW, separate table.
//
// IDENTITY / IDEMPOTENCY: `outboxId` is the deterministic `(workspaceId,
// revisionId)` collapse key (`gbrainSyncOutboxKey`, sync-outbox.ts:98) — two
// triggers for the same committed revision collapse to ONE effective index job.
//
// CLASSIFICATION: OPERATIONAL TRUTH — append-on-enqueue, MUTABLE status as the
// entry advances (`gbrain_sync_queued` → `sync_lagging` | `indexed`), the
// `indexed` status is the FROZEN terminal (no further mutation). Not rebuildable.
//
// REQ-S-003 / §16: no secret column, no raw-content column — `auditRef` and
// `sourceEventRef` are SUMMARY refs only (opaque linkage strings), `lastError` is
// a short dispatch-failure message (never raw content/secrets).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header) —
// the concrete driver speaks this shape directly against both dialects.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const gbrainSyncOutbox = sqliteTable("gbrain_sync_outbox", {
  // Deterministic `(workspaceId, revisionId)` collapse key — see module header.
  outboxId: text().primaryKey(),
  workspaceId: text().notNull(),
  revisionId: text().notNull(),
  planId: text().notNull(),
  // GBRAIN_SYNC_STATUSES: gbrain_sync_queued | sync_lagging | indexed (terminal).
  status: text().notNull(),
  attempts: integer().notNull(),
  // AuditId of the commit that produced this revision (summary linkage, §16).
  auditRef: text().notNull(),
  sourceEventRef: text(),
  enqueuedAt: text().notNull(),
  lastAttemptAt: text(),
  // Last dispatch error MESSAGE only (summary — no raw content/secrets, §16).
  lastError: text(),
});
