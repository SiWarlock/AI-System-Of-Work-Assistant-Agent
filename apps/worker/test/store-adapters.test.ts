// Worker composition SAFETY: the operational-truth store adapters faithfully map the
// @sow/db repositories onto the @sow/workflows persistence ports, over a REAL migrated
// in-memory sqlite. The load-bearing behaviors:
//   • HealthItemStore — a re-put under the same materializer dedupe id UPSERTS (one
//     row, refreshed), and subjectRef is recovered from item.id even when it contains
//     the `|` delimiter (a structured subjectRef).
//   • ScheduleStore — bookkeeping round-trips (get miss → undefined; put → get).
//   • InstanceLeaseStore — first-acquire wins; a stale-expected CAS loses (ok(false),
//     never a throw); a matched-expected renew wins.
//   • Every port's fault path fails closed (a real DbError REJECTS — never a silent
//     wrong answer).
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, auditId } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem } from "@sow/contracts";
import type {
  HealthItemRepository,
  ScheduleBookkeepingRepository,
  InstanceLeaseRepository,
  DbResult,
} from "@sow/db";
import type { LeaseRecord } from "@sow/workflows/ports/operational";
import { openDatabase, type OpenDatabase } from "../src/composition/backends";
import {
  createHealthItemStoreAdapter,
  createScheduleStoreAdapter,
  createInstanceLeaseStoreAdapter,
} from "../src/composition/store-adapters";

const NOW = "2026-07-02T00:00:00.000Z";
const AUDIT: AuditId = auditId("audit-1");

// --- real migrated in-memory sqlite (genesis-migrated repos) ----------------
const opened: OpenDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.conn.close();
});
async function freshDb(): Promise<OpenDatabase> {
  const o = await openDatabase({ dbPath: ":memory:" });
  opened.push(o);
  return o;
}

/**
 * Build a HealthItem the way the §9 materializer does: id === `${failureClass}|
 * ${subjectRef}` (the dedupe key IS the id). The adapter must recover subjectRef by
 * stripping the `${failureClass}|` prefix — even when subjectRef itself contains `|`.
 */
function materializedItem(
  failureClass: FailureClass,
  subjectRef: string,
  over: Partial<HealthItem> = {},
): HealthItem {
  return {
    id: `${failureClass}|${subjectRef}`,
    failureClass,
    severity: "warn",
    message: "boom",
    auditRef: AUDIT,
    openedAt: NOW,
    state: "open",
    ...over,
  };
}

// ── (a) HealthItemStore adapter ─────────────────────────────────────────────

