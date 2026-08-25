// GBrain sync outbox — dual-dialect operational-store DRIVER (task 19.1, §6/§16).
//
// Implements the exact shape of the in-package
// `packages/knowledge/src/knowledge-writer/sync-outbox.ts` `GbrainSyncOutboxStore`
// port (getByKey/enqueue/update/listDue/indexedHighWater), speaking the SAME
// `DbResult`/`DbError` §16 convention every other `@sow/db` repository uses. This
// module does NOT import `@sow/knowledge` (the layer-direction rule is
// `packages/knowledge → packages/db`, never the reverse) — it satisfies the port
// STRUCTURALLY; the worker composition root adapts it to the typed port (mirrors
// `packages/db/src/repositories/interfaces.ts`'s own "pure TypeScript, no
// knowledge-layer import" posture).
//
// STANDALONE (not wired into `createSqliteRepositories`/`createPostgresRepositories`
// in `adapters/{sqlite,postgres}/index.ts`, which this package does not touch for
// this table): each dialect gets its own small factory over an injected drizzle
// handle, built from the canonical dual-dialect schema pair — the SQLite
// `sqliteTable` (`../schema/gbrain-sync-outbox`) and its PG-CORE MIRROR
// (`../schema/pg/gbrain-sync-outbox`, registered in the `schema/pg` barrel so the
// task-24.39/24.43 schema↔migration coverage detector sees it) — migrated via
// `migrations/{sqlite,pg}/0014_gbrain_sync_outbox.sql`.
//
// ERROR CONVENTION (§16): NOTHING throws across a repository boundary. Every
// method returns a typed `DbResult<T>`; a driver throw is caught and mapped
// through the same `toDbError` taxonomy the SQLite/Postgres adapters already use
// (imported read-only from their `./errors` modules — no duplicated mapping).
//
// REQ-S-003 / §16: no secret column, no raw-content column — see the schema
// module header for the full field-by-field rationale.
import { and, desc, eq, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ok, err } from "@sow/contracts";
import { gbrainSyncOutbox as sqliteGbrainSyncOutbox } from "../schema/gbrain-sync-outbox";
import { gbrainSyncOutbox as pgGbrainSyncOutbox } from "../schema/pg/gbrain-sync-outbox";
import { toDbError as toSqliteDbError } from "../adapters/sqlite/errors";
import { toDbError as toPostgresDbError } from "../adapters/postgres/errors";
import type { DbError, DbResult } from "./interfaces";

/**
 * Row shape mirroring `GbrainSyncOutboxEntry` (sync-outbox.ts:46-62) field-for-
 * field, WITHOUT importing the knowledge-layer type (layer-direction rule). The
 * worker composition root casts/adapts this into the exact `GbrainSyncOutboxEntry`
 * / `GbrainSyncStatus` union — this module only knows "status is a non-empty
 * string" the same way `AuditRecord.event`/`.actor` are open strings upstream.
 */
export interface GbrainSyncOutboxRow {
  readonly outboxId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly planId: string;
  readonly status: string;
  readonly attempts: number;
  readonly auditRef: string;
  readonly sourceEventRef?: string;
  readonly enqueuedAt: string;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
}

/** The exact port shape `GbrainSyncOutboxStore` (sync-outbox.ts:69-92) needs. */
export interface GbrainSyncOutboxRepository {
  getByKey(workspaceId: string, revisionId: string): DbResult<GbrainSyncOutboxRow | undefined>;
  enqueue(entry: GbrainSyncOutboxRow): DbResult<GbrainSyncOutboxRow>;
  update(entry: GbrainSyncOutboxRow): DbResult<GbrainSyncOutboxRow>;
  listDue(now: string, limit: number): DbResult<GbrainSyncOutboxRow[]>;
  indexedHighWater(workspaceId: string): DbResult<GbrainSyncOutboxRow | undefined>;
}

const INDEXED_TERMINAL = "indexed";

/** Strip `undefined` optional fields so a drizzle insert never writes an explicit NULL-as-undefined. */
function toInsertValues(entry: GbrainSyncOutboxRow): GbrainSyncOutboxRow {
  const base: GbrainSyncOutboxRow = {
    outboxId: entry.outboxId,
    workspaceId: entry.workspaceId,
    revisionId: entry.revisionId,
    planId: entry.planId,
    status: entry.status,
    attempts: entry.attempts,
    auditRef: entry.auditRef,
    enqueuedAt: entry.enqueuedAt,
  };
  return {
    ...base,
    ...(entry.sourceEventRef !== undefined ? { sourceEventRef: entry.sourceEventRef } : {}),
    ...(entry.lastAttemptAt !== undefined ? { lastAttemptAt: entry.lastAttemptAt } : {}),
    ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
  };
}

/** Map a possibly-null-columned stored row back to the port's optional-field shape. */
function fromStoredRow(row: {
  outboxId: string;
  workspaceId: string;
  revisionId: string;
  planId: string;
  status: string;
  attempts: number;
  auditRef: string;
  sourceEventRef: string | null;
  enqueuedAt: string;
  lastAttemptAt: string | null;
  lastError: string | null;
}): GbrainSyncOutboxRow {
  return {
    outboxId: row.outboxId,
    workspaceId: row.workspaceId,
    revisionId: row.revisionId,
    planId: row.planId,
    status: row.status,
    attempts: row.attempts,
    auditRef: row.auditRef,
    ...(row.sourceEventRef !== null ? { sourceEventRef: row.sourceEventRef } : {}),
    enqueuedAt: row.enqueuedAt,
    ...(row.lastAttemptAt !== null ? { lastAttemptAt: row.lastAttemptAt } : {}),
    ...(row.lastError !== null ? { lastError: row.lastError } : {}),
  };
}

