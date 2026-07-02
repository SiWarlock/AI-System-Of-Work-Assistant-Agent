// 10.6 — vault git-remote doctor + Keychain-reachable check (§16 Backup &
// recovery preconditions). Ungated Vitest: injected ports, no real git / Keychain.
// §16: never throws across the boundary — every probe returns a typed Result.
//
// What these tests pin:
//   • the vault doctor enforces, per workspace Markdown repo AND the Global/
//     Coordination repo, that a git remote is CONFIGURED **or** an explicit
//     local-only acceptance is recorded — no silent unbacked vault;
//   • a repo with neither → a typed doctor finding (fail closed);
//   • the Keychain-reachable check surfaces a typed `unavailable` when the Keychain
//     is locked/denied (the degraded-mode precondition for 10.5 / LIFE-6), and
//     `ok` when reachable.

import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err } from "@sow/contracts";
import {
  runVaultRemoteDoctor,
  checkKeychainReachable,
  createBackupDoctor,
  type GitRemotePort,
  type VaultRepoTarget,
  type LocalOnlyAcceptanceStore,
  type KeychainProbePort,
} from "../../src/backup/doctor";

// ── fakes ─────────────────────────────────────────────────────────────────────

const TARGETS: readonly VaultRepoTarget[] = [
  { repoId: "employer-work", path: "/vault/employer-work", kind: "workspace" },
  { repoId: "personal-business", path: "/vault/personal-business", kind: "workspace" },
  { repoId: "personal-life", path: "/vault/personal-life", kind: "workspace" },
  { repoId: "global-coordination", path: "/vault/_global", kind: "global_coordination" },
];

function gitPortWithRemotes(withRemote: Set<string>): GitRemotePort {
  return {
    hasRemote: (path: string) =>
      Promise.resolve(ok(withRemote.has(path))),
  };
}

function acceptanceStore(accepted: Set<string>): LocalOnlyAcceptanceStore {
  return {
    isLocalOnlyAccepted: (repoId: string) =>
      Promise.resolve(ok(accepted.has(repoId))),
  };
}

// ── the vault git-remote doctor ──────────────────────────────────────────────────

describe("runVaultRemoteDoctor — remote-configured OR explicit local-only, per repo", () => {
  it("passes when every repo (incl. Global/Coordination) has a git remote configured", async () => {
    const git = gitPortWithRemotes(new Set(TARGETS.map((t) => t.path)));
    const r = await runVaultRemoteDoctor(TARGETS, git, acceptanceStore(new Set()));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(true);
      expect(r.value.findings).toEqual([]);
      // Every repo classified as backed-by-remote.
      expect(r.value.perRepo.every((p) => p.status === "remote_configured")).toBe(true);
      // The Global/Coordination repo is covered too.
      expect(r.value.perRepo.some((p) => p.repoId === "global-coordination")).toBe(true);
    }
  });

  it("passes when a repo lacks a remote BUT has an explicit local-only acceptance", async () => {
    // employer-work has no remote but IS accepted local-only; others have remotes.
    const git = gitPortWithRemotes(
      new Set(TARGETS.filter((t) => t.repoId !== "employer-work").map((t) => t.path)),
    );
    const r = await runVaultRemoteDoctor(
      TARGETS,
      git,
      acceptanceStore(new Set(["employer-work"])),
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(true);
      const ew = r.value.perRepo.find((p) => p.repoId === "employer-work");
      expect(ew?.status).toBe("local_only_accepted");
    }
  });

  it("FAILS closed on a silent unbacked vault (no remote, no acceptance)", async () => {
    // personal-life has neither a remote nor an acceptance.
    const git = gitPortWithRemotes(
      new Set(TARGETS.filter((t) => t.repoId !== "personal-life").map((t) => t.path)),
    );
    const r = await runVaultRemoteDoctor(TARGETS, git, acceptanceStore(new Set()));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(false);
      expect(r.value.findings).toContain("personal-life");
      const bad = r.value.perRepo.find((p) => p.repoId === "personal-life");
      expect(bad?.status).toBe("unbacked");
    }
  });

  it("flags an unbacked Global/Coordination repo specifically (it must be backed too)", async () => {
    const git = gitPortWithRemotes(
      new Set(TARGETS.filter((t) => t.kind === "workspace").map((t) => t.path)),
    );
    const r = await runVaultRemoteDoctor(TARGETS, git, acceptanceStore(new Set()));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.ok).toBe(false);
      expect(r.value.findings).toContain("global-coordination");
    }
  });

  it("a git-probe fault folds to a typed err, not a throw (§16)", async () => {
    const git: GitRemotePort = {
      hasRemote: () => Promise.resolve(err({ code: "unavailable", message: "git broke" })),
    };
    const r = await runVaultRemoteDoctor(TARGETS, git, acceptanceStore(new Set()));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("probe_failed");
  });

  it("does not throw on a hostile git port that rejects", async () => {
    const git: GitRemotePort = { hasRemote: () => Promise.reject(new Error("boom")) };
    const r = await runVaultRemoteDoctor(TARGETS, git, acceptanceStore(new Set()));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("probe_failed");
  });
});

// ── the Keychain-reachable check (degraded precondition for 10.5 / LIFE-6) ───────

describe("checkKeychainReachable — typed unavailable when locked (LIFE-6 precondition)", () => {
  it("returns ok(reachable) when the Keychain is unlocked", async () => {
    const probe: KeychainProbePort = { probe: () => Promise.resolve(ok("reachable")) };
    const r = await checkKeychainReachable(probe);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.state).toBe("reachable");
  });

  it("surfaces a typed unavailable when the Keychain is LOCKED (never a throw)", async () => {
    const probe: KeychainProbePort = { probe: () => Promise.resolve(ok("locked")) };
    const r = await checkKeychainReachable(probe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("keychain_unavailable");
      expect(r.error.state).toBe("locked");
    }
  });

  it("surfaces a typed unavailable when the Keychain access is DENIED", async () => {
    const probe: KeychainProbePort = { probe: () => Promise.resolve(ok("denied")) };
    const r = await checkKeychainReachable(probe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.state).toBe("denied");
  });

  it("a probe fault folds to a typed err (never throws)", async () => {
    const probe: KeychainProbePort = {
      probe: () => Promise.resolve(err({ code: "unknown", message: "probe blew up" })),
    };
    const r = await checkKeychainReachable(probe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("probe_failed");
  });

  it("does not throw on a hostile probe that rejects", async () => {
    const probe: KeychainProbePort = { probe: () => Promise.reject(new Error("boom")) };
    const r = await checkKeychainReachable(probe);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("probe_failed");
  });
});

// ── the wiring factory ──────────────────────────────────────────────────────────

describe("createBackupDoctor — the injectable factory (wiringFactory)", () => {
  it("exposes vaultRemoteDoctor() + keychainReachable() over injected ports", async () => {
    const git = gitPortWithRemotes(new Set(TARGETS.map((t) => t.path)));
    const probe: KeychainProbePort = { probe: () => Promise.resolve(ok("reachable")) };
    const doctor = createBackupDoctor({
      git,
      acceptance: acceptanceStore(new Set()),
      keychain: probe,
    });
    const vr = await doctor.vaultRemoteDoctor(TARGETS);
    expect(isOk(vr)).toBe(true);
    const kc = await doctor.keychainReachable();
    expect(isOk(kc)).toBe(true);
  });
});
