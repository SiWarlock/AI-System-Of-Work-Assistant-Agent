// Phase-2 task 2.10 — EXERCISED restore from a local operational-DB backup (§4/§16).
//
// ARCHITECTURE §16 (Backup & recovery) requires a DOCUMENTED restore for the
// not-Git-backed operational DB; §4 names the NOT-rebuildable operational-truth
// set (event log / audit / approvals / outboxes / connector cursors) whose ONLY
// recovery path this is. The restore must produce a CONSISTENT store — so this
// module verifies the rebuilt store against the backup's recorded integrity digest
// and fails CLOSED on divergence (§16: nothing recovers silently into a corrupt
// state).
//
// Like the backup half (`periodic-backup.ts`) and the migration runner (task 2.6),
// POLICY is separated from MECHANISM so the recovery path is dialect-portable
// (REQ-D-003):
//
//   - `restoreFromBackup` is a PURE orchestrator: it resolves the target artifact
//     (latest or by id), reads its bytes via the injected {@link BackupSink},
//     rebuilds via an injected {@link RestoreEngine}, then runs the integrity
//     gate. It holds no driver itself.
//   - `RestoreEngine<S>` rebuilds a live store handle from bytes and reports the
//     rebuilt store's re-serialized bytes + operational-truth row digest for
//     verification. The SQLite engine is the local-mode default (§13); a pg engine
//     implements the same port (reload a dump) for the dual-dialect suite (2.9).
//
// ERROR CONVENTION (§16): every method returns a typed `Result` and never throws;
// a failed step becomes a typed `RestoreFailure` with a closed-set reason + repair.
import Database from "better-sqlite3";
import { err, isErr, ok, type Result } from "@sow/contracts";

import { toDbError } from "../adapters/sqlite/errors";
import type { MigrationDialect } from "../migrate/runner";
import type { DbError } from "../repositories/interfaces";
import {
  OPERATIONAL_TRUTH_TABLES,
  sqliteRowDigest,
  type BackupSink,
  type StoredBackup,
} from "./periodic-backup";

type Conn = InstanceType<typeof Database>;

/** A live store rebuilt from backup bytes, plus its verification material. */
export interface RebuiltStore<S> {
  /** Live store handle (opaque to the orchestrator; the caller uses it). */
  readonly store: S;
  /** The rebuilt store re-serialized — compared to the backup for byte-consistency. */
  readonly bytes: Buffer;
  /** The rebuilt store's operational-truth digest — compared for row-consistency. */
  readonly rowDigest: string;
}

/**
 * Dialect-specific restore primitive. `rebuild` produces a live store from backup
 * bytes; `dispose` releases a handle when the orchestrator rejects it (integrity
 * failure). Returns typed `Result<_, DbError>` and never throws (§16).
 */
export interface RestoreEngine<S> {
  readonly dialect: MigrationDialect;
  rebuild(bytes: Buffer): Promise<Result<RebuiltStore<S>, DbError>>;
  /** Release a rebuilt handle the orchestrator is discarding (best-effort). */
  dispose?(store: S): void | Promise<void>;
}

/** The two consistency facts the integrity gate checks. */
export interface RestoreVerification {
  /** Restored store re-serializes to the exact backed-up image. */
  readonly bytesMatched: boolean;
  /** Restored operational-truth rows match the backup's recorded digest. */
  readonly rowDigestMatched: boolean;
}

/** Closed, enumerable set of restore failure reasons (stable IDs). */
export const RESTORE_FAILURE_REASONS = [
  "no_backup_available", // nothing to restore from
  "read_failed", // could not list / read the artifact bytes
  "rebuild_failed", // engine could not rebuild a store from the bytes
  "integrity_check_failed", // rebuilt store diverges from the recorded digest
] as const;

export type RestoreFailureReason = (typeof RESTORE_FAILURE_REASONS)[number];

/** Typed restore refusal (§16): stable kind, closed-set reason, actionable repair. */
export interface RestoreFailure {
  readonly kind: "restore_failure";
  readonly reason: RestoreFailureReason;
  readonly dialect: MigrationDialect;
  readonly message: string;
  readonly repair: string;
  /** Set on `integrity_check_failed` — which consistency fact(s) failed. */
  readonly verification?: RestoreVerification;
  /** Underlying driver/IO cause (kept opaque to callers). */
  readonly cause?: DbError;
}

/** A successful restore: the consistent live store + the artifact + verification. */
export interface RestoreOutcome<S> {
  readonly dialect: MigrationDialect;
  /** The restored, integrity-verified live store handle. */
  readonly store: S;
  /** The backup artifact that was restored. */
  readonly backup: StoredBackup;
  readonly verification: RestoreVerification;
}

/** Options for {@link restoreFromBackup}. */
export interface RestoreOptions {
  /** Restore this specific artifact; default = the latest (newest) backup. */
  readonly backupId?: string;
}

/**
 * Restore the operational DB from a local backup, verifying consistency:
 *   1. resolve the target artifact (by id, or the latest);
 *   2. read its bytes;
 *   3. rebuild a live store from the bytes;
 *   4. INTEGRITY GATE — the rebuilt operational-truth digest MUST match the
 *      backup's recorded digest (row-consistency). On mismatch the rebuilt handle
 *      is disposed and a typed `integrity_check_failed` is returned (fail closed,
 *      §4/§16). Byte-consistency (`bytesMatched`) is reported alongside.
 *
 * Pure orchestration over the injected {@link BackupSink} + {@link RestoreEngine};
 * the meaningful recovery target is the not-rebuildable operational-truth set (§4).
 */
