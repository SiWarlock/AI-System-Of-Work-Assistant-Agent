// Install-doctor ProbeSnapshot (task 11.5, §13) — the ENGINE's input surface.
//
// The pure `runDoctor` engine maps this record of per-check raw probe outcomes to a typed `DoctorReport`. Each
// field is OPTIONAL: an absent probe (a collector that could not run) is fail-closed by the diagnosers — the
// engine never throws and never silently passes an unconfirmed prereq. The REAL OS/boot probe COLLECTORS that
// PRODUCE this snapshot (diskutil/FileVault, Keychain reachability, port bind, `git remote`, gbrain
// --version/doctor, filesystem ACL stat, mount flags, `ps` process scan) are the DEFERRED bucket-B adapter — so
// the deterministic core is unit-testable today and wired when the repair command lands.

// ── environment probes ──────────────────────────────────────────────────────
export interface NodePnpmProbe {
  readonly nodeSatisfied: boolean;
  readonly pnpmSatisfied: boolean;
}
export interface FilevaultProbe {
  readonly enabled: boolean;
}
export interface KeychainProbe {
  readonly reachable: boolean;
}
export interface TemporalStartableProbe {
  readonly startable: boolean;
}
export interface GbrainStartableProbe {
  readonly startable: boolean;
}
export interface LoopbackPortsProbe {
  /** Loopback ports the doctor needs that are currently BOUND by another process (empty ⇒ all free). */
  readonly occupiedPorts: readonly number[];
}
export interface GitRemotesProbe {
  readonly hasRemote: boolean;
  /** The owner explicitly accepted local-only backup (§16) — makes a missing remote acceptable. */
  readonly localBackupAccepted: boolean;
}

// ── write-through one-writer POSTURE probes (REQ-S-NEW-008 / safety rule 1) ──
export interface VaultAclProbe {
  /** The worker is the SOLE OS principal with write access to the canonical vault dir (filesystem ACL). */
  readonly workerIsSoleWritePrincipal: boolean;
}
export interface GbrainMountProbe {
  /** The gbrain brain is mounted READ-ONLY / on an immutable revision snapshot. */
  readonly readOnly: boolean;
  /** The brain is mounted at the canonical path (not mispointed at a writable location). */
  readonly mountPointCanonical: boolean;
}

/**
 * The CLOSED set of write-capable gbrain operations a stray process may be running against a canonical brain.
 * The probe collector classifies a detected `ps` row into ONE of these labels — the engine names ONLY the label
 * (never raw args/secrets), so the stray-process finding is redaction-safe BY CONSTRUCTION.
 */
export const STRAY_GBRAIN_OPS = ["serve", "sync_install_cron", "autopilot", "jobs_work", "dream"] as const;
export type StrayGbrainOp = (typeof STRAY_GBRAIN_OPS)[number];

/** One detected stray gbrain writer — carries only its classified op label (redaction-safe). */
export interface StrayGbrainProcess {
  readonly op: StrayGbrainOp;
}
export interface StrayGbrainProcessProbe {
  /** Write-capable gbrain processes bound to a canonical brain (empty ⇒ none — the safe state). */
  readonly strayProcesses: readonly StrayGbrainProcess[];
}

/**
 * The full per-check probe snapshot. Every field OPTIONAL ⇒ a `{}`/partial snapshot degrades every unset check
 * fail-closed (no throw). The engine consumes ONLY this value — no side-effect seam — so `runDoctor` is pure.
 */
export interface ProbeSnapshot {
  readonly nodePnpm?: NodePnpmProbe;
  readonly filevault?: FilevaultProbe;
  readonly keychain?: KeychainProbe;
  readonly temporalStartable?: TemporalStartableProbe;
  readonly gbrainStartable?: GbrainStartableProbe;
  readonly loopbackPorts?: LoopbackPortsProbe;
  readonly gitRemotes?: GitRemotesProbe;
  readonly vaultAcl?: VaultAclProbe;
  readonly gbrainMount?: GbrainMountProbe;
  readonly strayGbrainProcess?: StrayGbrainProcessProbe;
}
