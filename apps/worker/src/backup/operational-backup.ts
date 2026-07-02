// @sow/worker — Task 10.6: periodic LOCAL backup of the NON-REBUILDABLE
// operational truth (§4 boundary / §16 Backup & recovery).
//
// ARCHITECTURE §16 (Backup & recovery): "The operational DB and Temporal
// persistence are operational truth and NOT Git-backed → a periodic local backup
// (pre-migration backup is mandatory, §4) with documented restore; remote
// operational-DB backup is an owner option." §4 names the not-rebuildable
// operational-truth set; the @sow/db `DOMAIN_DURABILITY` classification extends it
// with write_receipts (the WW-1 exactly-once external-write proofs — safety rule 3)
// and the Phase-10 durability tables (health_items / schedule_bookkeeping /
// instance_leases). Read models + GCL projections are REBUILDABLE / derived and are
// deliberately EXCLUDED — they are re-derived on restore (see `restore.ts`), never
// snapshotted redundantly (§4/§16: "read models are rebuildable").
//
// THIS module is the WORKER-LAYER ORCHESTRATOR. It builds ON the already-proven
// @sow/db backup primitives (`runPeriodicBackup` / the SQLite + pg engines +
// `FsBackupSink`) via an injected `OpDbBackupPort` — it does NOT re-implement the
// capture/cadence/retention mechanism. Its job is to (a) own the FULL
// non-rebuildable manifest (the op-DB truth set PLUS Temporal persistence, which the
// db-layer backup cannot reach), (b) capture the op-DB and Temporal snapshots
// together on one cadence, and (c) fold every port fault into a typed
// `BackupServiceFailure` (§16: never throws across the boundary).
//
// SELF-CONTAINED: exports factories (`createOperationalBackupService`) the worker
// composition root mounts. It does NOT wire itself into the bootstrap and holds no
// driver, no fs, and no clock — the caller injects the ports + `now`, so the
// orchestrator is a deterministic function of its inputs.
//
// arch_gap: §16 names a "periodic local backup" but pins NO concrete cadence
// interval and NO owner for the scheduler that drives it on a cadence. Handled here
// by making the interval an INJECTED option (the policy is the caller's) and leaving
// the driving scheduler (a worker supervisor tick or a Temporal cron) to the wiring.
// The DOCUMENTED default cadence lives in `docs/ops/backup-restore.md` (daily).

import { err, isErr, ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  OPERATIONAL_TRUTH_DOMAINS,
  type DbError,
  type OperationalDomain,
} from "@sow/db";

// ── the non-rebuildable backup manifest (the §4/§16 contract) ─────────────────

/**
 * The FULL set of NON-REBUILDABLE operational-truth domains this backup protects.
 * The §4-named five (event log / audit / approvals / outboxes / connector cursors)
 * PLUS the operational state that is likewise NOT a read model and NOT re-derivable:
 *   • workflow_runs / provider_state / workspace_config — operational state;
 *   • write_receipts — the WW-1 exactly-once external-write proofs (safety rule 3):
 *     losing them lets a rebuilt worker re-issue an already-committed external write;
 *   • health_items / schedule_bookkeeping / instance_leases — the Phase-10 (OBS-2 /
 *     LIFE-5 / LIFE-1) durability tables, none re-derivable from Markdown/truth.
 * Read models (`read_models`) + derived GCL projections (`gcl_projections`) are
 * EXCLUDED — they are re-derived after restore, not backed up redundantly.
 *
 * Kept in lock-step with the @sow/db `DOMAIN_DURABILITY` classification: this is
 * exactly the subset whose durability class is `operational_truth`. A test pins that
 * every member is `isOperationalTruth` and none is `isRebuildable`.
 */
export const NON_REBUILDABLE_BACKUP_DOMAINS = [
  ...OPERATIONAL_TRUTH_DOMAINS, // event_log / audit / approvals / outboxes / connector_cursors
  "workflow_runs",
  "provider_state",
  "workspace_config",
  "write_receipts",
  "health_items",
  "schedule_bookkeeping",
  "instance_leases",
] as const satisfies readonly OperationalDomain[];

/** A domain that is part of the non-rebuildable backup set. */
export type NonRebuildableDomain = (typeof NON_REBUILDABLE_BACKUP_DOMAINS)[number];

// ── ports (injected — keeps the orchestrator unit-testable) ───────────────────

