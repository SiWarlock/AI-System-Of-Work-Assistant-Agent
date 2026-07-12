// Operational-store schema — PG-CORE MIRROR of the knowledge-revisions domain (§4 /
// §6 / §16, task 11.1). PARALLEL dialect of `../knowledge-revisions.ts`: the durable
// KnowledgeWriter idempotent-replay index — a `CommittedRevision` recorded on every
// successful commit, keyed by the writer's `idempotencyKey` (the PK). IDENTICAL column
// names + portable types (text; `workflowRunRef`/`auditRecord` as one `json` column each),
// `idempotencyKey` PRIMARY KEY — adds NO column, parity holds — for the both-dialect
// repository contract suite (REQ-D-003).
//
// The `idempotencyKey` PK is the exactly-once identity (first-write-wins on a duplicate;
// never two revisions for one key). NOT rebuildable (§4 / §16): a lost row re-opens a
// duplicate KnowledgeWriter commit.
//
// REQ-S-003 / §16: no secret column — `auditRecord` is SUMMARIES ONLY (before/after
// summaries + refs + payloadHash, never raw content); `workflowRunRef` is the run identity
// + audit refs. Both are redaction-safe pointers.
import { json, pgTable, text } from "drizzle-orm/pg-core";

export const knowledgeRevisions = pgTable("knowledge_revisions", {
  // The KnowledgeWriter idempotency key — the store's IDENTITY + exactly-once PK.
  idempotencyKey: text().primaryKey(),
  // The committed vault revision id (`rev:<sha256>`) — data, NOT unique.
  revisionId: text().notNull(),
  // The base revision the commit applied against (compare-revision precondition).
  baseRevisionId: text().notNull(),
  // The committing plan's id (traceability back to the KnowledgeMutationPlan).
  planId: text().notNull(),
  // The committing actor (e.g. "KnowledgeWriter") — provenance, not a secret.
  actor: text().notNull(),
  // The source event ref that drove the commit (traceability).
  sourceEventRef: text().notNull(),
  // The workflow run identity (WorkflowRunRef) — one json column (refs, no raw content).
  workflowRunRef: json().notNull(),
  // The commit AuditRecord — one json column; SUMMARIES ONLY (§16, no raw content).
  auditRecord: json().notNull(),
  // The commit instant (ISO-8601).
  committedAt: text().notNull(),
});
