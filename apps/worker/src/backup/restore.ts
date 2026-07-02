// @sow/worker — Task 10.6: EXERCISED restore of the operational truth + re-derive
// of the rebuildable read models (§4 boundary / §16 Backup & recovery).
//
// ARCHITECTURE §16 requires a DOCUMENTED restore for the not-Git-backed operational
// DB + Temporal persistence, and §4 mandates that read models (incl. dashboard
// projections) are REBUILDABLE — re-derived from operational truth + Markdown, not
// restored from a redundant snapshot. This worker-layer orchestrator ties the two
// halves together so a recovery leaves NO orphaned or duplicated state:
//
//   1. RECOVER the non-rebuildable operational truth — the op-DB truth set (via the
//      injected `OpDbRestorePort`, bound to the @sow/db `restoreFromBackup` whose
//      integrity gate fails CLOSED on a row-digest mismatch) PLUS Temporal
//      persistence (via `TemporalPersistenceRestorePort`);
//   2. RE-DERIVE the rebuildable read models AFTER the truth is recovered (via the
//      injected `ReadModelRebuilder`) — never against a broken truth store, so a
//      failed truth recovery fails closed BEFORE any re-derivation runs;
//   3. VERIFY consistency — the re-derived set is EXACTLY the rebuildable domains and
//      is DISJOINT from the recovered-as-truth set (no domain is both restored and
//      re-derived → no clobber, no duplicate), and each rebuildable domain is
//      re-derived exactly once (no orphan).
//
// The re-derivation SET is derived from the @sow/db durability classification
// (`isRebuildable`) — the single source of truth for which domains are droppable +
// reconstructable. This keeps the restore and the backup manifest in lock-step: the
// backup captures the non-rebuildable set (operational-backup.ts); the restore
// re-derives its complement (the rebuildable set).
//
// PRE-MIGRATION ROLLBACK (§4/P2 owns creating the pre-migration backup — see the
// @sow/db migrate path + the worker CLAUDE.md forbidden-pattern #4): this module
// REFERENCES that backup by id as the documented rollback on a partial/failed
// migration; it does NOT duplicate the pre-migration-backup mechanism.
//
// SELF-CONTAINED: exports `createOperationalRestoreService` the composition root
// mounts. §16: never throws across the boundary — every port fault folds to a typed
// `RestoreServiceFailure`.