describe("createHealthItemStoreAdapter — sqlite-backed §9 health store", () => {
  it("persists an item and reads it back by its dedupe key (id)", async () => {
    const o = await freshDb();
    const store = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const item = materializedItem("worker_down", "wf-1");
    await store.put(item);

    const got = await store.getByDedupeKey(item.id);
    expect(got).toBeDefined();
    expect(got?.id).toBe(item.id);
    expect(got?.failureClass).toBe("worker_down");
    expect(got?.state).toBe("open");
  });

  it("a re-put under the SAME dedupe id UPSERTS (one row, refreshed) — no duplicate", async () => {
    const o = await freshDb();
    const store = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const first = materializedItem("worker_down", "wf-1", { message: "first" });
    await store.put(first);
    // A recurrence: same (failureClass, subjectRef) → same id → UPSERT (refresh message).
    const again = materializedItem("worker_down", "wf-1", { message: "second" });
    await store.put(again);

    const all = await store.list();
    const mine = all.filter((h) => h.id === first.id);
    expect(mine).toHaveLength(1); // deduped — NOT two rows
    expect(mine[0]?.message).toBe("second"); // latest observation refreshed
  });

  it("recovers subjectRef from an id whose subjectRef itself contains '|'", async () => {
    // The materializer id is `${failureClass}|${subjectRef}`; a structured subjectRef
    // (`ws|thing`) yields an id with TWO delimiters. Splitting on the failureClass
    // prefix (not every '|') keeps the dedupe correct: a put + a distinct put under a
    // DIFFERENT structured subjectRef must land as TWO rows, not collide.
    const o = await freshDb();
    const store = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const a = materializedItem("schema_rejection", "ws-a|thing-1");
    const b = materializedItem("schema_rejection", "ws-a|thing-2");
    await store.put(a);
    await store.put(b);

    expect(await store.getByDedupeKey(a.id)).toBeDefined();
    expect(await store.getByDedupeKey(b.id)).toBeDefined();
    expect(a.id).not.toBe(b.id); // distinct subjectRefs → distinct dedupe keys
    const all = await store.list();
    expect(all.filter((h) => h.failureClass === "schema_rejection")).toHaveLength(2);
  });

  it("getByDedupeKey on an unseen key is a MISS (undefined), never a throw", async () => {
    const o = await freshDb();
    const store = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    expect(await store.getByDedupeKey("worker_down|never-seen")).toBeUndefined();
  });

  it("FAILS CLOSED: a real DbError on put REJECTS (never a silently dropped failure item)", async () => {
    const faulting: HealthItemRepository = {
      getByDedupeKey: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
      put: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
      list: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
    };
    const store = createHealthItemStoreAdapter(faulting, () => NOW);
    await expect(store.put(materializedItem("worker_down", "wf-1"))).rejects.toThrow(/unavailable/);
    await expect(store.list()).rejects.toThrow(/unavailable/);
    // A genuine (non-not_found) lookup fault also REJECTS — it is not a miss.
    await expect(store.getByDedupeKey("k")).rejects.toThrow(/unavailable/);
  });
});

// ── (b) ScheduleStore adapter ───────────────────────────────────────────────

describe("createScheduleStoreAdapter — sqlite-backed LIFE-5 bookkeeping", () => {
  it("get on a never-run schedule is undefined; put → get round-trips", async () => {
    const o = await freshDb();
    const store = createScheduleStoreAdapter(o.repos.scheduleBookkeeping);
    expect(await store.getBookkeeping("sched-1")).toBeUndefined();

    await store.put({
      scheduleId: "sched-1",
      lastRunWall: NOW,
      lastRunMonotonicMs: 42,
      lastRunMonotonicEpoch: "epoch-A",
    });
    const got = await store.getBookkeeping("sched-1");
    expect(got).toEqual({
      scheduleId: "sched-1",
      lastRunWall: NOW,
      lastRunMonotonicMs: 42,
      lastRunMonotonicEpoch: "epoch-A",
    });
  });

  it("a put advances the last-run readings (upsert on scheduleId)", async () => {
    const o = await freshDb();
    const store = createScheduleStoreAdapter(o.repos.scheduleBookkeeping);
    await store.put({ scheduleId: "sched-1", lastRunWall: NOW });
    await store.put({ scheduleId: "sched-1", lastRunWall: "2026-07-03T00:00:00.000Z" });
    const got = await store.getBookkeeping("sched-1");
    expect(got?.lastRunWall).toBe("2026-07-03T00:00:00.000Z");
    expect(got?.lastRunMonotonicMs).toBeUndefined(); // first-run/wall-only preserved
  });

  it("FAILS CLOSED: a real DbError on getBookkeeping REJECTS (a miss would be a wrong answer)", async () => {
    const faulting: ScheduleBookkeepingRepository = {
      getBookkeeping: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
      put: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
    };
    const store = createScheduleStoreAdapter(faulting);
    await expect(store.getBookkeeping("s")).rejects.toThrow(/unavailable/);
    await expect(store.put({ scheduleId: "s", lastRunWall: NOW })).rejects.toThrow(/unavailable/);
  });
});

// ── (c) InstanceLeaseStore adapter ──────────────────────────────────────────

