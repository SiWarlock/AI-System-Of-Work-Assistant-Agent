// Phase-2 task 2.10 — periodic operational-DB backup + EXERCISED restore (UNIT).
//
// ARCHITECTURE §16 (Backup & recovery): "The operational DB and Temporal
// persistence are operational truth and not Git-backed → a periodic local backup
// (pre-migration backup is mandatory, §4) with documented restore." §4 names the
// NOT-rebuildable operational-truth set (event log / audit / approvals / outboxes
// / connector cursors) — restore is its recovery path. §16 also requires a TYPED
// result with explicit failure variants — nothing fails silently.
//
// This unit exercises the REAL recovery path on SQLite (server-free, deterministic
// per the brief): a real operational store is stood up via the task-2.6 migration
// runner over the on-disk genesis migration, seeded with operational-truth rows,
// then backed up to a local on-disk artifact and RESTORED — yielding a store that
// is BOTH byte-consistent (the serialized image round-trips exactly) AND
// row-consistent (every not-rebuildable domain's rows survive). pg PARITY: the
// orchestrators are dialect-agnostic (pure functions over injected ports); a pg
// engine plugs into the SAME runner — exercised by the dual-dialect contract suite
// (task 2.9). The Docker-pg run is opt-in (SOW_PG_DOCKER=1) and out of scope here.
//
// Coverage:
//   - periodic backup writes a real local artifact (size + digest + on-disk file);
//   - backup → restore yields a BYTE- and ROW-consistent operational store;
//   - cadence: a recent backup younger than the interval is SKIPPED (not_due);
//     an older one is DUE (persisted last-run bookkeeping, §16);
//   - retention: only the N most recent artifacts are kept (older pruned);
//   - typed failures: a capture failure returns a typed refusal (no throw, §16);
//   - restore integrity gate: empty store → no_backup_available; a digest
//     mismatch fails CLOSED with integrity_check_failed (§4/§16 consistent store).
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
} from "../../src/backup/restore";
import { applyMigrations } from "../../src/migrate/runner";
import { createSqliteMigrationEngine } from "../../src/migrate/sqlite-engine";
import type { DbError } from "../../src/repositories/interfaces";
import type { Result } from "@sow/contracts";

type Conn = InstanceType<typeof Database>;

// The REAL generated SQLite genesis migration set (the task-2.6 deliverable).
const REAL_SQLITE_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/sqlite", import.meta.url),
);

// --- temp-fixture bookkeeping ---------------------------------------------
const conns: Conn[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) {
    try {
      if (c.open) c.close();
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

function track(c: Conn): Conn {
  conns.push(c);
  return c;
}

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Stand up a REAL operational store: genesis migration applied (task 2.6). */
function makeStore(): Conn {
  const engine = createSqliteMigrationEngine(track(new Database(":memory:")));
  const r = applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });
  if (isErr(r)) throw new Error(`store setup failed: ${r.error.reason}`);
  return engine.connection;
}

/** Seed at least one row into every NOT-rebuildable operational-truth domain. */
function seedOps(conn: Conn): void {
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
  // A REBUILDABLE read-model row — captured byte-wise by the whole-DB snapshot,
  // but NOT part of the operational-truth recovery contract (§4).
  conn
    .prepare('INSERT INTO "read_models" ("readModelKey","data","rebuiltAt") VALUES (?,?,?)')
    .run("dashboard:home", "{}", "2026-06-30T10:05:00.000Z");
}

function rowsOf(conn: Conn, table: string): unknown[] {
  return conn.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}

// =====================================================================
describe("2.10 periodic operational-DB backup — local on-disk artifact (§16)", () => {
  it("captures the live op store to a real local backup artifact (forced run)", () => {
    const conn = makeStore();
    seedOps(conn);
    const dir = tmpDir("sow-bk-");
    const sink = createFsBackupSink(dir);
    const engine = createSqliteBackupEngine(conn);

    const r = runPeriodicBackup(engine, sink, {
      intervalMs: 24 * 3600 * 1000,
      now: new Date("2026-06-30T12:00:00.000Z"),
      force: true,
    });

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.performed).toBe(true);
    expect(r.value.dialect).toBe("sqlite");
    const bk = r.value.backup;
    expect(bk).toBeDefined();
    if (!bk) return;
    expect(bk.sizeBytes).toBeGreaterThan(0);
    expect(bk.rowDigest.length).toBeGreaterThan(0);
    expect(bk.createdAt).toBe("2026-06-30T12:00:00.000Z");
    // A real file on disk — the operational DB is NOT Git-backed (§16).
    expect(existsSync(bk.location)).toBe(true);

    const listed = sink.list();
    expect(isOk(listed)).toBe(true);
    if (!isOk(listed)) return;
    expect(listed.value.length).toBe(1);
    expect(listed.value[0]?.backupId).toBe(bk.backupId);

    // Sanity: the default retention is a sane positive integer.
    expect(DEFAULT_BACKUP_RETENTION).toBeGreaterThan(0);
  });
});

