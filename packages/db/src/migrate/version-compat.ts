// Phase-2 task 2.7 — App-version ↔ schema-version compatibility check + refusal.
//
// ARCHITECTURE §4 (Operational Storage, failure modes):
//   "record an app-version ↔ schema-version compatibility check and refuse to run
//    an incompatible pairing (no silent forward-only break). Down-migration or
//    restore-from-backup is the rollback path (Drizzle is forward-only by default)."
// §13 (Migrations & rollback) restates the refusal; §16 (error-handling
// convention) requires a TYPED result with explicit failure variants + actionable
// repair — nothing fails silently.
//
// This module is the PURE, deterministic predicate behind the startup gate: no DB
// handle, no clock, no random, no I/O. The migration runner (task 2.6) and the
// startup sequence call `assertSchemaCompatible(appVersion, onDiskSchemaVersion)`
// BEFORE applying anything; on `Err` the worker refuses to start and surfaces the
// typed repair message (the runner's restore-from-backup path is §16/§4).
//
// SEMANTICS. The recorded compatibility table maps each released app version to
// the schema version it ships after migration (`targetSchemaVersion`) and the
// oldest on-disk schema it can operate / forward-migrate from
// (`minReadableSchemaVersion`). Given the running app version and the on-disk
// schema version, the pairing is:
//   - COMPATIBLE  (Ok)  when  min <= onDisk <= target  — the app can operate it;
//                              an on-disk version below `target` is brought up by
//                              the forward migration runner (task 2.6), which
//                              backs up first.
//   - INCOMPATIBLE (Err) otherwise, with a closed-set reason + typed repair:
//       * schema_ahead_of_app    — on-disk schema NEWER than this app supports.
//                                  This is the headline guard: an older app must
//                                  NOT silently forward-run a newer schema
//                                  (corruption / data loss). Repair: upgrade the
//                                  app, or restore the pre-upgrade DB backup.
//       * schema_below_minimum   — on-disk schema older than the app can migrate
//                                  forward in one step. Repair: upgrade through an
//                                  intermediate release, or restore a backup.
//       * unknown_app_version    — the running app version is not recorded in the
//                                  table (packaging/release error) → fail closed.
//       * schema_version_unreadable — the schema-version marker is missing/corrupt
//                                  (not a non-negative integer). Repair: restore
//                                  from backup / run the install doctor.
import type { Result } from "@sow/contracts";
import { err, ok } from "@sow/contracts";

/**
 * The operational-DB schema version this codebase's migrations produce. Bumped in
 * lockstep with each schema-changing migration (task 2.6) and recorded against the
 * shipping app version in {@link APP_SCHEMA_COMPAT_TABLE}.
 */
export const CURRENT_SCHEMA_VERSION = 2 as const;

/** One recorded app-version → schema-version compatibility band. */
export interface AppSchemaCompat {
  /** Exact released app version (e.g. a semver string) this row describes. */
  readonly appVersion: string;
  /** Schema version this app version ships once migrations have been applied. */
  readonly targetSchemaVersion: number;
  /** Oldest on-disk schema version this app can operate / forward-migrate from. */
  readonly minReadableSchemaVersion: number;
}

/**
 * The recorded app-version ↔ schema-version compatibility table (§4/§13). Append a
 * row for every released app version; an un-recorded version refuses (fail-closed)
 * rather than guessing. Genesis: the Phase-2 initial schema (v1). v2 adds the
 * §9.8 `approvals.workspaceId` column (migration 0001) — forward-migratable from v1.
 *
 * NOTE (pre-existing gap, NOT closed here): `assertSchemaCompatible` has no production
 * caller today — `openDatabase` applies migrations directly with no preceding compat
 * gate. So this table + `CURRENT_SCHEMA_VERSION` keep the schema-version METADATA
 * coherent with the migration set, but the app↔schema version GUARD (worker forbidden
 * #4's version-check half) is not yet wired. The additive 0001 ALTER is backward-safe
 * on its own (an old app tolerates the unknown column); wiring the boot gate is tracked
 * separately.
 */
export const APP_SCHEMA_COMPAT_TABLE: readonly AppSchemaCompat[] = [
  { appVersion: "0.1.0", targetSchemaVersion: 1, minReadableSchemaVersion: 1 },
  { appVersion: "0.2.0", targetSchemaVersion: 2, minReadableSchemaVersion: 1 },
];

/** Closed, enumerable set of refusal reasons (stable IDs; never reordered). */
export const SCHEMA_COMPAT_REASONS = [
  "schema_ahead_of_app",
  "schema_below_minimum",
  "unknown_app_version",
  "schema_version_unreadable",
] as const;

