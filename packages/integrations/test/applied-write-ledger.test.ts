// @sow/integrations — the APPLIED-WRITE LEDGER closes C1: a replay of a SUPERSEDED
// envelope must still be recognised as a replay.
//
// ⛔ THE DEFECT (C1), the reason the external-write UPDATE path was reverted twice.
// `write_receipts` holds ONE row per OBJECT and `put` overwrites its
// `idempotencyKey`. So writing an object a SECOND time (an update) EVICTS the first
// envelope's replay key. A later replay of that first envelope is then not
// recognised — and an unrecognised replay is permission to write to the vendor
// AGAIN, which is the exact thing safety rule 3 exists to prevent:
//
//   "replay reuses the receipt ⇒ zero duplicate external writes"
//
// A create-only world never sees this, because an object is created once and its
// single row IS its whole history. That is why the gap could ship, and why it must
// be closed BEFORE `update` is wired rather than alongside it.
//
// The ledger (`recordApplication` / `getApplication`, @sow/db `write_applications`)
// records every APPLIED envelope independently of the object's current state, and
// `resolveExisting` prefers it. These pins drive the REAL `dispatchExternalWrite`
// over the REAL in-memory store — the question is about the whole pipeline, not any
// one function.
import { describe, it, expect, vi } from "vitest";
import { ok } from "@sow/contracts";
import type { Result, WriteReceipt } from "@sow/contracts";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../src/tools/gateway";
import { recordReceipt } from "../src/tools/receipt-store";
import { resolveExisting } from "../src/tools/existence-check";
import type { TargetWriteAdapter, AdapterError, ExistingObject } from "../src/tools/adapter-port";
import type { ReceiptStore, ReceiptRecord, ReceiptLookup } from "../src/ports/persistence";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import { InMemoryReceiptStore, makeProposedAction } from "./support/fakes";

/** A LINKED envelope+action pair — the gateway's candidate gate pins the two together
 *  (`envelopeMatchesAction`), so an independently-built envelope is rejected before any
 *  dispatch. Build the envelope FROM the action, exactly as production does. */
function pair(idempotencyKey: string, canonicalObjectKey = COK) {
  const action = makeProposedAction({ targetSystem: "drive", canonicalObjectKey, idempotencyKey });
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return { action, env: built.value };
}

const CLOCK = (): string => "2026-07-01T00:00:00.000Z";
const COK = "cok:drive:project-a:00_brief";

/** An adapter that reports a MISS on the live probe and counts real creates. */
function countingAdapter(): { adapter: TargetWriteAdapter; creates: () => number } {
  let creates = 0;
  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    async existenceCheck(): Promise<Result<ExistingObject | null, AdapterError>> {
      return ok(null); // the vendor has no such object yet
    },
    async create(): Promise<Result<WriteReceipt, AdapterError>> {
      creates += 1;
      return ok({ externalObjectId: `ext-${creates}`, recordedAt: CLOCK() });
    },
    async update(): Promise<Result<WriteReceipt, AdapterError>> {
      return ok({ externalObjectId: "ext-updated", recordedAt: CLOCK() });
    },
  };
  return { adapter, creates: () => creates };
}

function depsOver(store: ReceiptStore, adapter: TargetWriteAdapter): ExternalWriteDeps {
  return {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock: CLOCK,
  };
}

