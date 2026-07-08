// Operational-store schema — PG-CORE MIRROR of the pending-KMP domain (§13.10a,
// §4/§6/§9). PARALLEL dialect of `../pending-kmp.ts`: the pending KnowledgeMutationPlan
// store (the semantic-write sibling of the external-write `outbox`). The Copilot
// KMP-propose sink records a derived §6 KMP keyed by `planId`; on approval the executor
// commits it through KnowledgeWriter. IDENTICAL column names + portable types (text; the
// plan as one `json` column, like the outbox's `payload`) for the both-dialect repository
// contract suite (REQ-D-003).
//
// REQ-S-003: no secret column. §16: `plan` is candidate data on read-back (re-validated
// through KnowledgeMutationPlanSchema before applyPlan — never trust the stored blob).
import { json, pgTable, text } from "drizzle-orm/pg-core";

export const pendingKnowledgeMutations = pgTable("pending_knowledge_mutations", {
  planId: text().primaryKey(),
  workspaceId: text().notNull(),
  plan: json().notNull(),
  payloadHash: text().notNull(),
  status: text().notNull(),
  recordedAt: text().notNull(),
  settledAt: text(),
});
