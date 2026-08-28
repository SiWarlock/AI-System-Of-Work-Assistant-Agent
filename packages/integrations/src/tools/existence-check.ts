// @sow/integrations — the MANDATORY pre-write existence check (safety invariant
// 2: NO DUPLICATE EXTERNAL WRITE). Before any create the Tool Gateway calls
// `resolveExisting`, which probes in a FIXED order and returns a typed outcome:
//
//   (a) the APPLIED-WRITE LEDGER (`getApplication`), else
//       receiptStore.getByIdempotencyKey(env.idempotencyKey)  → 'replay'
//       (a retried/replayed envelope reuses the stored receipt, NEVER a second
//        create — the §20.1 replay gate). The ledger is preferred because the
//        receipt row holds only the key CURRENTLY on the object, which stops being
//        the same question once an object can be UPDATED.
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
  //
  // ⛔ A STORE FAULT IS NOT A MISS. On this gate a miss means "no prior write, go
  // ahead", so collapsing a fault into `undefined` grants permission to write again
  // — a fail-OPEN on the mechanism safety rule 3 rests on. When the store can tell
  // us (the optional `*Checked` variant), a fault becomes a typed `error` outcome,
  // which the gateway already handles fail-closed: it never creates, and holds for
  // retry. `unreachable` is the right adapter code for it — a DB blip is transient,
  // so this must retry rather than terminate (see the retryable/terminal split in
  // gateway.ts step 3).
  //
  // THE LEDGER IS THE AUTHORITATIVE SOURCE when the store has one. The receipt-row
  // lookups below can only report the key CURRENTLY on the object's single row, so
  // once an object can be updated they answer a question this gate did not ask (see
  // `ReceiptStore.recordApplication`). The ledger records every applied envelope
  // independently, so a superseded key is still recognised as a replay.
  //
  // Ordered FIRST because it is strictly more informative: on a create-only store
  // the two agree by construction (one application per object), so this changes
  // nothing until updates exist — and is already correct when they do.
  if (receiptStore.getApplication !== undefined) {
    const applied = await receiptStore.getApplication(env.idempotencyKey);
    if (applied.kind === "fault") {
      return {
        kind: "error",
        error: { code: "unreachable", message: `applied-write ledger lookup failed (${applied.code})` },
      };
    }
    if (applied.kind === "hit") return { kind: "replay", receipt: applied.record.receipt };
    // ⛔ A LEDGER MISS IS NOT AUTHORITATIVE, AND ASSUMING IT WAS WAS A REGRESSION.
    // The ledger only knows writes recorded THROUGH `recordReceipt`. A receipt put
    // into the store by any other path — a direct `store.put`, a seeded fixture, a
    // row written before this table existed — has no ledger entry, and treating the
    // miss as final DROPPED a replay the pre-ledger gate recognised. (Caught by
    // existence-check.test.ts: two replay pins went `existing` instead of `replay`.)
    //
    // The ledger ADDS recall; it must never SUBTRACT it. So fall through to the
    // receipt-row lookup below, which is the pre-ledger behaviour verbatim.
  }
  if (receiptStore.getByIdempotencyKeyChecked !== undefined) {
    const checked = await receiptStore.getByIdempotencyKeyChecked(env.idempotencyKey);
    if (checked.kind === "fault") {
      return {
        kind: "error",
        error: { code: "unreachable", message: `receipt store lookup failed (${checked.code})` },
      };
    }
    if (checked.kind === "hit") return { kind: "replay", receipt: checked.record.receipt };
  } else {
    const byReplay = await receiptStore.getByIdempotencyKey(env.idempotencyKey);
    if (byReplay !== undefined) {
      return { kind: "replay", receipt: byReplay.receipt };
    }
  }

  // (b) prior-write hit — a stored receipt on the same object identity. Same
  // fault-vs-miss distinction: a fault here would let the gateway proceed toward a
  // create for an object that may already exist — a duplicate write.
  if (receiptStore.getByCanonicalObjectKeyChecked !== undefined) {
    const checked = await receiptStore.getByCanonicalObjectKeyChecked(
      env.targetSystem,
      env.canonicalObjectKey,
    );
    if (checked.kind === "fault") {
      return {
        kind: "error",
        error: { code: "unreachable", message: `receipt store lookup failed (${checked.code})` },
      };
    }
    if (checked.kind === "hit") return { kind: "existing", receipt: checked.record.receipt };
  } else {
    const byObject = await receiptStore.getByCanonicalObjectKey(
      env.targetSystem,
      env.canonicalObjectKey,
    );
    if (byObject !== undefined) {
      return { kind: "existing", receipt: byObject.receipt };
    }
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
