// spec(§4) spec(§13.15) — schema↔migration coverage detector (task 24.39).
//
// THE DEFECT THIS FILE EXISTS TO CATCH, AND WHY NO EXISTING TEST COULD: the
// repository-contract suite (`test/contract/repository-contract.test.ts`)
// builds its test databases DIRECTLY FROM THE DRIZZLE SCHEMA (via
// `createSqliteSchema`/`createPgSchema`, `test/adapters/create-*-schema.ts`
// — DDL generated from `getTableConfig(table)`, never a migration file) and
// never calls `applyMigrations()`. So a schema table with no generated
// migration passes every repository test while the REAL migration-runner
// deployment path could never produce it — exactly how task 13.15's `task`
// table shipped `[x]` DONE with a green suite and zero rows in either
// `migrations/` dialect (24.39). This file is the detector: it builds its
// databases the OTHER way — via the REAL `applyMigrations()` lifecycle over
// the REAL `migrations/{sqlite,pg}` folders — so a schema table with no
// migration FAILS HERE.
//
// The "every schema table" set is enumerated PROGRAMMATICALLY off the schema
// barrel (`is(value, Table)` + `getTableName`), never a hand-maintained
// array — a hardcoded list is a snapshot that goes stale the next time
// someone adds a schema file, which is this task's failure mode one level up
// (see `create-sqlite-schema.ts`'s own `TABLES` array for the pattern this
// file deliberately does not repeat).
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { is, Table, getTableName } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { isOk } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";

import { applyMigrations } from "../../src/migrate/runner";
import {
  createSqliteMigrationEngine,
  DRIZZLE_JOURNAL_TABLE as SQLITE_JOURNAL_TABLE,
} from "../../src/migrate/sqlite-engine";
import { createPgMigrationEngine, SCHEMA_VERSION_TABLE as PG_MARKER_TABLE } from "../../src/migrate/pg-engine";
import { createSqliteRepositories } from "../../src/adapters/sqlite/index";
import { createPostgresRepositories } from "../../src/adapters/postgres/index";
import * as sqliteSchema from "../../src/schema/index";
import * as pgSchema from "../../src/schema/pg/index";
import type { TaskRow } from "../../src/repositories/interfaces";

const REAL_SQLITE_MIGRATIONS = fileURLToPath(
  new URL("../../migrations/sqlite", import.meta.url),
);
const REAL_PG_MIGRATIONS = fileURLToPath(new URL("../../migrations/pg", import.meta.url));

// PGlite constructs a real PG16 in wasm; mirrors lifecycle.test.ts's wide timeout.
const CASE_TIMEOUT_MS = 30_000;

/** Every table the given schema barrel module declares — derived, never hand-listed. */
function schemaTableNames(barrel: Record<string, unknown>): string[] {
  return Object.values(barrel)
    .filter((v): v is Table => is(v, Table))
    .map((t) => getTableName(t))
    .sort();
}

async function actualSqliteTableNames(conn: InstanceType<typeof Database>): Promise<string[]> {
  const rows = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

async function actualPgTableNames(client: PGlite): Promise<string[]> {
  const r = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  );
  return r.rows.map((row) => row.table_name).sort();
}

// Migration-LIFECYCLE machinery tables — legitimately present in a migrated DB
// without being schema-barrel domain tables, so a bidirectional (24.43) check must
// exclude them from the "orphan" direction. A FIXED, closed set defined by the
// migration engines themselves, not a hand-list that drifts as domain tables are
// added (the anti-pattern this task exists to eliminate) — it only grows if the
// migration engine's OWN bookkeeping shape changes, which is a different failure
// mode entirely. Both entries are imported from their engine's own export
// (`sqlite-engine.ts`'s `DRIZZLE_JOURNAL_TABLE`, `pg-engine.ts`'s
// `SCHEMA_VERSION_TABLE`) rather than duplicated as literals — this repo's L5/L37
// single-sourcing rule, not L88's "equal but independent" counter-case: if drizzle
// ever renames its journal table, the engine's own query AND this exclusion must
// change together, so they share one source of truth. pg's own
// `drizzle."__drizzle_migrations"` journal needs NO entry here at all — it lives
// outside the `public` schema `actualPgTableNames` is scoped to (verified at
// pg-engine.ts:161), so it never appears in `actual` to begin with.
//
// ⚠ THE RISK DIRECTION HERE IS THE OPPOSITE OF `DOMAIN_TABLES`'s (the array 24.43
// deleted from lifecycle.test.ts): that one failed by UNDER-reporting (silently
// passing over tables it didn't list). This is a DENYLIST on the orphan check, so
// it fails the OTHER way — if drizzle ever adds a second bookkeeping table, the
// orphan test below goes RED *spuriously*. The reflexive fix for a spurious RED is
// to widen the exclusion — which is exactly how a denylist rots into the next
// `DOMAIN_TABLES`. A new entry here needs a REASON ("this is engine bookkeeping,
// here is the engine line that creates it"), never just a name added to make a
// test pass.
const SQLITE_INFRA_TABLES = new Set([SQLITE_JOURNAL_TABLE]);
const PG_INFRA_TABLES = new Set([PG_MARKER_TABLE]);