// =====================================================================
describe("2.10 restore-from-backup — byte/row-consistent operational store (§4/§16)", () => {
  it("restores a BYTE-consistent AND ROW-consistent store from a backup", () => {
    const conn = makeStore();
    seedOps(conn);

    // Pre-backup truth + raw bytes, for the consistency comparisons.
    const before: Record<string, unknown[]> = {};
    for (const t of OPERATIONAL_TRUTH_TABLES) before[t] = rowsOf(conn, t);
    const sourceBytes = conn.serialize();

    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const bkRes = runPeriodicBackup(createSqliteBackupEngine(conn), sink, {
      intervalMs: 1,
      now: new Date("2026-06-30T12:00:00.000Z"),
      force: true,
    });
    expect(isOk(bkRes)).toBe(true);
    if (!isOk(bkRes)) return;

    const rr = restoreFromBackup(sink, createSqliteRestoreEngine());
    expect(isOk(rr)).toBe(true);
    if (!isOk(rr)) return;
    track(rr.value.store.connection);

    // Production-code verification flags (the integrity gate that ran).
    expect(rr.value.verification.rowDigestMatched).toBe(true);
    expect(rr.value.verification.bytesMatched).toBe(true);
    expect(rr.value.dialect).toBe("sqlite");

    // BYTE-consistent: the persisted file == the source image, and the restored
    // store re-serializes to that exact image.
    const fileBytes = readFileSync(rr.value.backup.location);
    expect(Buffer.compare(fileBytes, sourceBytes)).toBe(0);
    expect(Buffer.compare(rr.value.store.connection.serialize(), sourceBytes)).toBe(0);

    // ROW-consistent: every NOT-rebuildable operational-truth domain round-trips.
    for (const t of OPERATIONAL_TRUTH_TABLES) {
      expect(rowsOf(rr.value.store.connection, t), `table ${t}`).toEqual(before[t]);
    }
    // Not a vacuous pass — the recovery target actually carries data.
    expect(rowsOf(rr.value.store.connection, "event_log").length).toBe(2);
    expect(rowsOf(rr.value.store.connection, "approvals").length).toBe(1);
    expect(rowsOf(rr.value.store.connection, "outbox").length).toBe(1);
  });
});

// =====================================================================
describe("2.10 periodic cadence — persisted last-run bookkeeping (§16)", () => {
  it("isBackupDue: due iff now - last >= interval; unparseable last → due (fail-safe)", () => {
    const interval = 60_000;
    const now = new Date("2026-06-30T12:00:00.000Z");
    expect(isBackupDue(now, "2026-06-30T11:59:30.000Z", interval)).toBe(false); // 30s < 60s
    expect(isBackupDue(now, "2026-06-30T11:59:00.000Z", interval)).toBe(true); // 60s >= 60s
    expect(isBackupDue(now, "2026-06-30T11:58:00.000Z", interval)).toBe(true); // 120s
    expect(isBackupDue(now, "not-a-date", interval)).toBe(true);
  });

  it("skips a run when the latest backup is younger than the interval", () => {
    const conn = makeStore();
    seedOps(conn);
    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const engine = createSqliteBackupEngine(conn);

    const first = runPeriodicBackup(engine, sink, {
      intervalMs: 3_600_000,
      now: new Date("2026-06-30T12:00:00.000Z"),
    });
    expect(isOk(first) && first.value.performed).toBe(true);

    const second = runPeriodicBackup(engine, sink, {
      intervalMs: 3_600_000,
      now: new Date("2026-06-30T12:10:00.000Z"),
    });
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.performed).toBe(false);
    expect(second.value.skippedReason).toBe("not_due");

    const listed = sink.list();
    expect(isOk(listed) && listed.value.length === 1).toBe(true);
  });

  it("performs a run when the latest backup is older than the interval", () => {
    const conn = makeStore();
    seedOps(conn);
    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const engine = createSqliteBackupEngine(conn);

    const first = runPeriodicBackup(engine, sink, {
      intervalMs: 3_600_000,
      now: new Date("2026-06-30T12:00:00.000Z"),
    });
    expect(isOk(first) && first.value.performed).toBe(true);

    const later = runPeriodicBackup(engine, sink, {
      intervalMs: 3_600_000,
      now: new Date("2026-06-30T13:30:00.000Z"),
    });
    expect(isOk(later)).toBe(true);
    if (!isOk(later)) return;
    expect(later.value.performed).toBe(true);

    const listed = sink.list();
    expect(isOk(listed) && listed.value.length === 2).toBe(true);
  });
});

