// Install-doctor CLI / repair command (task 11.5-d, §13).
//
// The production entry that CLOSES the 11.5-a/b/c reachability waiver: a composition root that
// resolves the doctor input from config + injected ports, runs the built collectors + pure engine
// over the FULL 10-field snapshot, RENDERS the typed DoctorReport to an injected sink, and returns
// a status-derived exit code.
//
//   • REPORT-ONLY — no mutation, no side effect beyond the read probes + the write sink. The
//     "repair" is printed guidance; re-running after an EXTERNAL fix reports that check green
//     (idempotent by pure re-probe — the doctor NEVER auto-applies a fix).
//   • RENDER REDACTION (safety rule 7) — the output carries ONLY the typed DoctorReport fields
//     (status / failureVariant / repair / bounded single-line detail), never a raw ps/ls/mount
//     line, argv, absolute path, or secret (the report is already redaction-safe; render adds none).
//   • MULTI-VAULT COMPLETENESS (safety rule 1) — the two VAULT-SCOPED checks (vault_acl, git_remotes)
//     cover EVERY configured vault, AND-folded worst-of: a non-sole-write ACL or a missing remote on
//     ANY vault ⇒ a finding (a writable non-first vault must never silently pass — GO #1). The
//     per-vault collectors run SEQUENTIALLY so the per-vault loopback binds never overlap (a
//     concurrent fan-out would bind the same port twice ⇒ a false loopback_ports finding).
//   • LOCAL-ONLY — the collectors run local ls/mount/ps/fdesetup/security/git/--version + a loopback
//     bind; no network. `workerPrincipal` is resolved in the ENTRY (os.userInfo), never in the pure collector.
import { runDoctor } from "./doctor";
import { collectPrerequisiteProbes, collectSecurityProbes, probeGitRemotes } from "./probe-collectors";
import type { RunCommand, ProbeLoopbackBind } from "./probe-collectors";
import { collectPostureProbes, probeVaultAcl } from "./posture-collectors";
import type { ProbeSnapshot } from "./probe-snapshot";
import type { AppConfig, DoctorReport, DoctorStatus } from "@sow/contracts";

/** The composition-root deps. The real adapters + entry-resolved values are injected here. */
export interface InstallDoctorDeps {
  readonly config: AppConfig;
  readonly run: RunCommand;
  readonly bindLoopback: ProbeLoopbackBind;
  /** The output sink — the entry passes a `process.stdout` writer; tests capture. */
  readonly write: (output: string) => void;
  /** The OS principal the worker runs as — resolved in the ENTRY (os.userInfo), never in the pure collector. */
  readonly workerPrincipal: string;
  /** The canonical brain path (resolved in the entry from env/config/default). */
  readonly canonicalBrainPath: string;
  /** The local git repo dir for the remotes probe (resolved in the entry; default process.cwd()). */
  readonly repoDir: string;
  /** Whether the owner accepted local-only backup (config/default false). */
  readonly localBackupAccepted?: boolean;
}

/**
 * Render a DoctorReport to a deterministic, redaction-safe human-readable string: one `[status]
 * check` line per check (+ ` — failureVariant: repair (detail)` on any non-ok) and a final worst-of
 * `overall:` summary. Reads ONLY the typed fields (rule 7 — no raw probe context).
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const head = `[${c.status}] ${c.check}`;
    if (c.status === "ok") return head;
    const detail = c.detail !== undefined ? ` (${c.detail})` : "";
    return `${head} — ${c.failureVariant ?? ""}: ${c.repair ?? ""}${detail}`;
  });
  lines.push(`overall: ${report.overall}`);
  return lines.join("\n");
}

/**
 * Map the worst-of roll-up to a process exit code: `ok`/`degraded` → 0 (a degraded mode is a
 * TOLERATED first-class state — the app still runs), `finding` → 1 (a prerequisite to fix; an
 * install script MUST be able to gate on it — a finding NEVER exits 0).
 */
export function doctorExitCode(overall: DoctorStatus): number {
  return overall === "finding" ? 1 : 0;
}

