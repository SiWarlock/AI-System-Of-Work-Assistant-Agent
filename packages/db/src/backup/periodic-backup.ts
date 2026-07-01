// Phase-2 task 2.10 — periodic LOCAL backup of the operational DB (§4 / §16).
//
// ARCHITECTURE §16 (Backup & recovery): "The operational DB and Temporal
// persistence are operational truth and not Git-backed → a periodic local backup
// (pre-migration backup is mandatory, §4) with documented restore; remote
// operational-DB backup is an owner option." §4 names the NOT-rebuildable
// operational-truth set this backup protects (event log / audit / approvals /
// outboxes / connector cursors — plus workspace config, the workflow-run registry
// and provider state per the repository classification); read models + GCL
// projections are rebuildable and are captured only incidentally by the whole-DB
// snapshot. The RESTORE half of the recovery path lives in `restore.ts`.
//
// This module separates POLICY from MECHANISM so it is dialect-portable and
// testable without a server (REQ-D-003, the same posture as the task-2.6 runner):
//
//   - `runPeriodicBackup` is a PURE orchestrator: it owns the cadence decision
//     (persisted last-run bookkeeping, §16) and retention pruning, and delegates
//     every side effect to two injected ports. It holds no driver and no clock —
//     the caller injects `now`, so the function is a deterministic function of its
//     inputs (§16 Configuration & time: not naive wall-clock comparison).
//   - `OpStoreBackupEngine` captures the live DB to opaque bytes + an
//     operational-truth row digest (the integrity cross-check restore verifies).
//   - `BackupSink` persists/lists/reads/prunes the local artifacts.
//
// The concrete SQLite implementations (`createSqliteBackupEngine`,
// `createFsBackupSink`) are the LOCAL-mode default (§13). A pg engine implements
// the SAME `OpStoreBackupEngine` against PGlite/node-postgres (dump → reload) and
// plugs into the identical orchestrator — exercised by the dual-dialect contract
// suite (task 2.9).
//
// AT-REST: the bytes-at-rest control is macOS FileVault full-disk encryption (a
// §13 install-doctor prerequisite); app-level encryption (SQLCipher) is a V1.1
// hardening item (§15). See `packages/db/docs/at-rest-posture.md`.
//
// ERROR CONVENTION (§16): every port method and the orchestrator return a typed
// `Result` and NEVER throw across the boundary; a failed step becomes a typed
// `PeriodicBackupFailure` with a closed-set reason + an actionable repair.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { err, isErr, ok, type Result } from "@sow/contracts";

import { toDbError } from "../adapters/sqlite/errors";
import type { MigrationDialect } from "../migrate/runner";
import type { DbError } from "../repositories/interfaces";

type Conn = InstanceType<typeof Database>;

/**
 * The NOT-rebuildable operational-truth tables digested for restore-integrity
 * verification (§4). Read models + GCL projections are deliberately EXCLUDED —
 * they are rebuildable/derived, so they are not part of the recovery contract
 * (the whole-DB byte snapshot still carries them; only the integrity digest is
 * scoped to the truth that cannot be reconstructed).
 */
export const OPERATIONAL_TRUTH_TABLES = [
  "workspace_config",
  "event_log",
  "workflow_run_refs",
  "audit",
  "approvals",
  "outbox",
  "connector_cursors",
  "provider_state",
] as const;

// arch_gap: §16 names a "periodic local backup" but specifies NO concrete cadence
// interval, NO retention count, and NO owner for the scheduler that invokes this
// on a cadence (worker supervisor? a Temporal cron? — §9/§13 are silent). Handled
// here by making the interval + retention INJECTED options (so the policy is the
// caller's, not baked in) and leaving the driving scheduler to the worker track;
// this `7` is a chosen default, not a spec value. Pin the cadence/retention/owner
// when the worker backup scheduler lands.
/** Default number of most-recent local backups retained by `runPeriodicBackup`. */
export const DEFAULT_BACKUP_RETENTION = 7 as const;

// --- ports ----------------------------------------------------------------

/** An opaque whole-DB snapshot plus a digest of the operational-truth rows. */
export interface OpStoreSnapshot {
  readonly dialect: MigrationDialect;
  /** Serialized DB image (engine-defined bytes; SQLite = `serialize()` output). */
  readonly bytes: Buffer;
  /** Content digest of the operational-truth row set — restore re-derives + compares. */
  readonly rowDigest: string;
}

