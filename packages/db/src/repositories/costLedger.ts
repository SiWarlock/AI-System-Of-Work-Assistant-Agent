// Durable cross-run COST/BUDGET LEDGER — dual-dialect operational-store DRIVER
// (task 19.11, §16 error convention).
//
// SEAM THIS PLUGS: `apps/worker/src/composition/budget-ledger.ts`'s
// `BudgetLedgerPort { record(entry): void }` is record-only, synchronous, and has NO
// read side — so nothing can answer "how much has this workspace already spent
// across PRIOR runs?" This repository is the @sow/db half of closing that gap: a
// durable table + a `spentFor()` read. It does NOT widen `BudgetLedgerPort` and is
// NOT bound anywhere in `apps/worker` — that worker-side port widen (async record +
// a cumulative-read call) and the config-gated bind are OUT OF TERRITORY for this
// slice and remain fully open. Without a bound read side there is still NO cross-run
// enforcement — this ships the durable substrate a future gate would read, dormant.
//
// STANDALONE (not wired into `createSqliteRepositories`/`createPostgresRepositories`
// in `adapters/{sqlite,postgres}/index.ts`, which this slice does not touch): each
// dialect gets its own small factory over an injected drizzle handle, built from the
// canonical dual-dialect schema pair — the SQLite `sqliteTable`
// (`../schema/cost-ledger`) and its PG-CORE MIRROR (`../schema/pg/cost-ledger`).
// Mirrors `packages/db/src/repositories/gbrain-sync-outbox-repository.ts` (task 19.1)
// exactly — see that module's header for the fuller rationale of this shape. Because
// the schema is deliberately NOT registered in the schema barrel this slice (see
// `../schema/cost-ledger.ts`'s header) and no migration exists yet, this repository
// has no real-migration-backed table today; the test suite materializes the table
// directly from this Drizzle schema (mirrors `test/adapters/create-sqlite-schema.ts`'s
// own DDL-from-schema generator, scoped to just this table).
//
// ERROR CONVENTION (§16): NOTHING throws across a repository boundary. Every method
// returns a typed `DbResult<T>`; a driver throw is caught and mapped through the same
// `toDbError` taxonomy the SQLite/Postgres adapters already use (imported read-only
// from their `./errors` modules — no duplicated mapping).
//
// REQ-S-003 / §16: no secret column, no raw-content column — see the schema module
// header for the full field-by-field rationale.
import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ok, err } from "@sow/contracts";
import { costLedger as sqliteCostLedger } from "../schema/cost-ledger";
import { costLedger as pgCostLedger } from "../schema/pg/cost-ledger";
import { toDbError as toSqliteDbError, notFound as notFoundSqlite } from "../adapters/sqlite/errors";
import { toDbError as toPostgresDbError, notFound as notFoundPostgres } from "../adapters/postgres/errors";
import type { DbError, DbResult } from "./interfaces";

/** Row shape persisted per completed run — see `../schema/cost-ledger.ts` for the field-by-field rationale. */
export interface CostLedgerEntry {
  /** The idempotency key — one job is one run. FIRST-WRITE-WINS (see `record()`). */
  readonly jobId: string;
  readonly workspaceId: string;
  /** Nullable ⇒ unset (REQ-F-017 — never inferred). */
  readonly capability?: string;
  readonly costUsd: number;
  readonly runtimeSeconds: number;
  /** Nullable ⇒ no cap was configured for this run. */
  readonly maxCostUsd?: number;
  readonly maxRuntimeSeconds?: number;
  /** ISO-8601. */
  readonly recordedAt: string;
}

export interface CostLedgerRepository {
  /**
   * Record one run's spend. FIRST-WRITE-WINS: a duplicate `jobId` returns a typed
   * `conflict` — the stored row is NEVER overwritten by a later call for the same
   * job (a job runs once; a second `record()` for the same `jobId` is a caller bug,
   * not a legitimate update).
   */
  record(entry: CostLedgerEntry): DbResult<CostLedgerEntry>;
  /** `not_found` for an absent `jobId` (never invented/synthesized). */
  get(jobId: string): DbResult<CostLedgerEntry>;
  /**
   * Cumulative `costUsd` recorded for the workspace across every run. `ok(0)` is a
   * TRUE zero for a workspace with no recorded spend — distinct from a store fault.
   * A store fault is a typed `err` that the caller MUST treat as DENY, never as zero
   * spend: folding a fault to `0` would silently grant unbounded budget.
   */
  spentFor(workspaceId: string): DbResult<number>;
}

