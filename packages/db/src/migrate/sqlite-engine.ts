// Phase-2 task 2.6 — SQLite migration ENGINE (better-sqlite3, §4 / §13).
//
// The concrete {@link MigrationEngine} for the LOCAL-mode operational store (§13
// opens SQLite by default). It supplies the four dialect-specific lifecycle
// primitives the dialect-agnostic runner (`runner.ts`) orchestrates:
//
//   - backup()      → serialize the DB to an in-memory Buffer snapshot (the SQLite
//                     online-backup serialization; works for `:memory:` AND file DBs).
//   - migrate()     → drizzle's better-sqlite3 migrator, which wraps the whole run
//                     in a single BEGIN/COMMIT (transactional apply where supported).
//   - restore()     → deserialize the backup Buffer into a FRESH connection and swap
//                     it in (better-sqlite3 has no in-place deserialize); the failed
//                     connection is closed. Restore-from-backup IS the rollback path
//                     (drizzle is forward-only) — §4.
//   - recordApply() → persist the schema-version marker via `PRAGMA user_version`
//                     (SQLite's built-in per-DB integer marker).
//
// ERROR CONVENTION (§16): NOTHING throws across the boundary — every driver throw
// is caught and mapped to the closed `DbError` taxonomy via `toDbError` (the same
// mapper the SQLite adapter uses, task 2.3). The runner turns a failed step into a
// typed `MigrationFailure` with an actionable repair.
//
// pg PARITY: a Postgres engine implements the SAME interface against PGlite /
// node-postgres (backup = dump, restore = reload); the dual-dialect migration
// contract suite (task 2.9) drives both engines through this same runner.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { err, ok, type Result } from "@sow/contracts";

import type { DbError } from "../repositories/interfaces";
import { toDbError } from "../adapters/sqlite/errors";
import type {
  MigrationApplied,
  MigrationBackup,
  MigrationEngine,
} from "./runner";

type Conn = InstanceType<typeof Database>;

/**
 * SQLite {@link MigrationEngine}. Owns the live connection: {@link restore} swaps
 * it for a fresh connection deserialized from the backup, so callers MUST read the
 * current handle through {@link connection} after any restore (the original is
 * closed). The engine is the single owner of the lifecycle, which is exactly the
 * real semantics — after a failed migration the worker reconnects to the restored DB.
 */
class SqliteMigrationEngine implements MigrationEngine {
  readonly dialect = "sqlite" as const;
  #conn: Conn;

  constructor(conn: Conn) {
    this.#conn = conn;
  }

  /** The LIVE connection (replaced on {@link restore}; original is then closed). */
  get connection(): Conn {
    return this.#conn;
  }

  backup(): Result<MigrationBackup, DbError> {
    try {
      const snapshot = this.#conn.serialize();
      return ok({
        dialect: this.dialect,
        snapshot,
        capturedAt: new Date().toISOString(),
      });
    } catch (cause) {
      return err(toDbError(cause, "failed to capture pre-migration sqlite backup"));
    }
  }

  migrate(migrationsFolder: string): Result<MigrationApplied, DbError> {
    try {
      const before = this.#appliedCount();
      drizzleMigrate(drizzle(this.#conn), { migrationsFolder });
      const after = this.#appliedCount();
      // drizzle is transactional per run (BEGIN/COMMIT); on success the journal
      // grew by exactly the number of newly-applied migrations.
      return ok({ applied: Math.max(0, after - before) });
    } catch (cause) {
      return err(toDbError(cause, "sqlite migration apply failed"));
    }
  }

  restore(backup: MigrationBackup): Result<void, DbError> {
    if (!Buffer.isBuffer(backup.snapshot)) {
      return err({
        code: "unknown",
        message: "sqlite restore: backup snapshot is not a Buffer",
      });
    }
    try {
      const fresh = new Database(backup.snapshot);
      // Best-effort close of the failed connection before swapping it out.
      try {
        if (this.#conn.open) this.#conn.close();
      } catch {
        /* the failed connection may already be unusable — ignore */
      }
      this.#conn = fresh;
      return ok(undefined);
    } catch (cause) {
      return err(
        toDbError(cause, "failed to restore sqlite from pre-migration backup"),
      );
    }
  }

  recordApply(schemaVersion: number): Result<void, DbError> {
    try {
      // PRAGMA does not accept bound parameters; the value is a safe integer.
      this.#conn.pragma(`user_version = ${Math.trunc(schemaVersion)}`);
      return ok(undefined);
    } catch (cause) {
      return err(
        toDbError(cause, "failed to record sqlite schema-version marker"),
      );
    }
  }

  /** Count rows in drizzle's journal table (0 when it does not yet exist). */
  #appliedCount(): number {
    try {
      const row = this.#conn
        .prepare("SELECT count(*) AS c FROM __drizzle_migrations")
        .get() as { c?: number } | undefined;
      return typeof row?.c === "number" ? row.c : 0;
    } catch {
      return 0; // table absent on a fresh DB → zero applied so far
    }
  }
}

/** Construct the SQLite migration engine over an open better-sqlite3 connection. */
export function createSqliteMigrationEngine(conn: Conn): SqliteMigrationEngine {
  return new SqliteMigrationEngine(conn);
}

export type { SqliteMigrationEngine };
