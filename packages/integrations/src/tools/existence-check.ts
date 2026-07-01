// @sow/integrations — the MANDATORY pre-write existence check (safety invariant
// 2: NO DUPLICATE EXTERNAL WRITE). Before any create the Tool Gateway calls
// `resolveExisting`, which probes in a FIXED order and returns a typed outcome:
//
//   (a) receiptStore.getByIdempotencyKey(env.idempotencyKey)  → 'replay'
//       (a retried/replayed envelope reuses the stored receipt, NEVER a second
//        create — the §20.1 replay gate).
//   (b) receiptStore.getByCanonicalObjectKey(sys, cok)        → 'existing' (receipt)
//       (a prior write to the SAME object already committed → reuse it).
//   (c) adapter.existenceCheck(cok, env)                      → 'existing' (object)
//       (a live vendor hit — the object exists at the vendor even without a local
//        receipt → reuse it, never a duplicate create).
//   else                                                      → 'none'.
//
// A live adapter FAULT is returned as {kind:'error'} — it is NEVER collapsed into
// 'none', because treating an unreachable existence probe as "does not exist"
// would risk a duplicate create (fail-closed: the gateway must hold, not create).
// §16: async, returns a typed union, never throws.
import type { ExternalWriteEnvelope, WriteReceipt } from "@sow/contracts";
import type { ReceiptStore } from "../ports/persistence";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "./adapter-port";

/**
 * The typed outcome of the pre-write existence check. `replay` — a stored receipt
 * matched the idempotencyKey. `existing` — a prior-write receipt OR a live vendor
 * object matched the canonicalObjectKey (exactly one of `receipt` / `object` is
 * set). `none` — nothing exists; the gateway may proceed to create. `error` — the
 * live probe FAULTED; the gateway must fail-closed (hold), NOT create.
 */
export type ExistenceOutcome =
  | { readonly kind: "replay"; readonly receipt: WriteReceipt }
  | { readonly kind: "existing"; readonly receipt?: WriteReceipt; readonly object?: ExistingObject }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly error: AdapterError };

/**
 * Run the mandatory pre-write existence check for `env` in the fixed (a)→(b)→(c)
 * order (see module header). Pure apart from the injected store + adapter; never
 * throws. A live-probe fault is surfaced (never swallowed) so the caller stays
 * fail-closed.
 */
export async function resolveExisting(
  env: ExternalWriteEnvelope,
  adapter: TargetWriteAdapter,
  receiptStore: ReceiptStore,
): Promise<ExistenceOutcome> {
  // (a) replay gate — a stored receipt on the exact idempotencyKey.
  const byReplay = await receiptStore.getByIdempotencyKey(env.idempotencyKey);
  if (byReplay !== undefined) {
    return { kind: "replay", receipt: byReplay.receipt };
  }

  // (b) prior-write hit — a stored receipt on the same object identity.
  const byObject = await receiptStore.getByCanonicalObjectKey(
    env.targetSystem,
    env.canonicalObjectKey,
  );
  if (byObject !== undefined) {
    return { kind: "existing", receipt: byObject.receipt };
  }

  // (c) live vendor probe — the object may exist at the vendor without a local
  // receipt. A fault here is a typed error (never collapsed to 'none').
  const live = await adapter.existenceCheck(env.canonicalObjectKey, env);
  if (!live.ok) {
    return { kind: "error", error: live.error };
  }
  if (live.value !== null) {
    return { kind: "existing", object: live.value };
  }

  return { kind: "none" };
}
