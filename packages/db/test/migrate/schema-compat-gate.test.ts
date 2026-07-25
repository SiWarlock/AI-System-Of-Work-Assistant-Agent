// spec(§4) spec(§13) — task 11.2: the startup app↔schema-version compatibility gate.
//
// ARCHITECTURE §4/§13: "record an app-version ↔ schema-version compatibility check and
// refuse to run an incompatible pairing (no silent forward-only break)." The pure
// refusal predicate (`assertSchemaCompatible`, task 2.7) already exists; this slice adds
// the two primitives + the genesis-aware boot wrapper the boot gate consumes:
//   - engine `readOnDiskSchema()` — reads the on-disk marker (SQLite PRAGMA user_version /
//     Postgres `_sow_schema_version`) + whether any migration history exists (the
//     "populated" signal). Dual-dialect (REQ-D-003), driven over the REAL genesis set.
//   - pure `assertBootSchemaCompatible(onDisk, appVersion)` — genesis (fresh: marker 0 AND
//     no history) is NOT a downgrade refusal; otherwise delegate to `assertSchemaCompatible`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isOk } from "@sow/contracts";

import { applyMigrations, type MigrationEngine } from "../../src/migrate/runner";
import { createSqliteMigrationEngine } from "../../src/migrate/sqlite-engine";
import { createPgMigrationEngine } from "../../src/migrate/pg-engine";
import {
  CURRENT_SCHEMA_VERSION,
  assertBootSchemaCompatible,
  type AppSchemaCompat,
} from "../../src/migrate/version-compat";

const REAL_SQLITE_MIGRATIONS = fileURLToPath(new URL("../../migrations/sqlite", import.meta.url));
const REAL_PG_MIGRATIONS = fileURLToPath(new URL("../../migrations/pg", import.meta.url));

// PGlite constructs a real PG16 in wasm → wide timeout.
const CASE_TIMEOUT_MS = 30_000;

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

// ═══════════════════════════════════════════════════════════════════════════
// (A) engine.readOnDiskSchema() — dual-dialect, over the REAL genesis set
// ═══════════════════════════════════════════════════════════════════════════

interface EngineFixture {
  readonly name: string;
  readonly realMigrations: string;
  make(): MigrationEngine;
}

const sqliteEngineFixture: EngineFixture = {
  name: "sqlite",
  realMigrations: REAL_SQLITE_MIGRATIONS,
  make() {
    const engine = createSqliteMigrationEngine(new Database(":memory:"));
    cleanups.push(() => {
      if (engine.connection.open) engine.connection.close();
    });
    return engine;
  },
};

const pgEngineFixture: EngineFixture = {
  name: "postgres-pglite",
  realMigrations: REAL_PG_MIGRATIONS,
  make() {
    const engine = createPgMigrationEngine(new PGlite());
    cleanups.push(async () => {
      if (!engine.client.closed) await engine.client.close();
    });
    return engine;
  },
};

function defineReadSuite(fix: EngineFixture): void {
  describe(`readOnDiskSchema — ${fix.name}`, () => {
    it(
      "sqlite_read_schema_version_returns_marker: a fresh DB reports version 0 + no migration history",
      async () => {
        const engine = fix.make();
        const r = await engine.readOnDiskSchema();
        expect(isOk(r)).toBe(true);
        if (!isOk(r)) return;
        expect(r.value).toEqual({ version: 0, hasMigrationHistory: false });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "after the real genesis apply reports the recorded marker + migration history",
      async () => {
        const engine = fix.make();
        const applied = await applyMigrations(engine, { migrationsFolder: fix.realMigrations });
        expect(isOk(applied)).toBe(true);
        const r = await engine.readOnDiskSchema();
        expect(isOk(r)).toBe(true);
        if (!isOk(r)) return;
        // Assert against the imported constant (robust to a concurrent schema bump), not a literal.
        expect(r.value.version).toBe(CURRENT_SCHEMA_VERSION);
        expect(r.value.hasMigrationHistory).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );
  });
}

defineReadSuite(sqliteEngineFixture);
defineReadSuite(pgEngineFixture);

it("readOnDiskSchema returns a typed err (never throws) on a real read fault", async () => {
  const conn = new Database(":memory:");
  const engine = createSqliteMigrationEngine(conn);
  conn.close(); // force a read fault: operations on a closed better-sqlite3 handle throw
  const r = await engine.readOnDiskSchema();
  expect(isOk(r)).toBe(false); // §16: caught + folded to a typed DbError, never thrown
});

// ═══════════════════════════════════════════════════════════════════════════
// (B) assertBootSchemaCompatible — genesis vs refusal (pure, no I/O)
// ═══════════════════════════════════════════════════════════════════════════

describe("assertBootSchemaCompatible — genesis is not a refusal; incompatible pairings refuse", () => {
  const APP = "0.2.0"; // recorded: targetSchemaVersion 2, minReadableSchemaVersion 1

  it("open_database_genesis_boots_clean: genesis (version 0, no history) is compatible → migrate to target", () => {
    const r = assertBootSchemaCompatible({ version: 0, hasMigrationHistory: false }, APP);
    expect(isOk(r)).toBe(true);
  });

  it("a POPULATED DB with a zero marker (history present) is NOT genesis → refuses (fail-closed)", () => {
    const r = assertBootSchemaCompatible({ version: 0, hasMigrationHistory: true }, APP);
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("schema_below_minimum");
  });

  it("open_database_schema_ahead_refuses: on-disk schema ahead of the app → schema_ahead_of_app", () => {
    const r = assertBootSchemaCompatible({ version: 99, hasMigrationHistory: true }, APP);
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("schema_ahead_of_app");
  });

  it("open_database_below_minimum_refuses: a populated DB below the app minimum → schema_below_minimum", () => {
    // An injected future app whose minReadableSchemaVersion is 2 ⇒ an on-disk v1 is below minimum.
    const table: readonly AppSchemaCompat[] = [
      { appVersion: "future", targetSchemaVersion: 3, minReadableSchemaVersion: 2 },
    ];
    const r = assertBootSchemaCompatible({ version: 1, hasMigrationHistory: true }, "future", table);
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("schema_below_minimum");
  });

  it("open_database_compatible_pairing_proceeds: min <= onDisk <= target passes the gate", () => {
    expect(isOk(assertBootSchemaCompatible({ version: 2, hasMigrationHistory: true }, APP))).toBe(true);
    expect(isOk(assertBootSchemaCompatible({ version: 1, hasMigrationHistory: true }, APP))).toBe(true);
  });

  it("an unknown app version fails closed (unknown_app_version) even with history", () => {
    const r = assertBootSchemaCompatible({ version: 1, hasMigrationHistory: true }, "0.0.0");
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("unknown_app_version");
  });
});
