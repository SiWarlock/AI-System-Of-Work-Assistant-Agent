// spec(§16) — CostLedgerRepository (task 19.11): durable cross-run cost/budget
// ledger. ONE parameterized contract suite run identically against SQLite (real
// better-sqlite3) and Postgres (real PGlite, in-process) — mirrors
// `test/contract/gbrain-sync-outbox-contract.test.ts`'s shape for the standalone
// (task 19.1) repository pattern — plus a SEPARATE durability suite proving the
// SQLite table survives a real connection close/reopen (a real on-disk temp file,
// never `:memory:`), mirroring `test/adapters/knowledge-revision-durability.test.ts`.
//
// SCHEMA MATERIALIZATION: this table is deliberately NOT registered in the schema
// barrel and has no migration yet (see `src/schema/cost-ledger.ts`'s header — the
// migration + barrel wiring are a different, concurrently-worked package's
// territory). So unlike `repository-contract.test.ts`'s `createSqliteSchema`/
// `createPgSchema` helpers, this suite generates DDL directly from the Drizzle
// schema itself (via `getTableConfig`, never a hand-maintained string) SCOPED TO
// JUST THIS TABLE — the same technique those two helpers use, reproduced locally so
// this slice does not have to touch files outside its territory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { getTableConfig as getSqliteTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { getTableConfig as getPgTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPostgresCostLedgerRepository,
  createSqliteCostLedgerRepository,
  type CostLedgerEntry,
  type CostLedgerRepository,
} from "../src/repositories/costLedger";
import { costLedger as sqliteCostLedgerTable } from "../src/schema/cost-ledger";
import { costLedger as pgCostLedgerTable } from "../src/schema/pg/cost-ledger";
import type { DbErrorCode } from "../src/repositories/interfaces";

/** Emit `CREATE TABLE` for one Drizzle table (sqlite or pg-core) — mirrors
 * `test/adapters/create-sqlite-schema.ts`'s `buildCreateTable`, scoped to one table. */
