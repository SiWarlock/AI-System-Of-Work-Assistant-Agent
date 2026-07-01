// Slice 6.2 — resolveExisting: the MANDATORY pre-write existence check (safety
// invariant 2). Order is fixed: (a) receipt by idempotencyKey → replay; (b)
// receipt by canonicalObjectKey → prior write; (c) live adapter existenceCheck →
// vendor hit; else none. A live adapter fault (unreachable/etc.) surfaces as a
// typed error — NEVER silently treated as "none" (which would risk a duplicate
// create).
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WriteReceipt } from "@sow/contracts";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import { resolveExisting } from "../src/tools/existence-check";
import {
  InMemoryReceiptStore,
  makeEnvelope,
  makeReceiptRecord,
  makeWriteReceipt,
} from "./support/fakes";

function makeAdapter(
  existence: () => Promise<Result<ExistingObject | null, AdapterError>>,
): TargetWriteAdapter {
  return {
    targetSystem: "drive",
    existenceCheck: vi.fn(existence),
    create: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
}

describe("resolveExisting", () => {
  it("(a) replay hit: a stored receipt on the idempotencyKey short-circuits before the adapter", async () => {
    const store = new InMemoryReceiptStore();
    const rec = makeReceiptRecord({ idempotencyKey: "idem_replay" });
    await store.put(rec);
    const env = makeEnvelope({ idempotencyKey: "idem_replay" });
    const adapter = makeAdapter(async () => ok(null));

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("replay");
    if (res.kind === "replay") expect(res.receipt).toEqual(rec.receipt);
    expect(adapter.existenceCheck).not.toHaveBeenCalled();
  });

  it("(b) prior-write hit: a stored receipt on the canonicalObjectKey (different idem) resolves 'existing'", async () => {
    const store = new InMemoryReceiptStore();
    const rec = makeReceiptRecord({
      idempotencyKey: "idem_original",
      canonicalObjectKey: "cok_drive_shared",
    });
    await store.put(rec);
    // A different idempotencyKey, same object key.
    const env = makeEnvelope({
      idempotencyKey: "idem_new",
      canonicalObjectKey: "cok_drive_shared",
    });
    const adapter = makeAdapter(async () => ok(null));

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("existing");
    if (res.kind === "existing") expect(res.receipt).toEqual(rec.receipt);
    expect(adapter.existenceCheck).not.toHaveBeenCalled();
  });

  it("(c) live vendor hit: no stored receipt, adapter existenceCheck returns an object", async () => {
    const store = new InMemoryReceiptStore();
    const env = makeEnvelope({ idempotencyKey: "idem_live", canonicalObjectKey: "cok_live" });
    const object: ExistingObject = { externalObjectId: "ext_live_1", externalUrl: "https://x/1" };
    const adapter = makeAdapter(async () => ok(object));

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("existing");
    if (res.kind === "existing") expect(res.object).toEqual(object);
    expect(adapter.existenceCheck).toHaveBeenCalledOnce();
  });

  it("none: no stored receipt and the adapter reports no existing object", async () => {
    const store = new InMemoryReceiptStore();
    const env = makeEnvelope({ idempotencyKey: "idem_none", canonicalObjectKey: "cok_none" });
    const adapter = makeAdapter(async () => ok(null));

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("none");
  });

  it("adapter fault: a live existenceCheck error surfaces as {kind:'error'} — never silent 'none'", async () => {
    const store = new InMemoryReceiptStore();
    const env = makeEnvelope({ idempotencyKey: "idem_err", canonicalObjectKey: "cok_err" });
    const adapter = makeAdapter(async () =>
      err<AdapterError>({ code: "unreachable", message: "vendor down" }),
    );

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.error.code).toBe("unreachable");
  });

  it("replay takes precedence over a prior-write object hit (order is (a) before (b))", async () => {
    const store = new InMemoryReceiptStore();
    const replayReceipt: WriteReceipt = makeWriteReceipt({ externalObjectId: "ext_replay" });
    await store.put(
      makeReceiptRecord({
        idempotencyKey: "idem_shared",
        canonicalObjectKey: "cok_shared",
        receipt: replayReceipt,
      }),
    );
    const env = makeEnvelope({ idempotencyKey: "idem_shared", canonicalObjectKey: "cok_shared" });
    const adapter = makeAdapter(async () => ok(null));

    const res = await resolveExisting(env, adapter, store);
    expect(res.kind).toBe("replay");
  });
});
