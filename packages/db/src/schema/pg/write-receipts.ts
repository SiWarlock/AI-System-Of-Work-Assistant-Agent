// Operational-store schema — PG-CORE MIRROR of the write-receipts domain (WW-1,
// §8 / safety rule 3). PARALLEL dialect of `../write-receipts.ts`: the exactly-once
// external-write RECEIPT INDEX behind the §8 Tool Gateway's cross-process
// `ReceiptStore.reserve`. IDENTICAL column names + portable types (text; `receipt`
// as one `json` column), composite PK over (targetSystem, canonicalObjectKey), and
// a GLOBALLY-UNIQUE idempotencyKey — adds NO column, parity holds — for the
// both-dialect repository contract suite (REQ-D-003).
//
// The composite PK is the OBJECT IDENTITY the cross-process reserve INSERTs against
// (exactly one INSERT wins); idempotencyKey is the §8 replay key (unique). `receipt`
// is NULL until `put` upgrades the row reserved → committed.
//
// REQ-S-003 / §16: no secret column — `receipt` is the redaction-safe vendor
// proof-of-write, never raw secrets/content inline.
import { json, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const writeReceipts = pgTable(
  "write_receipts",
  {
    // §8 envelope keys — the OBJECT IDENTITY (composite PK), the cross-process
    // reserve's unique INSERT target.
    targetSystem: text().notNull(),
    canonicalObjectKey: text().notNull(),
    // §8 replay key — GLOBALLY UNIQUE among COMMITTED receipts (a replay reuses the
    // receipt by this key). NULLABLE: a reserved placeholder has NO replay key yet —
    // `put` sets the real key at commit. UNIQUE admits many NULLs (Postgres treats
    // NULLs as distinct), so distinct reservations never collide here — the OBJECT
    // IDENTITY (composite PK) is the reserve's uniqueness key, not this column.
    idempotencyKey: text().unique(),
    // Pins the exact payload that committed (envelope integrity).
    payloadHash: text().notNull(),
    // The vendor WriteReceipt proof — NULL until `put` upgrades reserved→committed;
    // its presence is the reserved-vs-committed discriminator the reserve reads.
    receipt: json(),
    recordedAt: text().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.targetSystem, t.canonicalObjectKey] }),
  }),
);

// ── write_applications — PG-CORE MIRROR of the APPLIED-WRITE LEDGER ───────────
// PARALLEL dialect of `../write-receipts.ts`'s `writeApplications` (see that
// header for WHY a second table exists: `write_receipts` holds ONE row per OBJECT
// and so structurally cannot answer "was THIS envelope ever applied?" once updates
// make an object's history longer than one row — safety rule 3 / C1).
// IDENTICAL column names + portable types (text; `receipt` as one `json` column,
// mirroring write_receipts), PK on the globally-unique `idempotencyKey` — adds NO
// column, parity holds — for the both-dialect contract suite (REQ-D-003).
//
// APPEND-ONLY + IMMUTABLE (first-write-wins). `receipt` is NOT NULL here: there is
// no reserved state — a row exists only once a write COMMITTED.
export const writeApplications = pgTable("write_applications", {
  idempotencyKey: text().primaryKey(),
  targetSystem: text().notNull(),
  canonicalObjectKey: text().notNull(),
  payloadHash: text().notNull(),
  receipt: json().notNull(),
  appliedAt: text().notNull(),
});