/** Tables present in `actual` that are neither declared by the schema barrel nor known migration-lifecycle infra. */
function orphanTables(actual: string[], declared: string[], infra: ReadonlySet<string>): string[] {
  const declaredSet = new Set(declared);
  return actual.filter((t) => !declaredSet.has(t) && !infra.has(t));
}

// Populated only as each dialect's `it` body actually RUNS — a runtime propagation
// check, not a static array — so a dialect silently skipped (the default vitest
// reporter's terminal-overwrite quirk under capture made exactly this ambiguous
// for a predecessor slice, session doc 153) fails loudly here instead of reading
// as "ran, just not shown."
const RAN_DIALECTS = new Set<string>();

// Mirrors column-parity.test.ts's "each parity model contributes a non-empty
// frozen field set" (:99-103) one level up: defends `migrated_database_has_
// every_schema_table` against silently passing over NOTHING if the barrel walk
// itself ever regresses to empty (an `is`/import-shape drift upstream) — that
// assertion only proves "declared ⊆ actual," which is vacuously true for an
// empty declared set, and it would pass loudly and greenly while reporting
// coverage. This is the "delete the feature, does the guard still pass" case
// (L90) for the detector's own enumeration step.
describe("24.39 — schema barrel enumeration is non-vacuous", () => {
  it("the sqlite schema barrel walk yields a non-empty table set", () => {
    expect(
      schemaTableNames(sqliteSchema as unknown as Record<string, unknown>).length,
    ).toBeGreaterThan(0);
  });

  it("the pg schema barrel walk yields a non-empty table set", () => {
    expect(schemaTableNames(pgSchema as unknown as Record<string, unknown>).length).toBeGreaterThan(
      0,
    );
  });
});

