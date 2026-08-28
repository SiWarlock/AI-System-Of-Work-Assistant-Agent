// Tasks 11.1 + 24.1 (REQ-D-005, safety rule 1) — the install-doctor posture check for the REAL advisory
// single-owner lock (./singleOwnerLock.ts), alongside `diagnoseGbrainMount`/`diagnoseStrayGbrainProcess`
// (../checks/posture.ts).
//
// ✅ WIRED into `runDoctor`'s `checks` array (`../doctor.ts`) at `eed76756`, 2026-08-25.
// ⛔ THIS HEADER SAID "NOT YET WIRED" FOR THREE DAYS AFTER IT WAS. Corrected 2026-08-28 — and the
// staleness was not harmless: a reader auditing why `sow-doctor` was red would have concluded the check
// could not be the cause, because this file says it does not run.
//
// ⚠ AND THE WIRING CARRIED A DEFECT THIS FILE'S FAIL-CLOSED RULE MADE INEVITABLE. The standalone
// `sow-doctor` CLI is a SEPARATE PROCESS from the worker, so it never supplied `singleOwnerLock`, and
// the rule below turned that absence into `single_owner_lock_not_held` on EVERY run — a healthy machine
// included — so the binary exited 1 forever.
// ⭐ The rule is still right. What was missing is that "not held" and "cannot be observed from here" are
// DIFFERENT STATES and only one of them is a verdict (worker L79). `runDoctor`'s `lockObservable: false`
// option now yields `single_owner_lock_not_observable` / `degraded` for a process that cannot take the
// reading — never `ok` (nothing was proven), never `_not_held` (nothing was measured).
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
