// Phase-2 task 2.6 / 2.9 — Postgres migration ENGINE (drizzle-orm/pglite, §4 / §13).
//
// The concrete {@link MigrationEngine} for the HOSTED-compatible operational store:
// the dual-dialect parity twin of `sqlite-engine.ts`. It supplies the same four
// dialect-specific lifecycle primitives the dialect-agnostic runner (`runner.ts`)
// orchestrates — so the runner drives SQLite and Postgres through the IDENTICAL
// backup → apply → (restore on failure) → record lifecycle (REQ-D-003 / task 2.9):
//
//   - backup()      → `dumpDataDir()` serializes the whole PGlite data directory to
//                     a tarball Buffer (the Postgres analogue of SQLite `serialize()`).
//   - migrate()     → drizzle's pglite migrator applies the pending migrations; the
//                     newly-applied count is read from drizzle's own journal table.
//   - restore()     → `new PGlite({ loadDataDir })` reloads the pre-migration dump
//                     into a FRESH client and swaps it in (there is no in-place
//                     reload); the failed client is closed. Restore-from-backup IS the
//                     rollback path (drizzle is forward-only) — §4.
//   - recordApply() → upsert the schema-version marker into a `_sow_schema_version`
//                     table (Postgres has no `PRAGMA user_version`).
//
// ERROR CONVENTION (§16): NOTHING throws across the boundary — every driver throw is
// caught and mapped to the closed `DbError` taxonomy via the Postgres `toDbError`
// (the same SQLSTATE mapper the pg adapter uses, task 2.4). The runner turns a failed
// step into a typed `MigrationFailure` with an actionable repair.
//
// This engine is async because PGlite is async end-to-end (in-process real PG16); the
// runner + `MigrationEngine` port are async so BOTH engines satisfy the same contract.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzleMigrate } from "drizzle-orm/pglite/migrator";
import { err, ok, type Result } from "@sow/contracts";

import { toDbError } from "../adapters/postgres/errors";
import type { DbError } from "../repositories/interfaces";
import type {
  MigrationApplied,
  MigrationBackup,
  MigrationEngine,
} from "./runner";

/** On-disk schema-version marker table (Postgres has no `PRAGMA user_version`). */
const SCHEMA_VERSION_TABLE = "_sow_schema_version";

/**
 * Postgres {@link MigrationEngine} over an in-process PGlite (real PG16). Owns the
 * live client: {@link restore} swaps it for a fresh client reloaded from the backup,
 * so callers MUST read the current handle through {@link client} after any restore
 * (the original is closed). Mirrors the SQLite engine's single-owner semantics.
 */
class PgMigrationEngine implements MigrationEngine {
  readonly dialect = "pg" as const;
  #client: PGlite;

  constructor(client: PGlite) {
    this.#client = client;
  }

  /** The LIVE client (replaced on {@link restore}; the original is then closed). */
  get client(): PGlite {
    return this.#client;
  }

  async backup(): Promise<Result<MigrationBackup, DbError>> {
    try {
      const dump = await this.#client.dumpDataDir();
      const snapshot = Buffer.from(await dump.arrayBuffer());
      return ok({
        dialect: this.dialect,
        snapshot,
        capturedAt: new Date().toISOString(),
      });
    } catch (cause) {
      return err(toDbError(cause, "failed to capture pre-migration postgres backup"));
    }
  }

  async migrate(migrationsFolder: string): Promise<Result<MigrationApplied, DbError>> {
    try {
      const before = await this.#appliedCount();
      await drizzleMigrate(drizzle(this.#client), { migrationsFolder });
      const after = await this.#appliedCount();
      // drizzle's pglite migrator records each applied migration in its own journal
      // table; the journal grew by exactly the number of newly-applied migrations.
      return ok({ applied: Math.max(0, after - before) });
    } catch (cause) {
      return err(toDbError(cause, "postgres migration apply failed"));
    }
  }

  async restore(backup: MigrationBackup): Promise<Result<void, DbError>> {
    if (!Buffer.isBuffer(backup.snapshot)) {
      return err({
        code: "unknown",
        message: "postgres restore: backup snapshot is not a Buffer",
      });
    }
    let fresh: PGlite;
    try {
      fresh = new PGlite({ loadDataDir: new Blob([backup.snapshot]) });
      // Force initialization now so a corrupt/truncated dump fails HERE (typed err),
      // not lazily on the caller's next query.
      await fresh.query("SELECT 1");
    } catch (cause) {
      return err(
        toDbError(cause, "failed to restore postgres from pre-migration backup"),
      );
    }
    // Best-effort close of the failed client before swapping it out.
    try {
      if (!this.#client.closed) await this.#client.close();
    } catch {
      /* the failed client may already be unusable — ignore */
    }
    this.#client = fresh;
    return ok(undefined);
  }

  async recordApply(schemaVersion: number): Promise<Result<void, DbError>> {
    try {
      // The value is a safe integer; embed it as a literal (DDL + single-row marker).
      const v = Math.trunc(schemaVersion);
      await this.#client.exec(
        `CREATE TABLE IF NOT EXISTS "${SCHEMA_VERSION_TABLE}" ("version" integer NOT NULL);` +
          `DELETE FROM "${SCHEMA_VERSION_TABLE}";` +
          `INSERT INTO "${SCHEMA_VERSION_TABLE}" ("version") VALUES (${v});`,
      );
      return ok(undefined);
    } catch (cause) {
      return err(
        toDbError(cause, "failed to record postgres schema-version marker"),
      );
    }
  }

  /** Count rows in drizzle's pglite journal table (0 when it does not yet exist). */
  async #appliedCount(): Promise<number> {
    try {
      const r = await this.#client.query<{ c: number }>(
        'SELECT count(*)::int AS c FROM drizzle."__drizzle_migrations"',
      );
      const c = r.rows[0]?.c;
      return typeof c === "number" ? c : 0;
    } catch {
      return 0; // schema/table absent on a fresh DB → zero applied so far
    }
  }
}

/** Construct the Postgres migration engine over an open PGlite (PG16) client. */
export function createPgMigrationEngine(client: PGlite): PgMigrationEngine {
  return new PgMigrationEngine(client);
}

export { SCHEMA_VERSION_TABLE };
export type { PgMigrationEngine };