// Companion to the "schema barrel enumeration is non-vacuous" block above: THAT
// block guards the declared side statically (no DB needed). This guards BOTH
// sides against the real migrated DB — an empty `actual` would let the 24.43
// orphan check below pass vacuously (nothing to be an orphan), the same failure
// shape one direction over. Self-contained: this file's bidirectional guarantee
// doesn't depend on the declared-side block above still existing unchanged.
describe("24.43 — detector_is_non_vacuous_in_both_directions", () => {
  it("sqlite: both the declared set and the migrated set are non-empty", async () => {
    const conn = new Database(":memory:");
    try {
      const engine = createSqliteMigrationEngine(conn);
      const applied = await applyMigrations(engine, { migrationsFolder: REAL_SQLITE_MIGRATIONS });
      expect(isOk(applied)).toBe(true);
      expect(schemaTableNames(sqliteSchema as unknown as Record<string, unknown>).length).toBeGreaterThan(0);
      expect((await actualSqliteTableNames(engine.connection)).length).toBeGreaterThan(0);
    } finally {
      conn.close();
    }
  }, CASE_TIMEOUT_MS);

  it("pg: both the declared set and the migrated set are non-empty", async () => {
    const client = new PGlite();
    try {
      const engine = createPgMigrationEngine(client);
      const applied = await applyMigrations(engine, { migrationsFolder: REAL_PG_MIGRATIONS });
      expect(isOk(applied)).toBe(true);
      expect(schemaTableNames(pgSchema as unknown as Record<string, unknown>).length).toBeGreaterThan(0);
      expect((await actualPgTableNames(engine.client)).length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, CASE_TIMEOUT_MS);
});

describe("24.39 — migrated_database_has_every_schema_table (sqlite)", () => {
  it(
    "a database built via applyMigrations() over the real sqlite migrations contains every table the sqlite schema barrel declares",
    async () => {
      RAN_DIALECTS.add("sqlite");
      const conn = new Database(":memory:");
      try {
        const engine = createSqliteMigrationEngine(conn);
        const applied = await applyMigrations(engine, {
          migrationsFolder: REAL_SQLITE_MIGRATIONS,
        });
        expect(isOk(applied)).toBe(true);

        const declared = schemaTableNames(sqliteSchema as unknown as Record<string, unknown>);
        const actual = await actualSqliteTableNames(engine.connection);
        const missing = declared.filter((t) => !actual.includes(t));
        expect(missing, `schema table(s) with no sqlite migration: ${missing.join(", ")}`).toEqual(
          [],
        );
      } finally {
        conn.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

// LEG B (24.43) — the mirror direction: a migration creating a table the schema
// no longer declares would go unnoticed by the "every schema table" check above
// (that direction only proves declared ⊆ actual). Excludes the fixed migration-
// lifecycle infra set (SQLITE_INFRA_TABLES), never a domain table.
describe("24.43 — migrated_database_has_no_table_the_schema_does_not_declare (sqlite)", () => {
  it(
    "a database built via applyMigrations() over the real sqlite migrations creates no table beyond the sqlite schema barrel (+ known migration-lifecycle bookkeeping)",
    async () => {
      const conn = new Database(":memory:");
      try {
        const engine = createSqliteMigrationEngine(conn);
        const applied = await applyMigrations(engine, {
          migrationsFolder: REAL_SQLITE_MIGRATIONS,
        });
        expect(isOk(applied)).toBe(true);

        const declared = schemaTableNames(sqliteSchema as unknown as Record<string, unknown>);
        const actual = await actualSqliteTableNames(engine.connection);
        const extra = orphanTables(actual, declared, SQLITE_INFRA_TABLES);
        expect(
          extra,
          `table(s) a sqlite migration creates but the schema barrel no longer declares: ${extra.join(", ")}`,
        ).toEqual([]);
      } finally {
        conn.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

describe("24.39 — migrated_database_has_every_schema_table (pg)", () => {
  it(
    "a database built via applyMigrations() over the real pg migrations contains every table the pg schema barrel declares",
    async () => {
      RAN_DIALECTS.add("pg");
      const client = new PGlite();
      try {
        const engine = createPgMigrationEngine(client);
        const applied = await applyMigrations(engine, { migrationsFolder: REAL_PG_MIGRATIONS });
        expect(isOk(applied)).toBe(true);

        const declared = schemaTableNames(pgSchema as unknown as Record<string, unknown>);
        const actual = await actualPgTableNames(engine.client);
        const missing = declared.filter((t) => !actual.includes(t));
        expect(missing, `schema table(s) with no pg migration: ${missing.join(", ")}`).toEqual([]);
      } finally {
        await client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

// LEG B (24.43), pg leg — see the sqlite block above for the full rationale.
describe("24.43 — migrated_database_has_no_table_the_schema_does_not_declare (pg)", () => {
  it(
    "a database built via applyMigrations() over the real pg migrations creates no table beyond the pg schema barrel (+ known migration-lifecycle bookkeeping)",
    async () => {
      const client = new PGlite();
      try {
        const engine = createPgMigrationEngine(client);
        const applied = await applyMigrations(engine, { migrationsFolder: REAL_PG_MIGRATIONS });
        expect(isOk(applied)).toBe(true);

        const declared = schemaTableNames(pgSchema as unknown as Record<string, unknown>);
        const actual = await actualPgTableNames(engine.client);
        const extra = orphanTables(actual, declared, PG_INFRA_TABLES);
        expect(
          extra,
          `table(s) a pg migration creates but the schema barrel no longer declares: ${extra.join(", ")}`,
        ).toEqual([]);
      } finally {
        await client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

describe("24.39 — task_table_round_trips_through_a_migrated_database", () => {
  const taskRow = (): TaskRow => ({
    taskId: "mig-1",
    workspaceId: "personal-business" as WorkspaceId,
    title: "Confirm the migrated schema matches the drizzle schema",
    status: "in_progress",
  });

  it(
    "TaskRepository upsert → get round-trips against a DB built by the sqlite migration path (not the schema path)",
    async () => {
      const conn = new Database(":memory:");
      try {
        const engine = createSqliteMigrationEngine(conn);
        const applied = await applyMigrations(engine, {
          migrationsFolder: REAL_SQLITE_MIGRATIONS,
        });
        expect(isOk(applied)).toBe(true);

        const repos = createSqliteRepositories(drizzleSqlite(engine.connection));
        const row = taskRow();
        const up = await repos.task.upsert(row);
        expect(isOk(up)).toBe(true);
        const got = await repos.task.get(row.taskId);
        expect(isOk(got)).toBe(true);
        if (isOk(got)) expect(got.value).toEqual(row);
      } finally {
        conn.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "TaskRepository upsert → get round-trips against a DB built by the pg migration path (not the schema path)",
    async () => {
      const client = new PGlite();
      try {
        const engine = createPgMigrationEngine(client);
        const applied = await applyMigrations(engine, { migrationsFolder: REAL_PG_MIGRATIONS });
        expect(isOk(applied)).toBe(true);

        const repos = createPostgresRepositories(drizzlePglite(engine.client));
        const row = taskRow();
        const up = await repos.task.upsert(row);
        expect(isOk(up)).toBe(true);
        const got = await repos.task.get(row.taskId);
        expect(isOk(got)).toBe(true);
        if (isOk(got)) expect(got.value).toEqual(row);
      } finally {
        await client.close();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

// Not RED-today (a structural safety net, mirroring this codebase's non-vacuity
// "positive control" convention, e.g. worker LESSONS #7/#28) — it pins that BOTH
// dialect legs above actually execute, so a future silent skip of one leg (via
// `.skip`, a bad `describe.each` filter, or the terminal-overwrite reporter quirk
// reading as "ran") fails loudly instead of quietly halving this file's coverage.
describe("24.39 — migration_detector_covers_both_dialects", () => {
  it("the schema-coverage detector executed for both sqlite and pg this run", () => {
    expect([...RAN_DIALECTS].sort()).toEqual(["pg", "sqlite"]);
  });
});
