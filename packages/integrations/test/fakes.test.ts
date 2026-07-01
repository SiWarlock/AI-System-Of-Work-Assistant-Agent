// TDD (red-first) for test/support/fakes.ts — the in-memory doubles every
// downstream §8 slice imports. Asserts each fake satisfies its interface (compile-
// time, via typed local bindings) and round-trips get/put with the exact @sow/db
// Result shapes + the ReceiptStore's undefined-on-miss contract.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type {
  OutboxRepository,
  ConnectorCursorRepository,
  ReceiptStore,
} from "../src/ports/persistence";
import {
  InMemoryReceiptStore,
  InMemoryOutbox,
  InMemoryConnectorCursors,
  makeProposedAction,
  makeEnvelope,
  makeWriteReceipt,
  makeReceiptRecord,
  makeOutboxEntry,
  makeCursorRecord,
} from "./support/fakes";

describe("InMemoryReceiptStore (implements ReceiptStore)", () => {
  it("round-trips by idempotencyKey AND canonicalObjectKey; miss → undefined", async () => {
    const store: ReceiptStore = new InMemoryReceiptStore();
    expect(await store.getByIdempotencyKey("nope")).toBeUndefined();
    expect(await store.getByCanonicalObjectKey("drive", "nope")).toBeUndefined();

    const rec = makeReceiptRecord();
    await store.put(rec);
    expect(await store.getByIdempotencyKey(rec.idempotencyKey)).toEqual(rec);
    expect(
      await store.getByCanonicalObjectKey(rec.targetSystem, rec.canonicalObjectKey),
    ).toEqual(rec);
    // Object index is targetSystem-scoped: same key, different system → miss.
    expect(await store.getByCanonicalObjectKey("github", rec.canonicalObjectKey)).toBeUndefined();
  });
});

describe("InMemoryOutbox (implements OutboxRepository)", () => {
  it("enqueue → get round-trips; unknown id → typed not_found", async () => {
    const outbox: OutboxRepository = new InMemoryOutbox();
    const miss = await outbox.get("outbox_1");
    expect(isErr(miss)).toBe(true);
    if (isErr(miss)) expect(miss.error.code).toBe("not_found");

    const entry = makeOutboxEntry();
    const enq = await outbox.enqueue(entry);
    expect(isOk(enq)).toBe(true);
    const got = await outbox.get(entry.outboxId);
    expect(isOk(got)).toBe(true);
    if (isOk(got)) expect(got.value).toEqual(entry);
  });

  it("getByIdempotencyKey is the replay gate — hit → ok, novel → not_found", async () => {
    const outbox = new InMemoryOutbox();
    const novel = await outbox.getByIdempotencyKey("idem_abc");
    expect(isErr(novel)).toBe(true);
    if (isErr(novel)) expect(novel.error.code).toBe("not_found");

    await outbox.enqueue(makeOutboxEntry({ idempotencyKey: "idem_abc" }));
    const hit = await outbox.getByIdempotencyKey("idem_abc");
    expect(isOk(hit)).toBe(true);
  });

  it("listDue excludes terminal + future-scheduled entries and orders by (enqueuedAt, outboxId)", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(
      makeOutboxEntry({ outboxId: "b", idempotencyKey: "i_b", enqueuedAt: "2026-06-30T00:00:02Z" }),
    );
    await outbox.enqueue(
      makeOutboxEntry({ outboxId: "a", idempotencyKey: "i_a", enqueuedAt: "2026-06-30T00:00:01Z" }),
    );
    // terminal — excluded
    await outbox.enqueue(
      makeOutboxEntry({ outboxId: "done", idempotencyKey: "i_done", status: "receipt_recorded" }),
    );
    // backoff into the future — excluded at now
    await outbox.enqueue(
      makeOutboxEntry({
        outboxId: "later",
        idempotencyKey: "i_later",
        nextAttemptAt: "2026-06-30T01:00:00Z",
      }),
    );

    const due = await outbox.listDue("2026-06-30T00:00:05Z", 10);
    expect(isOk(due)).toBe(true);
    if (isOk(due)) {
      expect(due.value.map((e) => e.outboxId)).toEqual(["a", "b"]);
    }
  });

  it("listDue honors the limit", async () => {
    const outbox = new InMemoryOutbox();
    await outbox.enqueue(makeOutboxEntry({ outboxId: "a", idempotencyKey: "i_a", enqueuedAt: "1" }));
    await outbox.enqueue(makeOutboxEntry({ outboxId: "b", idempotencyKey: "i_b", enqueuedAt: "2" }));
    const due = await outbox.listDue("9", 1);
    if (isOk(due)) expect(due.value).toHaveLength(1);
  });

  it("update replaces an existing entry; missing → not_found", async () => {
    const outbox = new InMemoryOutbox();
    const missing = await outbox.update(makeOutboxEntry());
    expect(isErr(missing)).toBe(true);

    await outbox.enqueue(makeOutboxEntry());
    const updated = await outbox.update(makeOutboxEntry({ status: "dispatched", attempts: 1 }));
    expect(isOk(updated)).toBe(true);
    const got = await outbox.get("outbox_1");
    if (isOk(got)) expect(got.value.status).toBe("dispatched");
  });
});

describe("InMemoryConnectorCursors (implements ConnectorCursorRepository)", () => {
  it("upsert → get round-trips; absent → not_found; listByConnector filters", async () => {
    const cursors: ConnectorCursorRepository = new InMemoryConnectorCursors();
    const miss = await cursors.get("todoist", "employer-work");
    expect(isErr(miss)).toBe(true);

    await cursors.upsert(makeCursorRecord({ cursor: "cur_1" }));
    const got = await cursors.get("todoist", "employer-work");
    expect(isOk(got)).toBe(true);
    if (isOk(got)) expect(got.value.cursor).toBe("cur_1");

    // upsert advances the SAME (connector, workspace) cursor.
    await cursors.upsert(makeCursorRecord({ cursor: "cur_2" }));
    const advanced = await cursors.get("todoist", "employer-work");
    if (isOk(advanced)) expect(advanced.value.cursor).toBe("cur_2");

    await cursors.upsert(makeCursorRecord({ workspaceId: "personal-business" }));
    const listed = await cursors.listByConnector("todoist");
    if (isOk(listed)) expect(listed.value).toHaveLength(2);
  });
});

describe("builders produce gate-valid shapes", () => {
  it("makeProposedAction / makeEnvelope / makeWriteReceipt carry the required keys", () => {
    const action = makeProposedAction();
    expect(action.canonicalObjectKey.length).toBeGreaterThan(0);
    expect(action.idempotencyKey.length).toBeGreaterThan(0);

    const env = makeEnvelope();
    expect(env.actionId).toBe(action.actionId);
    expect(env.canonicalObjectKey).toBe(action.canonicalObjectKey);

    const receipt = makeWriteReceipt();
    expect(receipt.externalObjectId.trim().length).toBeGreaterThan(0);
  });
});
