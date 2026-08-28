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

// ── write_applications — the APPLIED-WRITE LEDGER (safety rule 3, C1) ─────────
//
// WHY A SECOND TABLE. `write_receipts` above holds ONE ROW PER OBJECT: its PK is
// the object identity and `put` is an `onConflictDoUpdate` that OVERWRITES
// `idempotencyKey`. That is exactly right for the questions it answers — "does this
// object exist?" and "what is currently applied to it?" — and structurally unable
// to answer the one the replay gate actually asks: **"was THIS envelope ever
// applied?"**
//
// A create-only world never notices, because an object is created once, so the
// single row IS its whole history. UPDATES make the history longer than one row can
// hold: recording an update's receipt EVICTS the previous `idempotencyKey`, so a
// replay of the already-committed envelope stops being recognized as a replay and
// WRITES AGAIN — a duplicate external write, i.e. safety rule 3 itself. That defect
// (C1) is why the update path was attempted and reverted twice; see
// `docs/findings/external-write-update-path.md`.
//
// This table is the history `write_receipts` cannot be: one IMMUTABLE row per
// APPLIED envelope, keyed by the replay key, recorded independently of the object's
// current state. The replay gate reads it; nothing overwrites it.
//
// KEYS:
//   - PK `idempotencyKey` — deliberately the WHOLE key, not a composite with
//     `targetSystem`. `write_receipts.idempotencyKey` is documented GLOBALLY UNIQUE
//     and `getByIdempotencyKey(key)` takes no `targetSystem`; a composite PK here
//     would silently WIDEN that invariant to per-system uniqueness. Same key, same
//     meaning, both tables.
//
// CLASSIFICATION: OPERATIONAL TRUTH — APPEND-ONLY and IMMUTABLE (first-write-wins;
// a re-record of a seen key is a no-op, never an update — the FIRST application is
// the authoritative one for replay). NOT rebuildable: a lost row re-opens a
// duplicate external write. NOT parity-checked (same rationale as write_receipts).
//
// RETENTION: unbounded by design for now — a row is the only proof a given envelope
// was already applied, so pruning one re-opens a duplicate write for that key.
// Rows are small and bounded by the number of external writes ever made. A pruning
// story belongs with the ordering mechanism (Stage 2), where "superseded" first
// becomes a decidable property; until then, deleting is unsafe and nothing deletes.
//
// REQ-S-003 / §16: no secret column — `receipt` is the same redaction-safe vendor
// proof pointer `write_receipts.receipt` carries.
export const writeApplications = sqliteTable("write_applications", {
  // The §8 replay key — PK. One row per envelope that actually reached the vendor.
  idempotencyKey: text().primaryKey(),
  targetSystem: text().notNull(),
  canonicalObjectKey: text().notNull(),
  // The payload this application actually wrote (NOT necessarily what is current).
  payloadHash: text().notNull(),
  // The vendor proof this application produced. NOT NULL: unlike write_receipts,
  // there is no "reserved" state here — a row exists only once a write COMMITTED.
  receipt: text({ mode: "json" }).notNull(),
  appliedAt: text().notNull(),
});
