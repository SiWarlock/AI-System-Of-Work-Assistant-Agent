// Phase-2 task 2.10 / 2.9 — periodic op-DB backup + EXERCISED restore, DUAL-DIALECT.
//
// ARCHITECTURE §16 (Backup & recovery): "The operational DB and Temporal
// persistence are operational truth and not Git-backed → a periodic local backup
// (pre-migration backup is mandatory, §4) with documented restore." §4 names the
// NOT-rebuildable operational-truth set (event log / audit / approvals / outboxes
// / connector cursors) — restore is its recovery path. §16 also requires a TYPED
// result with explicit failure variants — nothing fails silently.
//
// DUAL-DIALECT (§12 / REQ-D-003): the backup + restore orchestrators are dialect-
// agnostic pure functions over injected ports, so the SAME recovery path is proven
// here over BOTH concrete engines — SQLite (better-sqlite3 `serialize`/deserialize
// over `new Database(':memory:')`) AND Postgres (`dumpDataDir`/`loadDataDir` over
// `new PGlite()` = in-process real PG16). Each case below runs for BOTH via
// `defineBackupSuite(fixture)`; no server is required. (The earlier note claiming pg
// was "exercised by the contract suite" was inaccurate — pg is exercised HERE.)
// BYTE-CONSISTENCY differs by dialect: SQLite `serialize()` is byte-stable so its
// round-trip is asserted byte-for-byte; a Postgres datadir dump is NOT byte-stable
// (tar/gzip headers vary) so ROW-digest consistency is the binding recovery
// invariant for both. The Docker-pg run is opt-in (SOW_PG_DOCKER=1), out of scope.
//
// Coverage (per dialect unless noted):
//   - periodic backup writes a real local artifact (size + digest + on-disk file);
//   - backup → restore yields a ROW-consistent (and, for SQLite, BYTE-consistent)
//     operational store;
//   - cadence: younger-than-interval is SKIPPED (not_due); older is DUE;
//   - retention: only the N most recent artifacts are kept (older pruned);
//   - restore integrity gate: empty store → no_backup_available; a digest mismatch
//     fails CLOSED with integrity_check_failed (§4/§16 consistent store).
// Dialect-agnostic: `isBackupDue` (pure) and the capture-failure typed refusal are
// asserted once via stubs.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { err, isErr, isOk, ok } from "@sow/contracts";

import {
  createFsBackupSink,
  createSqliteBackupEngine,
  DEFAULT_BACKUP_RETENTION,
  isBackupDue,
  OPERATIONAL_TRUTH_TABLES,
  PERIODIC_BACKUP_FAILURE_REASONS,
  runPeriodicBackup,
  type BackupSink,
  type OpStoreBackupEngine,
  type PeriodicBackupFailure,
  type PeriodicBackupOutcome,
  type StoredBackup,
} from "../../src/backup/periodic-backup";
import {
  createSqliteRestoreEngine,
  RESTORE_FAILURE_REASONS,
  restoreFromBackup,
  type RestoreEngine,
  type SqliteStore,
} from "../../src/backup/restore";
import {
  createPgBackupEngine,
  createPgRestoreEngine,
  type PgStore,
} from "../../src/backup/pg-ops";
import { applyMigrations, type MigrationDialect } from "../../src/migrate/runner";
import { createSqliteMigrationEngine } from "../../src/migrate/sqlite-engine";
import { createPgMigrationEngine } from "../../src/migrate/pg-engine";
import type { DbError } from "../../src/repositories/interfaces";
import type { Result } from "@sow/contracts";

type Conn = InstanceType<typeof Database>;

// The REAL generated genesis migration sets (task-2.6 deliverables).
const REAL_SQLITE_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/sqlite", import.meta.url),
);
const REAL_PG_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/pg", import.meta.url),
);

const CASE_TIMEOUT_MS = 30_000;