/** A persisted op-DB backup artifact, plus the non-rebuildable domains it covered. */
export interface OpDbBackupArtifact {
  readonly backupId: string;
  /** ISO-8601 creation time — the persisted last-run marker for cadence (§16). */
  readonly createdAt: string;
  readonly sizeBytes: number;
  /** Content digest of the operational-truth rows (the restore integrity cross-check). */
  readonly rowDigest: string;
  /** Opaque location (e.g. an absolute file path) the sink chose. */
  readonly location: string;
  /** The non-rebuildable domains this snapshot recovers on restore. */
  readonly coveredDomains: readonly NonRebuildableDomain[];
}

/**
 * The operational-DB backup port. The wiring binds it to the @sow/db
 * `runPeriodicBackup` + a `FsBackupSink` (the SQLite/pg engine), so this worker
 * layer never touches a driver. Every method returns a typed `Result` and MUST NOT
 * throw (§16); the adapter maps a driver throw to the closed `DbError` taxonomy.
 */
export interface OpDbBackupPort {
  /** ISO-8601 createdAt of the most-recent op-DB backup, or undefined if none. */
  latestBackupAt(): Promise<Result<string | undefined, DbError>>;
  /** Capture + persist the op-DB snapshot; returns the stored artifact. */
  backup(): Promise<Result<OpDbBackupArtifact, DbError>>;
}

/** A persisted Temporal-persistence backup artifact (rides alongside the op-DB one). */
export interface TemporalBackupArtifact {
  readonly backupId: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly location: string;
}

/**
 * The Temporal-persistence backup port. §16 names Temporal persistence as
 * operational truth that is NOT Git-backed. The wiring binds it to whatever backs
 * the Temporal datastore (a local dev-server DB file dump, or a hosted-Temporal
 * archival hook). Never throws across the boundary.
 */
export interface TemporalPersistenceBackupPort {
  backup(): Promise<Result<TemporalBackupArtifact, DbError>>;
}

// ── options + outcome + typed failure ─────────────────────────────────────────

/** Options for {@link runOperationalBackup}. */
export interface OperationalBackupOptions {
  /** Minimum interval between backups, in milliseconds (the cadence). */
  readonly intervalMs: number;
  /** Injected clock — the single time owner; keeps the orchestrator deterministic. */
  readonly now: Date;
  /** Bypass the cadence check (manual backup / pre-migration adjacency). */
  readonly force?: boolean;
}

/** Closed, enumerable backup-service failure reasons (stable IDs). */
export const BACKUP_SERVICE_FAILURE_REASONS = [
  "list_failed", // could not read the last-run marker → cadence undecidable
  "op_db_backup_failed", // op-DB snapshot could not be captured/persisted
  "temporal_backup_failed", // op-DB captured but Temporal persistence backup failed
] as const;

export type BackupServiceFailureReason =
  (typeof BACKUP_SERVICE_FAILURE_REASONS)[number];

/** Typed refusal (§16): a stable kind, a closed-set reason, an actionable repair. */
export interface BackupServiceFailure {
  readonly kind: "operational_backup_failure";
  readonly reason: BackupServiceFailureReason;
  readonly message: string;
  readonly repair: string;
  /** Underlying port cause of the failed step (kept opaque to callers). */
  readonly cause?: DbError;
}

/** Outcome of one operational-backup run. */
export interface OperationalBackupOutcome {
  /** True when a backup was taken; false when the cadence skipped this run. */
  readonly performed: boolean;
  /** Why a run was skipped (set only when `performed` is false). */
  readonly skippedReason?: "not_due";
  /** The op-DB artifact (set only when `performed`). */
  readonly opDb?: OpDbBackupArtifact;
  /** The Temporal-persistence artifact (set only when `performed`). */
  readonly temporal?: TemporalBackupArtifact;
}

// ── cadence ────────────────────────────────────────────────────────────────────

/**
 * Decide whether a backup is due: true iff `now - last >= intervalMs`. An
 * unparseable / absent last-run marker returns `true` (fail-safe: take a backup
 * rather than silently skip). §16 Configuration & time: keyed on the persisted
 * last-run marker, not a naive wall-clock heuristic.
 */
