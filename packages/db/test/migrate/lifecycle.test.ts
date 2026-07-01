// Phase-2 task 2.6 — migration apply LIFECYCLE (UNIT).
//
// ARCHITECTURE §4 (Operational Storage, failure modes): "back up the operational
// DB before applying any migration; run migrations transactionally where the
// engine allows; on partial/failed apply, restore from the pre-migration backup
// and refuse to start with a typed repair message; record an app-version ↔
// schema-version compatibility check ... (no silent forward-only break).
// Down-migration or restore-from-backup is the rollback path (Drizzle is
// forward-only by default)." §16 mandates a TYPED result with explicit failure
// variants + actionable repair — nothing fails silently.
//
// This unit drives `applyMigrations(db, opts)` (the dialect-agnostic lifecycle
// orchestrator) over the concrete SQLite engine (better-sqlite3 serialize /
// deserialize, fast + server-free per the brief). pg PARITY: the same runner
// drives a pg engine (PGlite/node-postgres) — exercised by the dual-dialect
// migration contract suite (task 2.9); the lifecycle invariants asserted here are
// dialect-independent (they live in the runner, not the engine).
//
// Coverage:
//   - happy apply: real generated genesis migration → all domains created, applied
//     count + schema-version marker recorded, NO restore (connection unchanged);
//   - idempotent re-run: already-applied → applied=0, still Ok, marker intact;
//   - FAIL → restore → typed repair: a deliberately-broken migration is injected;
//     the DB is restored to its EXACT pre-migration state and a typed refusal with
//     an actionable repair is returned (no half-applied schema);
//   - backup-before-migrate is MANDATORY: a backup failure refuses to apply at all;
//   - apply-failed-AND-restore-failed → the catastrophic, manual-recovery variant;
//   - apply Ok but marker-record fails → typed record_failed (data is valid).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk, ok, err, type Result } from "@sow/contracts";

import {
  applyMigrations,
  MIGRATION_FAILURE_REASONS,
  type MigrationBackup,
  type MigrationApplied,
  type MigrationEngine,
} from "../../src/migrate/runner";
import { createSqliteMigrationEngine } from "../../src/migrate/sqlite-engine";
import { CURRENT_SCHEMA_VERSION } from "../../src/migrate/version-compat";
import type { DbError } from "../../src/repositories/interfaces";

type Conn = InstanceType<typeof Database>;

// Absolute path to the REAL generated SQLite genesis migration set (the task-2.6
// deliverable). Resolved relative to this test file: test/migrate → packages/db.
const REAL_SQLITE_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/sqlite", import.meta.url),
);

// Every operational-store domain table the genesis migration must materialize (§4).
const DOMAIN_TABLES = [
  "workspace_config",
  "event_log",
  "workflow_run_refs",
  "audit",
  "approvals",
  "outbox",
  "connector_cursors",
  "provider_state",
  "read_models",
  "gcl_projections",
] as const;

