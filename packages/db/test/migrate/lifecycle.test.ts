// spec(§12) spec(§13) — migration contract test + rollback lifecycle (backup/restore-on-failure)
// Phase-2 task 2.6 / 2.9 — migration apply LIFECYCLE, DUAL-DIALECT (UNIT).
//
// ARCHITECTURE §4 (Operational Storage, failure modes): "back up the operational
// DB before applying any migration; run migrations transactionally where the
// engine allows; on partial/failed apply, restore from the pre-migration backup
// and refuse to start with a typed repair message; record an app-version ↔
// schema-version compatibility check ... (no silent forward-only break). Down-
// migration or restore-from-backup is the rollback path (Drizzle is forward-only by
// default)." §16 mandates a TYPED result with explicit failure variants + repair.
//
// DUAL-DIALECT (§12 / REQ-D-003): the lifecycle invariants live in the dialect-
// agnostic runner (`runner.ts`), so the SAME `applyMigrations` orchestration is
// proven here over BOTH concrete engines — the SQLite engine (better-sqlite3
// serialize/deserialize over `new Database(':memory:')`) AND the Postgres engine
// (`dumpDataDir`/`loadDataDir` over `new PGlite()` = in-process real PG16). Each
// lifecycle case below runs for BOTH via `defineLifecycleSuite(fixture)`; no server
// is required. (The earlier note claiming pg was "exercised by the contract suite"
// was inaccurate — pg is exercised HERE, directly.) An optional Docker-pg run
// (node-postgres against postgres:16) is gated on SOW_PG_DOCKER=1 and skipped by
// default.
//
// Coverage (per dialect):
//   - happy apply over the REAL generated genesis migration → all domains created,
//     applied count + schema-version marker recorded, NO restore (handle unchanged);
//   - idempotent re-run: already-applied → applied=0, still Ok, marker intact;
//   - FAIL → restore → typed repair: a deliberately-broken migration is injected;
//     the DB is restored to its EXACT pre-migration state and a typed refusal with
//     an actionable repair is returned (no half-applied schema).
// Dialect-agnostic orchestration branches (mandatory backup, catastrophic
// unrestorable, record_failed) are driven once via stub engines.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk, ok, err, type Result } from "@sow/contracts";

import {
  applyMigrations,
  MIGRATION_FAILURE_REASONS,
  type MigrationBackup,
  type MigrationApplied,
  type MigrationDialect,
  type MigrationEngine,
} from "../../src/migrate/runner";
import { createSqliteMigrationEngine } from "../../src/migrate/sqlite-engine";
import { createPgMigrationEngine } from "../../src/migrate/pg-engine";
import { CURRENT_SCHEMA_VERSION } from "../../src/migrate/version-compat";
import type { DbError } from "../../src/repositories/interfaces";

type Conn = InstanceType<typeof Database>;

// Absolute paths to the REAL generated genesis migration sets (task-2.6 deliverables).
const REAL_SQLITE_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/sqlite", import.meta.url),
);
const REAL_PG_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/pg", import.meta.url),
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

// PGlite constructs a real PG16 in wasm; several instances per case → wide timeout.
const CASE_TIMEOUT_MS = 30_000;

