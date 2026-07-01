// @sow/integrations — persistence ports for the §8 gateways.
//
// Re-exports the canonical P1 operational-store contracts (TYPE-ONLY, under
// verbatimModuleSyntax) so downstream gateway slices depend on ONE persistence
// surface and never re-declare the store shapes:
//   • OutboxRepository / OutboxEntry        — the write outbox (§8/§9 replay gate).
//   • ConnectorCursorRepository / ConnectorCursorRecord — connector sync cursors.
//
// Plus the gateway-OWNED narrow `ReceiptStore` port — the exactly-once write-
// receipt index the Tool Gateway consults BEFORE every create (safety invariant
// 2: pre-write existence check by canonicalObjectKey; replay reuses the stored
// receipt by idempotencyKey → zero duplicate external writes). Kept here (not in
// @sow/db) because it is a gateway concern, not a generic operational store.
export type {
  OutboxRepository,
  OutboxEntry,
  ConnectorCursorRepository,
  ConnectorCursorRecord,
} from "@sow/db";

import type { TargetSystem, WriteReceipt } from "@sow/contracts";

/**
 * One persisted external-write receipt, indexed by BOTH the replay key
 * (`idempotencyKey`) and the object identity key (`canonicalObjectKey` +
 * `targetSystem`). `payloadHash` pins the exact payload that committed. `receipt`
 * is the vendor proof-of-write.
 */
export interface ReceiptRecord {
  readonly idempotencyKey: string;
  readonly canonicalObjectKey: string;
  readonly targetSystem: TargetSystem;
  readonly payloadHash: string;
  readonly receipt: WriteReceipt;
  readonly recordedAt: string;
}

/**
 * The outcome of an atomic create-reservation (`ReceiptStore.reserve`). Closes the
 * check-then-create race (safety invariant 2 under concurrency / a second scheduler,
 * ARCHITECTURE §2.5): for a given object identity, at most ONE concurrent caller
 * receives `reserved` (and may issue the create); every other caller receives
 * `in_progress` (a reservation is held, no receipt yet — the caller must hold/retry,
 * NEVER create) or `committed` (a receipt already exists → reuse it).
 */
export type ReceiptReservation =
  | { readonly kind: "reserved" }
  | { readonly kind: "in_progress" }
  | { readonly kind: "committed"; readonly record: ReceiptRecord };

/**
 * The gateway-owned receipt index. The Tool Gateway consults it BEFORE every
 * create:
 *   • `getByIdempotencyKey` — the replay gate (a retried/replayed envelope reuses
 *     the stored receipt, never a second create).
 *   • `getByCanonicalObjectKey` — the pre-write existence check (a matching stored
 *     receipt means the object already exists → reuse, never a duplicate create).
 *   • `reserve` — atomically claim the exclusive right to CREATE the object
 *     identified by (targetSystem, canonicalObjectKey). This is the concurrency
 *     guard the existence check alone cannot give: two interleaved dispatches both
 *     see "no receipt yet", but only the reservation WINNER may create; the loser
 *     gets `in_progress` (hold/retry) or `committed` (reuse). The production adapter
 *     backs this with a unique-constraint insert so it is atomic ACROSS PROCESSES;
 *     the in-memory store uses a synchronous check-and-set.
 *   • `release` — release an UNCOMMITTED reservation (the create faulted) so a
 *     later retry / outbox drain may re-claim it. A committed receipt supersedes
 *     the reservation (see `put`), so release is only for the fault path.
 *   • `put` — record the receipt once the write commits (also clears any
 *     reservation for that object identity).
 * Returns `undefined` on miss (a lookup miss is not an error). Fail-closed
 * semantics live in the gateway, not the store.
 */
export interface ReceiptStore {
  getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined>;
  getByCanonicalObjectKey(
    targetSystem: TargetSystem,
    k: string,
  ): Promise<ReceiptRecord | undefined>;
  reserve(targetSystem: TargetSystem, canonicalObjectKey: string): Promise<ReceiptReservation>;
  release(targetSystem: TargetSystem, canonicalObjectKey: string): Promise<void>;
  put(r: ReceiptRecord): Promise<void>;
}
