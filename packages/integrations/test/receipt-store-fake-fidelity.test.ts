// @sow/integrations — the FAKE-vs-SHIPPED-STORE fidelity pins.
//
// ⛔ WHY THIS FILE EXISTS. `InMemoryReceiptStore` backs essentially every §8 Tool
// Gateway test. It used to keep a separate `byIdem` map that ACCUMULATED every
// historical idempotencyKey, while the shipped store keeps EXACTLY ONE ROW per
// object identity:
//
//     write_receipts PRIMARY KEY (targetSystem, canonicalObjectKey)
//     put() = onConflictDoUpdate(target: [targetSystem, canonicalObjectKey],
//                                set: { idempotencyKey, payloadHash, receipt, recordedAt })
//     — packages/db/src/adapters/sqlite/index.ts ~:1373-1391
//
// So in production a second receipt for the same object OVERWRITES the row and the
// previous idempotencyKey stops being findable. In the fake it stayed findable
// forever.
//
// That divergence is not academic: a change to the gateway's write path was verified
// against 918 passing tests and shipped a broken §20.1 replay gate — the mechanism
// safety rule 3 IS — because the fake answered a replay lookup that production would
// have missed. The suite was green because the fake was wrong.
//
// These pins exist so the fake cannot drift back. They assert the STORE SEMANTIC,
// not any gateway behaviour, and they should be read as the contract the fake owes
// the real adapter.
import { describe, it, expect } from "vitest";
import { InMemoryReceiptStore } from "./support/fakes";
import type { ReceiptRecord } from "../src/ports/persistence";

const RECEIPT = {
  externalObjectId: "obj_1",
  recordedAt: "2026-07-01T00:00:00.000Z",
} as const;

function record(idempotencyKey: string, payloadHash: string): ReceiptRecord {
  return {
    targetSystem: "drive",
    canonicalObjectKey: "cok:drive:project-a:00_brief",
    idempotencyKey,
    payloadHash,
    receipt: { ...RECEIPT },
    recordedAt: RECEIPT.recordedAt,
  } as unknown as ReceiptRecord;
}

describe("InMemoryReceiptStore — fidelity to the shipped write_receipts row semantics", () => {
  it("keeps ONE row per object identity — a second put REPLACES the first", async () => {
    const store = new InMemoryReceiptStore();
    await store.put(record("idem_first", "hash_a"));
    await store.put(record("idem_second", "hash_b"));

    expect(store.size()).toBe(1);
    const current = await store.getByCanonicalObjectKey(
      "drive" as never,
      "cok:drive:project-a:00_brief",
    );
    expect(current?.idempotencyKey).toBe("idem_second");
    expect(current?.payloadHash).toBe("hash_b");
  });

  it("EVICTS the superseded idempotencyKey — a replay of the old envelope MISSES", async () => {
    const store = new InMemoryReceiptStore();
    await store.put(record("idem_first", "hash_a"));
    expect(await store.getByIdempotencyKey("idem_first")).toBeDefined();

    // A newer write to the SAME object overwrites the row, taking the old key with it.
    await store.put(record("idem_second", "hash_b"));

    // ⛔ THE LOAD-BEARING ASSERTION. The old fake returned the record here, so a
    // gateway replay of a superseded envelope looked like a safe no-op in tests and
    // would have re-driven a real write in production.
    expect(await store.getByIdempotencyKey("idem_first")).toBeUndefined();
    expect(await store.getByIdempotencyKey("idem_second")).toBeDefined();
  });

  it("a DIFFERENT object keeps its own row and its own key", async () => {
    const store = new InMemoryReceiptStore();
    await store.put(record("idem_a", "hash_a"));
    const other = {
      ...record("idem_b", "hash_b"),
      canonicalObjectKey: "cok:drive:project-a:01_decisions",
    } as ReceiptRecord;
    await store.put(other);

    // Two objects ⇒ two rows; neither eviction affects the other. This is the
    // negative control: eviction is scoped to the object identity, not global.
    expect(store.size()).toBe(2);
    expect(await store.getByIdempotencyKey("idem_a")).toBeDefined();
    expect(await store.getByIdempotencyKey("idem_b")).toBeDefined();
  });

  it("a committed receipt supersedes a reservation for the same object", async () => {
    const store = new InMemoryReceiptStore();
    await store.put(record("idem_first", "hash_a"));
    const reservation = await store.reserve("drive" as never, "cok:drive:project-a:00_brief");
    expect(reservation.kind).toBe("committed");
  });
});
