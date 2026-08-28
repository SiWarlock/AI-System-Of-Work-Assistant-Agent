// Install-doctor check-engine (task 11.5, §13) — the pure `runDoctor(snapshot) → DoctorReport` core.
//
// Maps an INJECTED `ProbeSnapshot` (per-check raw outcomes) to a typed report: each check gets a distinct typed
// repair on any non-`ok`, and the overall roll-up is the DERIVED worst-of. PURE (no I/O, no clock, no mutation:
// same snapshot ⇒ same report) and NEVER throws (§16): a malformed probe folds to a fail-closed `probe_error`
// finding. The REAL OS/boot probe COLLECTORS that produce the snapshot + the CLI/boot repair command that calls
// `runDoctor` are the DEFERRED bucket-B follow-up — so the engine is unreachable-by-design until that wiring
// lands (documented waiver, as with the serving oracle-core + the G1e-2 loader).
import { rollUpStatus } from "@sow/contracts";
import type { DoctorCheckId, DoctorCheckResult, DoctorReport } from "@sow/contracts";
import type { ProbeSnapshot } from "./probe-snapshot";
import {
  DOCTOR_REPAIRS,
  diagnoseNodePnpm,
  diagnoseFilevault,
  diagnoseKeychain,
  diagnoseTemporalStartable,
  diagnoseGbrainStartable,
  diagnoseLoopbackPorts,
  diagnoseGitRemotes,
} from "./checks/environment";
import {
  diagnoseVaultAcl,
  diagnoseGbrainMount,
  diagnoseStrayGbrainProcess,
} from "./checks/posture";
import { diagnoseSingleOwnerLock } from "./lock/singleOwnerLockDoctorCheck";
import type { SingleOwnerLockProbe } from "./lock/singleOwnerLockDoctorCheck";

/**
 * `ProbeSnapshot` extended with the REQ-D-005 single-owner-lock probe (task 24.1 / 11.1, safety rule 1).
 * `../probe-snapshot.ts` is OUT OF THIS SLICE'S DECLARED TERRITORY (packages/contracts + this one file
 * only) — this LOCAL extension lets `runDoctor` consume the probe today without touching that file. Every
 * field on both types is optional, so a bare `ProbeSnapshot` is still STRUCTURALLY ASSIGNABLE here — this
 * only WIDENS what `runDoctor` can accept, never what an existing caller (`probe-collectors.ts`, every
 * pre-existing test) must supply; they keep compiling byte-unchanged. Cross-territory follow-up: fold
 * `singleOwnerLock?: SingleOwnerLockProbe` directly into `ProbeSnapshot` (retiring this shim) once a boot-time
 * collector exists to populate it — see the wiring note atop `./lock/singleOwnerLockDoctorCheck.ts`.
 */
export type ProbeSnapshotWithLock = ProbeSnapshot & { readonly singleOwnerLock?: SingleOwnerLockProbe };

/** Run one check, folding ANY throw (a malformed probe) to a fail-closed `probe_error` finding (§16 no-throw). */
export function safeCheck(check: DoctorCheckId, run: () => DoctorCheckResult): DoctorCheckResult {
  try {
    return run();
  } catch {
    return { check, status: "finding", failureVariant: "probe_error", repair: DOCTOR_REPAIRS.probe_error };
  }
}

/**
 * Run the install doctor over an injected probe snapshot. PURE + NEVER throws. The report lists every prerequisite
 * check in a fixed order with a distinct repair per failure, and a worst-of `overall` — the 7 environment checks,
 * the 3 write-through one-writer POSTURE checks (REQ-S-NEW-008), then the REQ-D-005 single-owner-lock check (task
 * 24.1 / 11.1) — each fail-closed to `finding`.
 */
/**
 * Options for {@link runDoctor}. ADDITIVE-OPTIONAL: omitted ⇒ byte-equivalent to before this existed.
 */
export interface RunDoctorOptions {
  /**
   * Whether THIS PROCESS can observe the boot-time single-owner lock. Default `true` (the worker's
   * own boot, where the probe is real).
   *
   * ⛔ SET `false` FROM A STANDALONE PROCESS, and the reason is not squeamishness. `SingleOwnerLockProbe`
   * is defined as the outcome of a BOOT-TIME `acquireSingleOwnerLock` call. A separate process — the
   * `sow-doctor` CLI — cannot read that, and cannot substitute for it either: acquiring the lock ITSELF
   * would report a finding exactly when a healthy worker holds it and `ok` exactly when none is running.
   * The inverse of the truth. So there is nothing honest for such a caller to put in the field, and the
   * fail-closed diagnoser then converts the absence into `single_owner_lock_not_held` — a verdict about
   * a lock that nothing measured.
   *
   * `false` yields `degraded` instead: the app runs, this check could NOT BE TAKEN HERE. Deliberately
   * not `ok` (nothing was proven) and deliberately carrying NO `failureVariant` — `single_owner_lock_not_held`
   * asserts a policy verdict this process did not earn.
   */
  readonly lockObservable?: boolean;
}

/** The `degraded` result for a process that structurally cannot take the boot-scoped lock reading. */
const LOCK_UNOBSERVABLE: DoctorCheckResult = {
  check: "single_owner_lock",
  status: "degraded",
  // ⛔ `_not_observable`, NEVER `_not_held` — the second asserts a verdict about the lock that this
  // process did not earn. The contract requires a variant on any non-`ok` status, so "no variant" was
  // not an option; the fix was a member for the state, not a borrowed one (24.67's reasoning).
  failureVariant: "single_owner_lock_not_observable",
  repair:
    "This check is scoped to the worker's boot and cannot be taken from a standalone process. " +
    "Check the running worker's System Health for its single-owner-lock item instead.",
};

export function runDoctor(snapshot: ProbeSnapshotWithLock, opts?: RunDoctorOptions): DoctorReport {
  const s: ProbeSnapshotWithLock = snapshot ?? {};
  // STRICT `=== false` so a malformed/absent option can never silently disable a rule-1 posture check.
  const lockUnobservable = opts?.lockObservable === false;
  const checks: DoctorCheckResult[] = [
    safeCheck("node_pnpm", () => diagnoseNodePnpm(s.nodePnpm)),
    safeCheck("filevault", () => diagnoseFilevault(s.filevault)),
    safeCheck("keychain", () => diagnoseKeychain(s.keychain)),
    safeCheck("temporal_startable", () => diagnoseTemporalStartable(s.temporalStartable)),
    safeCheck("gbrain_startable", () => diagnoseGbrainStartable(s.gbrainStartable)),
    safeCheck("loopback_ports", () => diagnoseLoopbackPorts(s.loopbackPorts)),
    safeCheck("git_remotes", () => diagnoseGitRemotes(s.gitRemotes)),
    // ── write-through one-writer POSTURE (REQ-S-NEW-008 / safety rule 1) — fail-closed to `finding` ──
    safeCheck("vault_acl", () => diagnoseVaultAcl(s.vaultAcl)),
    safeCheck("gbrain_readonly_mount", () => diagnoseGbrainMount(s.gbrainMount)),
    safeCheck("stray_gbrain_process", () => diagnoseStrayGbrainProcess(s.strayGbrainProcess)),
    // ── REQ-D-005 single-owner advisory-lock (task 24.1 / 11.1, safety rule 1) — fail-closed to `finding` ──
    lockUnobservable
      ? LOCK_UNOBSERVABLE
      : safeCheck("single_owner_lock", () => diagnoseSingleOwnerLock(s.singleOwnerLock)),
  ];
  return { checks, overall: rollUpStatus(checks.map((c) => c.status)) };
}
