// Operational-store schema — pending-KMP domain (§13.10a, §4/§6/§9).
//
// PERSISTS: the pending KnowledgeMutationPlan store — the SEMANTIC-write sibling of
// the external-write `outbox`. The Copilot KMP-propose sink (Slice E) records a
// derived, validated §6 KnowledgeMutationPlan here keyed by its `planId`; the pending
// §9.8 Approval carries `subjectKind: "semantic_mutation"` + `planRef === planId`
// pointing at this row; on approval the executor (Slice F) re-fetches the plan and
// commits it through KnowledgeWriter (safety rule 1 — never a direct write; the sole
// autonomous Markdown writer).
//
// CLASSIFICATION: OPERATIONAL TRUTH — append-on-record, MUTABLE status as the entry
// settles (pending → committed | rejected), TOMBSTONE via terminal status. Not
// rebuildable (§4 / §16). NOT parity-checked — this is not a 1:1 mirror of a frozen
// Appendix-A model (the KMP is stored as ONE `plan` json column, like the outbox's
// `payload`), so the Unit-1.14 parity set excludes it (mirrors the outbox precedent).
//
// REQ-S-003: no secret column. §16: `plan` is the to-commit KnowledgeMutationPlan
// (operational necessity for the on-approval commit — NOT a log sink); it carries no
// secret material and is CANDIDATE DATA on read-back (the executor re-validates it
// through KnowledgeMutationPlanSchema before applyPlan — never trust the stored blob).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header); the
// pg-core mirror is `./pg/pending-kmp.ts` with the IDENTICAL column-name surface (the
// both-dialect repository contract suite pins portability, REQ-D-003).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pendingKnowledgeMutations = sqliteTable("pending_knowledge_mutations", {
  // The KMP's planId — the PK the pending Approval's `planRef` points at.
  planId: text().primaryKey(),
  // WS-8 scope — the plan's server-bound workspace (matches the Approval + the KMP).
  workspaceId: text().notNull(),
  // The serialized KnowledgeMutationPlan (candidate data on read; no secrets — §16).
  plan: text({ mode: "json" }).notNull(),
  // Hash over the plan — MUST equal the pending Approval.payloadHash (§13.10a TOCTOU gate).
  payloadHash: text().notNull(),
  // Lifecycle: pending → committed | rejected (terminal status is the tombstone).
  status: text().notNull(),
  recordedAt: text().notNull(),
  // The terminal-transition instant (set when the executor commits or rejects). Nullable.
  settledAt: text(),
});