// --- temp-fixture bookkeeping ---------------------------------------------
const cleanups: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try {
      await c();
    } catch {
      /* best-effort */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// --- per-dialect fixture --------------------------------------------------
/** One concrete op-store dialect under test (S = restored store, H = live handle). */
interface BackupFixture<S, H> {
  readonly name: string;
  readonly dialect: MigrationDialect;
  /** SQLite `serialize()` is byte-stable; a pg datadir dump is not. */
  readonly bytesStable: boolean;
  /** Stand up a REAL migrated operational store, tracked for cleanup. */
  makeStore(): Promise<H>;
  seedOps(h: H): Promise<void>;
  backupEngine(h: H): OpStoreBackupEngine;
  restoreEngine(): RestoreEngine<S>;
  /** Live handle inside a restored store (tracked for cleanup). */
  live(store: S): H;
  rowsOf(h: H, table: string): Promise<unknown[]>;
  /** Serialized image of the live store (for the byte-stable round-trip check). */
  sourceBytes(h: H): Promise<Buffer>;
}

const sqliteFixture: BackupFixture<SqliteStore, Conn> = {
  name: "sqlite",
  dialect: "sqlite",
  bytesStable: true,
  async makeStore() {
    const engine = createSqliteMigrationEngine(new Database(":memory:"));
    const r = await applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });
    if (isErr(r)) throw new Error(`sqlite store setup failed: ${r.error.reason}`);
    const conn = engine.connection;
    cleanups.push(() => {
      if (conn.open) conn.close();
    });
    return conn;
  },
  seedOps(conn) {
    conn
      .prepare(
        'INSERT INTO "workspace_config" ("id","name","type","dataOwner","markdownRepoPath","gbrainBrainId","defaultVisibility","egressPolicy","providerMatrix") VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run("ws-emp", "Employer Work", "employer_work", "employer", "/vault/emp", "brain-emp", "isolated", "{}", "{}");
    const evt = conn.prepare(
      'INSERT INTO "event_log" ("eventId","eventName","occurredAt","recordedAt") VALUES (?,?,?,?)',
    );
    evt.run("evt-1", "workflow.started", "2026-06-30T10:00:00.000Z", "2026-06-30T10:00:00.050Z");
    evt.run("evt-2", "approval.created", "2026-06-30T10:01:00.000Z", "2026-06-30T10:01:00.050Z");
    conn
      .prepare(
        'INSERT INTO "audit" ("actor","event","refs","payloadHash","beforeSummary","afterSummary","timestamps") VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        "KnowledgeWriter",
        "note.committed",
        JSON.stringify(["note-1"]),
        "sha256:abc",
        "(none)",
        "created note",
        JSON.stringify({ occurredAt: "2026-06-30T10:02:00.000Z" }),
      );
    conn
      .prepare(
        'INSERT INTO "approvals" ("id","actionRef","status","actor","channel","payloadHash") VALUES (?,?,?,?,?,?)',
      )
      .run("apr-1", "act-1", "pending", "user", "mac", "sha256:def");
    conn
      .prepare(
        'INSERT INTO "outbox" ("outboxId","actionRef","workspaceId","targetSystem","canonicalObjectKey","idempotencyKey","payloadHash","status","attempts","enqueuedAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run("ob-1", "act-1", "ws-emp", "todoist", "todoist:task:x", "idem-1", "sha256:ghi", "pending", 0, "2026-06-30T10:03:00.000Z", "2026-06-30T10:03:00.000Z");
    conn
      .prepare(
        'INSERT INTO "connector_cursors" ("connectorId","workspaceId","status","updatedAt") VALUES (?,?,?,?)',
      )
      .run("calendar", "ws-emp", "healthy", "2026-06-30T10:04:00.000Z");
    // A REBUILDABLE read-model row — captured byte-wise but NOT part of the
    // operational-truth recovery contract (§4).
    conn
      .prepare('INSERT INTO "read_models" ("readModelKey","data","rebuiltAt") VALUES (?,?,?)')
      .run("dashboard:home", "{}", "2026-06-30T10:05:00.000Z");
    return Promise.resolve();
  },
  backupEngine(conn) {
    return createSqliteBackupEngine(conn);
  },
  restoreEngine() {
    return createSqliteRestoreEngine();
  },
  live(store) {
    cleanups.push(() => {
      if (store.connection.open) store.connection.close();
    });
    return store.connection;
  },
  rowsOf(conn, table) {
    return Promise.resolve(conn.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
  },
  sourceBytes(conn) {
    return Promise.resolve(conn.serialize());
  },
};

const pgFixture: BackupFixture<PgStore, PGlite> = {
  name: "postgres-pglite",
  dialect: "pg",
  bytesStable: false,
  async makeStore() {
    const client = new PGlite();
    const engine = createPgMigrationEngine(client);
    const r = await applyMigrations(engine, { migrationsFolder: REAL_PG_MIGRATIONS });
    if (isErr(r)) throw new Error(`pg store setup failed: ${r.error.reason}`);
    const live = engine.client;
    cleanups.push(async () => {
      if (!live.closed) await live.close();
    });
    return live;
  },
  async seedOps(client) {
    await client.query(
      'INSERT INTO "workspace_config" ("id","name","type","dataOwner","markdownRepoPath","gbrainBrainId","defaultVisibility","egressPolicy","providerMatrix") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::json,$9::json)',
      ["ws-emp", "Employer Work", "employer_work", "employer", "/vault/emp", "brain-emp", "isolated", "{}", "{}"],
    );
    await client.query(
      'INSERT INTO "event_log" ("eventId","eventName","occurredAt","recordedAt") VALUES ($1,$2,$3,$4)',
      ["evt-1", "workflow.started", "2026-06-30T10:00:00.000Z", "2026-06-30T10:00:00.050Z"],
    );
    await client.query(
      'INSERT INTO "event_log" ("eventId","eventName","occurredAt","recordedAt") VALUES ($1,$2,$3,$4)',
      ["evt-2", "approval.created", "2026-06-30T10:01:00.000Z", "2026-06-30T10:01:00.050Z"],
    );
    await client.query(
      'INSERT INTO "audit" ("actor","event","refs","payloadHash","beforeSummary","afterSummary","timestamps") VALUES ($1,$2,$3::json,$4,$5,$6,$7::json)',
      [
        "KnowledgeWriter",
        "note.committed",
        JSON.stringify(["note-1"]),
        "sha256:abc",
        "(none)",
        "created note",
        JSON.stringify({ occurredAt: "2026-06-30T10:02:00.000Z" }),
      ],
    );
    await client.query(
      'INSERT INTO "approvals" ("id","actionRef","status","actor","channel","payloadHash") VALUES ($1,$2,$3,$4,$5,$6)',
      ["apr-1", "act-1", "pending", "user", "mac", "sha256:def"],
    );
    await client.query(
      'INSERT INTO "outbox" ("outboxId","actionRef","workspaceId","targetSystem","canonicalObjectKey","idempotencyKey","payloadHash","status","attempts","enqueuedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      ["ob-1", "act-1", "ws-emp", "todoist", "todoist:task:x", "idem-1", "sha256:ghi", "pending", 0, "2026-06-30T10:03:00.000Z", "2026-06-30T10:03:00.000Z"],
    );
    await client.query(
      'INSERT INTO "connector_cursors" ("connectorId","workspaceId","status","updatedAt") VALUES ($1,$2,$3,$4)',
      ["calendar", "ws-emp", "healthy", "2026-06-30T10:04:00.000Z"],
    );
    await client.query(
      'INSERT INTO "read_models" ("readModelKey","data","rebuiltAt") VALUES ($1,$2::json,$3)',
      ["dashboard:home", "{}", "2026-06-30T10:05:00.000Z"],
    );
  },
  backupEngine(client) {
    return createPgBackupEngine(client);
  },
  restoreEngine() {
    return createPgRestoreEngine();
  },
  live(store) {
    cleanups.push(async () => {
      if (!store.client.closed) await store.client.close();
    });
    return store.client;
  },
  async rowsOf(client, table) {
    const r = await client.query<{ r: unknown }>(
      `SELECT row_to_json(x) AS r FROM "${table}" x ORDER BY row_to_json(x)::text`,
    );
    return r.rows.map((row) => row.r);
  },
  async sourceBytes(client) {
    const dump = await client.dumpDataDir();
    return Buffer.from(await dump.arrayBuffer());
  },
};

// =====================================================================
function defineBackupSuite<S, H>(fix: BackupFixture<S, H>): void {
  describe(`2.10/2.9 periodic op-DB backup — local on-disk artifact — ${fix.name}`, () => {
    it(
      "captures the live op store to a real local backup artifact (forced run)",
      async () => {
        const conn = await fix.makeStore();
        await fix.seedOps(conn);
        const dir = tmpDir("sow-bk-");
        const sink = createFsBackupSink(dir);

        const r = await runPeriodicBackup(fix.backupEngine(conn), sink, {
          intervalMs: 24 * 3600 * 1000,
          now: new Date("2026-06-30T12:00:00.000Z"),
          force: true,
        });

        expect(isOk(r)).toBe(true);
        if (!isOk(r)) return;
        expect(r.value.performed).toBe(true);
        expect(r.value.dialect).toBe(fix.dialect);
        const bk = r.value.backup;
        expect(bk).toBeDefined();
        if (!bk) return;
        expect(bk.sizeBytes).toBeGreaterThan(0);
        expect(bk.rowDigest.length).toBeGreaterThan(0);
        expect(bk.createdAt).toBe("2026-06-30T12:00:00.000Z");
        expect(existsSync(bk.location)).toBe(true);

        const listed = sink.list();
        expect(isOk(listed)).toBe(true);
        if (!isOk(listed)) return;
        expect(listed.value.length).toBe(1);
        expect(listed.value[0]?.backupId).toBe(bk.backupId);
        expect(DEFAULT_BACKUP_RETENTION).toBeGreaterThan(0);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe(`2.10/2.9 restore-from-backup — consistent operational store — ${fix.name}`, () => {
    it(
      "restores a ROW-consistent (and, for SQLite, BYTE-consistent) store from a backup",
      async () => {
        const conn = await fix.makeStore();
        await fix.seedOps(conn);

        const before: Record<string, unknown[]> = {};
        for (const t of OPERATIONAL_TRUTH_TABLES) before[t] = await fix.rowsOf(conn, t);
        const sourceBytes = await fix.sourceBytes(conn);

        const sink = createFsBackupSink(tmpDir("sow-bk-"));
        const bkRes = await runPeriodicBackup(fix.backupEngine(conn), sink, {
          intervalMs: 1,
          now: new Date("2026-06-30T12:00:00.000Z"),
          force: true,
        });
        expect(isOk(bkRes)).toBe(true);
        if (!isOk(bkRes)) return;

        const rr = await restoreFromBackup(sink, fix.restoreEngine());
        expect(isOk(rr)).toBe(true);
        if (!isOk(rr)) return;
        const liveHandle = fix.live(rr.value.store);

        // The binding recovery invariant (both dialects): the restored operational-
        // truth digest matches the backup's recorded digest.
        expect(rr.value.verification.rowDigestMatched).toBe(true);
        expect(rr.value.dialect).toBe(fix.dialect);

        // BYTE-consistency only where the dialect's serialization is byte-stable.
        if (fix.bytesStable) {
          expect(rr.value.verification.bytesMatched).toBe(true);
          const fileBytes = readFileSync(rr.value.backup.location);
          expect(Buffer.compare(fileBytes, sourceBytes)).toBe(0);
          const liveBytes = await fix.sourceBytes(liveHandle);
          expect(Buffer.compare(liveBytes, sourceBytes)).toBe(0);
        }

        // ROW-consistency: every NOT-rebuildable operational-truth domain round-trips.
        for (const t of OPERATIONAL_TRUTH_TABLES) {
          expect(await fix.rowsOf(liveHandle, t), `table ${t}`).toEqual(before[t]);
        }
        // Not a vacuous pass — the recovery target actually carries data.
        expect((await fix.rowsOf(liveHandle, "event_log")).length).toBe(2);
        expect((await fix.rowsOf(liveHandle, "approvals")).length).toBe(1);
        expect((await fix.rowsOf(liveHandle, "outbox")).length).toBe(1);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe(`2.10/2.9 periodic cadence — persisted last-run bookkeeping — ${fix.name}`, () => {
    it(
      "skips a run when the latest backup is younger than the interval; performs when older",
      async () => {
        const conn = await fix.makeStore();
        await fix.seedOps(conn);
        const sink = createFsBackupSink(tmpDir("sow-bk-"));
        const engine = fix.backupEngine(conn);

        const first = await runPeriodicBackup(engine, sink, {
          intervalMs: 3_600_000,
          now: new Date("2026-06-30T12:00:00.000Z"),
        });
        expect(isOk(first) && first.value.performed).toBe(true);

        const tooSoon = await runPeriodicBackup(engine, sink, {
          intervalMs: 3_600_000,
          now: new Date("2026-06-30T12:10:00.000Z"),
        });
        expect(isOk(tooSoon)).toBe(true);
        if (!isOk(tooSoon)) return;
        expect(tooSoon.value.performed).toBe(false);
        expect(tooSoon.value.skippedReason).toBe("not_due");

        const later = await runPeriodicBackup(engine, sink, {
          intervalMs: 3_600_000,
          now: new Date("2026-06-30T13:30:00.000Z"),
        });
        expect(isOk(later)).toBe(true);
        if (!isOk(later)) return;
        expect(later.value.performed).toBe(true);

        const listed = sink.list();
        expect(isOk(listed) && listed.value.length === 2).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe(`2.10/2.9 retention — keeps only the N most recent backups — ${fix.name}`, () => {
    it(
      "prunes older artifacts beyond `keep`, returning the removed set",
      async () => {
        const conn = await fix.makeStore();
        await fix.seedOps(conn);
        const dir = tmpDir("sow-bk-");
        const sink = createFsBackupSink(dir);
        const engine = fix.backupEngine(conn);

        const times = [
          "2026-06-30T08:00:00.000Z",
          "2026-06-30T09:00:00.000Z",
          "2026-06-30T10:00:00.000Z",
          "2026-06-30T11:00:00.000Z",
        ];
        let last: Result<PeriodicBackupOutcome, PeriodicBackupFailure> | undefined;
        for (const t of times) {
          last = await runPeriodicBackup(engine, sink, {
            intervalMs: 1,
            now: new Date(t),
            keep: 2,
            force: true,
          });
          expect(isOk(last)).toBe(true);
        }

        const listed = sink.list();
        expect(isOk(listed)).toBe(true);
        if (!isOk(listed)) return;
        expect(listed.value.length).toBe(2);
        expect(listed.value.map((b) => b.createdAt)).toEqual([
          "2026-06-30T11:00:00.000Z",
          "2026-06-30T10:00:00.000Z",
        ]);

        expect(last).toBeDefined();
        if (!last || !isOk(last)) return;
        expect(last.value.pruned.length).toBeGreaterThan(0);

        const bins = readdirSync(dir).filter((f) => f.endsWith(".bin"));
        expect(bins.length).toBe(2);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe(`2.10/2.9 restore integrity gate — fails closed on divergence — ${fix.name}`, () => {
    it(
      "returns no_backup_available when the store is empty",
      async () => {
        const sink = createFsBackupSink(tmpDir("sow-bk-"));
        const r = await restoreFromBackup(sink, fix.restoreEngine());
        expect(isErr(r)).toBe(true);
        if (!isErr(r)) return;
        expect(r.error.reason).toBe("no_backup_available");
        expect(RESTORE_FAILURE_REASONS).toContain(r.error.reason);
        expect(r.error.repair.length).toBeGreaterThan(0);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "fails closed with integrity_check_failed when rebuilt rows diverge from the digest",
      async () => {
        const conn = await fix.makeStore();
        await fix.seedOps(conn);
        const realBytes = await fix.sourceBytes(conn);

        // A sink whose metadata claims a rowDigest the rebuilt store cannot match.
        const tamperedSink: BackupSink = {
          write: () => err<DbError>({ code: "unknown", message: "n/a" }),
          list: () =>
            ok([
              {
                backupId: "b1",
                dialect: fix.dialect,
                createdAt: "2026-06-30T12:00:00.000Z",
                sizeBytes: realBytes.length,
                rowDigest: "DELIBERATELY-WRONG-DIGEST",
                location: "(in-memory)",
              } satisfies StoredBackup,
            ]),
          read: () => ok(realBytes),
          prune: () => ok([]),
        };

        const r = await restoreFromBackup(tamperedSink, fix.restoreEngine());
        expect(isErr(r)).toBe(true);
        if (!isErr(r)) return;
        expect(r.error.reason).toBe("integrity_check_failed");
        expect(r.error.verification?.rowDigestMatched).toBe(false);
        expect(r.error.repair.length).toBeGreaterThan(0);
      },
      CASE_TIMEOUT_MS,
    );
  });
}

defineBackupSuite(sqliteFixture);
defineBackupSuite(pgFixture);

// Optional Docker-pg backup/restore run (node-postgres against postgres:16) — a
// separate, env-gated path, skipped by default (pglite above proves it server-free).
describe.skipIf(process.env.SOW_PG_DOCKER !== "1")(
  "2.9 backup/restore — postgres (Docker, node-postgres) [SOW_PG_DOCKER=1]",
  () => {
    it.todo("drive the same backup/restore against a Docker postgres:16 via node-postgres");
  },
);

// =====================================================================
// Dialect-agnostic: pure cadence predicate + capture-failure typed refusal (once).
describe("2.10 periodic cadence — isBackupDue (pure, dialect-agnostic)", () => {
  it("due iff now - last >= interval; unparseable last → due (fail-safe)", () => {
    const interval = 60_000;
    const now = new Date("2026-06-30T12:00:00.000Z");
    expect(isBackupDue(now, "2026-06-30T11:59:30.000Z", interval)).toBe(false); // 30s < 60s
    expect(isBackupDue(now, "2026-06-30T11:59:00.000Z", interval)).toBe(true); // 60s >= 60s
    expect(isBackupDue(now, "2026-06-30T11:58:00.000Z", interval)).toBe(true); // 120s
    expect(isBackupDue(now, "not-a-date", interval)).toBe(true);
  });
});

describe("2.10 typed failures — nothing throws across the boundary (§16)", () => {
  it("a capture failure returns a typed periodic_backup_failure (no throw)", async () => {
    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const failingEngine: OpStoreBackupEngine = {
      dialect: "sqlite",
      capture: () =>
        Promise.resolve(err<DbError>({ code: "unavailable", message: "operational DB gone" })),
    };

    const r = await runPeriodicBackup(failingEngine, sink, {
      intervalMs: 1,
      now: new Date("2026-06-30T12:00:00.000Z"),
      force: true,
    });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.kind).toBe("periodic_backup_failure");
    expect(PERIODIC_BACKUP_FAILURE_REASONS).toContain(r.error.reason);
    expect(r.error.reason).toBe("capture_failed");
    expect(r.error.repair.length).toBeGreaterThan(0);
    expect(r.error.cause?.code).toBe("unavailable");

    const listed = sink.list();
    expect(isOk(listed) && listed.value.length === 0).toBe(true);
  });
});
