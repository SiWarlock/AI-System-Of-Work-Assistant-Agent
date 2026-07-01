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
