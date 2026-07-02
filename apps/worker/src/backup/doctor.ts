// @sow/worker — Task 10.6: backup PRECONDITION doctors (§16 Backup & recovery).
//
// Two install/runtime doctor checks that guard the §16 backup guarantees:
//
//   (a) VAULT GIT-REMOTE DOCTOR. §16: "Workspace repos and the Global/Coordination
//       repo are backed by the owner's Obsidian Sync / iCloud and/or a configured
//       git remote … the install doctor checks a remote is configured OR records an
//       explicit local-only acceptance." So for EACH workspace Markdown repo AND the
//       Global/Coordination repo, this enforces: a git remote is configured, OR an
//       explicit local-only acceptance is recorded — otherwise a typed finding (fail
//       closed: no silent unbacked vault).
//
//   (b) KEYCHAIN-REACHABLE CHECK. §16 names Keychain-locked as a first-class degraded
//       mode: the `SecretsPort` (KeychainSecretsAdapter) surfaces a typed UNAVAILABLE
//       when the Keychain is locked/denied; the worker marks affected
//       providers/connectors degraded and re-attempts on unlock (LIFE-6). This check
//       is the degraded-mode PRECONDITION for the worker-supervision/lifecycle task
//       (10.5): it probes reachability and surfaces a typed `keychain_unavailable`
//       (with the locked/denied state) rather than throwing. Keychain export/restore
//       GUIDANCE is documented in `docs/ops/backup-restore.md`.
//
// Every side effect is an injected PORT (git remote probe, local-only acceptance
// store, Keychain probe) so both doctors are unit-testable with no real git /
// Keychain. §16: never throws across the boundary — every method returns a typed
// `Result`. SELF-CONTAINED: exports `createBackupDoctor` the composition root mounts;
// it does NOT wire itself into the worker bootstrap.
//
// arch_gap: the frozen OBS-2 `FailureClass` set has no dedicated `keychain_locked`
// member — the providers layer models Keychain-locked/denied as its OWN broker
// health states (packages/providers `provider-health.ts`), not a FailureClass. This
// check therefore returns a typed `keychain_unavailable` refusal (carrying the
// locked/denied state); the caller/supervisor maps it onto the existing degraded-mode
// surfaces (10.5) — this module does not mint a HealthItem itself.