function buildCreateTable(table: SQLiteTable | PgTable, isPg: boolean): string {
  const cfg = isPg ? getPgTableConfig(table as PgTable) : getSqliteTableConfig(table as SQLiteTable);
  const defs: string[] = cfg.columns.map((col) => {
    let def = `"${col.name}" ${col.getSQLType()}`;
    if (col.notNull) def += " NOT NULL";
    if (col.primary) def += " PRIMARY KEY";
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${defs.join(",\n  ")}\n);`;
}

const DROP_TABLE = `DROP TABLE "cost_ledger";`;

interface AdapterHandle {
  readonly repo: CostLedgerRepository;
  readonly dropTable: () => void | Promise<void>;
  readonly teardown: () => Promise<void>;
}

interface AdapterCase {
  readonly name: string;
  readonly setup: () => Promise<AdapterHandle>;
}

const sqliteFixture: AdapterCase = {
  name: "sqlite",
  setup: async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(buildCreateTable(sqliteCostLedgerTable, false));
    const repo = createSqliteCostLedgerRepository(drizzleSqlite(sqlite));
    return {
      repo,
      dropTable: () => {
        sqlite.exec(DROP_TABLE);
      },
      teardown: async () => {
        sqlite.close();
      },
    };
  },
};

const pglitePgFixture: AdapterCase = {
  name: "postgres-pglite",
  setup: async () => {
    const client = new PGlite();
    await client.exec(buildCreateTable(pgCostLedgerTable, true));
    const repo = createPostgresCostLedgerRepository(drizzlePglite(client));
    return {
      repo,
      dropTable: async () => {
        await client.exec(DROP_TABLE);
      },
      teardown: async () => {
        await client.close();
      },
    };
  },
};

const ADAPTERS: readonly AdapterCase[] = [sqliteFixture, pglitePgFixture];

const DB_ERROR_CODES: readonly DbErrorCode[] = [
  "not_found",
  "conflict",
  "constraint_violation",
  "serialization_failure",
  "unavailable",
  "stored_row_schema_violation",
  "unknown",
];

function entry(over: Partial<CostLedgerEntry> & Pick<CostLedgerEntry, "jobId" | "workspaceId">): CostLedgerEntry {
  return {
    costUsd: 1,
    runtimeSeconds: 10,
    recordedAt: "2026-08-24T00:00:00.000Z",
    ...over,
  };
}

describe.each(ADAPTERS)("CostLedgerRepository contract :: $name", (adapter) => {
  let handle: AdapterHandle;
  let repo: CostLedgerRepository;

  const setup = async () => {
    handle = await adapter.setup();
    repo = handle.repo;
  };
  const teardown = async () => {
    await handle.teardown();
  };
  afterEach(async () => {
    await teardown();
  });

  it("exposes the exact port surface", async () => {
    await setup();
    expect(typeof repo.record).toBe("function");
    expect(typeof repo.get).toBe("function");
    expect(typeof repo.spentFor).toBe("function");
  });

  it("record → get round-trips, including the nullable fields", async () => {
    await setup();
    const e = entry({
      jobId: "job-1",
      workspaceId: "ws-A",
      capability: "extraction",
      costUsd: 2.5,
      runtimeSeconds: 42,
      maxCostUsd: 10,
      maxRuntimeSeconds: 600,
    });
    const recorded = await repo.record(e);
    expect(recorded.ok).toBe(true);

    const got = await repo.get("job-1");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual(e);
  });

  it("get on an absent jobId is a typed not_found, never a throw", async () => {
    await setup();
    const got = await repo.get("job-never-recorded");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe("not_found");
  });

  it("record is FIRST-WRITE-WINS: a duplicate jobId is a typed conflict and the stored row is unchanged", async () => {
    await setup();
    const key = { jobId: "job-dup", workspaceId: "ws-B" };
    const first = entry({ ...key, costUsd: 5, recordedAt: "2026-08-24T00:00:00.000Z" });
    const firstResult = await repo.record(first);
    expect(firstResult.ok).toBe(true);

    // Same jobId, a DIFFERENT costUsd — this must be REJECTED, never silently applied.
    const second = entry({ ...key, costUsd: 999, recordedAt: "2026-08-24T01:00:00.000Z" });
    const secondResult = await repo.record(second);
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) expect(secondResult.error.code).toBe("conflict");

    const got = await repo.get("job-dup");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.costUsd).toBe(5); // the FIRST write's value, not the second's.
  });

  it("spentFor on a workspace with no recorded spend is a TRUE ok(0)", async () => {
    await setup();
    const spent = await repo.spentFor("ws-never-spent");
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(spent.value).toBe(0);
  });

  it("spentFor sums TWO records under one workspace — the cross-run property a future budget gate reads", async () => {
    await setup();
    await repo.record(entry({ jobId: "job-c1", workspaceId: "ws-C", costUsd: 1.25 }));
    await repo.record(entry({ jobId: "job-c2", workspaceId: "ws-C", costUsd: 3.75 }));
    // A different workspace's spend must NOT leak into ws-C's sum.
    await repo.record(entry({ jobId: "job-other", workspaceId: "ws-D", costUsd: 100 }));

    const spent = await repo.spentFor("ws-C");
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(spent.value).toBe(5); // 1.25 + 3.75, never 100 leaking in.
  });

  it("spentFor on a store fault is a typed err, NEVER ok(0) — a fault folded to 0 would grant unbounded budget", async () => {
    await setup();
    await repo.record(entry({ jobId: "job-e1", workspaceId: "ws-E", costUsd: 1 }));
    await handle.dropTable();

    const spent = await repo.spentFor("ws-E");
    expect(spent.ok).toBe(false);
  });

  it("§16 error convention: DbError codes drawn from the closed taxonomy", async () => {
    await setup();
    expect(DB_ERROR_CODES).toContain("conflict");
  });
});

// ── no_raw_content_column: a STRUCTURAL assertion over the schema module ───────
describe("cost ledger schema :: no_raw_content_column", () => {
  it("carries only redaction-safe ids + numeric bounds — never raw content or a secret (rule 7)", () => {
    const cfg = getSqliteTableConfig(sqliteCostLedgerTable);
    const columnNames = cfg.columns.map((c) => c.name).sort();
    expect(columnNames).toEqual(
      [
        "jobId",
        "workspaceId",
        "capability",
        "costUsd",
        "runtimeSeconds",
        "maxCostUsd",
        "maxRuntimeSeconds",
        "recordedAt",
      ].sort(),
    );
    const forbidden = ["content", "body", "payload", "secret", "token", "key", "password"];
    for (const name of columnNames) {
      const lower = name.toLowerCase();
      for (const bad of forbidden) {
        expect(lower.includes(bad)).toBe(false);
      }
    }
  });
});

// ── durability: a real on-disk SQLite connection close/reopen (never :memory:) ──
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** A fresh temp-file db path (NOT :memory: — the file must outlive a connection close). */
function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sow-cl-"));
  tempDirs.push(dir);
  return join(dir, "ops.db");
}

describe("19.11 CostLedgerRepository — durable across a connection close/reopen (§16)", () => {
  it("a FRESH repo instance over the SAME on-disk db sees a prior instance's recorded entries, and spentFor sums across the restart", async () => {
    const file = tempDbFile();

    // ── run #1: create schema, record two runs' spend, then SHUT DOWN ───────────
    const sqlite1 = new Database(file);
    sqlite1.exec(buildCreateTable(sqliteCostLedgerTable, false));
    const repo1 = createSqliteCostLedgerRepository(drizzleSqlite(sqlite1));
    const r1 = await repo1.record(entry({ jobId: "job-r1", workspaceId: "ws-restart", costUsd: 2 }));
    expect(r1.ok).toBe(true);
    const r2 = await repo1.record(entry({ jobId: "job-r2", workspaceId: "ws-restart", costUsd: 3 }));
    expect(r2.ok).toBe(true);
    sqlite1.close(); // simulates a worker restart — an in-memory store would lose this here

    // ── run #2 (RESTART): brand-new connection + FRESH repo over the same file ──
    const sqlite2 = new Database(file);
    const repo2 = createSqliteCostLedgerRepository(drizzleSqlite(sqlite2));

    const got = await repo2.get("job-r1");
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.costUsd).toBe(2);

    const spent = await repo2.spentFor("ws-restart");
    sqlite2.close();
    expect(spent.ok).toBe(true);
    if (spent.ok) expect(spent.value).toBe(5); // 2 + 3, survived the restart.
  });

  it("a jobId never recorded returns not_found on a fresh instance (no phantom rows)", async () => {
    const file = tempDbFile();
    const sqlite1 = new Database(file);
    sqlite1.exec(buildCreateTable(sqliteCostLedgerTable, false));
    const repo1 = createSqliteCostLedgerRepository(drizzleSqlite(sqlite1));
    await repo1.record(entry({ jobId: "job-real", workspaceId: "ws-restart2", costUsd: 1 }));
    sqlite1.close();

    const sqlite2 = new Database(file);
    const repo2 = createSqliteCostLedgerRepository(drizzleSqlite(sqlite2));
    const got = await repo2.get("job-never-existed");
    sqlite2.close();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe("not_found");
  });
});