/**
 * Dialect-specific capture primitive. Returns a typed `Result<_, DbError>` and
 * NEVER throws across the boundary (§16); the SQLite engine catches driver throws
 * and maps them to the closed `DbError` taxonomy.
 */
export interface OpStoreBackupEngine {
  readonly dialect: MigrationDialect;
  /** Capture the live operational DB to bytes + an operational-truth row digest. */
  capture(): Promise<Result<OpStoreSnapshot, DbError>>;
}

/** Metadata + bytes handed to a {@link BackupSink} for durable local persistence. */
export interface StoredBackupInput {
  readonly backupId: string;
  readonly dialect: MigrationDialect;
  /** ISO-8601 creation time — the persisted last-run marker for cadence (§16). */
  readonly createdAt: string;
  readonly rowDigest: string;
  readonly bytes: Buffer;
}

/** A persisted local backup artifact (the sink's durable record of one backup). */
export interface StoredBackup {
  readonly backupId: string;
  readonly dialect: MigrationDialect;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly rowDigest: string;
  /** Opaque sink-defined location (e.g. an absolute file path). */
  readonly location: string;
}

/**
 * Durable store for local backup artifacts. Methods return typed
 * `Result<_, DbError>` and never throw (§16). `list` returns artifacts
 * NEWEST-FIRST by `createdAt` (the cadence + retention orchestrator relies on it).
 */
export interface BackupSink {
  write(record: StoredBackupInput): Result<StoredBackup, DbError>;
  /** All persisted artifacts, newest-first by createdAt. */
  list(): Result<readonly StoredBackup[], DbError>;
  /** Read an artifact's raw bytes (typed err if absent/unreadable). */
  read(backupId: string): Result<Buffer, DbError>;
  /** Delete every artifact beyond the `keep` newest; returns the removed set. */
  prune(keep: number): Result<readonly StoredBackup[], DbError>;
}

// --- orchestrator ---------------------------------------------------------

/** Options for {@link runPeriodicBackup}. */
export interface PeriodicBackupOptions {
  /** Minimum interval between backups, in milliseconds (the cadence). */
  readonly intervalMs: number;
  /** Injected clock — the single time owner; keeps the orchestrator deterministic. */
  readonly now: Date;
  /** Most-recent artifacts to retain (default {@link DEFAULT_BACKUP_RETENTION}). */
  readonly keep?: number;
  /** Bypass the cadence check (manual backup / pre-migration adjacency). */
  readonly force?: boolean;
}

/** Closed, enumerable set of periodic-backup failure reasons (stable IDs). */
export const PERIODIC_BACKUP_FAILURE_REASONS = [
  "list_failed", // could not read the last-run bookkeeping → cadence undecidable
  "capture_failed", // could not snapshot the operational DB → nothing written
  "persist_failed", // snapshot captured but the artifact could not be stored
  "prune_failed", // artifact written, but retention pruning failed
] as const;

export type PeriodicBackupFailureReason =
  (typeof PERIODIC_BACKUP_FAILURE_REASONS)[number];

/** Typed refusal (§16): a stable kind, a closed-set reason, an actionable repair. */
export interface PeriodicBackupFailure {
  readonly kind: "periodic_backup_failure";
  readonly reason: PeriodicBackupFailureReason;
  readonly dialect: MigrationDialect;
  readonly message: string;
  readonly repair: string;
  /** Underlying driver/IO cause of the failed step (kept opaque to callers). */
  readonly cause?: DbError;
}

/** Outcome of a periodic-backup run. */
export interface PeriodicBackupOutcome {
  readonly dialect: MigrationDialect;
  /** True when a backup was taken; false when the cadence skipped this run. */
  readonly performed: boolean;
  /** Why a run was skipped (set only when `performed` is false). */
  readonly skippedReason?: "not_due";
  /** The stored backup (set only when `performed` is true). */
  readonly backup?: StoredBackup;
  /** Artifacts removed by retention pruning (empty when skipped). */
  readonly pruned: readonly StoredBackup[];
}

/**
 * Decide whether a backup is due: true iff `now - last >= intervalMs`. An
 * unparseable last-run marker returns `true` (fail-safe: take a backup rather
 * than silently skip on corrupt bookkeeping). §16 Configuration & time: the
 * decision uses the persisted last-run marker, not a naive wall-clock heuristic.
 */
