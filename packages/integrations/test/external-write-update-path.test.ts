// @sow/integrations — the external-write UPDATE path, and the four hazards that
// reverted it twice. `docs/findings/external-write-update-path.md` is the record.
//
// THE BUG BEING FIXED: `TargetWriteAdapter.update` had ZERO callers, so every write
// was create-or-reuse. A NotebookLM re-sync with CHANGED bodies issued no vendor
// write at all, carried none of the new content, and reported `outcome: "synced"`.
// Edited notes never reached Drive and the caller was told the vault was in sync.
//
// Wiring that is the easy half. Each hazard below is a way the naive wiring turns a
// RECOVERABLE problem (stale content — re-sync fixes it) into an UNRECOVERABLE one
// (a duplicate write, a clobbered foreign object, a reverted document). The decision
// rule throughout: when they conflict, PREFER STALE.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WriteReceipt } from "@sow/contracts";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../src/tools/gateway";
import { recordReceipt, recordAdoptedObject } from "../src/tools/receipt-store";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import type { TargetWriteAdapter, AdapterError, ExistingObject } from "../src/tools/adapter-port";
import type { ReceiptStore } from "../src/ports/persistence";
import { InMemoryReceiptStore, makeProposedAction } from "./support/fakes";

const COK = "cok:drive:project-a:00_brief";
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-01T01:00:00.000Z";
const T2 = "2026-07-01T02:00:00.000Z";
const clockAt = (t: string) => (): string => t;

/** A linked envelope+action pair carrying a specific payload hash. */
function pair(idempotencyKey: string, payload: Record<string, unknown>) {
  const action = makeProposedAction({ targetSystem: "drive", canonicalObjectKey: COK, idempotencyKey, payload });
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return { action, env: built.value };
}

interface Spy {
  readonly adapter: TargetWriteAdapter;
  readonly creates: () => number;
  readonly updates: () => number;
  readonly updatedPayloads: () => Record<string, unknown>[];
}

/** `probeFinds` — what the LIVE vendor probe reports (null = no such object). */
function spyAdapter(probeFinds: ExistingObject | null = null, updateFault?: AdapterError): Spy {
  let creates = 0;
  const updatedPayloads: Record<string, unknown>[] = [];
  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    async existenceCheck(): Promise<Result<ExistingObject | null, AdapterError>> {
      return ok(probeFinds);
    },
    async create(): Promise<Result<WriteReceipt, AdapterError>> {
      creates += 1;
      return ok({ externalObjectId: "ext-created", recordedAt: T0 });
    },
    async update(_env, payload): Promise<Result<WriteReceipt, AdapterError>> {
      if (updateFault !== undefined) return err(updateFault);
      updatedPayloads.push(payload);
      return ok({ externalObjectId: "ext-created", recordedAt: T1 });
    },
  };
  return { adapter, creates: () => creates, updates: () => updatedPayloads.length, updatedPayloads: () => updatedPayloads };
}

function depsOver(store: ReceiptStore, adapter: TargetWriteAdapter, at = T0): ExternalWriteDeps {
  return {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock: clockAt(at),
  };
}

describe("external-write UPDATE path — the bug it fixes", () => {
  it("a re-dispatch with CHANGED content now UPDATES the vendor object (it used to silently write nothing)", async () => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();

    const first = pair("idem-1", { body: "original" });
    expect((await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0))).status).toBe(
      "created",
    );

    const second = pair("idem-2", { body: "EDITED" });
    const res = await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1));

    expect(res.status).toBe("updated");
    expect(spy.updates()).toBe(1);
    expect(spy.updatedPayloads()[0]).toEqual({ body: "EDITED" });
    // Exactly ONE vendor object — an update, never a second create.
    expect(spy.creates()).toBe(1);
  });

  it("a re-dispatch with the SAME content writes nothing and reuses (idempotent, no churn)", async () => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const first = pair("idem-1", { body: "same" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));

    // A DIFFERENT idempotencyKey but an IDENTICAL payload ⇒ identical payloadHash.
    const again = pair("idem-2", { body: "same" });
    const res = await dispatchExternalWrite(again.env, again.action, depsOver(store, spy.adapter, T1));

    expect(res.status).toBe("reused");
    expect(spy.updates()).toBe(0);
    expect(spy.creates()).toBe(1);
  });
});