// =====================================================================
describe("2.10 retention — keeps only the N most recent backups", () => {
  it("prunes older artifacts beyond `keep`, returning the removed set", () => {
    const conn = makeStore();
    seedOps(conn);
    const dir = tmpDir("sow-bk-");
    const sink = createFsBackupSink(dir);
    const engine = createSqliteBackupEngine(conn);

    const times = [
      "2026-06-30T08:00:00.000Z",
      "2026-06-30T09:00:00.000Z",
      "2026-06-30T10:00:00.000Z",
      "2026-06-30T11:00:00.000Z",
    ];
    let last: Result<PeriodicBackupOutcome, PeriodicBackupFailure> | undefined;
    for (const t of times) {
      last = runPeriodicBackup(engine, sink, {
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

    // The final run reported the artifact it pruned (the 09:00 one falling out).
    expect(last).toBeDefined();
    if (!last || !isOk(last)) return;
    expect(last.value.pruned.length).toBeGreaterThan(0);

    // Pruned artifacts are gone from disk (only 2 `.bin` remain).
    const bins = readdirSync(dir).filter((f) => f.endsWith(".bin"));
    expect(bins.length).toBe(2);
  });
});

// =====================================================================
describe("2.10 typed failures — nothing throws across the boundary (§16)", () => {
  it("a capture failure returns a typed periodic_backup_failure (no throw)", () => {
    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const failingEngine: OpStoreBackupEngine = {
      dialect: "sqlite",
      capture: () => err<DbError>({ code: "unavailable", message: "operational DB gone" }),
    };

    const r = runPeriodicBackup(failingEngine, sink, {
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

    // Nothing was persisted on a failed capture.
    const listed = sink.list();
    expect(isOk(listed) && listed.value.length === 0).toBe(true);
  });
});

// =====================================================================
describe("2.10 restore integrity gate — fails closed on divergence (§4/§16)", () => {
  it("returns no_backup_available when the store is empty", () => {
    const sink = createFsBackupSink(tmpDir("sow-bk-"));
    const r = restoreFromBackup(sink, createSqliteRestoreEngine());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("no_backup_available");
    expect(RESTORE_FAILURE_REASONS).toContain(r.error.reason);
    expect(r.error.repair.length).toBeGreaterThan(0);
  });

  it("fails closed with integrity_check_failed when rebuilt rows diverge from the recorded digest", () => {
    const conn = makeStore();
    seedOps(conn);
    const realBytes = conn.serialize();

    // A sink whose metadata claims a rowDigest the rebuilt store cannot match.
    const tamperedSink: BackupSink = {
      write: () => err<DbError>({ code: "unknown", message: "n/a" }),
      list: () =>
        ok([
          {
            backupId: "b1",
            dialect: "sqlite",
            createdAt: "2026-06-30T12:00:00.000Z",
            sizeBytes: realBytes.length,
            rowDigest: "DELIBERATELY-WRONG-DIGEST",
            location: "(in-memory)",
          } satisfies StoredBackup,
        ]),
      read: () => ok(realBytes),
      prune: () => ok([]),
    };

    const r = restoreFromBackup(tamperedSink, createSqliteRestoreEngine());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("integrity_check_failed");
    expect(r.error.verification?.rowDigestMatched).toBe(false);
    expect(r.error.repair.length).toBeGreaterThan(0);
  });
});