// --- temp-fixture bookkeeping ---------------------------------------------
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try {
      await c();
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

/** Write a drizzle-format migrations folder (meta/_journal.json + <tag>.sql). */
function writeMigrationsFolder(
  dialect: "sqlite" | "postgresql",
  files: ReadonlyArray<{ tag: string; sql: string }>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-mig-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = files.map((f, idx) => ({
    idx,
    version: "7",
    when: 1_700_000_000_000 + idx,
    tag: f.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect, entries }, null, 2),
  );
  for (const f of files) writeFileSync(join(dir, `${f.tag}.sql`), f.sql);
  return dir;
}

/** A migration whose 2nd statement fails (insert into a non-existent table). */
const BROKEN_MIGRATION = {
  tag: "0000_broken",
  sql:
    'CREATE TABLE "broken_table" ("id" integer PRIMARY KEY)\n' +
    "--> statement-breakpoint\n" +
    'INSERT INTO "table_that_does_not_exist" ("id") VALUES (1)',
};

// --- per-dialect fixture --------------------------------------------------
/** One concrete operational-store dialect under test (H = its live handle type). */
interface LifecycleFixture<H> {
  readonly name: string;
  readonly dialect: MigrationDialect;
  readonly realMigrations: string;
  /** Stand up a fresh engine; `live()` returns the CURRENT handle (restore-aware). */
  make(): Promise<{ engine: MigrationEngine; live: () => H }>;
  seedOps(h: H): Promise<void>;
  opsRows(h: H): Promise<Array<{ v: string }>>;
  tableExists(h: H, name: string): Promise<boolean>;
  userVersion(h: H): Promise<number>;
  isOpen(h: H): boolean;
  failingMigrations(): string;
}

const sqliteFixture: LifecycleFixture<Conn> = {
  name: "sqlite",
  dialect: "sqlite",
  realMigrations: REAL_SQLITE_MIGRATIONS,
  make() {
    const engine = createSqliteMigrationEngine(new Database(":memory:"));
    cleanups.push(() => {
      const c = engine.connection;
      if (c.open) c.close();
    });
    return Promise.resolve({ engine, live: () => engine.connection });
  },
  seedOps(conn) {
    conn.exec('CREATE TABLE "ops_data" ("id" integer PRIMARY KEY, "v" text NOT NULL)');
    conn.prepare('INSERT INTO "ops_data" ("v") VALUES (?)').run("pre-migration");
    return Promise.resolve();
  },
  opsRows(conn) {
    return Promise.resolve(
      conn.prepare('SELECT v FROM "ops_data"').all() as Array<{ v: string }>,
    );
  },
  tableExists(conn, name) {
    const row = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { name?: string } | undefined;
    return Promise.resolve(row?.name === name);
  },
  userVersion(conn) {
    return Promise.resolve(conn.pragma("user_version", { simple: true }) as number);
  },
  isOpen(conn) {
    return conn.open;
  },
  failingMigrations() {
    return writeMigrationsFolder("sqlite", [BROKEN_MIGRATION]);
  },
};

const pgFixture: LifecycleFixture<PGlite> = {
  name: "postgres-pglite",
  dialect: "pg",
  realMigrations: REAL_PG_MIGRATIONS,
  make() {
    const engine = createPgMigrationEngine(new PGlite());
    cleanups.push(async () => {
      const c = engine.client;
      if (!c.closed) await c.close();
    });
    return Promise.resolve({ engine, live: () => engine.client });
  },
  async seedOps(client) {
    await client.exec(
      'CREATE TABLE "ops_data" ("id" serial PRIMARY KEY, "v" text NOT NULL);',
    );
    await client.query('INSERT INTO "ops_data" ("v") VALUES ($1)', ["pre-migration"]);
  },
  async opsRows(client) {
    const r = await client.query<{ v: string }>('SELECT v FROM "ops_data"');
    return r.rows;
  },
  async tableExists(client, name) {
    const r = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [name],
    );
    return r.rows.length > 0;
  },
  async userVersion(client) {
    try {
      const r = await client.query<{ version: number }>(
        'SELECT version FROM "_sow_schema_version" LIMIT 1',
      );
      const v = r.rows[0]?.version;
      return typeof v === "number" ? v : 0;
    } catch {
      return 0; // marker table absent (pre-migration / restored state) → 0
    }
  },
  isOpen(client) {
    return !client.closed;
  },
  failingMigrations() {
    return writeMigrationsFolder("postgresql", [BROKEN_MIGRATION]);
  },
};

