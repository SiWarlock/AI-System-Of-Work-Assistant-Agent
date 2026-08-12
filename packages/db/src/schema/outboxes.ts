// Operational-store schema — outboxes domain (Unit 1.14, §4/§8/§9).
//
// PERSISTS: the external-write OUTBOX (the §8 Tool Gateway is the only
// external-write path). Each entry tracks a ProposedAction through the §9
// Proposed-External-Action machine
// (proposed→approval_required|auto_allowed→precondition_checked→dispatched→
// receipt_recorded|retry_queued|rejected|expired) and carries the
// external-write-envelope fields: idempotencyKey, canonicalObjectKey, payload
// hash, and (once committed) the WriteReceipt → replay reuses the receipt for
// ZERO duplicate external writes (the replay gate, §8).
//
// CLASSIFICATION: OPERATIONAL TRUTH — append-on-enqueue, MUTABLE status as the
// entry advances, TOMBSTONE via terminal status (receipt_recorded|rejected|
// expired). Not rebuildable (§4 / §16). NOT parity-checked — the Unit-1.14
// parity set does not include an outbox/ProposedAction model (the outbox is a
// composite of ProposedAction + ExternalWriteEnvelope + WriteReceipt; modeled
// here for the dispatch loop, not as a 1:1 mirror of one frozen model).
//
// REQ-S-003: no secret column. §16: `payload` is the to-dispatch action payload
// (operational necessity for replay/dispatch — NOT a log sink) and carries no
// secret material (secrets are Keychain references resolved at dispatch time).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const outbox = sqliteTable("outbox", {
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
  // Task 24.35 — the original approvalPolicy token at propose time (nullable/additive; see interfaces.ts).
  approvalPolicy: text(),
  // §9 Proposed-External-Action machine state.
  status: text().notNull(),
  // To-dispatch action payload (no secrets; §16 redaction applies to log sinks).
  payload: text({ mode: "json" }),
  // The WriteReceipt once the external write commits (exactly-once proof, §8).
  writeReceipt: text({ mode: "json" }),
  attempts: integer().notNull(),
  enqueuedAt: text().notNull(),
  nextAttemptAt: text(),
  updatedAt: text().notNull(),
});
