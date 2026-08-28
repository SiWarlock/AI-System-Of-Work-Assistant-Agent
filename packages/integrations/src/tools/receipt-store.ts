// @sow/integrations — a thin helper layer over the ReceiptStore port (§8 Tool
// Gateway). The `ReceiptStore` interface itself lives in the foundation
// (src/ports/persistence.ts); this module only builds a `ReceiptRecord` from a
// committed write + records/looks it up. The receipt index is the exactly-once
// backbone (safety invariant 2): a stored receipt keyed by BOTH idempotencyKey
// (replay gate) and canonicalObjectKey (pre-write existence check) means the next
// dispatch reuses it, never a duplicate create. §16: async, never throws.
import type { ExternalWriteEnvelope, WriteReceipt } from "@sow/contracts";
import type { ReceiptStore, ReceiptRecord } from "../ports/persistence";

/**
 * Build the `ReceiptRecord` that indexes a just-committed write. Copies the
 * envelope's replay + object identity keys and its `payloadHash` (proof the
 * payload approved is the payload written), wraps the vendor `receipt`, and
 * stamps `recordedAt` from the INJECTED `clock` (no `Date.now()` in src). Pure
 * apart from the injected clock.
 */
export function buildReceiptRecord(
  env: ExternalWriteEnvelope,
  receipt: WriteReceipt,
  clock: () => string,
): ReceiptRecord {
  return {
    idempotencyKey: env.idempotencyKey,
    canonicalObjectKey: env.canonicalObjectKey,
    targetSystem: env.targetSystem,
    payloadHash: env.payloadHash,
    receipt,
    recordedAt: clock(),
  };
}

/**
 * Record a committed write's receipt into the store, keyed by both idempotency +
 * canonical-object keys (the store indexes both). Returns the persisted record so
 * the caller can return it without a re-read. Never throws.
 */
export async function recordReceipt(
  store: ReceiptStore,
  env: ExternalWriteEnvelope,
  receipt: WriteReceipt,
  clock: () => string,
): Promise<ReceiptRecord> {
  const record = buildReceiptRecord(env, receipt, clock);
  // LEDGER FIRST, then the object row — the order is deliberate, not incidental.
  //
  // Both writes are needed and neither is transactional with the other, so a crash
  // between them must leave the SAFE half persisted. The ledger is the durable
  // proof-of-application: with it present, a replay of this envelope is recognised
  // and reuses the receipt. Persisting the object row first and dying would leave
  // the ledger without this key, and the replay would fall through to the
  // object-key arm — still safe here (it finds the row and reuses), but it depends
  // on a SECOND mechanism rather than the one that owns the question.
  //
  // Write the proof that the vendor was touched before the bookkeeping about what
  // is current. A no-op if the store predates the ledger (create-only ⇒ correct).
  await store.recordApplication?.(record);
  await store.put(record);
  return record;
}

/** Look up a stored receipt by its replay key (idempotencyKey). */
export async function findByReplayKey(
  store: ReceiptStore,
  idempotencyKey: string,
): Promise<ReceiptRecord | undefined> {
  return store.getByIdempotencyKey(idempotencyKey);
}

/** Look up a stored receipt by its object identity (targetSystem+canonicalObjectKey). */
export async function findByObjectKey(
  store: ReceiptStore,
  env: ExternalWriteEnvelope,
): Promise<ReceiptRecord | undefined> {
  return store.getByCanonicalObjectKey(env.targetSystem, env.canonicalObjectKey);
}
