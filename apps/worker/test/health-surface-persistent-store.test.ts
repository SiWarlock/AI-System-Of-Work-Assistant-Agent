// Worker composition SAFETY (9.4b follow-up): the degraded controller's System-Health
// surface must PERSIST to the SAME `health_items` table the `systemHealth` query reads —
// otherwise a Temporal-unavailable `worker_down` item is written to process memory and
// the renderer's "System health" section shows a false "All systems healthy" (the exact
// gap the reverted `135bd58` left). `createPersistentHealthSurfaceStore` bridges the
// rich §10.3 HealthSurfaceStore port onto the persistent bare HealthItemStore adapter,
// so a `surface.record(...)` lands where `backends.healthItems.list()` reads it.
//
// Load-bearing behaviors pinned here (over REAL migrated in-memory sqlite):
//   • a recorded worker_down failure is READABLE via the query's read path (list());
//   • a recurring outage bumps ONE deduped row (never a duplicate);
//   • auto-resolve on reconnect flips the SAME row to resolved (truth, not stale alarm);
//   • the wrapper preserves the frozen HealthItem (openedAt + subjectRef honest);
//   • a real DbError under the wrapper FAILS CLOSED (rejects — never a silent drop).
import { describe, it, expect, afterEach } from "vitest";
import { auditId } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem } from "@sow/contracts";
import type { HealthItemRepository } from "@sow/db";
import { openDatabase, type OpenDatabase } from "../src/composition/backends";
import {
  createHealthItemStoreAdapter,
  createPersistentHealthSurfaceStore,
} from "../src/composition/store-adapters";
import { createHealthSurface, type SurfacedHealthItem } from "../src/health/surface";

const NOW = "2026-07-03T00:00:00.000Z";
const LATER = "2026-07-03T00:05:00.000Z";
const AUDIT: AuditId = auditId("worker-boot:temporal-degraded");

const opened: OpenDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.conn.close();
});
async function freshDb(): Promise<OpenDatabase> {
  const o = await openDatabase({ dbPath: ":memory:" });
  opened.push(o);
  return o;
}

/** A materializer-shaped HealthItem: id === `${failureClass}|${subjectRef}` (dedupe key IS the id). */
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

describe("createPersistentHealthSurfaceStore — degraded health persists to the query's table", () => {
  it("a worker_down failure recorded through the surface is READABLE via the same healthItems.list() the systemHealth query uses", async () => {
    const o = await freshDb();
    const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const surface = createHealthSurface(createPersistentHealthSurfaceStore(healthItems));

    const rec = await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "Temporal server unreachable — dispatch is held.",
      auditRef: AUDIT,
      now: NOW,
    });
    expect(rec.ok).toBe(true);

    // The QUERY read path: systemHealth.healthItems() → backends.healthItems.list().
    const items = await healthItems.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("worker_down|temporal:default");
    expect(items[0]?.failureClass).toBe("worker_down");
    expect(items[0]?.state).toBe("open");
  });

  it("a recurring outage bumps ONE deduped item — never a duplicate row", async () => {
    const o = await freshDb();
    const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const surface = createHealthSurface(createPersistentHealthSurfaceStore(healthItems));

    const first = await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "first",
      auditRef: AUDIT,
      now: NOW,
    });
    const again = await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "second",
      auditRef: AUDIT,
      now: LATER,
    });
    expect(first.ok && again.ok).toBe(true);

    const items = await healthItems.list();
    expect(items).toHaveLength(1); // deduped by (worker_down, temporal:default) — not two rows
    expect(items[0]?.state).toBe("open");
    expect(items[0]?.openedAt).toBe(NOW); // openedAt preserved across the recurrence
  });

  it("auto-resolve on reconnect flips the SAME row to resolved (the query sees truth, not a stale alarm)", async () => {
    const o = await freshDb();
    const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const surface = createHealthSurface(createPersistentHealthSurfaceStore(healthItems));

    await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "down",
      auditRef: AUDIT,
      now: NOW,
    });
    const resolved = await surface.resolve({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      now: LATER,
    });
    expect(resolved.ok).toBe(true);

    const items = await healthItems.list();
    expect(items).toHaveLength(1); // still one row — resolve is an in-place lifecycle transition
    expect(items[0]?.state).toBe("resolved");
  });

  it("getByDedupeKey wraps the persisted frozen item (dedupeKey + subjectRef + openedAt honest)", async () => {
    const o = await freshDb();
    const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const store = createPersistentHealthSurfaceStore(healthItems);
    // Persist a structured-subjectRef item so subjectRef recovery (split on the first
    // failureClass-prefixed delimiter, not every '|') is exercised.
    await healthItems.put(materializedItem("schema_rejection", "ws-a|thing-1"));

    const got = await store.getByDedupeKey("schema_rejection|ws-a|thing-1");
    expect(got).toBeDefined();
    expect(got?.dedupeKey).toBe("schema_rejection|ws-a|thing-1");
    expect(got?.subjectRef).toBe("ws-a|thing-1");
    expect(got?.item.openedAt).toBe(NOW);
    expect(got?.item.state).toBe("open");
  });

  it("getByDedupeKey on an unseen key is a MISS (undefined), never a throw", async () => {
    const o = await freshDb();
    const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
    const store = createPersistentHealthSurfaceStore(healthItems);
    expect(await store.getByDedupeKey("worker_down|never-seen")).toBeUndefined();
  });

  it("FAILS CLOSED: a real DbError under the wrapper REJECTS (never a silently dropped health item)", async () => {
    const faulting: HealthItemRepository = {
      getByDedupeKey: () => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } }),
      put: () => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } }),
      list: () => Promise.resolve({ ok: false, error: { code: "unavailable", message: "db down" } }),
    };
    const healthItems = createHealthItemStoreAdapter(faulting, () => NOW);
    const store = createPersistentHealthSurfaceStore(healthItems);

    const record: SurfacedHealthItem = {
      dedupeKey: "worker_down|temporal:default",
      subjectRef: "temporal:default",
      item: materializedItem("worker_down", "temporal:default"),
      openedAt: NOW,
      lastSeen: NOW,
      occurrenceCount: 1,
    };
    await expect(store.put(record)).rejects.toThrow(/unavailable/);
    await expect(store.list()).rejects.toThrow(/unavailable/);
    await expect(store.getByDedupeKey("k")).rejects.toThrow(/unavailable/);
  });
});
