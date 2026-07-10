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
 * check in a fixed order with a distinct repair per failure, and a worst-of `overall` — the 7 environment checks
 * then the 3 write-through one-writer POSTURE checks (REQ-S-NEW-008), each fail-closed to `finding`.
 */
export function runDoctor(snapshot: ProbeSnapshot): DoctorReport {
  const s: ProbeSnapshot = snapshot ?? {};
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
  ];
  return { checks, overall: rollUpStatus(checks.map((c) => c.status)) };
}