import { err, isErr, ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { DbError } from "@sow/db";

// ── (a) vault git-remote doctor ────────────────────────────────────────────────

/** Which vault repo a doctor target names — a workspace vault or the shared one. */
export type VaultRepoKind = "workspace" | "global_coordination";

/** A vault Markdown repo the doctor must verify is backed (remote OR local-only). */
export interface VaultRepoTarget {
  /** Stable id (e.g. the workspace slug, or `global-coordination`). */
  readonly repoId: string;
  /** Absolute filesystem path of the repo (the git-remote probe keys on it). */
  readonly path: string;
  readonly kind: VaultRepoKind;
}

/**
 * Probes whether a git repo at a path has a remote configured. The wiring binds it
 * to `git -C <path> remote` (or equivalent). Never throws across the boundary (§16);
 * a git failure is a typed `DbError`-shaped err.
 */
export interface GitRemotePort {
  hasRemote(path: string): Promise<Result<boolean, DbError>>;
}

/**
 * Reads whether an EXPLICIT local-only acceptance has been recorded for a repo (the
 * owner acknowledged "this vault has no remote on purpose"). The wiring binds it to
 * the operational store / config. Never throws.
 */
export interface LocalOnlyAcceptanceStore {
  isLocalOnlyAccepted(repoId: string): Promise<Result<boolean, DbError>>;
}

/** The per-repo backing status the doctor computed. */
export type VaultRepoBackingStatus =
  | "remote_configured" // a git remote is configured → backed
  | "local_only_accepted" // no remote, but an explicit local-only acceptance exists
  | "unbacked"; // no remote and no acceptance → a silent unbacked vault (fail)

/** The doctor's verdict for one repo. */
export interface VaultRepoReport {
  readonly repoId: string;
  readonly kind: VaultRepoKind;
  readonly status: VaultRepoBackingStatus;
}

/** The overall vault git-remote doctor report. */
export interface VaultRemoteDoctorReport {
  /** True IFF every repo is remote_configured OR local_only_accepted. */
  readonly ok: boolean;
  /** repoIds that are `unbacked` (the findings the install doctor surfaces). */
  readonly findings: readonly string[];
  readonly perRepo: readonly VaultRepoReport[];
}

/** Closed, enumerable vault-doctor failure reasons. */
export type VaultDoctorFailureReason = "probe_failed";

/** Typed vault-doctor refusal (§16): a probe fault, never a throw. */
export interface VaultDoctorFailure {
  readonly kind: "vault_doctor_failure";
  readonly reason: VaultDoctorFailureReason;
  readonly message: string;
  readonly repair: string;
  readonly cause?: DbError;
}

/**
 * Run the vault git-remote doctor over every target repo (workspaces + the
 * Global/Coordination repo). For each: remote configured → `remote_configured`;
 * else an explicit local-only acceptance → `local_only_accepted`; else `unbacked`
 * (a finding). The report is `ok` only when NO repo is unbacked (fail closed on a
 * silent unbacked vault). A probe fault on any repo folds to a typed
 * `probe_failed` — the check cannot silently pass on an unreadable git repo (§16).
 */
export async function runVaultRemoteDoctor(
  targets: readonly VaultRepoTarget[],
  git: GitRemotePort,
  acceptance: LocalOnlyAcceptanceStore,
): Promise<Result<VaultRemoteDoctorReport, VaultDoctorFailure>> {
  const perRepo: VaultRepoReport[] = [];
  const findings: string[] = [];

  for (const t of targets) {
    // Probe the git remote (guard a rejecting port).
    let hasRemote: Result<boolean, DbError>;
    try {
      hasRemote = await git.hasRemote(t.path);
    } catch (cause) {
      return err(probeFailed(`git remote probe threw for "${t.repoId}"`, toDbErrorLike(cause)));
    }
    if (isErr(hasRemote)) {
      return err(probeFailed(`git remote probe failed for "${t.repoId}"`, hasRemote.error));
    }
    if (hasRemote.value) {
      perRepo.push({ repoId: t.repoId, kind: t.kind, status: "remote_configured" });
      continue;
    }

    // No remote — check for an explicit local-only acceptance.
    let accepted: Result<boolean, DbError>;
    try {
      accepted = await acceptance.isLocalOnlyAccepted(t.repoId);
    } catch (cause) {
      return err(
        probeFailed(`local-only acceptance probe threw for "${t.repoId}"`, toDbErrorLike(cause)),
      );
    }
    if (isErr(accepted)) {
      return err(
        probeFailed(`local-only acceptance probe failed for "${t.repoId}"`, accepted.error),
      );
    }
    if (accepted.value) {
      perRepo.push({ repoId: t.repoId, kind: t.kind, status: "local_only_accepted" });
      continue;
    }

    // Neither → a silent unbacked vault (a finding, fail closed).
    perRepo.push({ repoId: t.repoId, kind: t.kind, status: "unbacked" });
    findings.push(t.repoId);
  }

  return ok({ ok: findings.length === 0, findings, perRepo });
}

function probeFailed(message: string, cause: DbError): VaultDoctorFailure {
  return {
    kind: "vault_doctor_failure",
    reason: "probe_failed",
    message,
    repair:
      "Ensure each vault path is a readable git repo, then re-run the doctor. " +
      "Configure a git remote (git remote add origin …) or record an explicit local-only acceptance for each repo.",
    cause,
  };
}

// ── (b) Keychain-reachable check (degraded precondition for 10.5 / LIFE-6) ──────

/** The reachability states the Keychain probe reports (mirrors the SecretsPort states). */
export type KeychainReachability = "reachable" | "locked" | "denied";

/**
 * Probes whether the macOS Keychain is reachable (unlocked + access granted). The
 * wiring binds it to the SecretsPort / KeychainSecretsAdapter reachability probe.
 * Never throws across the boundary (§16); a probe failure is a typed err.
 */
export interface KeychainProbePort {
  probe(): Promise<Result<KeychainReachability, DbError>>;
}

/** A successful reachability result (the Keychain is unlocked + accessible). */
export interface KeychainReachableOk {
  readonly state: "reachable";
}

/** Closed, enumerable Keychain-check failure reasons. */
export type KeychainCheckFailureReason = "keychain_unavailable" | "probe_failed";

/**
 * Typed Keychain-unavailable refusal (§16 / LIFE-6): the degraded-mode signal 10.5
 * consumes. `state` is the locked/denied state (present on `keychain_unavailable`).
 */
export interface KeychainCheckFailure {
  readonly kind: "keychain_check_failure";
  readonly reason: KeychainCheckFailureReason;
  readonly message: string;
  readonly repair: string;
  /** The unavailable state (locked/denied) — set on `keychain_unavailable`. */
  readonly state?: "locked" | "denied";
  readonly cause?: DbError;
}

/**
 * Check the Keychain is reachable — the degraded-mode PRECONDITION for worker
 * supervision (10.5). A `reachable` probe → `ok`. A `locked`/`denied` probe → a
 * typed `keychain_unavailable` refusal carrying the state (the worker marks affected
 * providers/connectors degraded + re-attempts on unlock, LIFE-6). A probe FAULT →
 * `probe_failed`. Never throws (§16).
 */
export async function checkKeychainReachable(
  probe: KeychainProbePort,
): Promise<Result<KeychainReachableOk, KeychainCheckFailure>> {
  let result: Result<KeychainReachability, DbError>;
  try {
    result = await probe.probe();
  } catch (cause) {
    return err(keychainProbeFailed(toDbErrorLike(cause)));
  }
  if (isErr(result)) {
    return err(keychainProbeFailed(result.error));
  }
  if (result.value === "reachable") {
    return ok({ state: "reachable" });
  }
  // locked | denied → a typed unavailable (degraded-mode signal).
  return err({
    kind: "keychain_check_failure",
    reason: "keychain_unavailable",
    message: `macOS Keychain is ${result.value}; secrets are unavailable (degraded mode).`,
    repair:
      "Unlock the login Keychain (or grant access when prompted) and re-run. " +
      "Dependent providers/connectors stay degraded and re-attempt on unlock (LIFE-6).",
    state: result.value,
  });
}

function keychainProbeFailed(cause: DbError): KeychainCheckFailure {
  return {
    kind: "keychain_check_failure",
    reason: "probe_failed",
    message: "Could not probe the macOS Keychain for reachability.",
    repair: "Ensure the Keychain service is running, then re-run the check.",
    cause,
  };
}

// ── shared ───────────────────────────────────────────────────────────────────────

/** Coerce an unknown thrown value to a `DbError`-shaped opaque cause (never re-throws). */
function toDbErrorLike(cause: unknown): DbError {
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";
  return { code: "unknown", message, cause };
}

// ── the wiring factory (wiringFactory) ────────────────────────────────────────

/** Ports the backup doctor is built over. */
export interface BackupDoctorPorts {
  readonly git: GitRemotePort;
  readonly acceptance: LocalOnlyAcceptanceStore;
  readonly keychain: KeychainProbePort;
}

/** The injectable backup doctor the composition root mounts. */
export interface BackupDoctor {
  vaultRemoteDoctor(
    targets: readonly VaultRepoTarget[],
  ): Promise<Result<VaultRemoteDoctorReport, VaultDoctorFailure>>;
  keychainReachable(): Promise<Result<KeychainReachableOk, KeychainCheckFailure>>;
}

/**
 * Build the backup doctor over the injected ports. The composition root binds `git`
 * to a `git remote` probe, `acceptance` to the local-only acceptance store, and
 * `keychain` to the SecretsPort reachability probe. This factory does NOT wire itself
 * into the worker bootstrap.
 */
export function createBackupDoctor(ports: BackupDoctorPorts): BackupDoctor {
  return {
    vaultRemoteDoctor(targets: readonly VaultRepoTarget[]) {
      return runVaultRemoteDoctor(targets, ports.git, ports.acceptance);
    },
    keychainReachable() {
      return checkKeychainReachable(ports.keychain);
    },
  };
}
