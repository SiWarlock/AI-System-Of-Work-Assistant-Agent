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

/**
 * Record an ADOPTED vendor object — one the live existence probe found but that
 * THIS SYSTEM NEVER WROTE. Indexes the object row so the next dispatch
 * short-circuits on the object key; deliberately does **NOT** touch the
 * applied-write ledger.
 *
 * ⛔ WHY THIS IS SEPARATE FROM {@link recordReceipt}. The ledger means exactly one
 * thing — "this envelope reached the vendor" — and every later decision will be
 * built on that meaning. Adoption observed that an object EXISTS; it issued no
 * write. Routing it through `recordReceipt` would mint a ledger row for an
 * envelope that was never applied, quietly turning the ledger into "objects we
 * know about", which is a different and much weaker claim.
 *
 * ⚠ RESIDUAL, and it is C4/C5 from `docs/findings/external-write-update-path.md`:
 * the object row this writes still carries `env.payloadHash` — the payload we
 * intended, NOT the bytes actually at the vendor, which we never saw. That is inert
 * today because nothing compares payloadHash. It stops being inert the moment
 * `update` is wired by comparing hashes: an adopted row would assert ownership of
 * content the system never authored, and the next changed-content dispatch would
 * update a FOREIGN object. Wiring `update` MUST first make an adopted object
 * distinguishable from an authored one — do not treat this row as proof of
 * authorship.
 */
export async function recordAdoptedObject(
  store: ReceiptStore,
  env: ExternalWriteEnvelope,
  receipt: WriteReceipt,
  clock: () => string,
): Promise<ReceiptRecord> {
  const record = buildReceiptRecord(env, receipt, clock);
  await store.put(record); // object row ONLY — never the ledger
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

/**
 * Did THIS SYSTEM author the content currently on `record`'s object?
 *
 * ⛔ THIS IS THE C4/C5 GUARD, and it needs no new column. After the adoption split
 * (`recordAdoptedObject`), the two ways an object row can come to exist are
 * distinguishable by construction:
 *   • AUTHORED — written by `recordReceipt`, which appends an applied-write LEDGER
 *     row for the envelope that produced it.
 *   • ADOPTED  — written by `recordAdoptedObject` from a live-probe hit. No ledger
 *     row, because no write was ever issued.
 * So authorship is exactly "a ledger row exists for the object row's CURRENT
 * idempotencyKey". The ledger's meaning — "this envelope reached the vendor" — is
 * what makes the answer trustworthy, which is why adoption had to be kept out of it
 * before this could be asked at all.
 *
 * FAILS CLOSED, deliberately, in both uncertain directions:
 *   • no ledger on the store (an older/legacy store) ⇒ `false` — unknown authorship
 *     is not authorship.
 *   • a ledger FAULT ⇒ `false` — a store that cannot answer must not be read as
 *     "yes, we own this".
 * Refusing to update an object we might not own costs a STALE document, which a
 * re-sync fixes. Updating one we do not own clobbers a stranger's content, which
 * nothing fixes.
 *
 * ⚠ Consequence worth naming: an object authored BEFORE the ledger existed reads as
 * unauthored and can never be updated in place. That is vacuous today — the write
 * transport is dormant (`§ARM-21` unarmed), so no real vendor object has ever been
 * written by this system — and it self-heals the first time a write goes through
 * `recordReceipt`.
 */
export async function isAuthoredByThisSystem(
  store: ReceiptStore,
  record: ReceiptRecord,
): Promise<boolean> {
  if (store.getApplication === undefined) return false;
  const applied = await store.getApplication(record.idempotencyKey);
  return applied.kind === "hit";
}
