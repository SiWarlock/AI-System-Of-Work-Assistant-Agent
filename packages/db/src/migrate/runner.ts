// Phase-2 task 2.6 — migration apply LIFECYCLE runner (dialect-agnostic).
//
// ARCHITECTURE §4 (Operational Storage, failure modes): "back up the operational
// DB before applying any migration; run migrations transactionally where the
// engine allows; on partial/failed apply, restore from the pre-migration backup
// and refuse to start with a typed repair message ... (no silent forward-only
// break). Down-migration or restore-from-backup is the rollback path (Drizzle is
// forward-only by default)." §13 restates it; §16 requires a TYPED result with
// explicit failure variants + an actionable repair — nothing fails silently.
//
// This module is the PURE orchestrator: it sequences the four lifecycle steps and
// returns a typed Result, delegating every dialect-specific operation to an
// injected {@link MigrationEngine}. It holds NO driver, runs NO SQL, and reaches
// across NO boundary itself — so the same runner drives the SQLite engine (local
// default, §13) and the Postgres engine (hosted-compatible) identically; the
// lifecycle invariants live here, not in any one engine (dual-dialect parity,
// REQ-D-003 / task 2.9).
//
// The error type mirrors task 2.7's `IncompatibleSchema` (this dir): a domain
// typed failure with a stable `kind`, a closed-set `reason`, and an actionable
// `repair`, NOT the driver-level `DbError`. Engines speak `DbError` (driver
// faults); the runner translates a failed lifecycle STEP into a `MigrationFailure`
// carrying the underlying `DbError` cause opaquely.
import type { Result } from "@sow/contracts";
import { err, isErr, ok } from "@sow/contracts";

import type { DbError } from "../repositories/interfaces";
import { CURRENT_SCHEMA_VERSION } from "./version-compat";

/** The two operational-store dialects (§4): SQLite local + standard Postgres. */
export type MigrationDialect = "sqlite" | "pg";

/**
 * An opaque pre-migration backup snapshot produced by {@link MigrationEngine.backup}.
 * The `snapshot` payload is engine-defined (e.g. serialized SQLite bytes, a pg
 * dump handle) and is treated as a black box by the runner — it is only ever
 * handed back to the SAME engine's {@link MigrationEngine.restore}.
 */
export interface MigrationBackup {
  readonly dialect: MigrationDialect;
  /** Engine-defined restore payload — opaque to the runner. */
  readonly snapshot: unknown;
  /** ISO-8601 capture time (for the operator's rollback/audit record). */
  readonly capturedAt: string;
}

/** Outcome of a successful drizzle apply over a migrations folder. */
export interface MigrationApplied {
  /** Migration files newly applied this run (0 = already up to date / no-op). */
  readonly applied: number;
}

/**
 * Dialect-specific lifecycle primitives the runner orchestrates. Every method
 * returns a typed `Result<_, DbError>` and NEVER throws across the boundary (§16);
 * an engine catches its driver's throws and maps them to the closed `DbError`
 * taxonomy.
 */
export interface MigrationEngine {
  readonly dialect: MigrationDialect;
  /** Capture the MANDATORY pre-migration backup (§4). */
  backup(): Promise<Result<MigrationBackup, DbError>>;
  /** Apply all pending migrations from `migrationsFolder`, transactionally where
   *  the engine supports it. Returns the count newly applied. */
  migrate(migrationsFolder: string): Promise<Result<MigrationApplied, DbError>>;
  /** Restore the operational DB to a previously-captured backup (rollback path). */
  restore(backup: MigrationBackup): Promise<Result<void, DbError>>;
  /** Record a successful apply by persisting the on-disk schema-version marker. */
  recordApply(schemaVersion: number): Promise<Result<void, DbError>>;
}

/** Options for {@link applyMigrations}. */
export interface ApplyMigrationsOptions {
  /** drizzle migrations folder for this engine's dialect (e.g. `migrations/sqlite`). */
  readonly migrationsFolder: string;
  /** Schema version recorded on success. Default: {@link CURRENT_SCHEMA_VERSION}. */
  readonly schemaVersion?: number;
}

/** A successful lifecycle outcome. */
export interface MigrationOutcome {
  readonly dialect: MigrationDialect;
  /** Migration files newly applied this run (0 = already up to date). */
  readonly applied: number;
  /** Schema version now recorded on disk. */
  readonly schemaVersion: number;
  /** The pre-migration backup retained for the operator's rollback path. */
  readonly backup: MigrationBackup;
}

/** Closed, enumerable set of lifecycle-failure reasons (stable IDs; never reordered). */
export const MIGRATION_FAILURE_REASONS = [
  "backup_failed", // could not capture the mandatory backup → never applied
  "apply_failed_restored", // apply failed; restored to pre-migration state
  "apply_failed_unrestorable", // apply failed AND restore failed → manual recovery
  "record_failed", // apply succeeded; the schema-version marker write failed
] as const;