export function isBackupDue(
  now: Date,
  lastCreatedAt: string,
  intervalMs: number,
): boolean {
  const last = Date.parse(lastCreatedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}

/**
 * Run one periodic local backup of the operational DB through the full §16 path:
 *   1. CADENCE — read the latest persisted artifact (last-run bookkeeping) and
 *      SKIP if it is younger than `intervalMs`, unless `force` is set;
 *   2. CAPTURE — snapshot the live DB to bytes + an operational-truth row digest;
 *   3. PERSIST — store the artifact durably (the local backup);
 *   4. PRUNE — retain only the `keep` newest artifacts.
 *
 * Pure orchestration over the injected {@link OpStoreBackupEngine} +
 * {@link BackupSink}; deterministic given its inputs (the injected `now`).
 */
export async function runPeriodicBackup(
  engine: OpStoreBackupEngine,
  sink: BackupSink,
  opts: PeriodicBackupOptions,
): Promise<Result<PeriodicBackupOutcome, PeriodicBackupFailure>> {
  const keep = opts.keep ?? DEFAULT_BACKUP_RETENTION;

  // 1) Cadence — read the persisted last-run marker (the newest artifact).
  const existing = sink.list();
  if (isErr(existing)) {
    return err({
      kind: "periodic_backup_failure",
      reason: "list_failed",
      dialect: engine.dialect,
      message: "Could not read existing backups to decide whether one is due.",
      repair:
        "Ensure the backup directory is readable, then retry. No backup was taken.",
      cause: existing.error,
    });
  }
  if (!opts.force) {
    const latest = existing.value[0]; // newest-first
    if (latest && !isBackupDue(opts.now, latest.createdAt, opts.intervalMs)) {
      return ok({
        dialect: engine.dialect,
        performed: false,
        skippedReason: "not_due",
        pruned: [],
      });
    }
  }

  // 2) Capture the live operational DB.
  const snapshot = await engine.capture();
  if (isErr(snapshot)) {
    return err({
      kind: "periodic_backup_failure",
      reason: "capture_failed",
      dialect: engine.dialect,
      message: "Could not capture the operational DB snapshot.",
      repair:
        "Ensure the operational DB is reachable and not locked, then retry. " +
        "No backup was written.",
      cause: snapshot.error,
    });
  }

  // 3) Persist the artifact durably (the local backup, §16 — not Git-backed).
  const createdAt = opts.now.toISOString();
  const backupId = makeBackupId(createdAt, snapshot.value.bytes);
  const stored = sink.write({
    backupId,
    dialect: engine.dialect,
    createdAt,
    rowDigest: snapshot.value.rowDigest,
    bytes: snapshot.value.bytes,
  });
  if (isErr(stored)) {
    return err({
      kind: "periodic_backup_failure",
      reason: "persist_failed",
      dialect: engine.dialect,
      message: "Captured the operational DB but could not persist the backup.",
      repair:
        "Ensure the backup directory is writable with free disk space, then retry.",
      cause: stored.error,
    });
  }

  // 4) Retention — keep only the `keep` newest artifacts.
  const pruned = sink.prune(keep);
  if (isErr(pruned)) {
    return err({
      kind: "periodic_backup_failure",
      reason: "prune_failed",
      dialect: engine.dialect,
      message:
        "Backup was written, but pruning old backups beyond the retention " +
        "limit failed.",
      repair:
        "The new backup IS safe. Manually remove the oldest artifacts, or " +
        "rerun once the backup directory is writable.",
      cause: pruned.error,
    });
  }

  return ok({
    dialect: engine.dialect,
    performed: true,
    backup: stored.value,
    pruned: pruned.value,
  });
}

/** Build a unique, time-sortable backup id from the timestamp + a content hash. */
function makeBackupId(createdAt: string, bytes: Buffer): string {
  const stamp = createdAt.replace(/[:.]/g, "-");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  return `op-${stamp}-${hash}`;
}

// --- SQLite engine (local-mode default, §13) ------------------------------

function tableExists(conn: Conn, name: string): boolean {
  const row = conn
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name?: string } | undefined;
  return row?.name === name;
}

