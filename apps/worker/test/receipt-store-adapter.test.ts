// Worker composition SAFETY: the ReceiptStore adapter faithfully maps the @sow/db
// WriteReceiptRepository onto the @sow/integrations ReceiptStore. The load-bearing
// invariant (safety rule 3 / inv-5): a COMMITTED reserve maps to {kind:"committed",
// record} so a replay REUSES the receipt and NEVER issues a second external create; a
// reserved-but-receiptless row is NOT a committed object (undefined), so the pre-write
// existence check can never treat a bare reservation as an existing write.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  WriteReceiptRepository,
  ReserveOutcome,
  WriteReceiptRow,
  DbResult,
} from "@sow/db";
import type { WriteReceipt } from "@sow/contracts";
import { createReceiptStoreAdapter } from "../src/composition/backends";

const RECEIPT: WriteReceipt = {
  externalObjectId: "ext-1",
  recordedAt: "2026-07-02T00:00:00.000Z",
};

const committedRow: WriteReceiptRow = {
  targetSystem: "todoist",
  canonicalObjectKey: "obj:1",
  idempotencyKey: "idem:1",
  payloadHash: "hash:1",
  receipt: RECEIPT,
  recordedAt: "2026-07-02T00:00:00.000Z",
};

// A reserved placeholder: a row WITH NO receipt (another worker mid-write).
const reservedRow: WriteReceiptRow = {
  targetSystem: "todoist",
  canonicalObjectKey: "obj:2",
  idempotencyKey: "idem:2",
  payloadHash: "hash:2",
  recordedAt: "2026-07-02T00:00:00.000Z",
  // receipt intentionally absent
};

/** A programmable fake WriteReceiptRepository. */
function fakeRepo(overrides: Partial<WriteReceiptRepository>): WriteReceiptRepository {
  const notFound = <T>(): DbResult<T> =>
    Promise.resolve(err({ code: "not_found", message: "miss" }));
  return {
    reserve: () => Promise.resolve(ok<ReserveOutcome>({ kind: "reserved" })),
    getByIdempotencyKey: notFound,
    getByCanonicalObjectKey: notFound,
    put: () => Promise.resolve(ok(undefined)),
    release: () => Promise.resolve(ok(undefined)),
    ...overrides,
  };
}

describe("ReceiptStore adapter — faithful @sow/db → @sow/integrations mapping", () => {
  it("a COMMITTED reserve maps to {kind:'committed', record} (replay reuses; no 2nd create)", async () => {
    const store = createReceiptStoreAdapter(
      fakeRepo({
        reserve: () => Promise.resolve(ok<ReserveOutcome>({ kind: "committed", record: committedRow })),
      }),
    );
    const res = await store.reserve("todoist" as never, "obj:1");
    expect(res.kind).toBe("committed");
    if (res.kind !== "committed") return;
    // The record carries the SAME receipt — the gateway short-circuits to reuse.
    expect(res.record.receipt.externalObjectId).toBe("ext-1");
    expect(res.record.idempotencyKey).toBe("idem:1");
    expect(res.record.canonicalObjectKey).toBe("obj:1");
  });

  it("a 'reserved' reserve maps 1:1 (this caller is the create winner)", async () => {
    const store = createReceiptStoreAdapter(fakeRepo({}));
    const res = await store.reserve("todoist" as never, "obj:x");
    expect(res.kind).toBe("reserved");
  });

  it("an 'in_progress' reserve maps 1:1 (another worker mid-write; caller must not create)", async () => {
    const store = createReceiptStoreAdapter(
      fakeRepo({ reserve: () => Promise.resolve(ok<ReserveOutcome>({ kind: "in_progress" })) }),
    );
    const res = await store.reserve("todoist" as never, "obj:y");
    expect(res.kind).toBe("in_progress");
  });

  it("a reserve FAULT fails closed to in_progress (never 'reserved' → never a duplicate create)", async () => {
    const store = createReceiptStoreAdapter(
      fakeRepo({ reserve: () => Promise.resolve(err({ code: "unavailable", message: "db down" })) }),
    );
    const res = await store.reserve("todoist" as never, "obj:z");
    expect(res.kind).toBe("in_progress");
  });

  it("getByCanonicalObjectKey on a COMMITTED row returns the record (existing object → reuse)", async () => {
    const store = createReceiptStoreAdapter(
      fakeRepo({ getByCanonicalObjectKey: () => Promise.resolve(ok(committedRow)) }),
    );
    const rec = await store.getByCanonicalObjectKey("todoist" as never, "obj:1");
    expect(rec).toBeDefined();
    expect(rec?.receipt.externalObjectId).toBe("ext-1");
  });

  it("getByCanonicalObjectKey on a RESERVED (receiptless) row returns undefined (a bare reservation is NOT an existing object)", async () => {
    const store = createReceiptStoreAdapter(
      fakeRepo({ getByCanonicalObjectKey: () => Promise.resolve(ok(reservedRow)) }),
    );
    const rec = await store.getByCanonicalObjectKey("todoist" as never, "obj:2");
    // A receiptless row must not surface — else the existence check would skip the create.
    expect(rec).toBeUndefined();
  });

  it("a not_found lookup is a MISS (undefined), never an error", async () => {
    const store = createReceiptStoreAdapter(fakeRepo({}));
    expect(await store.getByIdempotencyKey("nope")).toBeUndefined();
    expect(await store.getByCanonicalObjectKey("todoist" as never, "nope")).toBeUndefined();
  });

  it("put round-trips the ReceiptRecord onto a WriteReceiptRow faithfully", async () => {
    let seen: WriteReceiptRow | undefined;
    const store = createReceiptStoreAdapter(
      fakeRepo({
        put: (row) => {
          seen = row;
          return Promise.resolve(ok(undefined));
        },
      }),
    );
    await store.put({
      idempotencyKey: "idem:9",
      canonicalObjectKey: "obj:9",
      targetSystem: "todoist" as never,
      payloadHash: "hash:9",
      receipt: RECEIPT,
      recordedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(seen).toBeDefined();
    expect(seen?.idempotencyKey).toBe("idem:9");
    expect(seen?.canonicalObjectKey).toBe("obj:9");
    expect(seen?.receipt?.externalObjectId).toBe("ext-1");
  });
});