describe("C3 ORDERING — a stale re-drive must never REVERT the document", () => {
  it("a re-drive whose intent PREDATES the applied payload is SUPERSEDED and writes nothing", async () => {
    // The measured C3 scenario: an update is held during an outage; a fresher body
    // lands meanwhile; the outbox then drains the OLD entry. Applying it would write
    // the old bytes back over the new ones.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();

    const create = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(create.env, create.action, depsOver(store, spy.adapter, T0));
    // A NEWER body lands at T2.
    const fresh = pair("idem-3", { body: "v3-fresh" });
    await dispatchExternalWrite(fresh.env, fresh.action, depsOver(store, spy.adapter, T2));
    expect(spy.updates()).toBe(1);

    // Now the STALE entry drains. Its intent was created at T1 — BEFORE the T2 write.
    const stale = pair("idem-2", { body: "v2-stale" });
    const res = await dispatchExternalWrite(stale.env, stale.action, depsOver(store, spy.adapter, T2), {
      intentCreatedAt: T1,
    });

    expect(res.status).toBe("superseded");
    expect(spy.updates()).toBe(1); // unchanged — the revert did NOT happen
    expect(spy.updatedPayloads()).toEqual([{ body: "v3-fresh" }]);
  });

  it("a re-drive whose intent is NEWER than the applied payload still applies", async () => {
    // Non-vacuity: the ordering guard must not simply block every re-drive, which
    // would silently break the outbox hold (inv-4: held, never dropped).
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const create = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(create.env, create.action, depsOver(store, spy.adapter, T0));

    const held = pair("idem-2", { body: "v2" });
    const res = await dispatchExternalWrite(held.env, held.action, depsOver(store, spy.adapter, T2), {
      intentCreatedAt: T1, // created AFTER the T0 write ⇒ genuinely newer
    });

    expect(res.status).toBe("updated");
    expect(spy.updatedPayloads()).toEqual([{ body: "v2" }]);
  });

  it("a FRESH dispatch supplies no intent time and is never superseded", async () => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const create = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(create.env, create.action, depsOver(store, spy.adapter, T2));

    const next = pair("idem-2", { body: "v2" });
    const res = await dispatchExternalWrite(next.env, next.action, depsOver(store, spy.adapter, T2));
    expect(res.status).toBe("updated");
  });
});

