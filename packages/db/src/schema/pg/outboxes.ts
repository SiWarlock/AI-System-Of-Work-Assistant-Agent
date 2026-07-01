// Operational-store schema — PG-CORE MIRROR of the outboxes domain (Unit 2.1,
// §4/§8/§9). PARALLEL dialect of `../outboxes.ts`: the external-write OUTBOX (the §8
// Tool Gateway is the only external-write path), tracking a ProposedAction through
// the §9 Proposed-External-Action machine + the external-write-envelope keys →
// replay reuses the WriteReceipt for ZERO duplicate external writes. IDENTICAL column
// names + portable types (text/integer; payload/writeReceipt as one `json` column
// each) for the both-dialect repository contract suite (REQ-D-003).
//
// REQ-S-003: no secret column (secrets are Keychain references resolved at dispatch).
import { integer, json, pgTable, text } from "drizzle-orm/pg-core";

export const outbox = pgTable("outbox", {
  // arch_gap: outbox-entry id grammar unspecified upstream — opaque non-empty PK.
  outboxId: text().primaryKey(),
  // Links the originating ProposedAction (§8/§9) — its actionId.
  actionRef: text().notNull(),
  workspaceId: text().notNull(),
  targetSystem: text().notNull(),
  // §8 envelope keys — both required, drive idempotent match-then-reuse.
  canonicalObjectKey: text().notNull(),
  idempotencyKey: text().notNull(),
  payloadHash: text().notNull(),
  // §9 Proposed-External-Action machine state.
  status: text().notNull(),
  // To-dispatch action payload (no secrets; §16 redaction applies to log sinks).
  payload: json(),
  // The WriteReceipt once the external write commits (exactly-once proof, §8).
  writeReceipt: json(),
  attempts: integer().notNull(),
  enqueuedAt: text().notNull(),
  nextAttemptAt: text(),
  updatedAt: text().notNull(),
});