import { err, isErr, ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { isRebuildable, type DbError, type OperationalDomain } from "@sow/db";

// The rebuildable domains re-derived after a restore (the complement of the
// non-rebuildable backup set). Derived from the @sow/db classification so it can
// never drift from `DOMAIN_DURABILITY`: read models + derived GCL projections.
const REBUILDABLE_DOMAINS = (
  ["read_models", "gcl_projections"] as const satisfies readonly OperationalDomain[]
).filter((d) => isRebuildable(d));

// ── ports (injected) ────────────────────────────────────────────────────────────

/** The result of recovering the op-DB truth set from a backup. */
export interface OpDbRestoreResult {
  readonly backupId: string;
  /** The non-rebuildable domains recovered from the backup. */
  readonly recoveredDomains: readonly OperationalDomain[];
  /** True IFF the @sow/db integrity gate verified the recovered store (row digest). */
  readonly integrityVerified: boolean;
}

/** Options for an op-DB restore — pick a specific backup, or the latest. */
export interface OpDbRestoreOptions {
  /** Restore this specific artifact (e.g. the pre-migration backup); default = latest. */
  readonly backupId?: string;
}

/**
 * The op-DB restore port. The wiring binds it to the @sow/db `restoreFromBackup` +
 * the SQLite/pg restore engine (whose integrity gate already fails closed on a
 * row-digest mismatch). Never throws across the boundary (§16).
 */
export interface OpDbRestorePort {
  restore(opts?: OpDbRestoreOptions): Promise<Result<OpDbRestoreResult, DbError>>;
}

/** The result of recovering Temporal persistence from a backup. */
export interface TemporalRestoreResult {
  readonly backupId: string;
}

/** The Temporal-persistence restore port (bound to the Temporal datastore reload). */
export interface TemporalPersistenceRestorePort {
  restore(): Promise<Result<TemporalRestoreResult, DbError>>;
}

/** The re-derived read models (dashboard projections + GCL projections). */
export interface RestoredReadModels {
  /** The rebuildable domains that were re-derived. */
  readonly rederivedDomains: readonly OperationalDomain[];
}

/**
 * The read-model rebuilder port. AFTER the operational truth is recovered, the
 * worker asks this to re-derive the rebuildable read models from truth + Markdown.
 * The wiring binds it to the §11 dashboard-projection + GCL-projection re-derivation.
 * It is asked to rebuild ONLY the rebuildable set — never an operational-truth
 * domain (that would clobber recovered truth). Never throws (§16).
 */
export interface ReadModelRebuilder {
  rebuild(
    domains: readonly OperationalDomain[],
  ): Promise<Result<RestoredReadModels, DbError>>;
}

// ── outcome + consistency verdict ─────────────────────────────────────────────

/** The post-restore consistency verdict — proves no orphaned/duplicated state. */
export interface RestoreConsistency {
  /** Rebuildable domains that were NOT re-derived (should be empty). */
  readonly orphanedDomains: readonly OperationalDomain[];
  /** Domains both recovered-as-truth AND re-derived (should be empty — a clobber). */
  readonly duplicatedDomains: readonly OperationalDomain[];
  /** True IFF no orphans and no duplicates. */
  readonly clean: boolean;
}

/** A successful restore: recovered truth + re-derived read models + the verdict. */
export interface RestoreOutcome {
  readonly opDb: OpDbRestoreResult;
  readonly temporal: TemporalRestoreResult;
  readonly readModels: RestoredReadModels;
  readonly consistency: RestoreConsistency;
}

/** Closed, enumerable restore-service failure reasons (stable IDs). */
export const RESTORE_SERVICE_FAILURE_REASONS = [
  "op_db_restore_failed", // could not recover the op-DB truth set
  "integrity_unverified", // recovered but the integrity gate did not verify — refuse
  "temporal_restore_failed", // could not recover Temporal persistence
  "rederivation_failed", // truth recovered but a read-model re-derivation failed
  "inconsistent_after_restore", // re-derivation left an orphan/duplicate — refuse
] as const;

export type RestoreServiceFailureReason =
  (typeof RESTORE_SERVICE_FAILURE_REASONS)[number];

/** Typed restore refusal (§16): stable kind, closed-set reason, actionable repair. */
export interface RestoreServiceFailure {
  readonly kind: "operational_restore_failure";
  readonly reason: RestoreServiceFailureReason;
  readonly message: string;
  readonly repair: string;
  /** Set on `inconsistent_after_restore` — which facts diverged. */
  readonly consistency?: RestoreConsistency;
  readonly cause?: DbError;
}

// ── the orchestrator ────────────────────────────────────────────────────────────

/**
 * Restore the non-rebuildable operational truth then re-derive the rebuildable read
 * models (§4/§16). Ordered so re-derivation NEVER runs against a broken truth store:
 *   1. recover the op-DB truth set; a fault OR an unverified integrity gate fails
 *      CLOSED (no re-derivation);
 *   2. recover Temporal persistence;
 *   3. re-derive the rebuildable read models (dashboard + GCL projections);
 *   4. verify no orphan (a rebuildable domain not re-derived) and no duplicate (a
 *      domain both recovered-as-truth and re-derived).
 *
 * Pure orchestration over the injected ports; never throws (§16).
 */
export async function restoreOperational(
  opDb: OpDbRestorePort,
  temporal: TemporalPersistenceRestorePort,
  rebuilder: ReadModelRebuilder,
  opts?: OpDbRestoreOptions,
): Promise<Result<RestoreOutcome, RestoreServiceFailure>> {
  // 1) Recover the op-DB truth set (fail closed on fault or unverified integrity).
  let opDbResult: Result<OpDbRestoreResult, DbError>;
  try {
    opDbResult = await opDb.restore(opts);
  } catch (cause) {
    return err(
      fail(
        "op_db_restore_failed",
        "Could not restore the operational DB from backup.",
        toDbErrorLike(cause),
      ),
    );
  }
  if (isErr(opDbResult)) {
    return err(
      fail(
        "op_db_restore_failed",
        "Could not restore the operational DB from backup.",
        opDbResult.error,
      ),
    );
  }
  if (!opDbResult.value.integrityVerified) {
    // The @sow/db integrity gate did not verify the recovered store — refuse to
    // proceed (never re-derive read models against a corrupt truth store, §4/§16).
    return err(
      fail(
        "integrity_unverified",
        `Restored operational store from backup "${opDbResult.value.backupId}" did not pass ` +
          "the integrity check — refusing to return a corrupt store.",
        undefined,
      ),
    );
  }

  // 2) Recover Temporal persistence.
  let temporalResult: Result<TemporalRestoreResult, DbError>;
  try {
    temporalResult = await temporal.restore();
  } catch (cause) {
    return err(
      fail(
        "temporal_restore_failed",
        "Restored the operational DB but could not restore Temporal persistence.",
        toDbErrorLike(cause),
      ),
    );
  }
  if (isErr(temporalResult)) {
    return err(
      fail(
        "temporal_restore_failed",
        "Restored the operational DB but could not restore Temporal persistence.",
        temporalResult.error,
      ),
    );
  }

  // 3) Re-derive the rebuildable read models (ONLY the rebuildable set).
  let rebuilt: Result<RestoredReadModels, DbError>;
  try {
    rebuilt = await rebuilder.rebuild(REBUILDABLE_DOMAINS);
  } catch (cause) {
    return err(
      fail(
        "rederivation_failed",
        "Recovered operational truth but could not re-derive the read models.",
        toDbErrorLike(cause),
      ),
    );
  }
  if (isErr(rebuilt)) {
    return err(
      fail(
        "rederivation_failed",
        "Recovered operational truth but could not re-derive the read models.",
        rebuilt.error,
      ),
    );
  }

  // 4) Consistency: no orphan (rebuildable-not-rederived), no duplicate (recovered
  //    AND re-derived → a clobber). Fail closed if the recovery is not clean.
  const consistency = checkConsistency(
    opDbResult.value.recoveredDomains,
    rebuilt.value.rederivedDomains,
  );
  if (!consistency.clean) {
    return err({
      kind: "operational_restore_failure",
      reason: "inconsistent_after_restore",
      message:
        "Restore left an orphaned or duplicated domain — the read-model re-derivation " +
        "does not exactly cover the rebuildable set disjoint from recovered truth.",
      repair:
        "Do NOT use this restore. Re-run against an earlier backup and re-verify, or " +
        "run the install doctor (§13/§16).",
      consistency,
    });
  }

  return ok({
    opDb: opDbResult.value,
    temporal: temporalResult.value,
    readModels: rebuilt.value,
    consistency,
  });
}

/**
 * The documented rollback on a PARTIAL/FAILED migration: restore from the
 * §4/P2-owned pre-migration backup (referenced by id — this module does NOT create
 * it) and re-derive the read models. A thin, named wrapper over
 * {@link restoreOperational} so the rollback path is a single call site.
 */
export function rollbackFromPreMigrationBackup(
  opDb: OpDbRestorePort,
  temporal: TemporalPersistenceRestorePort,
  rebuilder: ReadModelRebuilder,
  opts: { readonly preMigrationBackupId: string },
): Promise<Result<RestoreOutcome, RestoreServiceFailure>> {
  return restoreOperational(opDb, temporal, rebuilder, {
    backupId: opts.preMigrationBackupId,
  });
}

// ── consistency check ────────────────────────────────────────────────────────────

/**
 * Compute the post-restore consistency verdict:
 *   • ORPHAN — a rebuildable domain that was NOT re-derived;
 *   • DUPLICATE — a domain both recovered-as-truth AND re-derived (a clobber of
 *     recovered truth, or a redundant snapshot+rebuild of the same state).
 * Clean iff both are empty. PURE.
 */
export function checkConsistency(
  recoveredDomains: readonly OperationalDomain[],
  rederivedDomains: readonly OperationalDomain[],
): RestoreConsistency {
  const rederived = new Set(rederivedDomains);
  const recovered = new Set(recoveredDomains);
  const orphanedDomains = REBUILDABLE_DOMAINS.filter((d) => !rederived.has(d));
  const duplicatedDomains = rederivedDomains.filter((d) => recovered.has(d));
  const clean = orphanedDomains.length === 0 && duplicatedDomains.length === 0;
  return { orphanedDomains, duplicatedDomains, clean };
}

// ── failure builder ──────────────────────────────────────────────────────────────

const REPAIRS: Record<RestoreServiceFailureReason, string> = {
  op_db_restore_failed:
    "Verify a valid operational-DB backup exists and is readable, or choose an earlier backup.",
  integrity_unverified:
    "Do NOT use this restore. Restore a different (earlier) backup and re-verify, or run the install doctor (§13/§16).",
  temporal_restore_failed:
    "The operational-DB restore IS complete. Ensure the Temporal persistence store is reachable, then re-run the Temporal restore.",
  rederivation_failed:
    "Operational truth is recovered. Re-run the read-model re-derivation once the truth store + Markdown vault are reachable.",
  inconsistent_after_restore:
    "Do NOT use this restore. Re-run against an earlier backup and re-verify, or run the install doctor (§13/§16).",
};

function fail(
  reason: RestoreServiceFailureReason,
  message: string,
  cause: DbError | undefined,
): RestoreServiceFailure {
  const base: RestoreServiceFailure = {
    kind: "operational_restore_failure",
    reason,
    message,
    repair: REPAIRS[reason],
  };
  return cause !== undefined ? { ...base, cause } : base;
}

/** Coerce an unknown thrown value to a `DbError`-shaped opaque cause (never re-throws). */
function toDbErrorLike(cause: unknown): DbError {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";
  return { code: "unknown", message, cause };
}

// ── the wiring factory (wiringFactory) ────────────────────────────────────────

/** The injectable operational-restore service the composition root mounts. */
export interface OperationalRestoreService {
  restore(
    opts?: OpDbRestoreOptions,
  ): Promise<Result<RestoreOutcome, RestoreServiceFailure>>;
  rollbackFromPreMigration(opts: {
    readonly preMigrationBackupId: string;
  }): Promise<Result<RestoreOutcome, RestoreServiceFailure>>;
}

/**
 * Build the operational-restore service over the injected ports. The composition
 * root binds `opDb` to the @sow/db `restoreFromBackup`, `temporal` to the
 * Temporal-persistence reload, and `rebuilder` to the §11 read-model re-derivation.
 * This factory does NOT wire itself into the worker bootstrap.
 */
export function createOperationalRestoreService(
  opDb: OpDbRestorePort,
  temporal: TemporalPersistenceRestorePort,
  rebuilder: ReadModelRebuilder,
): OperationalRestoreService {
  return {
    restore(opts?: OpDbRestoreOptions) {
      return restoreOperational(opDb, temporal, rebuilder, opts);
    },
    rollbackFromPreMigration(opts) {
      return rollbackFromPreMigrationBackup(opDb, temporal, rebuilder, opts);
    },
  };
}
