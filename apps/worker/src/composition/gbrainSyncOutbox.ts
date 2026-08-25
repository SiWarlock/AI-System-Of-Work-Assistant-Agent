// GBrain sync outbox — worker COMPOSITION for task 19.1. Adapts the `@sow/db`
// dual-dialect driver (`createSqliteGbrainSyncOutboxRepository`) onto the
// `@sow/knowledge` `GbrainSyncOutboxStore` port, builds the working-tree-backed
// `CanonicalMarkdownSource` the index apply needs, and provides the drain-on-wake
// re-driver. Nothing here flips a default or provisions a real key (NOTHING ARMS)
// — this wires the ALREADY-BUILT-DORMANT sync-outbox + index-apply engines to a
// real, if modest, substrate so `triggerGbrainSync`/`applyGbrainIndexJob` get a
// genuine non-test caller.
//
// OWN SQLITE CONNECTION (deliberate, not `backends.ts`'s shared handle — this
// package does not touch `backends.ts`/`ProofSpineBackends`, which exposes no
// raw drizzle handle): the `gbrain_sync_outbox` table is used EXCLUSIVELY through
// this module's own driver, so a dedicated connection over the SAME `dbPath` is
// self-sufficient — for a real file path SQLite tables are file-scoped (a
// migration applied on the main connection is visible here too); for the
// `:memory:` test/dev default each connection is private, so this module ALSO
// ensures its own table exists (`CREATE TABLE IF NOT EXISTS`, DDL generated from
// the canonical schema via `getTableConfig` — never a hand-duplicated literal)
// rather than depending on the main connection's migration having run first.
import { createRequire } from "node:module";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { ok, err, RevisionIdSchema } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { gbrainSyncOutbox as gbrainSyncOutboxTable } from "@sow/db/schema/gbrain-sync-outbox";
import {
  createSqliteGbrainSyncOutboxRepository,
  type GbrainSyncOutboxRepository,
  type GbrainSyncOutboxRow,
} from "@sow/db/repositories/gbrain-sync-outbox-repository";
import type { DbError } from "@sow/db/repositories/interfaces";
import {
  GBRAIN_SYNC_STATUSES,
  applyGbrainIndexJob,
  type GbrainSyncOutboxEntry,
  type GbrainSyncOutboxStore,
  type GbrainSyncStatus,
  type GbrainIndexSyncDeps,
  type CanonicalMarkdownSource,
  type SnapshotLoadError,
  type IndexApplyClient,
  type CanonicalVaultSnapshot,
  type VaultFs,
} from "@sow/knowledge";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's own better-sqlite3 generic param.
type SqliteDb = any;

const require_ = createRequire(import.meta.url);

