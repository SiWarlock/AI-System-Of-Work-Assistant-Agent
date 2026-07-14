// Operational-store schema — parity-reports domain (§4 / §6 / §12 / §16, task 11.1).
//
// PERSISTS: the revision-scoped `ParityReport` the SoW-owned ParityReconciler emits each
// reconciliation pass — the SERVE-TIME SOURCE the Knowledge-layer serving-gate coverage leg
// reads. At serve time the coverage reader looks up the LATEST report for a workspace @ its head
// revision; a clean+complete report lets the trust oracle admit KnowledgeWriter-stamped content,
// a dirty/incomplete/absent one degrades the workspace to Markdown-provenanced-only serving (§12
// fail-closed). This store is DORMANT until B2 binds the reader — it is the injection point.
//
// CLASSIFICATION: OPERATIONAL TRUTH — NOT rebuildable (§4 / §16: the model header says "not
// rebuildable — backed up, never reconstructed"). A `ParityReport` is IMMUTABLE per `reportId`
// (the PK): a duplicate-key `record` is FIRST-WRITE-WINS (idempotent no-op), never two rows for
// one report id. NOT parity-checked against a frozen Appendix-A table shape — the whole frozen
// `ParityReport` (incl. its embedded `Divergence[]`) is stored as ONE `payload` json column (like
// the outbox's `payload` / knowledge-revisions' `workflowRunRef`), so the Unit-1.14 / Unit-2.1
// column-parity set excludes it (mirrors the outbox / pending-kmp / knowledge-revisions precedent).
//
// REQ-S-003 / §16: NO secret column. A `ParityReport` carries fact COUNTS, a schema version, and
// `Divergence[]` (fact identities + content HASHES — never raw content); it is redaction-safe.
//
// KEYS: `reportId` is the PRIMARY KEY (the store identity + exactly-once first-write-wins).
// `workspaceId` + `reconciledAtRevision` are the SERVE-TIME QUERY key (the loader validates a
// report only when its `reconciledAtRevision === head revisionId`, so the read keys on that pair).
// `recordedAt` is store-side operational metadata (NOT a contract field) supplying the "latest"
// ordering the timestamp-free `ParityReport` lacks — a re-reconcile at the same revision supersedes.
//
// DIALECT/portability: SQLite single-source; the pg-core mirror is `./pg/parity-reports.ts` with
// the IDENTICAL column-name surface (the both-dialect repository contract suite pins it, REQ-D-003).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const parityReports = sqliteTable("parity_reports", {
  // The report id — the store IDENTITY + exactly-once PK (first-write-wins on a duplicate).
  reportId: text().primaryKey(),
  // The reconciled workspace — half the serve-time query key (WS scope).
  workspaceId: text().notNull(),
  // The Markdown revision this reconciliation was scoped to — the other half of the query key
  // (the serving loader matches it against the workspace's head `revisionId`).
  reconciledAtRevision: text().notNull(),
  // Store-side "latest" ordering (ISO-8601, caller-supplied via injected clock) — NOT a contract
  // field; a re-reconcile at the same (workspace, revision) supersedes by the newest `recordedAt`.
  recordedAt: text().notNull(),
  // The full serialized `ParityReport` — ONE json column (candidate data on read-back: the repo
  // re-gates it through `ParityReportSchema.parse`, so a corrupt/unparseable blob fails closed).
  payload: text({ mode: "json" }).notNull(),
});