const lease = (over: Partial<LeaseRecord> = {}): LeaseRecord => ({
  taskQueue: "tq-1",
  ownerId: "owner-A",
  acquiredAt: NOW,
  expiresAt: "2026-07-02T00:05:00.000Z",
  generation: 1,
  ...over,
});

describe("createInstanceLeaseStoreAdapter — sqlite-backed LIFE-1 lease CAS", () => {
  it("first acquire wins (expected undefined against an empty slot)", async () => {
    const o = await freshDb();
    const store = createInstanceLeaseStoreAdapter(o.repos.instanceLeases);
    expect(await store.get("tq-1")).toBeUndefined();

    const won = await store.compareAndSet(undefined, lease());
    expect(won).toBe(true);

    const held = await store.get("tq-1");
    expect(held?.ownerId).toBe("owner-A");
    expect(held?.generation).toBe(1);
  });

  it("a second first-acquire against a now-occupied slot LOSES (ok(false), not a throw)", async () => {
    const o = await freshDb();
    const store = createInstanceLeaseStoreAdapter(o.repos.instanceLeases);
    expect(await store.compareAndSet(undefined, lease({ ownerId: "owner-A" }))).toBe(true);
    // Another instance tries a first-acquire (expected undefined) on the taken slot.
    const lost = await store.compareAndSet(undefined, lease({ ownerId: "owner-B", generation: 2 }));
    expect(lost).toBe(false); // contention is a boolean verdict, never a throw
    // The original holder is untouched.
    expect((await store.get("tq-1"))?.ownerId).toBe("owner-A");
  });

  it("a renew whose expected MATCHES the stored record wins; a stale expected LOSES", async () => {
    const o = await freshDb();
    const store = createInstanceLeaseStoreAdapter(o.repos.instanceLeases);
    const held = lease();
    expect(await store.compareAndSet(undefined, held)).toBe(true);

    // Matched-expected renew (same owner, bump generation + expiry) → WIN.
    const renewed = lease({ generation: 2, expiresAt: "2026-07-02T00:10:00.000Z" });
    expect(await store.compareAndSet(held, renewed)).toBe(true);
    expect((await store.get("tq-1"))?.generation).toBe(2);

    // A STALE expected (the pre-renew record) no longer matches → LOSE (no double-grant).
    const stale = await store.compareAndSet(held, lease({ ownerId: "owner-C", generation: 3 }));
    expect(stale).toBe(false);
    expect((await store.get("tq-1"))?.ownerId).toBe("owner-A"); // renewed holder retained
  });

  it("FAILS CLOSED: a real DbError on compareAndSet REJECTS (never a coerced true/false)", async () => {
    const faulting: InstanceLeaseRepository = {
      get: () => Promise.resolve(err({ code: "unavailable", message: "db down" })),
      compareAndSet: (): DbResult<boolean> =>
        Promise.resolve(err({ code: "unavailable", message: "db down" })),
    };
    const store = createInstanceLeaseStoreAdapter(faulting);
    await expect(store.compareAndSet(undefined, lease())).rejects.toThrow(/unavailable/);
    await expect(store.get("tq-1")).rejects.toThrow(/unavailable/);
  });

  it("contention (ok(false)) passes straight through as false — distinct from a fault", async () => {
    // A repo that reports LOSS as ok(false) (the normal CAS-lost verdict) must yield
    // false, NOT a rejection — only a real DbError rejects.
    const contended: InstanceLeaseRepository = {
      get: () => Promise.resolve(err({ code: "not_found", message: "miss" })),
      compareAndSet: (): DbResult<boolean> => Promise.resolve(ok(false)),
    };
    const store = createInstanceLeaseStoreAdapter(contended);
    expect(await store.compareAndSet(undefined, lease())).toBe(false);
    expect(await store.get("tq-1")).toBeUndefined(); // not_found → undefined, not a throw
  });
});
