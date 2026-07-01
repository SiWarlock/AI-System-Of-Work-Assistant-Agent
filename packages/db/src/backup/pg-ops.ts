// Phase-2 task 2.10 / 2.9 — Postgres backup + restore ENGINES (drizzle-orm/pglite).
//
// The dual-dialect parity twins of the SQLite backup/restore engines in
// `periodic-backup.ts` / `restore.ts`. They plug into the SAME dialect-agnostic
// orchestrators (`runPeriodicBackup` / `restoreFromBackup`) so the §16 backup +
// recovery path is proven identical on Postgres and SQLite (REQ-D-003 / task 2.9):
//
//   - capture()  → `dumpDataDir()` serializes the whole PGlite data directory to a
//                  tarball Buffer + digests the not-rebuildable operational-truth rows.
//   - rebuild()  → `new PGlite({ loadDataDir })` reloads those bytes into a fresh
//                  client, re-digests, and re-dumps for the orchestrator's integrity
//                  gate (the gate fails CLOSED on a row-digest mismatch — §4/§16).
//
// BYTE-CONSISTENCY NOTE: unlike SQLite `serialize()`, a Postgres data-directory dump
// is NOT byte-stable across dumps (tar/gzip headers + internal state vary), so the
// gate's byte-match is informational for pg — ROW-digest consistency is the binding
// recovery invariant. The gate keys on the row digest, which IS stable.
//
// ERROR CONVENTION (§16): every method returns a typed `Result` and never throws;
// driver throws are mapped to the closed `DbError` taxonomy via the pg `toDbError`.
import { createHash } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { err, isErr, ok, type Result } from "@sow/contracts";

import { toDbError } from "../adapters/postgres/errors";
import type { DbError } from "../repositories/interfaces";
import {
  OPERATIONAL_TRUTH_TABLES,
  type OpStoreBackupEngine,
  type OpStoreSnapshot,
} from "./periodic-backup";
import type { RebuiltStore, RestoreEngine } from "./restore";

/** The Postgres restore handle — the live, restored PGlite client. */
export interface PgStore {
  readonly client: PGlite;
}

/** Whether a table exists in the `public` schema of the given client. */
async function pgTableExists(client: PGlite, name: string): Promise<boolean> {
  const r = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
    [name],
  );
  return r.rows.length > 0;
}

/** Serialize the whole PGlite data directory to a tarball Buffer. */
async function dumpBytes(client: PGlite): Promise<Buffer> {
  const dump = await client.dumpDataDir();
  return Buffer.from(await dump.arrayBuffer());
}

/**
 * Content digest of the NOT-rebuildable operational-truth rows (pg parity of
 * `sqliteRowDigest`). Rows are canonicalized with `row_to_json` and ordered by their
 * JSON text so the digest is deterministic + content-addressed (Postgres has no
 * `rowid`); an absent table is marked, mirroring the SQLite digest exactly.
 */
export async function pgRowDigest(
  client: PGlite,
  tables: readonly string[],
): Promise<Result<string, DbError>> {
  try {
    const h = createHash("sha256");
    for (const t of tables) {
      h.update(`\n#table:${t}\n`);
      if (!(await pgTableExists(client, t))) {
        h.update("<absent>");
        continue;
      }
      const rows = await client.query<{ r: unknown }>(
        `SELECT row_to_json(x) AS r FROM "${t}" x ORDER BY row_to_json(x)::text`,
      );
      h.update(JSON.stringify(rows.rows.map((row) => row.r)));
    }
    return ok(h.digest("hex"));
  } catch (cause) {
    return err(toDbError(cause, "failed to digest postgres operational-truth rows"));
  }
}

class PgBackupEngine implements OpStoreBackupEngine {
  readonly dialect = "pg" as const;
  readonly #client: PGlite;
  readonly #tables: readonly string[];

  constructor(client: PGlite, tables: readonly string[]) {
    this.#client = client;
    this.#tables = tables;
  }

  async capture(): Promise<Result<OpStoreSnapshot, DbError>> {
    let bytes: Buffer;
    try {
      bytes = await dumpBytes(this.#client);
    } catch (cause) {
      return err(toDbError(cause, "failed to serialize operational DB for backup"));
    }
    const digest = await pgRowDigest(this.#client, this.#tables);
    if (isErr(digest)) return digest;
    return ok({ dialect: this.dialect, bytes, rowDigest: digest.value });
  }
}

/** Construct the Postgres backup engine over an open PGlite client. */
export function createPgBackupEngine(
  client: PGlite,
  tables: readonly string[] = OPERATIONAL_TRUTH_TABLES,
): OpStoreBackupEngine {
  return new PgBackupEngine(client, tables);
}

class PgRestoreEngine implements RestoreEngine<PgStore> {
  readonly dialect = "pg" as const;
  readonly #tables: readonly string[];

  constructor(tables: readonly string[]) {
    this.#tables = tables;
  }

  async rebuild(bytes: Buffer): Promise<Result<RebuiltStore<PgStore>, DbError>> {
    let client: PGlite;
    try {
      client = new PGlite({ loadDataDir: new Blob([bytes]) });
      // Force init now so a truncated/corrupt dump fails HERE (typed err).
      await client.query("SELECT 1");
    } catch (cause) {
      return err(toDbError(cause, "failed to rebuild postgres store from backup bytes"));
    }
    const digest = await pgRowDigest(client, this.#tables);
    if (isErr(digest)) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      return digest;
    }
    let reBytes: Buffer;
    try {
      reBytes = await dumpBytes(client);
    } catch (cause) {
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
      return err(toDbError(cause, "failed to re-serialize restored postgres store"));
    }
    return ok({ store: { client }, bytes: reBytes, rowDigest: digest.value });
  }

  async dispose(store: PgStore): Promise<void> {
    try {
      if (!store.client.closed) await store.client.close();
    } catch {
      /* best-effort */
    }
  }
}

/** Construct the Postgres restore engine (verifies the operational-truth tables). */
export function createPgRestoreEngine(
  tables: readonly string[] = OPERATIONAL_TRUTH_TABLES,
): RestoreEngine<PgStore> {
  return new PgRestoreEngine(tables);
}

export type { PgBackupEngine, PgRestoreEngine };