/**
 * Deterministic content digest of the given tables' rows (operational-truth
 * integrity cross-check). Rows are read in a stable `rowid` order; an absent
 * table is recorded as such so a structural change is still observable. SQLite-
 * specific (uses `rowid` + `sqlite_master`); the pg engine has its own digest.
 */
export function sqliteRowDigest(
  conn: Conn,
  tables: readonly string[],
): Result<string, DbError> {
  try {
    const h = createHash("sha256");
    for (const t of tables) {
      h.update(`\n#table:${t}\n`);
      if (!tableExists(conn, t)) {
        h.update("<absent>");
        continue;
      }
      const rows = conn.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
      h.update(JSON.stringify(rows));
    }
    return ok(h.digest("hex"));
  } catch (cause) {
    return err(toDbError(cause, "failed to digest operational-truth rows"));
  }
}

class SqliteBackupEngine implements OpStoreBackupEngine {
  readonly dialect = "sqlite" as const;
  readonly #conn: Conn;
  readonly #tables: readonly string[];

  constructor(conn: Conn, tables: readonly string[]) {
    this.#conn = conn;
    this.#tables = tables;
  }

  async capture(): Promise<Result<OpStoreSnapshot, DbError>> {
    let bytes: Buffer;
    try {
      bytes = this.#conn.serialize();
    } catch (cause) {
      return err(toDbError(cause, "failed to serialize operational DB for backup"));
    }
    const digest = sqliteRowDigest(this.#conn, this.#tables);
    if (isErr(digest)) return digest;
    return ok({ dialect: this.dialect, bytes, rowDigest: digest.value });
  }
}

/** Construct the SQLite backup engine over an open better-sqlite3 connection. */
export function createSqliteBackupEngine(
  conn: Conn,
  tables: readonly string[] = OPERATIONAL_TRUTH_TABLES,
): OpStoreBackupEngine {
  return new SqliteBackupEngine(conn, tables);
}

// --- filesystem sink (the local backup store) -----------------------------

class FsBackupSink implements BackupSink {
  readonly #dir: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#dir = dir;
  }

  #bin(id: string): string {
    return join(this.#dir, `${id}.bin`);
  }

  #meta(id: string): string {
    return join(this.#dir, `${id}.json`);
  }

  write(record: StoredBackupInput): Result<StoredBackup, DbError> {
    try {
      const location = this.#bin(record.backupId);
      writeFileSync(location, record.bytes);
      const stored: StoredBackup = {
        backupId: record.backupId,
        dialect: record.dialect,
        createdAt: record.createdAt,
        sizeBytes: record.bytes.length,
        rowDigest: record.rowDigest,
        location,
      };
      writeFileSync(this.#meta(record.backupId), JSON.stringify(stored, null, 2));
      return ok(stored);
    } catch (cause) {
      return err(toDbError(cause, "failed to persist backup artifact"));
    }
  }

  list(): Result<readonly StoredBackup[], DbError> {
    try {
      const records: StoredBackup[] = [];
      for (const f of readdirSync(this.#dir)) {
        if (!f.endsWith(".json")) continue;
        const raw = readFileSync(join(this.#dir, f), "utf8");
        records.push(JSON.parse(raw) as StoredBackup);
      }
      // Newest-first; backupId is the deterministic tie-breaker.
      records.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.backupId.localeCompare(a.backupId),
      );
      return ok(records);
    } catch (cause) {
      return err(toDbError(cause, "failed to list backup artifacts"));
    }
  }

  read(backupId: string): Result<Buffer, DbError> {
    try {
      return ok(readFileSync(this.#bin(backupId)));
    } catch (cause) {
      return err(toDbError(cause, `backup ${backupId} not readable`));
    }
  }

  prune(keep: number): Result<readonly StoredBackup[], DbError> {
    const listed = this.list();
    if (isErr(listed)) return listed;
    const removed = listed.value.slice(Math.max(0, Math.trunc(keep)));
    try {
      for (const r of removed) {
        rmSync(this.#bin(r.backupId), { force: true });
        rmSync(this.#meta(r.backupId), { force: true });
      }
      return ok(removed);
    } catch (cause) {
      return err(toDbError(cause, "failed to prune old backup artifacts"));
    }
  }
}

/** Construct a local filesystem backup sink rooted at `dir` (created if absent). */
export function createFsBackupSink(dir: string): BackupSink {
  return new FsBackupSink(dir);
}

export type { SqliteBackupEngine };
