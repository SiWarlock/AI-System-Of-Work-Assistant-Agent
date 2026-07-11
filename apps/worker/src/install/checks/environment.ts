// Install-doctor environment diagnosers (task 11.5, §13) — the 7 NON-safety prerequisite checks. Each maps an
// injected probe outcome to a typed DoctorCheckResult with a DISTINCT repair (no shared catch-all). PURE; an
// ABSENT probe fails closed to the check's OWN variant (assume-worst — an unconfirmed prereq is never a silent
// ok). Temporal/GBrain unavailability is a tolerated first-class DEGRADED mode (§9/§16), not a hard finding.
import type { DoctorCheckId, DoctorCheckResult, DoctorFailureVariant } from "@sow/contracts";
import type {
  NodePnpmProbe,
  FilevaultProbe,
  KeychainProbe,
  TemporalStartableProbe,
  GbrainStartableProbe,
  LoopbackPortsProbe,
  GitRemotesProbe,
} from "../probe-snapshot";

/** DISTINCT repair per failure variant — the doctor's core value. One entry per variant; no generic fallback. */
export const DOCTOR_REPAIRS: Readonly<Record<DoctorFailureVariant, string>> = {
  node_or_pnpm_unsatisfied: "Install Node 22 LTS and pnpm and ensure both are on PATH (see docs/install).",
  filevault_off:
    "Enable FileVault in System Settings > Privacy & Security (at-rest encryption for the operational store, §4).",
  keychain_unreachable:
    "Keychain subsystem unavailable — verify the macOS Keychain is present and the `security` tooling responds (a LOCKED keychain is a runtime concern the SecretsPort handles, not an install defect).",
  temporal_not_startable:
    "Start the local Temporal dev server; until then the app runs Temporal-degraded (automation paused).",
  gbrain_not_startable: "Install/start gbrain; until then retrieval degrades to direct-Markdown only.",
  loopback_port_occupied:
    "Free the loopback port(s) another process has bound, or reconfigure the app's local API port.",
  git_remote_missing: "Configure a git remote for the vault, or record explicit local-only-backup acceptance (§16).",
  vault_acl_not_worker_exclusive:
    "Restrict the canonical vault directory ACL so the worker is the SOLE OS write principal (one-writer; else GO #1 re-opens).",
  gbrain_mount_writable_or_mispointed:
    "Re-mount the gbrain brain READ-ONLY at the canonical path (a writable/mispointed mount re-opens GO #1).",
  stray_gbrain_writer_detected:
    "Stop the stray write-capable gbrain process(es) bound to the canonical brain (one-writer; else GO #1 re-opens).",
  probe_error:
    "The probe could not be read (malformed/unavailable); re-run the doctor once the probe collector is available.",
};

export const okResult = (check: DoctorCheckId): DoctorCheckResult => ({ check, status: "ok" });
export const findingResult = (
  check: DoctorCheckId,
  failureVariant: DoctorFailureVariant,
  detail?: string,
): DoctorCheckResult =>
  detail === undefined
    ? { check, status: "finding", failureVariant, repair: DOCTOR_REPAIRS[failureVariant] }
    : { check, status: "finding", failureVariant, repair: DOCTOR_REPAIRS[failureVariant], detail };
export const degradedResult = (check: DoctorCheckId, failureVariant: DoctorFailureVariant): DoctorCheckResult => ({
  check,
  status: "degraded",
  failureVariant,
  repair: DOCTOR_REPAIRS[failureVariant],
});

export function diagnoseNodePnpm(p: NodePnpmProbe | undefined): DoctorCheckResult {
  if (p === undefined) return findingResult("node_pnpm", "node_or_pnpm_unsatisfied");
  return p.nodeSatisfied && p.pnpmSatisfied
    ? okResult("node_pnpm")
    : findingResult("node_pnpm", "node_or_pnpm_unsatisfied");
}

export function diagnoseFilevault(p: FilevaultProbe | undefined): DoctorCheckResult {
  if (p === undefined) return findingResult("filevault", "filevault_off");
  return p.enabled ? okResult("filevault") : findingResult("filevault", "filevault_off");
}

export function diagnoseKeychain(p: KeychainProbe | undefined): DoctorCheckResult {
  if (p === undefined) return findingResult("keychain", "keychain_unreachable");
  return p.reachable ? okResult("keychain") : findingResult("keychain", "keychain_unreachable");
}

export function diagnoseTemporalStartable(p: TemporalStartableProbe | undefined): DoctorCheckResult {
  // A tolerated degraded mode (the app boots Temporal-degraded) — degraded, not a hard finding.
  if (p === undefined) return degradedResult("temporal_startable", "temporal_not_startable");
  return p.startable ? okResult("temporal_startable") : degradedResult("temporal_startable", "temporal_not_startable");
}

export function diagnoseGbrainStartable(p: GbrainStartableProbe | undefined): DoctorCheckResult {
  if (p === undefined) return degradedResult("gbrain_startable", "gbrain_not_startable");
  return p.startable ? okResult("gbrain_startable") : degradedResult("gbrain_startable", "gbrain_not_startable");
}

export function diagnoseLoopbackPorts(p: LoopbackPortsProbe | undefined): DoctorCheckResult {
  if (p === undefined) return findingResult("loopback_ports", "loopback_port_occupied");
  return p.occupiedPorts.length === 0
    ? okResult("loopback_ports")
    : findingResult("loopback_ports", "loopback_port_occupied", `occupied loopback ports: ${p.occupiedPorts.join(", ")}`);
}

export function diagnoseGitRemotes(p: GitRemotesProbe | undefined): DoctorCheckResult {
  if (p === undefined) return findingResult("git_remotes", "git_remote_missing");
  // §16 backup: a configured remote OR an explicit local-only-backup acceptance satisfies the check.
  return p.hasRemote || p.localBackupAccepted ? okResult("git_remotes") : findingResult("git_remotes", "git_remote_missing");
}