export function isOperationalBackupDue(
  now: Date,
  lastCreatedAt: string | undefined,
  intervalMs: number,
): boolean {
  if (lastCreatedAt === undefined) return true;
  const last = Date.parse(lastCreatedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= intervalMs;
}

// ── the orchestrator ────────────────────────────────────────────────────────────

/**
 * Run one periodic local backup of the FULL non-rebuildable operational truth:
 *   1. CADENCE — read the op-DB last-run marker; SKIP if younger than `intervalMs`,
 *      unless `force`;
 *   2. OP-DB — capture + persist the op-DB snapshot (the §4/§16 truth set);
 *   3. TEMPORAL — capture + persist the Temporal-persistence snapshot ALONGSIDE it.
 *
 * Pure orchestration over the injected {@link OpDbBackupPort} +
 * {@link TemporalPersistenceBackupPort}; deterministic given its inputs (the
 * injected `now`). Read models + GCL projections are intentionally NOT captured —
 * they are re-derived on restore (see `restore.ts`). Never throws (§16): a hostile
 * port that rejects is caught and folded to a typed failure.
 */
export async function runOperationalBackup(
  opDb: OpDbBackupPort,
  temporal: TemporalPersistenceBackupPort,
  opts: OperationalBackupOptions,
): Promise<Result<OperationalBackupOutcome, BackupServiceFailure>> {
  // 1) Cadence — read the persisted last-run marker (guard a rejecting port).
  let latest: Result<string | undefined, DbError>;
  try {
    latest = await opDb.latestBackupAt();
  } catch (cause) {
    return err(fail("list_failed", "Could not read the last backup time.", cause));
  }
  if (isErr(latest)) {
    return err(
      failFrom(
        "list_failed",
        "Could not read existing backups to decide whether one is due. No backup was taken.",
        latest.error,
      ),
    );
  }
  if (!opts.force && !isOperationalBackupDue(opts.now, latest.value, opts.intervalMs)) {
    return ok({ performed: false, skippedReason: "not_due" });
  }

  // 2) Op-DB snapshot (the non-rebuildable truth set).
  let opDbResult: Result<OpDbBackupArtifact, DbError>;
  try {
    opDbResult = await opDb.backup();
  } catch (cause) {
    return err(
      fail("op_db_backup_failed", "Could not capture the operational DB snapshot.", cause),
    );
  }
  if (isErr(opDbResult)) {
    return err(
      failFrom(
        "op_db_backup_failed",
        "Could not capture the operational DB snapshot. No backup was written.",
        opDbResult.error,
      ),
    );
  }

  // 3) Temporal-persistence snapshot (rides alongside — §16 names it operational truth).
  let temporalResult: Result<TemporalBackupArtifact, DbError>;
  try {
    temporalResult = await temporal.backup();
  } catch (cause) {
    return err(
      fail(
        "temporal_backup_failed",
        "Captured the operational DB but could not back up Temporal persistence.",
        cause,
      ),
    );
  }
  if (isErr(temporalResult)) {
    return err(
      failFrom(
        "temporal_backup_failed",
        "Captured the operational DB but could not back up Temporal persistence.",
        temporalResult.error,
      ),
    );
  }

  return ok({
    performed: true,
    opDb: opDbResult.value,
    temporal: temporalResult.value,
  });
}

// ── failure builders ────────────────────────────────────────────────────────────

const REPAIRS: Record<BackupServiceFailureReason, string> = {
  list_failed:
    "Ensure the backup directory is readable, then retry. No backup was taken.",
  op_db_backup_failed:
    "Ensure the operational DB is reachable and not locked, and the backup directory is writable, then retry.",
  temporal_backup_failed:
    "The operational-DB backup IS safe. Ensure the Temporal persistence store is reachable, then rerun the backup.",
};

function fail(
  reason: BackupServiceFailureReason,
  message: string,
  cause: unknown,
): BackupServiceFailure {
  return {
    kind: "operational_backup_failure",
    reason,
    message,
    repair: REPAIRS[reason],
    cause: toDbErrorLike(cause),
  };
}

function failFrom(
  reason: BackupServiceFailureReason,
  message: string,
  cause: DbError,
): BackupServiceFailure {
  return { kind: "operational_backup_failure", reason, message, repair: REPAIRS[reason], cause };
}

/** Coerce an unknown thrown value to a `DbError`-shaped opaque cause (never re-throws). */
function toDbErrorLike(cause: unknown): DbError {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";
  return { code: "unknown", message, cause };
}

// ── the wiring factory (wiringFactory) ────────────────────────────────────────

/** The injectable operational-backup service the composition root mounts. */
export interface OperationalBackupService {
  run(
    opts: OperationalBackupOptions,
  ): Promise<Result<OperationalBackupOutcome, BackupServiceFailure>>;
}

/**
 * Build the operational-backup service over the injected ports. The composition
 * root binds `opDb` to the @sow/db `runPeriodicBackup` + `FsBackupSink` (SQLite/pg
 * engine) and `temporal` to the Temporal-persistence backup hook. This factory does
 * NOT wire itself into the worker bootstrap.
 */
export function createOperationalBackupService(
  opDb: OpDbBackupPort,
  temporal: TemporalPersistenceBackupPort,
): OperationalBackupService {
  return {
    run(opts: OperationalBackupOptions) {
      return runOperationalBackup(opDb, temporal, opts);
    },
  };
}