// =====================================================================
function defineLifecycleSuite<H>(fix: LifecycleFixture<H>): void {
  describe(`2.6/2.9 applyMigrations lifecycle — ${fix.name}`, () => {
    it(
      "backs up, applies the real genesis, records the marker; no restore",
      async () => {
        const { engine, live } = await fix.make();
        const original = live();
        await fix.seedOps(original);

        const r = await applyMigrations(engine, { migrationsFolder: fix.realMigrations });

        expect(isOk(r)).toBe(true);
        if (!isOk(r)) return;
        expect(r.value.dialect).toBe(fix.dialect);
        // The real migration set is now 0000_genesis + 0001_approvals_workspace_id +
        // 0002_audit_workspace_id + 0003_approvals_semantic_subject (§13.10a — the
        // subjectKind/planRef add + actionRef→nullable; SQLite table-recreate, pg ALTER),
        // all applied from empty.
        expect(r.value.applied).toBe(4);
        expect(r.value.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        expect(r.value.backup.dialect).toBe(fix.dialect);

        // A successful apply NEVER restores → the live handle identity is unchanged.
        expect(live()).toBe(original);
        expect(fix.isOpen(live())).toBe(true);

        // Every operational domain table exists; the schema-version marker recorded.
        for (const t of DOMAIN_TABLES) {
          expect(await fix.tableExists(live(), t), `table ${t}`).toBe(true);
        }
        expect(await fix.userVersion(live())).toBe(CURRENT_SCHEMA_VERSION);

        // Pre-existing operational data is untouched by a forward apply.
        expect(await fix.opsRows(live())).toEqual([{ v: "pre-migration" }]);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "is idempotent — re-applying the same set is a no-op (applied=0), still Ok",
      async () => {
        const { engine, live } = await fix.make();

        const first = await applyMigrations(engine, { migrationsFolder: fix.realMigrations });
        expect(isOk(first)).toBe(true);

        const second = await applyMigrations(engine, { migrationsFolder: fix.realMigrations });
        expect(isOk(second)).toBe(true);
        if (!isOk(second)) return;
        expect(second.value.applied).toBe(0);
        expect(await fix.userVersion(live())).toBe(CURRENT_SCHEMA_VERSION);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "FAILED apply restores to the EXACT pre-migration state + returns a typed repair",
      async () => {
        const { engine, live } = await fix.make();
        const original = live();
        await fix.seedOps(original);

        const r = await applyMigrations(engine, { migrationsFolder: fix.failingMigrations() });

        // Typed refusal (§16): a closed-set reason + a non-empty actionable repair.
        expect(isErr(r)).toBe(true);
        if (!isErr(r)) return;
        expect(r.error.kind).toBe("migration_failure");
        expect(MIGRATION_FAILURE_REASONS).toContain(r.error.reason);
        expect(r.error.reason).toBe("apply_failed_restored");
        expect(r.error.restored).toBe(true);
        expect(r.error.dialect).toBe(fix.dialect);
        expect(r.error.repair.length).toBeGreaterThan(0);
        expect(r.error.repair.toLowerCase()).toMatch(/restore|backup/);
        expect(r.error.cause).toBeDefined();

        // Restore swapped in the pre-migration snapshot → the live handle is replaced
        // and the FAILED handle is closed (proof the restore path executed, not merely
        // the engine's own per-run transaction rollback).
        expect(live()).not.toBe(original);
        expect(fix.isOpen(original)).toBe(false);
        expect(fix.isOpen(live())).toBe(true);

        // EXACTLY the pre-migration state: data intact, no half-applied schema, no
        // schema-version bump, no drizzle journal in the operational schema.
        expect(await fix.opsRows(live())).toEqual([{ v: "pre-migration" }]);
        expect(await fix.tableExists(live(), "broken_table")).toBe(false);
        expect(await fix.tableExists(live(), "__drizzle_migrations")).toBe(false);
        expect(await fix.userVersion(live())).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });
}

defineLifecycleSuite(sqliteFixture);
defineLifecycleSuite(pgFixture);

// Optional Docker-pg lifecycle run (node-postgres against a real postgres:16) — a
// separate, env-gated path, skipped by default (the pglite fixture above already
// proves the pg lifecycle server-free).
describe.skipIf(process.env.SOW_PG_DOCKER !== "1")(
  "2.9 applyMigrations lifecycle — postgres (Docker, node-postgres) [SOW_PG_DOCKER=1]",
  () => {
    it.todo("drive the same lifecycle against a Docker postgres:16 via node-postgres");
  },
);

// --- stub engines: exercise the runner's orchestration branches in isolation ---
class StubEngine implements MigrationEngine {
  readonly dialect: MigrationDialect = "sqlite";
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
  backup(): Promise<Result<MigrationBackup, DbError>> {
    this.backupCalls += 1;
    return Promise.resolve(
      this.behavior.backup ??
        ok({ dialect: "sqlite", snapshot: null, capturedAt: "2026-06-30T00:00:00.000Z" }),
    );
  }
  migrate(): Promise<Result<MigrationApplied, DbError>> {
    this.migrateCalls += 1;
    return Promise.resolve(this.behavior.migrate ?? ok({ applied: 1 }));
  }
  restore(): Promise<Result<void, DbError>> {
    this.restoreCalls += 1;
    return Promise.resolve(this.behavior.restore ?? ok(undefined));
  }
  recordApply(): Promise<Result<void, DbError>> {
    this.recordCalls += 1;
    return Promise.resolve(this.behavior.record ?? ok(undefined));
  }
}

describe("2.6 applyMigrations — lifecycle orchestration (dialect-agnostic branches)", () => {
  it("backup-before-migrate is MANDATORY — a backup failure refuses to apply", async () => {
    const engine = new StubEngine({
      backup: err<DbError>({ code: "unavailable", message: "disk full" }),
    });
    const r = await applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("backup_failed");
    expect(r.error.restored).toBe(false);
    expect(r.error.repair.length).toBeGreaterThan(0);
    // Crucially: migration was NEVER attempted without a backup in hand.
    expect(engine.migrateCalls).toBe(0);
    expect(engine.restoreCalls).toBe(0);
  });

  it("apply fails AND restore fails → catastrophic, manual-recovery typed refusal", async () => {
    const engine = new StubEngine({
      migrate: err<DbError>({ code: "constraint_violation", message: "bad ddl" }),
      restore: err<DbError>({ code: "unavailable", message: "backup unreadable" }),
    });
    const r = await applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("apply_failed_unrestorable");
    expect(r.error.restored).toBe(false);
    expect(r.error.cause?.code).toBe("constraint_violation");
    expect(r.error.restoreCause?.code).toBe("unavailable");
    expect(r.error.repair.toLowerCase()).toMatch(/manual|external|do not start/);
  });

  it("apply succeeds but recording the marker fails → typed record_failed (data valid)", async () => {
    const engine = new StubEngine({
      record: err<DbError>({ code: "unknown", message: "pragma failed" }),
    });
    const r = await applyMigrations(engine, { migrationsFolder: "/unused" });

    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("record_failed");
    expect(r.error.restored).toBe(false); // migrations ARE applied; not rolled back
    expect(engine.restoreCalls).toBe(0);
    expect(engine.recordCalls).toBe(1);
  });
});
