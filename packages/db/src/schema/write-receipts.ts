// Operational-store schema — write-receipts domain (WW-1, §8 / safety rule 3).
//
// PERSISTS: the exactly-once external-write RECEIPT INDEX — the cross-process
// backstop behind the §8 Tool Gateway's `ReceiptStore.reserve` (safety rule 3:
// every external side effect goes through the Tool Gateway with an idempotency
// key + canonical object key + pre-write existence check + write receipt; replay
// reuses the receipt → ZERO duplicate external writes).
//
// The in-process `ReceiptStore` (packages/integrations) can only serialize
// dispatches WITHIN one worker; this table makes the reserve atomic ACROSS
// PROCESSES by backing it with a UNIQUE-CONSTRAINT INSERT on the object identity
// (targetSystem, canonicalObjectKey). A `reserve` INSERTs a placeholder row (no
// `receipt` yet); the INSERTER is the sole winner permitted to CREATE. The
// receipt is filled in by `put` once the external write commits, upgrading the
// row from reserved → committed; a later reserve then reuses the committed row.
//
// CLASSIFICATION: OPERATIONAL TRUTH — append-on-reserve, MUTABLE (reserved →
// committed via `put`), NOT rebuildable (a lost receipt would permit a duplicate
// external write). NOT parity-checked — the write-receipt INDEX row is a
// composite of the §8 envelope keys + the frozen WriteReceipt proof, not a 1:1
// mirror of one Appendix-A model (mirrors the outbox/connector-cursors pattern).
//
// KEYS:
//   - composite PK (targetSystem, canonicalObjectKey) — the OBJECT IDENTITY; this
//     is the unique key the cross-process reserve INSERTs against (mirrors the
//     connector-cursors composite-key pattern).
//   - idempotencyKey is GLOBALLY UNIQUE — the §8 replay key: a retried/replayed
//     envelope reuses the stored receipt by idempotencyKey, never a second create.
//
// REQ-S-003 / §16: no secret column. `receipt` is the vendor proof-of-write
// (externalObjectId / externalUrl / recordedAt / rawRef) — a redaction-safe
// pointer, never raw secrets/content inline.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const writeReceipts = sqliteTable(
  "write_receipts",
  {
    // §8 envelope keys — the OBJECT IDENTITY (composite PK). The cross-process
    // reserve INSERTs against this unique key: exactly one INSERT wins.
    targetSystem: text().notNull(),
    canonicalObjectKey: text().notNull(),
    // §8 replay key — GLOBALLY UNIQUE among COMMITTED receipts (a replay reuses the
    // receipt by this key). NULLABLE: a reserved placeholder has NO replay key yet —
    // `put` sets the real key at commit. UNIQUE admits many NULLs (SQLite + Postgres
    // treat NULLs as distinct), so distinct reservations never collide here — the
    // OBJECT IDENTITY (composite PK) is the reserve's uniqueness key, not this column.
    idempotencyKey: text().unique(),
    // Pins the exact payload that committed (envelope integrity).
    payloadHash: text().notNull(),
    // The vendor WriteReceipt proof — NULL until `put` upgrades reserved→committed.
    // Its presence is the reserved-vs-committed discriminator the reserve reads.
    receipt: text({ mode: "json" }),
    recordedAt: text().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.targetSystem, t.canonicalObjectKey] }),
  }),
);
