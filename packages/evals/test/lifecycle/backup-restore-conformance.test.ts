// §12 CONFORMANCE — BACKUP / RESTORE (task 10.8 suite 4; §4 / §16 Backup &
// recovery). A CROSS-CUTTING conformance suite over the REAL restore orchestrator
// (restoreOperational / createOperationalRestoreService) + the REAL vault doctor
// (runVaultRemoteDoctor / createBackupDoctor). It pins:
//   • restore RECOVERS the non-rebuildable operational truth AND re-derives the
//     read models with NO orphan and NO duplicate (disjoint sets, exact cover);
//   • an unverified integrity gate FAILS CLOSED (never re-derives against a corrupt
//     truth store);
//   • the vault doctor enforces REMOTE-or-EXPLICIT-LOCAL-ONLY (an unbacked vault is
//     a finding — no silent unbacked vault, §16).
//
// SUTs imported: @sow/worker restoreOperational + its ports (OpDbRestorePort,
// TemporalPersistenceRestorePort, ReadModelRebuilder) and runVaultRemoteDoctor +
// its ports (GitRemotePort, LocalOnlyAcceptanceStore). @sow/db isRebuildable /
// OperationalDomain drive the correct domain sets.
import { describe, expect, it } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  isRebuildable,
  type DbError,
  type OperationalDomain,
} from "@sow/db";
import {
  restoreOperational,
  checkConsistency,
  createOperationalRestoreService,
  type OpDbRestorePort,
  type OpDbRestoreResult,
  type OpDbRestoreOptions,
  type TemporalPersistenceRestorePort,
  type TemporalRestoreResult,
  type ReadModelRebuilder,
  type RestoredReadModels,
} from "@sow/worker/backup/restore";
import {
  runVaultRemoteDoctor,
  createBackupDoctor,
  type VaultRepoTarget,
  type GitRemotePort,
  type LocalOnlyAcceptanceStore,
  type KeychainProbePort,
  type KeychainReachability,
} from "@sow/worker/backup/doctor";

// The full domain universe + the correct split (per @sow/db classification).
const ALL_DOMAINS: readonly OperationalDomain[] = [
  "event_log",
  "audit",
  "approvals",
  "outboxes",
  "connector_cursors",
  "workflow_runs",
  "provider_state",
  "workspace_config",
  "write_receipts",
  "health_items",
  "schedule_bookkeeping",
  "instance_leases",
  "read_models",
  "gcl_projections",
];
const NON_REBUILDABLE = ALL_DOMAINS.filter((d) => !isRebuildable(d));
const REBUILDABLE = ALL_DOMAINS.filter((d) => isRebuildable(d));

// ── restore-port fakes ──────────────────────────────────────────────────────────

function opDbPort(result: OpDbRestoreResult): OpDbRestorePort {
  return { restore: (_opts?: OpDbRestoreOptions) => Promise.resolve(ok(result)) };
}
function opDbPortErr(e: DbError): OpDbRestorePort {
  return { restore: () => Promise.resolve(err(e)) };
}
function temporalPort(): TemporalPersistenceRestorePort {
  return { restore: () => Promise.resolve(ok<TemporalRestoreResult>({ backupId: "temporal-bk-1" })) };
}
function rebuilder(rederivedDomains: readonly OperationalDomain[]): ReadModelRebuilder {
  return {
    rebuild: (_domains) =>
      Promise.resolve(ok<RestoredReadModels>({ rederivedDomains })),
  };
}

const cleanOpDbResult: OpDbRestoreResult = {
  backupId: "op-bk-1",
  recoveredDomains: NON_REBUILDABLE,
  integrityVerified: true,
};