// --- temp-fixture bookkeeping ---------------------------------------------
const tempDirs: string[] = [];
const conns: Conn[] = [];
afterEach(() => {
  for (const c of conns.splice(0)) {
    try {
      if (c.open) c.close();
    } catch {
      /* best-effort */
    }
  }
  for (const d of tempDirs.splice(0)) {
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

/** Pre-existing OPERATIONAL data that must survive a failed migration + restore. */
function seedOps(conn: Conn): void {
  conn.exec('CREATE TABLE "ops_data" ("id" integer PRIMARY KEY, "v" text NOT NULL)');
  conn.prepare('INSERT INTO "ops_data" ("v") VALUES (?)').run("pre-migration");
}

function tableExists(conn: Conn, name: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

function userVersion(conn: Conn): number {
  return conn.pragma("user_version", { simple: true }) as number;
}

/** Write a drizzle-format migrations folder (meta/_journal.json + <tag>.sql). */
function writeMigrationsFolder(
  files: ReadonlyArray<{ tag: string; sql: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-mig-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = files.map((f, idx) => ({
    idx,
    version: "6",
    when: 1_700_000_000_000 + idx,
    tag: f.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2),
  );
  for (const f of files) writeFileSync(join(dir, `${f.tag}.sql`), f.sql);
  return dir;
}

/** A migration whose 2nd statement fails (insert into a non-existent table). */
function failingMigrationsFolder(): string {
  return writeMigrationsFolder([
    {
      tag: "0000_broken",
      sql:
        'CREATE TABLE "broken_table" ("id" integer PRIMARY KEY)\n' +
        "--> statement-breakpoint\n" +
        'INSERT INTO "table_that_does_not_exist" ("id") VALUES (1)',
    },
  ]);
}

describe("2.6 applyMigrations — happy apply over the real genesis migration", () => {
  it("backs up, applies, records the schema-version marker; no restore", () => {
    const conn = track(new Database(":memory:"));
    seedOps(conn);
    const engine = createSqliteMigrationEngine(conn);
    const original = engine.connection;

    const r = applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.dialect).toBe("sqlite");
    expect(r.value.applied).toBe(1);
    expect(r.value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.value.backup.dialect).toBe("sqlite");

    // A successful apply NEVER restores → the connection identity is unchanged.
    expect(engine.connection).toBe(original);
    expect(engine.connection.open).toBe(true);

    // Every operational domain table exists; the schema-version marker is recorded.
    for (const t of DOMAIN_TABLES) {
      expect(tableExists(engine.connection, t), `table ${t}`).toBe(true);
    }
    expect(userVersion(engine.connection)).toBe(CURRENT_SCHEMA_VERSION);

    // Pre-existing operational data is untouched by a forward apply.
    const rows = engine.connection.prepare('SELECT v FROM "ops_data"').all();
    expect(rows).toEqual([{ v: "pre-migration" }]);
  });

  it("is idempotent — re-applying the same set is a no-op (applied=0), still Ok", () => {
    const conn = track(new Database(":memory:"));
    const engine = createSqliteMigrationEngine(conn);

    const first = applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });
    expect(isOk(first)).toBe(true);

    const second = applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.applied).toBe(0);
    expect(userVersion(engine.connection)).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("2.6 applyMigrations — FAILED apply restores + refuses with a typed repair", () => {
  it("restores the DB to its EXACT pre-migration state and returns a typed refusal", () => {
    const conn = track(new Database(":memory:"));
    seedOps(conn);
    const engine = createSqliteMigrationEngine(conn);
    const original = engine.connection;

    const r = applyMigrations(engine, { migrationsFolder: failingMigrationsFolder() });

    // Typed refusal (§16): a closed-set reason + a non-empty actionable repair.
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.kind).toBe("migration_failure");
    expect(MIGRATION_FAILURE_REASONS).toContain(r.error.reason);
    expect(r.error.reason).toBe("apply_failed_restored");
    expect(r.error.restored).toBe(true);
    expect(r.error.dialect).toBe("sqlite");
    expect(r.error.repair.length).toBeGreaterThan(0);
    expect(r.error.repair.toLowerCase()).toMatch(/restore|backup/);
    // The underlying driver cause is carried (kept opaque to callers).
    expect(r.error.cause).toBeDefined();

    // Restore swapped to the pre-migration snapshot → the connection is replaced
    // and the failed connection is closed (proof the restore path executed, not
    // merely drizzle's own per-run transaction rollback).
    expect(engine.connection).not.toBe(original);
    expect(original.open).toBe(false);
    expect(engine.connection.open).toBe(true);

    // The DB is EXACTLY the pre-migration state: data intact, no half-applied
    // schema, no schema-version bump, no drizzle journal.
    expect(engine.connection.prepare('SELECT v FROM "ops_data"').all()).toEqual([
      { v: "pre-migration" },
    ]);
    expect(tableExists(engine.connection, "broken_table")).toBe(false);
    expect(tableExists(engine.connection, "__drizzle_migrations")).toBe(false);
    expect(userVersion(engine.connection)).toBe(0);
  });
});

// --- stub engines: exercise the runner's orchestration branches in isolation ---
class StubEngine implements MigrationEngine {
  readonly dialect = "sqlite" as const;
  backupCalls = 0;
  migrateCalls = 0;
  restoreCalls = 0;
  recordCalls = 0;
  constructor(
    private readonly behavior: {
      backup?: Result<MigrationBackup, DbError>;
      migrate?: Result<MigrationApplied, DbError>;
      restore?: Result<void, DbError>;
      record?: Result<void, DbError>;
    },
  ) {}
  backup(): Result<MigrationBackup, DbError> {
    this.backupCalls += 1;
    return (
      this.behavior.backup ??
      ok({ dialect: "sqlite", snapshot: null, capturedAt: "2026-06-30T00:00:00.000Z" })
    );
  }
  migrate(): Result<MigrationApplied, DbError> {
    this.migrateCalls += 1;
    return this.behavior.migrate ?? ok({ applied: 1 });
  }
  restore(): Result<void, DbError> {
    this.restoreCalls += 1;
    return this.behavior.restore ?? ok(undefined);
  }
  recordApply(): Result<void, DbError> {
    this.recordCalls += 1;
    return this.behavior.record ?? ok(undefined);
  }
}

describe("2.6 applyMigrations — lifecycle orchestration (dialect-agnostic branches)", () => {
  it("backup-before-migrate is MANDATORY — a backup failure refuses to apply", () => {
    const engine = new StubEngine({
      backup: err<DbError>({ code: "unavailable", message: "disk full" }),
    });
    const r = applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("backup_failed");
    expect(r.error.restored).toBe(false);
    expect(r.error.repair.length).toBeGreaterThan(0);
    // Crucially: migration was NEVER attempted without a backup in hand.
    expect(engine.migrateCalls).toBe(0);
    expect(engine.restoreCalls).toBe(0);
  });

  it("apply fails AND restore fails → catastrophic, manual-recovery typed refusal", () => {
    const engine = new StubEngine({
      migrate: err<DbError>({ code: "constraint_violation", message: "bad ddl" }),
      restore: err<DbError>({ code: "unavailable", message: "backup unreadable" }),
    });
    const r = applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("apply_failed_unrestorable");
    expect(r.error.restored).toBe(false);
    expect(r.error.cause?.code).toBe("constraint_violation");
    expect(r.error.restoreCause?.code).toBe("unavailable");
    expect(r.error.repair.toLowerCase()).toMatch(/manual|external|do not start/);
  });

  it("apply succeeds but recording the marker fails → typed record_failed (data valid)", () => {
    const engine = new StubEngine({
      record: err<DbError>({ code: "unknown", message: "pragma failed" }),
    });
    const r = applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("record_failed");
    expect(r.error.restored).toBe(false); // migrations ARE applied; not rolled back
    expect(engine.restoreCalls).toBe(0);
    expect(engine.recordCalls).toBe(1);
  });
});