describe("C4/C5 AUTHORSHIP — never update an object this system did not write", () => {
  it("an ADOPTED object (found by the live probe) is NEVER updated, even with changed content", async () => {
    // Attempt 1 persisted a receipt carrying `env.payloadHash` for a payload never
    // written, so the NEXT changed-content dispatch read "we own this" and updated a
    // FOREIGN object. The adopted row still carries that intended hash — authorship
    // is decided by the LEDGER, which adoption never writes to.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter({ externalObjectId: "ext-someone-elses" });

    // First dispatch: the live probe finds a foreign object ⇒ adopt, no write.
    const first = pair("idem-1", { body: "ours" });
    expect((await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0))).status).toBe(
      "reused",
    );
    expect(spy.creates()).toBe(0);
    expect(spy.updates()).toBe(0);

    // Second dispatch with DIFFERENT content: the hash differs from the adopted
    // row's, which looks exactly like an update intent — and must be refused.
    const second = pair("idem-2", { body: "DIFFERENT" });
    const res = await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1));

    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.reason).toContain("not authored by this system");
    expect(spy.updates()).toBe(0); // the foreign object was NOT clobbered
  });

  it("an AUTHORED object IS updated — the guard is not a blanket refusal", async () => {
    // Non-vacuity for the pin above: without this, a guard that refused everything
    // would pass it.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const first = pair("idem-1", { body: "ours" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));

    const second = pair("idem-2", { body: "DIFFERENT" });
    expect((await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1))).status).toBe(
      "updated",
    );
    expect(spy.updates()).toBe(1);
  });

  it("a store with NO ledger cannot prove authorship, so it refuses to update (fails closed)", async () => {
    const base = new InMemoryReceiptStore();
    const legacy: ReceiptStore = {
      getByIdempotencyKey: (k) => base.getByIdempotencyKey(k),
      getByCanonicalObjectKey: (t, k) => base.getByCanonicalObjectKey(t, k),
      reserve: (t, k) => base.reserve(t, k),
      release: (t, k) => base.release(t, k),
      put: (r) => base.put(r),
    };
    const spy = spyAdapter();
    const first = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(first.env, first.action, depsOver(legacy, spy.adapter, T0));

    const second = pair("idem-2", { body: "v2" });
    const res = await dispatchExternalWrite(second.env, second.action, depsOver(legacy, spy.adapter, T1));
    expect(res.status).toBe("rejected");
    expect(spy.updates()).toBe(0);
  });

  it("the authorship guard runs on the LEDGER, not on the object row's payloadHash", async () => {
    // Direct proof of the mechanism: an object row written by `recordAdoptedObject`
    // and one written by `recordReceipt` are byte-identical apart from the ledger.
    const adoptedStore = new InMemoryReceiptStore();
    const authoredStore = new InMemoryReceiptStore();
    const { env } = pair("idem-x", { body: "v1" });
    const receipt: WriteReceipt = { externalObjectId: "ext", recordedAt: T0 };
    await recordAdoptedObject(adoptedStore, env, receipt, clockAt(T0));
    await recordReceipt(authoredStore, env, receipt, clockAt(T0));

    // Same object row…
    const a = await adoptedStore.getByCanonicalObjectKey(env.targetSystem, env.canonicalObjectKey);
    const b = await authoredStore.getByCanonicalObjectKey(env.targetSystem, env.canonicalObjectKey);
    expect(a).toEqual(b);
    // …different ledger, which is the ONLY thing that separates them.
    expect(await adoptedStore.getApplication(env.idempotencyKey)).toEqual({ kind: "miss" });
    expect((await authoredStore.getApplication(env.idempotencyKey)).kind).toBe("hit");
  });
});

describe("update FAULTS map exactly like create faults", () => {
  it.each([
    ["unreachable", "held"],
    ["conflict", "conflict"],
    ["rejected", "rejected"],
    ["not_found", "rejected"],
    ["unknown", "rejected"],
  ] as const)("an update %s fault ⇒ %s", async (code, expected) => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter(null, { code, message: `boom ${code}` });
    const first = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));

    const second = pair("idem-2", { body: "v2" });
    const res = await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1));
    expect(res.status).toBe(expected);
    if (res.status === "created" || res.status === "updated" || res.status === "reused") return;
    if (res.status === "approval_pending") return;
    // The closed adapter code rides its own field — a caller never parses `reason`.
    if (res.status !== "superseded") expect(res.adapterCode).toBe(code);
  });

  it("a failed update persists NOTHING — the previous receipt and ledger stand", async () => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter(null, { code: "unreachable", message: "vendor down" });
    const first = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));

    const second = pair("idem-2", { body: "v2" });
    expect((await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1))).status).toBe(
      "held",
    );
    // The object row still describes the FIRST write…
    const row = await store.getByCanonicalObjectKey(second.env.targetSystem, COK);
    expect(row?.idempotencyKey).toBe("idem-1");
    // …and the failed envelope never entered the ledger.
    expect(await store.getApplication("idem-2")).toEqual({ kind: "miss" });
  });
});

describe("C1 — the replay gate survives an update (the eviction the ledger exists for)", () => {
  it("after an update, a replay of the ORIGINAL create envelope issues NO vendor write", async () => {
    // This is the scenario the ledger was built for, now reachable for real: with
    // `update` wired, arm (b) no longer short-circuits a changed-content dispatch,
    // so arm (a) is the only replay defence — and `put` evicted its key.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const first = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));
    const second = pair("idem-2", { body: "v2" });
    await dispatchExternalWrite(second.env, second.action, depsOver(store, spy.adapter, T1));
    expect(spy.updates()).toBe(1);

    // The object row has LOST the create's key…
    expect(await store.getByIdempotencyKey("idem-1")).toBeUndefined();
    // …but replaying that exact envelope must still be recognised, and must not
    // write anything — neither a create nor an update back to v1.
    const replay = await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T2));
    expect(replay.status).toBe("reused");
    expect(spy.creates()).toBe(1);
    expect(spy.updates()).toBe(1);
  });
});