/** Strip `undefined` optional fields so a drizzle insert never writes an explicit NULL-as-undefined. */
function toInsertValues(entry: CostLedgerEntry): CostLedgerEntry {
  const base: CostLedgerEntry = {
    jobId: entry.jobId,
    workspaceId: entry.workspaceId,
    costUsd: entry.costUsd,
    runtimeSeconds: entry.runtimeSeconds,
    recordedAt: entry.recordedAt,
  };
  return {
    ...base,
    ...(entry.capability !== undefined ? { capability: entry.capability } : {}),
    ...(entry.maxCostUsd !== undefined ? { maxCostUsd: entry.maxCostUsd } : {}),
    ...(entry.maxRuntimeSeconds !== undefined ? { maxRuntimeSeconds: entry.maxRuntimeSeconds } : {}),
  };
}

/** Map a possibly-null-columned stored row back to the port's optional-field shape. */
function fromStoredRow(row: {
  jobId: string;
  workspaceId: string;
  capability: string | null;
  costUsd: number;
  runtimeSeconds: number;
  maxCostUsd: number | null;
  maxRuntimeSeconds: number | null;
  recordedAt: string;
}): CostLedgerEntry {
  return {
    jobId: row.jobId,
    workspaceId: row.workspaceId,
    ...(row.capability !== null ? { capability: row.capability } : {}),
    costUsd: row.costUsd,
    runtimeSeconds: row.runtimeSeconds,
    ...(row.maxCostUsd !== null ? { maxCostUsd: row.maxCostUsd } : {}),
    ...(row.maxRuntimeSeconds !== null ? { maxRuntimeSeconds: row.maxRuntimeSeconds } : {}),
    recordedAt: row.recordedAt,
  };
}

// ── SQLite driver ─────────────────────────────────────────────────────────────

/**
 * Build the SQLite `CostLedgerRepository` over a `better-sqlite3` drizzle handle.
 * `record()` is a plain INSERT (no `onConflictDoUpdate`) so a duplicate `jobId`
 * throws a PK-violation, which `toDbError` maps to `conflict` — first-write-wins by
 * construction, never a silent overwrite.
 */
export function createSqliteCostLedgerRepository(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's own generic param; every adapter in this package types it this way.
  db: BetterSQLite3Database<any>,
): CostLedgerRepository {
  const t = sqliteCostLedger;

  return {
    async record(entry): DbResult<CostLedgerEntry> {
      const values = toInsertValues(entry);
      try {
        db.insert(t).values(values).run();
        return ok(entry);
      } catch (cause) {
        return err(toSqliteDbError(cause, "cost_ledger record failed"));
      }
    },
    async get(jobId): DbResult<CostLedgerEntry> {
      try {
        const row = db.select().from(t).where(eq(t.jobId, jobId)).get();
        if (row === undefined) return err(notFoundSqlite("cost ledger entry"));
        return ok(fromStoredRow(row));
      } catch (cause) {
        return err(toSqliteDbError(cause, "cost_ledger get failed"));
      }
    },
    async spentFor(workspaceId): DbResult<number> {
      try {
        const row = db
          .select({ total: sql<number>`COALESCE(SUM(${t.costUsd}), 0)` })
          .from(t)
          .where(eq(t.workspaceId, workspaceId))
          .get();
        return ok(row?.total ?? 0);
      } catch (cause) {
        return err(toSqliteDbError(cause, "cost_ledger spentFor failed"));
      }
    },
  };
}

// ── Postgres driver ────────────────────────────────────────────────────────────

/**
 * Build the Postgres `CostLedgerRepository` over a `pg-core` drizzle handle (PGlite
 * or node-postgres). Mirrors the SQLite driver's semantics exactly.
 */
export function createPostgresCostLedgerRepository(
  db: PgDatabase<PgQueryResultHKT>,
): CostLedgerRepository {
  const t = pgCostLedger;

  return {
    async record(entry): DbResult<CostLedgerEntry> {
      const values = toInsertValues(entry);
      try {
        await db.insert(t).values(values);
        return ok(entry);
      } catch (cause) {
        return err(toPostgresDbError(cause, "cost_ledger record failed"));
      }
    },
    async get(jobId): DbResult<CostLedgerEntry> {
      try {
        const rows = await db.select().from(t).where(eq(t.jobId, jobId)).limit(1);
        if (rows[0] === undefined) return err(notFoundPostgres("cost ledger entry"));
        return ok(fromStoredRow(rows[0]));
      } catch (cause) {
        return err(toPostgresDbError(cause, "cost_ledger get failed"));
      }
    },
    async spentFor(workspaceId): DbResult<number> {
      try {
        const rows = await db
          .select({ total: sql<number>`COALESCE(SUM(${t.costUsd}), 0)` })
          .from(t)
          .where(eq(t.workspaceId, workspaceId));
        return ok(rows[0]?.total ?? 0);
      } catch (cause) {
        return err(toPostgresDbError(cause, "cost_ledger spentFor failed"));
      }
    },
  };
}

export type { DbError, DbResult };