describe("§12 backup/restore conformance — recovers truth + re-derives read models, no orphan/duplicate", () => {
  it("a clean restore recovers the non-rebuildable truth AND re-derives EXACTLY the rebuildable set", async () => {
    const r = await restoreOperational(
      opDbPort(cleanOpDbResult),
      temporalPort(),
      rebuilder(REBUILDABLE),
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // non-rebuildable truth recovered from the backup
    expect([...r.value.opDb.recoveredDomains].sort()).toEqual([...NON_REBUILDABLE].sort());
    expect(r.value.opDb.integrityVerified).toBe(true);
    // rebuildable read models re-derived
    expect([...r.value.readModels.rederivedDomains].sort()).toEqual([...REBUILDABLE].sort());
    // no orphan, no duplicate — the two sets are disjoint + fully covered
    expect(r.value.consistency.clean).toBe(true);
    expect(r.value.consistency.orphanedDomains).toEqual([]);
    expect(r.value.consistency.duplicatedDomains).toEqual([]);
  });

  it("the recovered-truth set and the re-derived set are DISJOINT (no clobber)", () => {
    const recovered = new Set(NON_REBUILDABLE);
    for (const d of REBUILDABLE) expect(recovered.has(d)).toBe(false);
    // and every rebuildable domain is a read-model / derived domain (not truth)
    for (const d of REBUILDABLE) expect(isRebuildable(d)).toBe(true);
  });

  it("an ORPHAN (a rebuildable domain not re-derived) fails closed as inconsistent", async () => {
    // rebuilder re-derives only read_models, dropping gcl_projections → orphan
    const r = await restoreOperational(
      opDbPort(cleanOpDbResult),
      temporalPort(),
      rebuilder(["read_models"]),
    );
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.reason).toBe("inconsistent_after_restore");
    expect(r.error.consistency?.orphanedDomains ?? []).toContain("gcl_projections");
  });

  it("a DUPLICATE (a domain both recovered-as-truth AND re-derived) fails closed as inconsistent", async () => {
    // recovered truth INCLUDES a rebuildable domain AND the rebuilder re-derives it
    // → the same domain is both restored and re-derived (a clobber).
    const overlapResult: OpDbRestoreResult = {
      backupId: "op-bk-dup",
      recoveredDomains: [...NON_REBUILDABLE, "read_models"],
      integrityVerified: true,
    };
    const r = await restoreOperational(opDbPort(overlapResult), temporalPort(), rebuilder(REBUILDABLE));
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.reason).toBe("inconsistent_after_restore");
    expect(r.error.consistency?.duplicatedDomains ?? []).toContain("read_models");
  });

  it("an UNVERIFIED integrity gate fails CLOSED — never re-derives against a corrupt truth store", async () => {
    let rebuildCalled = false;
    const spyingRebuilder: ReadModelRebuilder = {
      rebuild: (_d) => {
        rebuildCalled = true;
        return Promise.resolve(ok<RestoredReadModels>({ rederivedDomains: REBUILDABLE }));
      },
    };
    const r = await restoreOperational(
      opDbPort({ backupId: "corrupt", recoveredDomains: NON_REBUILDABLE, integrityVerified: false }),
      temporalPort(),
      spyingRebuilder,
    );
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.error.reason).toBe("integrity_unverified");
    expect(rebuildCalled).toBe(false); // re-derivation NEVER ran against a corrupt store
  });

  it("an op-DB restore fault fails closed BEFORE any Temporal/read-model recovery", async () => {
    const r = await restoreOperational(
      opDbPortErr({ code: "unknown", message: "backup unreadable" } as DbError),
      temporalPort(),
      rebuilder(REBUILDABLE),
    );
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("op_db_restore_failed");
  });

  it("checkConsistency is the pure oracle: clean iff exact cover + disjoint", () => {
    expect(checkConsistency(NON_REBUILDABLE, REBUILDABLE).clean).toBe(true);
    expect(checkConsistency(NON_REBUILDABLE, ["read_models"]).clean).toBe(false); // orphan
    expect(checkConsistency([...NON_REBUILDABLE, "read_models"], REBUILDABLE).clean).toBe(false); // dup
  });

  it("the composition-root service exposes the same behavior (createOperationalRestoreService)", async () => {
    const svc = createOperationalRestoreService(
      opDbPort(cleanOpDbResult),
      temporalPort(),
      rebuilder(REBUILDABLE),
    );
    const r = await svc.restore();
    expect(isOk(r) && r.value.consistency.clean).toBe(true);
    // the pre-migration rollback path routes through the same orchestrator
    const rollback = await svc.rollbackFromPreMigration({ preMigrationBackupId: "pre-mig-1" });
    expect(isOk(rollback) && rollback.value.consistency.clean).toBe(true);
  });
});

// ── vault doctor: remote-or-explicit-local-only ─────────────────────────────────

function gitPort(withRemote: ReadonlySet<string>): GitRemotePort {
  return { hasRemote: (path) => Promise.resolve(ok<boolean>(withRemote.has(path))) };
}
function acceptancePort(accepted: ReadonlySet<string>): LocalOnlyAcceptanceStore {
  return { isLocalOnlyAccepted: (repoId) => Promise.resolve(ok<boolean>(accepted.has(repoId))) };
}