describe("C2 CONCURRENCY — last-writer-wins, stated honestly rather than implied", () => {
  it("two concurrent updates BOTH reach the vendor: `reserve` guards CREATE only", async () => {
    // Attempt 2 documented a limit materially narrower than the real one. This pins
    // the ACTUAL behaviour so nobody has to rediscover it: `receiptStore.reserve`
    // returns `committed` for an object that already has a receipt, so it cannot
    // serialize two updates. Both land; the last one wins at the vendor.
    //
    // Accepted on the decision rule: the outcome is ONE object carrying one of two
    // legitimate payloads — recoverable by re-sync — not the create path's
    // duplicate-OBJECT hazard, which is not.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const first = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(first.env, first.action, depsOver(store, spy.adapter, T0));

    const a = pair("idem-a", { body: "from-A" });
    const b = pair("idem-b", { body: "from-B" });
    const [ra, rb] = await Promise.all([
      dispatchExternalWrite(a.env, a.action, depsOver(store, spy.adapter, T1)),
      dispatchExternalWrite(b.env, b.action, depsOver(store, spy.adapter, T1)),
    ]);

    expect([ra.status, rb.status]).toEqual(["updated", "updated"]);
    expect(spy.updates()).toBe(2); // BOTH reached the vendor — this is the limit
    expect(spy.creates()).toBe(1); // but still exactly ONE object
  });
});

describe("safety rule 3 end-to-end — the update path never issues a duplicate CREATE", () => {
  it("across create → update → replay → stale-redrive → concurrent pair, `create` is called exactly ONCE", async () => {
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const c = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(c.env, c.action, depsOver(store, spy.adapter, T0));
    const u = pair("idem-2", { body: "v2" });
    await dispatchExternalWrite(u.env, u.action, depsOver(store, spy.adapter, T1));
    await dispatchExternalWrite(c.env, c.action, depsOver(store, spy.adapter, T2)); // replay
    const stale = pair("idem-3", { body: "v0-stale" });
    await dispatchExternalWrite(stale.env, stale.action, depsOver(store, spy.adapter, T2), { intentCreatedAt: T0 });
    const p = pair("idem-4", { body: "v4" });
    const q = pair("idem-5", { body: "v5" });
    await Promise.all([
      dispatchExternalWrite(p.env, p.action, depsOver(store, spy.adapter, T2)),
      dispatchExternalWrite(q.env, q.action, depsOver(store, spy.adapter, T2)),
    ]);

    expect(spy.creates()).toBe(1);
  });
});

describe("the approval path — the THIRD re-drive, and the one nobody had named", () => {
  it("an approval whose envelope predates a newer write is SUPERSEDED, not applied", async () => {
    // `approvalFlow.ts` dispatches `input.context.envelope` — durable Temporal
    // workflow input held across a HUMAN decision, for days by design. Approve it
    // after a fresher sync landed and the naive path writes the OLD payload back.
    // Passing the approval's own creation time makes it a decidable case.
    const store = new InMemoryReceiptStore();
    const spy = spyAdapter();
    const create = pair("idem-1", { body: "v1" });
    await dispatchExternalWrite(create.env, create.action, depsOver(store, spy.adapter, T0));

    // The operator proposed this at T1; it sat pending.
    const proposed = pair("idem-approved", { body: "what-the-human-saw" });
    // Meanwhile a fresher sync landed at T2.
    const fresher = pair("idem-fresh", { body: "v-fresh" });
    await dispatchExternalWrite(fresher.env, fresher.action, depsOver(store, spy.adapter, T2));

    const res = await dispatchExternalWrite(proposed.env, proposed.action, depsOver(store, spy.adapter, T2), {
      intentCreatedAt: T1,
    });
    expect(res.status).toBe("superseded");
    expect(spy.updatedPayloads()).toEqual([{ body: "v-fresh" }]);
  });
});