/** The configured vault dirs (all workspaces); an empty/unset map ⇒ [] ⇒ explicit fail-closed findings. */
function resolveVaultDirs(config: AppConfig): string[] {
  return config.vaultRootPaths !== undefined ? Object.values(config.vaultRootPaths) : [];
}

/** The trailing decimal port of a `host:port` address, or undefined (strict digits — no hex/exponent). */
function parsePort(addr: string | undefined): number | undefined {
  if (addr === undefined) return undefined;
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return undefined;
  const tail = addr.slice(idx + 1);
  if (!/^\d+$/.test(tail)) return undefined;
  const n = Number(tail);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

/** The loopback ports the doctor probes (worker API + Temporal, from config) — DEDUPED (a shared port binds once). */
function resolveLoopbackPorts(config: AppConfig): number[] {
  const ports: number[] = [];
  if (config.apiPort !== undefined) ports.push(config.apiPort);
  const temporalPort = parsePort(config.temporalAddress);
  if (temporalPort !== undefined) ports.push(temporalPort);
  return [...new Set(ports)];
}

/**
 * The install-doctor composition root: resolve the input from config + injected ports, run the
 * collectors + engine over the folded 10-field snapshot, render to the sink, return the exit code.
 * REPORT-ONLY (no mutation). Reuses the 11.5-a/b/c collectors + engine UNCHANGED.
 */
export async function runInstallDoctor(deps: InstallDoctorDeps): Promise<number> {
  const vaultDirs = resolveVaultDirs(deps.config);
  const loopbackPorts = resolveLoopbackPorts(deps.config);
  const localBackupAccepted = deps.localBackupAccepted ?? false;
  // A stable dir for the once-run vault-INDEPENDENT collectors (their vault-scoped fields are discarded).
  const anchorVault = vaultDirs[0] ?? "";

  // The vault-INDEPENDENT probes run EXACTLY ONCE — node/pnpm, temporal, gbrain-startable, loopback
  // (bound once ⇒ no cross-vault self-collision), filevault, keychain, gbrain-mount, stray. The
  // vault-scoped fields these collectors also carry (prereq.gitRemotes, posture.vaultAcl) are
  // OVERRIDDEN below by the per-vault fold.
  const [prereq, security, posture] = await Promise.all([
    collectPrerequisiteProbes({ run: deps.run, bindLoopback: deps.bindLoopback, loopbackPorts, repoDir: anchorVault, localBackupAccepted }),
    collectSecurityProbes({ run: deps.run }),
    collectPostureProbes({ run: deps.run, vaultDir: anchorVault, canonicalBrainPath: deps.canonicalBrainPath, workerPrincipal: deps.workerPrincipal }),
  ]);

  // The two VAULT-SCOPED checks fold worst-of over EVERY configured vault (these probes bind no port,
  // so the fan-out is collision-free). NO configured vault ⇒ EXPLICIT findings (an unconfigured
  // install fails closed — never an implicit "" probe that could resolve against the wrong dir).
  let vaultAclSole = false;
  let hasRemoteAll = false;
  if (vaultDirs.length > 0) {
    const [vaultAcls, gitRemotesPerVault] = await Promise.all([
      Promise.all(vaultDirs.map((v) => probeVaultAcl(deps.run, v, deps.workerPrincipal))),
      Promise.all(vaultDirs.map((v) => probeGitRemotes(deps.run, v, localBackupAccepted))), // §16: the VAULT repo's remote
    ]);
    vaultAclSole = vaultAcls.every((p) => p.workerIsSoleWritePrincipal === true);
    hasRemoteAll = gitRemotesPerVault.every((p) => p.hasRemote === true);
  }

  const snapshot: Partial<ProbeSnapshot> = {
    ...prereq,
    ...security,
    ...posture,
    vaultAcl: { workerIsSoleWritePrincipal: vaultAclSole },
    gitRemotes: { hasRemote: hasRemoteAll, localBackupAccepted },
  };
  const report = runDoctor(snapshot);
  deps.write(renderDoctorReport(report));
  return doctorExitCode(report.overall);
}