const targets: readonly VaultRepoTarget[] = [
  { repoId: "employer-work", path: "/vaults/employer", kind: "workspace" },
  { repoId: "personal-business", path: "/vaults/personal", kind: "workspace" },
  { repoId: "global-coordination", path: "/vaults/global", kind: "global_coordination" },
];

describe("§12 backup/restore conformance — vault doctor enforces remote-or-explicit-local-only (§16)", () => {
  it("every repo backed by a remote → ok, no findings", async () => {
    const r = await runVaultRemoteDoctor(
      targets,
      gitPort(new Set(["/vaults/employer", "/vaults/personal", "/vaults/global"])),
      acceptancePort(new Set()),
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(true);
      expect(r.value.findings).toEqual([]);
      expect(r.value.perRepo.every((p) => p.status === "remote_configured")).toBe(true);
    }
  });

  it("a repo with NO remote but an EXPLICIT local-only acceptance is accepted (not a finding)", async () => {
    const r = await runVaultRemoteDoctor(
      targets,
      gitPort(new Set(["/vaults/employer", "/vaults/global"])), // personal has no remote
      acceptancePort(new Set(["personal-business"])), // but explicitly accepted local-only
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(true);
      const personal = r.value.perRepo.find((p) => p.repoId === "personal-business");
      expect(personal?.status).toBe("local_only_accepted");
    }
  });

  it("an UNBACKED vault (no remote, no acceptance) is a FINDING — no silent unbacked vault", async () => {
    const r = await runVaultRemoteDoctor(
      targets,
      gitPort(new Set(["/vaults/employer"])), // personal + global unbacked
      acceptancePort(new Set()),
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(false); // fail closed
      expect([...r.value.findings].sort()).toEqual(["global-coordination", "personal-business"]);
    }
  });

  it("a git-probe fault fails closed as probe_failed (never silently passes an unreadable repo)", async () => {
    const faultingGit: GitRemotePort = {
      hasRemote: () => Promise.resolve(err({ code: "unknown", message: "not a git repo" } as DbError)),
    };
    const r = await runVaultRemoteDoctor(targets, faultingGit, acceptancePort(new Set()));
    expect(isOk(r)).toBe(false);
    if (!isOk(r)) expect(r.error.reason).toBe("probe_failed");
  });

  it("createBackupDoctor exposes the doctor + a Keychain reachability precondition", async () => {
    const keychain: KeychainProbePort = {
      probe: () => Promise.resolve(ok<KeychainReachability>("reachable")),
    };
    const doctor = createBackupDoctor({
      git: gitPort(new Set(["/vaults/employer", "/vaults/personal", "/vaults/global"])),
      acceptance: acceptancePort(new Set()),
      keychain,
    });
    const vault = await doctor.vaultRemoteDoctor(targets);
    expect(isOk(vault) && vault.value.ok).toBe(true);
    const kc = await doctor.keychainReachable();
    expect(isOk(kc) && kc.value.state).toBe("reachable");

    // a locked Keychain is the degraded-mode signal (typed refusal, never a throw)
    const lockedDoctor = createBackupDoctor({
      git: gitPort(new Set()),
      acceptance: acceptancePort(new Set()),
      keychain: { probe: () => Promise.resolve(ok<KeychainReachability>("locked")) },
    });
    const lockedKc = await lockedDoctor.keychainReachable();
    expect(isOk(lockedKc)).toBe(false);
    if (!isOk(lockedKc)) {
      expect(lockedKc.error.reason).toBe("keychain_unavailable");
      expect(lockedKc.error.state).toBe("locked");
    }
  });
});

// ── the DoD gate entry (wiringFactory) ─────────────────────────────────────────
// Machine-checkable predicate: a clean restore is consistent AND the doctor flags
// an unbacked vault.
export async function backupRestoreConformanceHolds(): Promise<boolean> {
  const restore: Result<{ consistency: { clean: boolean } }, unknown> = await restoreOperational(
    opDbPort(cleanOpDbResult),
    temporalPort(),
    rebuilder(REBUILDABLE),
  );
  if (!isOk(restore) || !restore.value.consistency.clean) return false;
  const doctor = await runVaultRemoteDoctor(
    targets,
    gitPort(new Set(["/vaults/employer"])),
    acceptancePort(new Set()),
  );
  return isOk(doctor) && doctor.value.ok === false && doctor.value.findings.length === 2;
}