/** DDL generated from the canonical schema (never a hand-duplicated literal). */
function createTableIfNotExistsDdl(table: SQLiteTable): string {
  const cfg = getTableConfig(table);
  const defs = cfg.columns.map((col) => {
    let def = `"${col.name}" ${col.getSQLType()}`;
    if (col.notNull) def += " NOT NULL";
    if (col.primary) def += " PRIMARY KEY";
    if (col.isUnique) def += " UNIQUE";
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${defs.join(",\n  ")}\n);`;
}

/** A `GbrainSyncOutboxStore` bound to a real dual-dialect-driver connection + its close handle. */
export interface GbrainSyncOutboxBinding {
  readonly store: GbrainSyncOutboxStore;
  readonly close: () => void;
}

/**
 * Open a dedicated better-sqlite3 connection (see module header) and return the
 * `GbrainSyncOutboxStore` port adapter over the `@sow/db` driver. `dbPath`
 * mirrors `BackendsConfig.dbPath` — `:memory:` is fine for tests.
 */
export function createGbrainSyncOutboxBinding(dbPath?: string): GbrainSyncOutboxBinding {
  const Database = require_("better-sqlite3") as new (path: string) => SqliteDb;
  const { drizzle } = require_("drizzle-orm/better-sqlite3") as {
    drizzle: (conn: SqliteDb) => SqliteDb;
  };
  const conn = new Database(dbPath ?? ":memory:");
  conn.exec(createTableIfNotExistsDdl(gbrainSyncOutboxTable));
  const db = drizzle(conn);
  const repository = createSqliteGbrainSyncOutboxRepository(db);
  return {
    store: adaptRepositoryToStore(repository),
    close: () => {
      try {
        conn.close();
      } catch {
        /* best-effort — mirrors backends.ts's own close() posture */
      }
    },
  };
}

/** Map a `GbrainSyncStatus` string coming off the driver, fail-closed to `sync_lagging` on a malformed row. */
function toGbrainSyncStatus(raw: string): GbrainSyncStatus {
  return (GBRAIN_SYNC_STATUSES as readonly string[]).includes(raw)
    ? (raw as GbrainSyncStatus)
    : "sync_lagging";
}

function rowToEntry(row: GbrainSyncOutboxRow): GbrainSyncOutboxEntry {
  const base: GbrainSyncOutboxEntry = {
    outboxId: row.outboxId,
    workspaceId: row.workspaceId,
    revisionId: RevisionIdSchema.parse(row.revisionId),
    planId: row.planId,
    status: toGbrainSyncStatus(row.status),
    attempts: row.attempts,
    auditRef: row.auditRef,
    enqueuedAt: row.enqueuedAt,
  };
  return {
    ...base,
    ...(row.sourceEventRef !== undefined ? { sourceEventRef: row.sourceEventRef } : {}),
    ...(row.lastAttemptAt !== undefined ? { lastAttemptAt: row.lastAttemptAt } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
  };
}

function entryToRow(entry: GbrainSyncOutboxEntry): GbrainSyncOutboxRow {
  const base: GbrainSyncOutboxRow = {
    outboxId: entry.outboxId,
    workspaceId: entry.workspaceId,
    revisionId: String(entry.revisionId),
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

async function adaptResult<T, U>(
  p: Promise<Result<T, DbError>>,
  map: (t: T) => U,
): Promise<Result<U, DbError>> {
  const r = await p;
  if (!r.ok) return err(r.error);
  return ok(map(r.value));
}

/** Adapt the `@sow/db` row-shaped driver to the exact `GbrainSyncOutboxStore` port. */
export function adaptRepositoryToStore(repo: GbrainSyncOutboxRepository): GbrainSyncOutboxStore {
  return {
    getByKey: (workspaceId, revisionId) =>
      adaptResult(repo.getByKey(workspaceId, String(revisionId)), (row) =>
        row === undefined ? undefined : rowToEntry(row),
      ),
    enqueue: (entry) => adaptResult(repo.enqueue(entryToRow(entry)), rowToEntry),
    update: (entry) => adaptResult(repo.update(entryToRow(entry)), rowToEntry),
    listDue: (now, limit) => adaptResult(repo.listDue(now, limit), (rows) => rows.map(rowToEntry)),
    indexedHighWater: (workspaceId) =>
      adaptResult(repo.indexedHighWater(workspaceId), (row) => (row === undefined ? undefined : rowToEntry(row))),
  };
}

// ── CanonicalMarkdownSource — a working-tree read over the committed vault ────

/**
 * Build a `CanonicalMarkdownSource` over the worker's `VaultFs` (working-tree
 * read — the vault holds only the CURRENT committed Markdown, sole-writer, so
 * reading its live tree IS reading "the committed Markdown at [head]"; the
 * `applyGbrainIndexJob` hash-guard (index-sync.ts step 3) refuses to index
 * anything that doesn't hash to the job's OWN revision id, so a stale/mid-flight
 * read degrades to a retryable `sync_lagging`, never a wrong index).
 */
export function createWorkingTreeMarkdownSource(fs: VaultFs): CanonicalMarkdownSource {
  return {
    async loadSnapshot(
      workspaceId: string,
      revisionId: string,
    ): Promise<Result<CanonicalVaultSnapshot, SnapshotLoadError>> {
      try {
        const paths = await fs.list();
        const files = new Map<string, string>();
        for (const path of paths) {
          const content = await fs.read(path);
          if (content !== undefined) files.set(path, content);
        }
        return ok({
          workspaceId: workspaceId as CanonicalVaultSnapshot["workspaceId"],
          revisionId: RevisionIdSchema.parse(revisionId),
          files,
        });
      } catch (cause) {
        return err({
          code: "source_fault",
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        });
      }
    },
  };
}

// ── drain-on-wake ──────────────────────────────────────────────────────────────

export interface DrainGbrainSyncOutboxResult {
  readonly attempted: number;
  readonly indexed: number;
  readonly lagging: number;
}

/**
 * Re-drive every not-yet-`indexed` outbox row EXACTLY ONCE against the SAME row
 * (task 19.1's "drain-on-wake"). `listDue` already excludes the `indexed`
 * terminal, so a second drain over an already-indexed row does no work by
 * construction — this loop cannot re-process it. Never throws (§16):
 * `applyGbrainIndexJob` itself never throws, and this function adds no further
 * boundary.
 */
export async function drainGbrainSyncOutbox(
  deps: GbrainIndexSyncDeps,
  limit = 50,
): Promise<DrainGbrainSyncOutboxResult> {
  const due = await deps.outbox.listDue(deps.now(), limit);
  if (!due.ok) return { attempted: 0, indexed: 0, lagging: 0 };
  let indexed = 0;
  let lagging = 0;
  for (const entry of due.value) {
    const outcome = await applyGbrainIndexJob(entry, deps);
    if (outcome.kind === "lagging") lagging += 1;
    else indexed += 1;
  }
  return { attempted: due.value.length, indexed, lagging };
}

export type { IndexApplyClient };