describe("applied-write ledger — a superseded replay key is still a replay (C1)", () => {
  it("recognises a superseded key as a REPLAY — the receipt row has lost it entirely", async () => {
    const store = new InMemoryReceiptStore();
    const { adapter, creates } = countingAdapter();

    const { env: first, action: firstAction } = pair("idem-first");
    expect((await dispatchExternalWrite(first, firstAction, depsOver(store, adapter))).status).toBe("created");
    expect(creates()).toBe(1);

    // A SECOND application to the SAME object under a NEW key — what an update is.
    // Recorded through the production helper, so the object row is overwritten
    // exactly as `put` does in production.
    await recordReceipt(store, pair("idem-second").env, { externalObjectId: "ext-1", recordedAt: CLOCK() }, CLOCK);

    // THE EVICTION, measured: the first key is GONE from the receipt row.
    expect(await store.getByIdempotencyKey("idem-first")).toBeUndefined();

    // THE FIX: arm (a) still resolves it, as a `replay`. Asserting the KIND is what
    // makes this load-bearing — see the next test for why `reused` alone would not.
    const outcome = await resolveExisting(first, adapter, store);
    expect(outcome.kind).toBe("replay");
  });

  it("⚠ WHY THE DUPLICATE-CREATE IS NOT DEMONSTRABLE YET: arm (b) currently MASKS C1", async () => {
    // Worth stating plainly, because the first draft of this suite asserted
    // `status === "reused"` and PASSED with the ledger disabled — proving nothing.
    //
    // Today every dispatch for an existing object is short-circuited by arm (b)
    // (`getByCanonicalObjectKey`): the object row exists, so the gateway returns
    // `reused` whether or not arm (a) recognised the replay. That mask is also
    // exactly why `update` currently never happens — arm (b) answers "the object
    // exists" and the gateway stops.
    //
    // Stage 2 must let an update PAST arm (b) (a changed payload has to proceed),
    // and at that moment arm (a) becomes the ONLY replay defence — with its key
    // already evicted. That is C1, and it is why the ledger lands FIRST.
    const store = new InMemoryReceiptStore();
    const { adapter, creates } = countingAdapter();
    const { env: first, action: firstAction } = pair("idem-first");
    await dispatchExternalWrite(first, firstAction, depsOver(store, adapter));
    await recordReceipt(store, pair("idem-second").env, { externalObjectId: "ext-1", recordedAt: CLOCK() }, CLOCK);

    // Strip the ledger: this is the pre-ledger store, and the outcome is IDENTICAL
    // at the gateway — which is the masking, demonstrated rather than asserted.
    const masked: ReceiptStore = {
      getByIdempotencyKey: (k) => store.getByIdempotencyKey(k),
      getByCanonicalObjectKey: (t, k) => store.getByCanonicalObjectKey(t, k),
      reserve: (t, k) => store.reserve(t, k),
      release: (t, k) => store.release(t, k),
      put: (r) => store.put(r),
    };
    expect((await dispatchExternalWrite(first, firstAction, depsOver(masked, adapter))).status).toBe("reused");
    expect(creates()).toBe(1);
    // …but it got there via arm (b), NOT the replay gate:
    expect((await resolveExisting(first, adapter, masked)).kind).toBe("existing");
    // With the ledger, the SAME envelope resolves on arm (a) instead:
    expect((await resolveExisting(first, adapter, store)).kind).toBe("replay");
  });

  it("the replay returns the receipt the FIRST application actually produced, not the latest one", async () => {
    // Returning "a receipt" is not enough — a replay must get back ITS OWN write's
    // proof. Handing back a later write's receipt would point the caller at the
    // wrong vendor object.
    const store = new InMemoryReceiptStore();
    const { env } = pair("idem-a");
    await recordReceipt(store, env, { externalObjectId: "ext-A", recordedAt: CLOCK() }, CLOCK);
    await recordReceipt(
      store,
      pair("idem-b").env,
      { externalObjectId: "ext-B", recordedAt: CLOCK() },
      CLOCK,
    );

    const { adapter } = countingAdapter();
    const outcome = await resolveExisting(env, adapter, store);
    expect(outcome.kind).toBe("replay");
    if (outcome.kind !== "replay") return;
    expect(outcome.receipt.externalObjectId).toBe("ext-A");
  });

  it("a ledger FAULT fails CLOSED — it is never read as 'never applied'", async () => {
    // Same hazard the *Checked pair exists for, on the newer arm: a store that
    // cannot answer must not grant permission to write again.
    const faulting: ReceiptStore = {
      getApplication: async (): Promise<ReceiptLookup> => ({ kind: "fault", code: "unavailable" }),
      getByIdempotencyKey: async () => undefined,
      getByCanonicalObjectKey: async () => undefined,
      reserve: async () => ({ kind: "reserved" }),
      release: async () => undefined,
      put: async () => undefined,
    };
    const probe = vi.fn();
    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async () => {
        probe();
        return ok(null);
      },
      create: async () => ok({ externalObjectId: "x", recordedAt: CLOCK() }),
      update: async () => ok({ externalObjectId: "x", recordedAt: CLOCK() }),
    };
    const { env } = pair("idem-f");
    const outcome = await resolveExisting(env, adapter, faulting);

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.error.code).toBe("unreachable"); // retryable — a DB blip is transient
    // Fail-closed means it stopped BEFORE the live probe, not merely before the create.
    expect(probe).not.toHaveBeenCalled();
  });

  it("recordReceipt writes the ledger BEFORE the object row (the safe half survives a crash between them)", async () => {
    const order: string[] = [];
    // Written out rather than spread over an InMemoryReceiptStore: spreading a class
    // instance copies own FIELDS, not prototype METHODS, so that object would not
    // actually be a ReceiptStore — it only looked like one.
    const store: ReceiptStore = {
      getByIdempotencyKey: async () => undefined,
      getByCanonicalObjectKey: async () => undefined,
      reserve: async () => ({ kind: "reserved" }),
      release: async () => undefined,
      recordApplication: async (_r: ReceiptRecord) => {
        order.push("ledger");
      },
      put: async (_r: ReceiptRecord) => {
        order.push("object-row");
      },
    };
    await recordReceipt(
      store,
      pair("idem-o").env,
      { externalObjectId: "ext", recordedAt: CLOCK() },
      CLOCK,
    );
    expect(order).toEqual(["ledger", "object-row"]);
  });

  it("REGRESSION: a ledger MISS falls through to the receipt row — the ledger ADDS recall, never subtracts it", async () => {
    // The bug this pins was real and was caught by the pre-existing suite: making the
    // ledger authoritative meant a receipt written by any path OTHER than
    // `recordReceipt` — a direct `store.put`, a seeded fixture, a row predating the
    // table — was no longer recognised as a replay, because it has no ledger entry.
    // Two long-standing replay pins went `existing` instead of `replay`.
    //
    // A store WITH a ledger must still recognise everything the pre-ledger gate did.
    const store = new InMemoryReceiptStore();
    expect(store.getApplication).toBeDefined(); // the ledger IS present…

    const { env } = pair("idem-put-only");
    // …but this receipt is written via `put` ALONE, so the ledger never sees it.
    await store.put({
      idempotencyKey: env.idempotencyKey,
      canonicalObjectKey: env.canonicalObjectKey,
      targetSystem: env.targetSystem,
      payloadHash: env.payloadHash,
      receipt: { externalObjectId: "ext-put-only", recordedAt: CLOCK() },
      recordedAt: CLOCK(),
    });
    expect(await store.getApplication(env.idempotencyKey)).toEqual({ kind: "miss" });

    const { adapter } = countingAdapter();
    const outcome = await resolveExisting(env, adapter, store);
    expect(outcome.kind).toBe("replay"); // NOT `existing` — arm (a) still answers
    if (outcome.kind !== "replay") return;
    expect(outcome.receipt.externalObjectId).toBe("ext-put-only");
  });

  it("DORMANCY: a store WITHOUT the ledger behaves exactly as before (create-only correctness)", async () => {
    // The methods are optional. A store that predates them must keep working, and on
    // a create-only path the two answers are identical by construction — one
    // application per object.
    const base = new InMemoryReceiptStore();
    const legacy: ReceiptStore = {
      getByIdempotencyKey: (k) => base.getByIdempotencyKey(k),
      getByCanonicalObjectKey: (t, k) => base.getByCanonicalObjectKey(t, k),
      reserve: (t, k) => base.reserve(t, k),
      release: (t, k) => base.release(t, k),
      put: (r) => base.put(r),
    };
    expect(legacy.getApplication).toBeUndefined();

    const { adapter, creates } = countingAdapter();
    const { env, action } = pair("idem-legacy");

    expect((await dispatchExternalWrite(env, action, depsOver(legacy, adapter))).status).toBe("created");
    // The ordinary replay (key still current on the row) is recognised without the ledger.
    expect((await dispatchExternalWrite(env, action, depsOver(legacy, adapter))).status).toBe("reused");
    expect(creates()).toBe(1);
  });
});
