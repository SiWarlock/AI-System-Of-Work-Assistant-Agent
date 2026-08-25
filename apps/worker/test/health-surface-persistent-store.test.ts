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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, afterEach } from "vitest";
import { auditId, isOk } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem } from "@sow/contracts";
import type { HealthItemRepository } from "@sow/db";
import { openDatabase, type OpenDatabase } from "../src/composition/backends";
import {
  createHealthItemStoreAdapter,
  createPersistentHealthSurfaceStore,
} from "../src/composition/store-adapters";
import {
  createHealthSurface,
  type SurfacedHealthItem,
  type HealthSurfaceStore,
} from "../src/health/surface";

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

// ── task 24.3 — the operator read-cursor axis survives a REAL store restart ──────────────
//
// The production persistence chain (`createPersistentHealthSurfaceStore` over
// `createHealthItemStoreAdapter`/`HealthItemRepository`) does NOT yet round-trip
// `lastReadAt` — `createPersistentHealthSurfaceStore.put` forwards only `record.item`
// (the frozen @sow/contracts HealthItem) to the repo, which has no `last_read_at`
// column (store-adapters.ts is PKG-W2's file; the @sow/db schema is further still —
// both are handed off in crossTerritoryNeeds). So THIS suite proves the SURFACE's own
// read-cursor logic (the new `markRead` command + `lastReadAt` bookkeeping in
// `createHealthSurface`, task 24.3's actual deliverable) is durably correct against a
// REAL on-disk sqlite file — closing and reopening the connection at the SAME path to
// simulate a worker restart, mirroring the `openDatabase` genesis/restart pattern in
// `schema-compat-gate.test.ts`. The full-item JSON persistence here is a minimal TEST
// FIXTURE, not a second production store — it does not touch/replace the real
// HealthItemRepository chain pinned above.
function openFileBackedHealthSurfaceStore(dbPath: string): {
  readonly store: HealthSurfaceStore;
  readonly close: () => void;
} {
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS surfaced_health_items (dedupe_key TEXT PRIMARY KEY, record_json TEXT NOT NULL)",
  );
  const store: HealthSurfaceStore = {
    async getByDedupeKey(dedupeKey: string): Promise<SurfacedHealthItem | undefined> {
      const row = db
        .prepare("SELECT record_json FROM surfaced_health_items WHERE dedupe_key = ?")
        .get(dedupeKey) as { record_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.record_json) as SurfacedHealthItem);
    },
    async put(record: SurfacedHealthItem): Promise<void> {
      db.prepare(
        "INSERT INTO surfaced_health_items (dedupe_key, record_json) VALUES (?, ?) " +
          "ON CONFLICT(dedupe_key) DO UPDATE SET record_json = excluded.record_json",
      ).run(record.dedupeKey, JSON.stringify(record));
    },
    async list(): Promise<SurfacedHealthItem[]> {
      const rows = db.prepare("SELECT record_json FROM surfaced_health_items").all() as {
        record_json: string;
      }[];
      return rows.map((r) => JSON.parse(r.record_json) as SurfacedHealthItem);
    },
  };
  return { store, close: () => db.close() };
}

/** Read one item back through the PUBLIC `HealthSurface.list()` surface (no direct getByDedupeKey on
 *  the port) — the same read path the panel's "reopen" would use. */
async function findByDedupeKey(
  surface: ReturnType<typeof createHealthSurface>,
  dedupeKey: string,
): Promise<SurfacedHealthItem | undefined> {
  const r = await surface.list();
  if (!isOk(r)) return undefined;
  return r.value.find((i) => i.dedupeKey === dedupeKey);
}

describe("HealthSurface — task 24.3 read-cursor (lastReadAt) survives a REAL sqlite-file restart", () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it("mints unread, reopening shows unread, mark-read persists, and a FULL close+reopen at the same file path keeps it read", async () => {
    dir = mkdtempSync(join(tmpdir(), "sow-health-read-cursor-"));
    const dbFile = join(dir, "health.db");

    // 1. Mint the item with the panel CLOSED (no UI action — just the failure occurring).
    const first = openFileBackedHealthSurfaceStore(dbFile);
    const surfaceA = createHealthSurface(first.store);
    const minted = await surfaceA.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "Temporal server unreachable — dispatch is held.",
      auditRef: AUDIT,
      now: NOW,
    });
    expect(isOk(minted)).toBe(true);

    // 2. "Reopen" the panel — a plain read; the item is PRESENT and UNREAD (lastReadAt absent).
    const afterOpen = await findByDedupeKey(surfaceA, "worker_down|temporal:default");
    expect(afterOpen).toBeDefined();
    expect(afterOpen?.lastReadAt).toBeUndefined();

    // 3. Mark it read.
    const marked = await surfaceA.markRead({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      now: LATER,
    });
    expect(isOk(marked)).toBe(true);
    if (isOk(marked)) expect(marked.value?.lastReadAt).toBe(LATER);
    first.close();

    // 4. RESTART: a fresh store instance over the SAME on-disk file (the connection was
    //    fully closed above — this is not the same in-memory object, a genuine reopen).
    const second = openFileBackedHealthSurfaceStore(dbFile);
    const surfaceB = createHealthSurface(second.store);
    const afterRestart = await findByDedupeKey(surfaceB, "worker_down|temporal:default");
    expect(afterRestart).toBeDefined();
    expect(afterRestart?.lastReadAt).toBe(LATER); // stays read across the restart
    second.close();
  });

  it("markRead on an item with no prior read is NOT a no-op re-stamp on a re-call (idempotent — same value returned)", async () => {
    dir = mkdtempSync(join(tmpdir(), "sow-health-read-cursor-idem-"));
    const dbFile = join(dir, "health.db");
    const { store, close } = openFileBackedHealthSurfaceStore(dbFile);
    const surface = createHealthSurface(store);
    await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "down",
      auditRef: AUDIT,
      now: NOW,
    });
    const firstMark = await surface.markRead({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      now: LATER,
    });
    const secondMark = await surface.markRead({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      now: "2026-07-03T00:10:00.000Z", // a LATER "now" — must NOT overwrite the original read stamp
    });
    expect(isOk(firstMark) && isOk(secondMark)).toBe(true);
    if (isOk(firstMark) && isOk(secondMark)) {
      expect(firstMark.value?.lastReadAt).toBe(LATER);
      expect(secondMark.value?.lastReadAt).toBe(LATER); // unchanged — idempotent, first read wins
    }
    close();
  });

  it("markRead on an item that does not exist is ok(undefined), never a throw", async () => {
    dir = mkdtempSync(join(tmpdir(), "sow-health-read-cursor-miss-"));
    const dbFile = join(dir, "health.db");
    const { store, close } = openFileBackedHealthSurfaceStore(dbFile);
    const surface = createHealthSurface(store);
    const r = await surface.markRead({
      failureClass: "worker_down",
      subjectRef: "never-seen",
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBeUndefined();
    close();
  });
});