export async function restoreFromBackup<S>(
  sink: BackupSink,
  engine: RestoreEngine<S>,
  opts: RestoreOptions = {},
): Promise<Result<RestoreOutcome<S>, RestoreFailure>> {
  // 1) Resolve the target artifact.
  const listed = sink.list();
  if (isErr(listed)) {
    return err({
      kind: "restore_failure",
      reason: "read_failed",
      dialect: engine.dialect,
      message: "Could not list operational-DB backups to restore from.",
      repair: "Ensure the backup directory is readable, then retry.",
      cause: listed.error,
    });
  }
  const target =
    opts.backupId !== undefined
      ? listed.value.find((b) => b.backupId === opts.backupId)
      : listed.value[0];
  if (!target) {
    return err({
      kind: "restore_failure",
      reason: "no_backup_available",
      dialect: engine.dialect,
      message:
        opts.backupId !== undefined
          ? `No operational-DB backup with id "${opts.backupId}" was found.`
          : "No operational-DB backup is available to restore from.",
      repair:
        "Take a periodic backup first (runPeriodicBackup), or point the restore " +
        "at a valid backup directory / artifact id.",
    });
  }

  // 2) Read the artifact bytes.
  const bytes = sink.read(target.backupId);
  if (isErr(bytes)) {
    return err({
      kind: "restore_failure",
      reason: "read_failed",
      dialect: engine.dialect,
      message: `Could not read backup artifact "${target.backupId}".`,
      repair: "Verify the artifact exists and is readable, or choose another backup.",
      cause: bytes.error,
    });
  }

  // 3) Rebuild a live store from the bytes.
  const rebuilt = await engine.rebuild(bytes.value);
  if (isErr(rebuilt)) {
    return err({
      kind: "restore_failure",
      reason: "rebuild_failed",
      dialect: engine.dialect,
      message: `Could not rebuild an operational store from backup "${target.backupId}".`,
      repair:
        "The artifact may be truncated/corrupt. Restore an earlier backup, or " +
        "run the install doctor (§13).",
      cause: rebuilt.error,
    });
  }

  // 4) Integrity gate (fail closed on row divergence — §4/§16 consistent store).
  const rowDigestMatched = rebuilt.value.rowDigest === target.rowDigest;
  const bytesMatched = rebuilt.value.bytes.equals(bytes.value);
  const verification: RestoreVerification = { bytesMatched, rowDigestMatched };
  if (!rowDigestMatched) {
    await engine.dispose?.(rebuilt.value.store);
    return err({
      kind: "restore_failure",
      reason: "integrity_check_failed",
      dialect: engine.dialect,
      message:
        `Restored operational store diverges from backup "${target.backupId}"'s ` +
        "recorded integrity digest — refusing to return a corrupt store.",
      repair:
        "Do NOT use this restore. Restore a different (earlier) backup and " +
        "re-verify, or run the install doctor (§13/§16).",
      verification,
    });
  }

  return ok({
    dialect: engine.dialect,
    store: rebuilt.value.store,
    backup: target,
    verification,
  });
}

// --- SQLite restore engine (local-mode default, §13) ----------------------

/** The SQLite restore handle — the live, restored better-sqlite3 connection. */
export interface SqliteStore {
  readonly connection: Conn;
}

class SqliteRestoreEngine implements RestoreEngine<SqliteStore> {
  readonly dialect = "sqlite" as const;
  readonly #tables: readonly string[];

  constructor(tables: readonly string[]) {
    this.#tables = tables;
  }

  async rebuild(bytes: Buffer): Promise<Result<RebuiltStore<SqliteStore>, DbError>> {
    let conn: Conn;
    try {
      // better-sqlite3 deserializes a serialized image directly from the Buffer.
      conn = new Database(bytes);
    } catch (cause) {
      return err(toDbError(cause, "failed to rebuild sqlite store from backup bytes"));
    }
    const digest = sqliteRowDigest(conn, this.#tables);
    if (isErr(digest)) {
      try {
        conn.close();
      } catch {
        /* best-effort */
      }
      return digest;
    }
    let reBytes: Buffer;
    try {
      reBytes = conn.serialize();
    } catch (cause) {
      try {
        conn.close();
      } catch {
        /* best-effort */
      }
      return err(toDbError(cause, "failed to re-serialize restored sqlite store"));
    }
    return ok({ store: { connection: conn }, bytes: reBytes, rowDigest: digest.value });
  }

  dispose(store: SqliteStore): void {
    try {
      if (store.connection.open) store.connection.close();
    } catch {
      /* best-effort */
    }
  }
}

/** Construct the SQLite restore engine (verifies the operational-truth tables). */
export function createSqliteRestoreEngine(
  tables: readonly string[] = OPERATIONAL_TRUTH_TABLES,
): RestoreEngine<SqliteStore> {
  return new SqliteRestoreEngine(tables);
}

export type { SqliteRestoreEngine };
