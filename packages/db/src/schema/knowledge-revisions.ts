// Operational-store schema — knowledge-revisions domain (§4 / §6 / §16, task 11.1).
//
// PERSISTS: the durable KnowledgeWriter idempotent-replay index. A `CommittedRevision`
// (packages/knowledge revision.ts) is recorded here on every successful KnowledgeWriter
// commit, keyed by the writer's `idempotencyKey`. The writer's `applyPlan` SHORT-CIRCUITS
// on `getByIdempotencyKey` BEFORE any Markdown/audit write (§6 idempotency), so a replay
// with the same key returns the already-committed revision — no double write, no second
// AuditRecord. This DURABLE store replaces the in-memory `Map` the worker's inert stub
// used (apps/worker boot.ts) — an in-memory map loses this record across a worker restart,
// re-opening a double commit; the persisted row survives (the exactly-once substrate).
//
// CLASSIFICATION: OPERATIONAL TRUTH — APPEND-ONLY, keyed by `idempotencyKey` (the PK).
// NOT rebuildable (§4 / §16): a lost row would re-open a duplicate KnowledgeWriter commit.
// A duplicate-key `record` is FIRST-WRITE-WINS (idempotent no-op) — NEVER two revisions for
// one key. NOT parity-checked — this is not a 1:1 mirror of a frozen Appendix-A model (the
// `workflowRunRef`/`auditRecord` sub-objects are stored as ONE json column each, like the
// outbox's `payload`), so the Unit-1.14 parity set excludes it (mirrors the outbox / pending-kmp
// precedent).
//
// REQ-S-003 / §16: no secret column. `auditRecord` carries the commit AuditRecord which is
// SUMMARIES ONLY (before/after summaries, refs, payloadHash — never raw content, §16);
// `workflowRunRef` is the run identity + audit refs. Both are redaction-safe pointers.
//
// KEY: `idempotencyKey` is the PRIMARY KEY — the store's identity is the KnowledgeWriter
// idempotency key (the ONLY column the store looks up by), so the exactly-once "never two
// revisions for one key" invariant is the PK constraint itself (first-write-wins insert).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header); the pg-core
// mirror is `./pg/knowledge-revisions.ts` with the IDENTICAL column-name surface (the
// both-dialect repository contract suite pins portability, REQ-D-003).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const knowledgeRevisions = sqliteTable("knowledge_revisions", {
  // The KnowledgeWriter idempotency key — the store's IDENTITY + exactly-once PK
  // (getByIdempotencyKey looks up by this; first-write-wins on a duplicate).
  idempotencyKey: text().primaryKey(),
  // The committed vault revision id (`rev:<sha256>`) — data, NOT unique (a no-op
  // commit could in principle re-hash to an existing revision under a new key).
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
  workflowRunRef: text({ mode: "json" }).notNull(),
  // The commit AuditRecord — one json column; SUMMARIES ONLY (§16, no raw content).
  auditRecord: text({ mode: "json" }).notNull(),
  // The commit instant (ISO-8601).
  committedAt: text().notNull(),
});