export type MigrationFailureReason = (typeof MIGRATION_FAILURE_REASONS)[number];

/**
 * Typed lifecycle refusal (§16): a stable `kind`, a closed-set `reason`, whether
 * the DB was restored to its pre-migration state, an actionable `repair`, and the
 * opaque underlying driver cause(s). No silent failure, no thrown error.
 */
export interface MigrationFailure {
  readonly kind: "migration_failure";
  readonly reason: MigrationFailureReason;
  readonly dialect: MigrationDialect;
  /** True iff the operational DB is back at its EXACT pre-migration state. */
  readonly restored: boolean;
  /** Human-readable summary. */
  readonly message: string;
  /** Actionable, forward-only-safe repair guidance (§4/§13/§16). */
  readonly repair: string;
  /** Underlying driver cause of the failing step (kept opaque). */
  readonly cause?: DbError;
  /** The restore step's OWN failure — set only on `apply_failed_unrestorable`. */
  readonly restoreCause?: DbError;
}

/**
 * Apply pending migrations through the full §4 lifecycle:
 *   1. BACK UP the operational DB (mandatory — no backup ⇒ refuse to apply);
 *   2. apply transactionally where the engine supports it;
 *   3. on a FAILED apply, RESTORE from the pre-migration backup and REFUSE to
 *      start with a typed repair (never a half-applied schema);
 *   4. on success, RECORD the schema-version marker.
 *
 * Deterministic orchestration over the injected `db` engine; returns a typed
 * `Result` and never throws.
 *
 * @param db   the dialect-specific {@link MigrationEngine} (named `db` — it IS the
 *             operational-DB lifecycle handle for backup/migrate/restore/record).
 * @param opts the migrations folder + optional target schema version.
 */
export async function applyMigrations(
  db: MigrationEngine,
  opts: ApplyMigrationsOptions,
): Promise<Result<MigrationOutcome, MigrationFailure>> {
  const targetSchemaVersion = opts.schemaVersion ?? CURRENT_SCHEMA_VERSION;

  // 1) MANDATORY backup-before-migrate (§4). No backup in hand ⇒ fail closed:
  //    refuse to apply anything (nothing is touched).
  const backup = await db.backup();
  if (isErr(backup)) {
    return err({
      kind: "migration_failure",
      reason: "backup_failed",
      dialect: db.dialect,
      restored: false,
      message: "Could not capture the mandatory pre-migration backup; no migration was applied.",
      repair:
        "Refusing to migrate without a pre-migration backup (§4). Ensure the " +
        "operational DB is reachable with free disk space and write permission, " +
        "then retry. The database was not modified.",
      cause: backup.error,
    });
  }

  // 2) Apply (transactional where the engine supports it).
  const applied = await db.migrate(opts.migrationsFolder);
  if (isErr(applied)) {
    // 3) FAILED apply ⇒ restore from the pre-migration backup; refuse to start.
    const restored = await db.restore(backup.value);
    if (isErr(restored)) {
      // Apply failed AND restore failed — the catastrophic path. Manual recovery.
      return err({
        kind: "migration_failure",
        reason: "apply_failed_unrestorable",
        dialect: db.dialect,
        restored: false,
        message:
          "Migration failed AND automatic restore from the pre-migration backup failed.",
        repair:
          "CRITICAL: do NOT start. The operational DB may be in a half-applied " +
          "state. Restore it from the most recent external/periodic backup " +
          "manually (§16 Backup & Recovery), then retry the migration.",
        cause: applied.error,
        restoreCause: restored.error,
      });
    }
    return err({
      kind: "migration_failure",
      reason: "apply_failed_restored",
      dialect: db.dialect,
      restored: true,
      message:
        "Migration failed; the operational DB was restored to its pre-migration state.",
      repair:
        "Refusing to start with a half-applied schema. The DB was restored from " +
        "the pre-migration backup. Fix the failing migration (or upgrade the app " +
        "to a compatible build), then retry. Down-migration / restore-from-backup " +
        "is the only rollback path — drizzle is forward-only.",
      cause: applied.error,
    });
  }

  // 4) Record the successful apply (schema-version marker).
  const recorded = await db.recordApply(targetSchemaVersion);
  if (isErr(recorded)) {
    return err({
      kind: "migration_failure",
      reason: "record_failed",
      dialect: db.dialect,
      restored: false, // the migrations ARE applied — do not roll back valid data
      message:
        "Migrations applied successfully, but recording the schema-version marker failed.",
      repair:
        "The schema is correct and the apply is idempotent. Re-run the migration " +
        "step to record the schema-version marker (already-applied migrations are " +
        "skipped). No restore is needed.",
      cause: recorded.error,
    });
  }

  return ok({
    dialect: db.dialect,
    applied: applied.value.applied,
    schemaVersion: targetSchemaVersion,
    backup: backup.value,
  });
}