export type SchemaCompatReason = (typeof SCHEMA_COMPAT_REASONS)[number];

/** Typed refusal (§16): a stable kind, a closed-set reason, echoed inputs, and an
 *  actionable repair message — no silent failure, no thrown error. */
export interface IncompatibleSchema {
  /** Stable discriminant for the typed result. */
  readonly kind: "incompatible_schema";
  readonly reason: SchemaCompatReason;
  /** Running app version, echoed for the message + UI. */
  readonly appVersion: string;
  /** On-disk schema version as supplied (echoed verbatim; NaN stays NaN). */
  readonly schemaVersion: number;
  /** App's target schema, or `null` when the app version is unknown. */
  readonly targetSchemaVersion: number | null;
  /** App's minimum readable schema, or `null` when the app version is unknown. */
  readonly minReadableSchemaVersion: number | null;
  /** Human-readable summary of the incompatibility. */
  readonly message: string;
  /** Actionable, forward-only-safe repair guidance (§4/§13/§16). */
  readonly repair: string;
}

const fail = (e: IncompatibleSchema): Result<void, IncompatibleSchema> => err(e);

/**
 * Pure compatibility gate. Returns `ok(undefined)` when the running `appVersion`
 * may operate an operational DB at `schemaVersion` (possibly after the forward
 * migration runner brings it up to target), or `err(IncompatibleSchema)` with a
 * typed repair message otherwise. Deterministic: a function of its arguments only.
 *
 * @param table  Compatibility table to resolve against (defaults to the recorded
 *               {@link APP_SCHEMA_COMPAT_TABLE}; injectable for testing).
 */
export function assertSchemaCompatible(
  appVersion: string,
  schemaVersion: number,
  table: readonly AppSchemaCompat[] = APP_SCHEMA_COMPAT_TABLE,
): Result<void, IncompatibleSchema> {
  const row = table.find((r) => r.appVersion === appVersion);

  // Unknown app version — fail closed; we cannot reason about compatibility.
  if (row === undefined) {
    return fail({
      kind: "incompatible_schema",
      reason: "unknown_app_version",
      appVersion,
      schemaVersion,
      targetSchemaVersion: null,
      minReadableSchemaVersion: null,
      message: `App version "${appVersion}" is not in the schema-compatibility table.`,
      repair:
        "This is a packaging/release error: install an officially released build, " +
        "or add a compatibility entry for this app version before running it.",
    });
  }

  const { targetSchemaVersion, minReadableSchemaVersion } = row;

  // Corrupt/missing schema-version marker — must be a non-negative integer.
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    return fail({
      kind: "incompatible_schema",
      reason: "schema_version_unreadable",
      appVersion,
      schemaVersion,
      targetSchemaVersion,
      minReadableSchemaVersion,
      message: `Operational-DB schema-version marker is missing or corrupt (got ${String(schemaVersion)}).`,
      repair:
        "Restore the operational DB from the most recent pre-migration backup, " +
        "or run the install doctor to re-derive the schema-version marker.",
    });
  }

  // On-disk schema NEWER than this app supports — the forward-only-break guard.
  if (schemaVersion > targetSchemaVersion) {
    return fail({
      kind: "incompatible_schema",
      reason: "schema_ahead_of_app",
      appVersion,
      schemaVersion,
      targetSchemaVersion,
      minReadableSchemaVersion,
      message:
        `On-disk operational-DB schema v${schemaVersion} was written by a newer app; ` +
        `this app (v${appVersion}) supports up to schema v${targetSchemaVersion}.`,
      repair:
        `Refusing to run to avoid a silent forward-only break. ` +
        `Upgrade the app to a version that supports schema v${schemaVersion}, ` +
        `or restore the pre-upgrade operational-DB backup.`,
    });
  }

  // On-disk schema older than this app can forward-migrate in one step.
  if (schemaVersion < minReadableSchemaVersion) {
    return fail({
      kind: "incompatible_schema",
      reason: "schema_below_minimum",
      appVersion,
      schemaVersion,
      targetSchemaVersion,
      minReadableSchemaVersion,
      message:
        `On-disk operational-DB schema v${schemaVersion} is older than the minimum ` +
        `v${minReadableSchemaVersion} this app (v${appVersion}) can migrate forward.`,
      repair:
        `Upgrade through an intermediate app release that migrates ` +
        `v${schemaVersion} → v${minReadableSchemaVersion}, or restore a compatible backup.`,
    });
  }

  // min <= schemaVersion <= target — compatible (forward migration, if any, is 2.6's job).
  return ok(undefined);
}
