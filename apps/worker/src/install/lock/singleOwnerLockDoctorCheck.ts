// Tasks 11.1 + 24.1 (REQ-D-005, safety rule 1) — the install-doctor posture check for the REAL advisory
// single-owner lock (./singleOwnerLock.ts), alongside `diagnoseGbrainMount`/`diagnoseStrayGbrainProcess`
// (../checks/posture.ts).
//
// ⛔ NOT YET WIRED into `runDoctor`'s `checks` array (../doctor.ts) — `DoctorCheckId` and
// `doctorFailureVariantSchema` are a CLOSED enum frozen in `packages/contracts/src/install/doctor-result.ts`,
// which is outside this package's territory (a different implementation track owns packages/contracts).
// Wiring this in is a ONE-LINE addition once that package adds `"single_owner_lock"` to `DOCTOR_CHECK_IDS`
// and `"single_owner_lock_not_held"` to `doctorFailureVariantSchema` (recorded as a cross-territory need):
//
//   safeCheck("single_owner_lock", () => diagnoseSingleOwnerLock(s.singleOwnerLock))
//
// added to the `checks` array in `../doctor.ts`, plus a `singleOwnerLock?: SingleOwnerLockProbe` field on
// `ProbeSnapshot` (../probe-snapshot.ts). Until then this module is fully built + unit-tested standalone,
// exactly matching the shape (`check` / `status` / `failureVariant` / `repair`) the real
// `DoctorCheckResult` will have once the contracts extension lands — so wiring it in later is mechanical.
//
// FAIL-CLOSED (mirrors ../checks/posture.ts): `ok` ONLY on an explicit `acquired === true`; an absent
// (undefined) probe or `acquired === false` ⇒ `finding` — an unconfirmed lock hold is never silently `ok`.

/** The raw probe this diagnoser reads — the outcome of a boot-time `acquireSingleOwnerLock` call over the
 *  canonical brain/vault lock path. `holderPid` is the OTHER holder's pid when refused (diagnostic only —
 *  never rendered raw per rule 7; a repair message names no pid). */
export interface SingleOwnerLockProbe {
  readonly acquired: boolean;
  readonly holderPid?: number;
}

/** Mirrors the real `@sow/contracts` `DoctorCheckResult` shape (check/status/failureVariant/repair) with a
 *  LOCAL `check` literal, since `DoctorCheckId` cannot be extended from this package. */
export interface SingleOwnerLockCheckResult {
  readonly check: "single_owner_lock";
  readonly status: "ok" | "finding";
  readonly failureVariant?: "single_owner_lock_not_held";
  readonly repair?: string;
}

const REPAIR =
  "Another process holds the canonical brain/vault lock, or this worker never acquired it. Ensure no " +
  "other SoW worker instance (or a stray gbrain process) is running against this vault/brain, then restart.";

/**
 * Diagnose the single-owner-lock posture from an injected probe. `ok` ONLY on an explicit
 * `acquired === true`; an absent/undefined probe or `acquired === false` fails closed to `finding` (an
 * unconfirmed hold is never reported safe). Never throws; pure.
 */
export function diagnoseSingleOwnerLock(probe: SingleOwnerLockProbe | undefined): SingleOwnerLockCheckResult {
  if (probe != null && probe.acquired === true) {
    return { check: "single_owner_lock", status: "ok" };
  }
  return {
    check: "single_owner_lock",
    status: "finding",
    failureVariant: "single_owner_lock_not_held",
    repair: REPAIR,
  };
}