// ── SQLite driver ─────────────────────────────────────────────────────────────

/**
 * Build the SQLite `GbrainSyncOutboxRepository` over a `better-sqlite3` drizzle
 * handle. `enqueue`/`update` both UPSERT by `outboxId` (the deterministic
 * (workspaceId, revisionId) collapse key) — a second `enqueue` for the same key
 * overwrites in place rather than erroring, so the store itself is the collapse
 * backstop even if a caller's own getByKey-guard races (defense in depth).
 */
export function createSqliteGbrainSyncOutboxRepository(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's own generic param; every adapter in this package types it this way.
  db: BetterSQLite3Database<any>,
): GbrainSyncOutboxRepository {
  const t = sqliteGbrainSyncOutbox;

  async function upsert(entry: GbrainSyncOutboxRow): DbResult<GbrainSyncOutboxRow> {
    const values = toInsertValues(entry);
    try {
      db.insert(t)
        .values(values)
        .onConflictDoUpdate({ target: t.outboxId, set: values })
        .run();
      return ok(entry);
    } catch (cause) {
      return err(toSqliteDbError(cause, "gbrain_sync_outbox upsert failed"));
    }
  }

  return {
    async getByKey(workspaceId, revisionId): DbResult<GbrainSyncOutboxRow | undefined> {
      try {
        const row = db
          .select()
          .from(t)
          .where(and(eq(t.workspaceId, workspaceId), eq(t.revisionId, revisionId)))
          .get();
        return ok(row === undefined ? undefined : fromStoredRow(row));
      } catch (cause) {
        return err(toSqliteDbError(cause, "gbrain_sync_outbox getByKey failed"));
      }
    },
    enqueue: upsert,
    update: upsert,
    async listDue(_now, limit): DbResult<GbrainSyncOutboxRow[]> {
      try {
        const rows = db
          .select()
          .from(t)
          .where(ne(t.status, INDEXED_TERMINAL))
          .orderBy(t.enqueuedAt, t.outboxId)
          .limit(limit)
          .all();
        return ok(rows.map(fromStoredRow));
      } catch (cause) {
        return err(toSqliteDbError(cause, "gbrain_sync_outbox listDue failed"));
      }
    },
    async indexedHighWater(workspaceId): DbResult<GbrainSyncOutboxRow | undefined> {
      try {
        const row = db
          .select()
          .from(t)
          .where(and(eq(t.workspaceId, workspaceId), eq(t.status, INDEXED_TERMINAL)))
          .orderBy(desc(t.enqueuedAt), desc(t.outboxId))
          .limit(1)
          .get();
        return ok(row === undefined ? undefined : fromStoredRow(row));
      } catch (cause) {
        return err(toSqliteDbError(cause, "gbrain_sync_outbox indexedHighWater failed"));
      }
    },
  };
}

// ── Postgres driver ────────────────────────────────────────────────────────────

/**
 * Build the Postgres `GbrainSyncOutboxRepository` over a `pg-core` drizzle handle
 * (PGlite or node-postgres). Mirrors the SQLite driver's semantics exactly —
 * `enqueue`/`update` UPSERT by `outboxId`.
 */
export function createPostgresGbrainSyncOutboxRepository(
  db: PgDatabase<PgQueryResultHKT>,
): GbrainSyncOutboxRepository {
  const t = pgGbrainSyncOutbox;

  async function upsert(entry: GbrainSyncOutboxRow): DbResult<GbrainSyncOutboxRow> {
    const values = toInsertValues(entry);
    try {
      await db.insert(t).values(values).onConflictDoUpdate({ target: t.outboxId, set: values });
      return ok(entry);
    } catch (cause) {
      return err(toPostgresDbError(cause, "gbrain_sync_outbox upsert failed"));
    }
  }

  return {
    async getByKey(workspaceId, revisionId): DbResult<GbrainSyncOutboxRow | undefined> {
      try {
        const rows = await db
          .select()
          .from(t)
          .where(and(eq(t.workspaceId, workspaceId), eq(t.revisionId, revisionId)))
          .limit(1);
        return ok(rows[0] === undefined ? undefined : fromStoredRow(rows[0]));
      } catch (cause) {
        return err(toPostgresDbError(cause, "gbrain_sync_outbox getByKey failed"));
      }
    },
    enqueue: upsert,
    update: upsert,
    async listDue(_now, limit): DbResult<GbrainSyncOutboxRow[]> {
      try {
        const rows = await db
          .select()
          .from(t)
          .where(ne(t.status, INDEXED_TERMINAL))
          .orderBy(t.enqueuedAt, t.outboxId)
          .limit(limit);
        return ok(rows.map(fromStoredRow));
      } catch (cause) {
        return err(toPostgresDbError(cause, "gbrain_sync_outbox listDue failed"));
      }
    },
    async indexedHighWater(workspaceId): DbResult<GbrainSyncOutboxRow | undefined> {
      try {
        const rows = await db
          .select()
          .from(t)
          .where(and(eq(t.workspaceId, workspaceId), eq(t.status, INDEXED_TERMINAL)))
          .orderBy(desc(t.enqueuedAt), desc(t.outboxId))
          .limit(1);
        return ok(rows[0] === undefined ? undefined : fromStoredRow(rows[0]));
      } catch (cause) {
        return err(toPostgresDbError(cause, "gbrain_sync_outbox indexedHighWater failed"));
      }
    },
  };
}

export type { DbError, DbResult };
