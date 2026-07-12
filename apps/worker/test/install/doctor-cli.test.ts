// Install-doctor CLI / repair command (task 11.5-d, §13) — the production entry that closes the
// 11.5-a/b/c reachability waiver.
//
// Two tiers: fast-unit — the PURE renderDoctorReport + doctorExitCode + the runInstallDoctor
// composition over injected fake run/bindLoopback/config/write (no subprocess); and a
// SOW_DOCTOR_REAL-gated end-to-end run over the REAL adapters on this machine.
import { describe, it, expect } from "vitest";
import type { AppConfig, DoctorReport, DoctorCheckResult } from "@sow/contracts";
import {
  renderDoctorReport,
  doctorExitCode,
  runInstallDoctor,
  type InstallDoctorDeps,
} from "../../src/install/doctor-cli";
import type { CommandRequest, CommandOutcome, RunCommand, ProbeLoopbackBind } from "../../src/install/probe-collectors";
import { createLocalCommandRunner, createLoopbackBindProbe } from "../../src/install/probe-adapters";

// ── fixtures ────────────────────────────────────────────────────────────────
const okCheck = (check: DoctorCheckResult["check"]): DoctorCheckResult => ({ check, status: "ok" });
const report = (checks: DoctorCheckResult[]): DoctorReport => ({
  checks,
  overall: checks.reduce<DoctorReport["overall"]>(
    (w, c) => (c.status === "finding" ? "finding" : c.status === "degraded" && w === "ok" ? "degraded" : w),
    "ok",
  ),
});

const okBind: ProbeLoopbackBind = () => Promise.resolve({ bindable: true });
const notFound: CommandOutcome = { ok: false, code: "not_found", message: "not_found" };
const baseConfig: AppConfig = { operationalDbPath: "/x/db.sqlite", vaultRootPaths: { ws: "/vault" } };

function deps(over: Partial<InstallDoctorDeps> & { readonly run: RunCommand; readonly write: (o: string) => void }): InstallDoctorDeps {
  return {
    config: baseConfig,
    bindLoopback: okBind,
    workerPrincipal: "worker",
    canonicalBrainPath: "/brain",
    repoDir: "/repo",
    ...over,
  };
}

describe("doctor-cli — render + exit code (fast unit)", () => {
  it("render_all_ok_report — every check renders id + ok, no repair lines, overall ok — spec(§13)", () => {
    const r = report([okCheck("node_pnpm"), okCheck("filevault"), okCheck("vault_acl")]);
    const out = renderDoctorReport(r);
    expect(out).toContain("[ok] node_pnpm");
    expect(out).toContain("[ok] vault_acl");
    expect(out).not.toContain("—"); // no repair separator on an all-ok report
    expect(out).toContain("overall: ok");
  });

  it("render_finding_shows_distinct_repair — each finding renders its DISTINCT failureVariant + repair + detail — spec(§13)", () => {
    const r = report([
      { check: "filevault", status: "finding", failureVariant: "filevault_off", repair: "Enable FileVault in System Settings." },
      {
        check: "stray_gbrain_process",
        status: "finding",
        failureVariant: "stray_gbrain_writer_detected",
        repair: "Stop the stray gbrain writer.",
        detail: "detected gbrain writers: serve",
      },
    ]);
    const out = renderDoctorReport(r);
    expect(out).toContain("filevault_off: Enable FileVault in System Settings.");
    expect(out).toContain("stray_gbrain_writer_detected: Stop the stray gbrain writer.");
    expect(out).toContain("(detected gbrain writers: serve)");
    expect(out).toContain("overall: finding");
  });

  it("render_redaction_clean_on_posture_finding — a posture finding renders ONLY typed fields (no raw argv/path/secret) — spec(§16 safety rule 7)", () => {
    const r = report([
      {
        check: "stray_gbrain_process",
        status: "finding",
        failureVariant: "stray_gbrain_writer_detected",
        repair: "Stop the stray gbrain writer bound to the canonical brain.",
        detail: "detected gbrain writers: serve, dream",
      },
    ]);
    const out = renderDoctorReport(r);
    // The renderer is a PURE pass-through of the typed fields — it AUGMENTS nothing. Assert the exact
    // rendered lines so a regression that appended raw probe context (a path/argv/secret) is caught.
    expect(out).toBe(
      "[finding] stray_gbrain_process — stray_gbrain_writer_detected: Stop the stray gbrain writer bound to the canonical brain. (detected gbrain writers: serve, dream)\noverall: finding",
    );
    // (Reinforces rule-7: no raw argv / absolute path / secret from the underlying ps line.)
    expect(out).not.toContain("/usr/local/bin/gbrain");
    expect(out).not.toContain("--http");
    expect(out).not.toContain("--token");
  });

  it("exit_code_ok_degraded_zero_finding_nonzero — ok/degraded exit 0, finding exits non-zero — spec(§13 install-script gating)", () => {
    expect(doctorExitCode("ok")).toBe(0);
    expect(doctorExitCode("degraded")).toBe(0);
    expect(doctorExitCode("finding")).not.toBe(0);
  });
});

describe("doctor-cli — runInstallDoctor composition (fast unit, no subprocess)", () => {
  it("run_install_doctor_composes_and_writes — composes the collectors + engine, writes the rendered report, returns the derived exit code — spec(§13)", async () => {
    let written = "";
    // Everything faults (notFound) ⇒ findings ⇒ overall finding ⇒ non-zero exit.
    const code = await runInstallDoctor(deps({ run: () => Promise.resolve(notFound), write: (o) => (written += o) }));
    expect(written).toContain("overall: finding");
    expect(written).toContain("[finding] node_pnpm");
    expect(code).not.toBe(0);
  });

  it("report_only_no_mutation — the injected run sees ONLY the fixed READ commands; no mutation/repair command is issued — spec(§13 report-only)", async () => {
    const calls: CommandRequest[] = [];
    const run: RunCommand = (req) => {
      calls.push(req);
      return Promise.resolve(notFound);
    };
    await runInstallDoctor(deps({ run, write: () => {} }));
    // Every command is a known local READ probe — a whitelist; nothing mutating.
    const readBins = new Set(["node", "pnpm", "temporal", "gbrain", "git", "/usr/bin/fdesetup", "/usr/bin/security", "/bin/ls", "/sbin/mount", "/bin/ps"]);
    for (const c of calls) expect(readBins.has(c.bin)).toBe(true);
    // The git probe is the local no-network form (never fetch/push).
    const git = calls.find((c) => c.bin === "git");
    expect(git?.args).toEqual(["remote", "-v"]);
  });

  it("workerPrincipal_injected_not_probed — the ENTRY-injected workerPrincipal drives the vault-ACL owner check (the pure collector never reads the OS) — spec(§13)", async () => {
    // An ls owned by "alice", no group/other write, no ACL ⇒ sole IFF the injected principal is "alice".
    const aliceLs: RunCommand = (req) =>
      Promise.resolve(req.bin === "/bin/ls" ? { ok: true, stdout: "drwx------  5 alice  staff  160 x /vault\n" } : notFound);
    let asAlice = "";
    await runInstallDoctor(deps({ run: aliceLs, write: (o) => (asAlice = o), workerPrincipal: "alice" }));
    expect(asAlice).toContain("[ok] vault_acl");

    let asBob = "";
    await runInstallDoctor(deps({ run: aliceLs, write: (o) => (asBob = o), workerPrincipal: "bob" }));
    expect(asBob).toContain("[finding] vault_acl");
  });

  it("multi_vault_acl_folds_worst_of — a non-sole-write ACL on ANY configured vault ⇒ vault_acl finding; all sole ⇒ ok — spec(§13 REQ-S-NEW-008 completeness)", async () => {
    const config: AppConfig = { operationalDbPath: "/x/db", vaultRootPaths: { a: "/vaultA", b: "/vaultB" } };
    // The ls fake dispatches on the requested vault path — the LAST argv token (after the `-lde --`
    // fixed flags + the `--` end-of-options separator introduced in 11.5-e).
    const lsFor = (perVault: (path: string) => string): RunCommand => (req) =>
      req.bin === "/bin/ls"
        ? Promise.resolve({ ok: true, stdout: perVault(req.args.at(-1) ?? "") })
        : Promise.resolve(notFound);

    // vaultB is group-writable (NOT sole) ⇒ the folded vault_acl is a finding (never a silent ok).
    let mixed = "";
    await runInstallDoctor(
      deps({
        config,
        workerPrincipal: "worker",
        run: lsFor((p) =>
          p === "/vaultB" ? "drwxrwx---  5 worker  staff  160 x /vaultB\n" : "drwx------  5 worker  staff  160 x /vaultA\n",
        ),
        write: (o) => (mixed = o),
      }),
    );
    expect(mixed).toContain("[finding] vault_acl");

    // BOTH vaults worker-sole-write ⇒ the folded vault_acl is ok.
    let allSole = "";
    await runInstallDoctor(
      deps({
        config,
        workerPrincipal: "worker",
        run: lsFor((p) => `drwx------  5 worker  staff  160 x ${p}\n`),
        write: (o) => (allSole = o),
      }),
    );
    expect(allSole).toContain("[ok] vault_acl");
  });

  it("loopback_bound_once_no_self_collision — a multi-vault run binds each port EXACTLY once (hoisted out of the vault loop) ⇒ no self-collision — spec(§13)", async () => {
    const config: AppConfig = {
      operationalDbPath: "/x/db",
      apiPort: 3000,
      temporalAddress: "127.0.0.1:7233",
      vaultRootPaths: { a: "/vaultA", b: "/vaultB" },
    };
    // A REAL exclusive-bind model + a per-port bind counter: a concurrent same-port bind would collide,
    // and a per-vault re-bind (the regression) would count > 1.
    const held = new Set<number>();
    const bindCount = new Map<number, number>();
    const bindLoopback: ProbeLoopbackBind = async (port) => {
      bindCount.set(port, (bindCount.get(port) ?? 0) + 1);
      if (held.has(port)) return { bindable: false };
      held.add(port);
      await Promise.resolve();
      held.delete(port);
      return { bindable: true };
    };
    let out = "";
    await runInstallDoctor(deps({ config, run: () => Promise.resolve(notFound), bindLoopback, write: (o) => (out = o) }));
    // No false-occupied ⇒ loopback_ports ok; and each port bound EXACTLY once (never per-vault — pins the hoist).
    expect(out).toContain("[ok] loopback_ports");
    expect(bindCount.get(3000)).toBe(1);
    expect(bindCount.get(7233)).toBe(1);
  });

  it("multi_vault_git_remotes_folds_worst_of — a missing remote on ANY vault (no localBackupAccepted) ⇒ git_remotes finding — spec(§13 §16 vault remote)", async () => {
    const config: AppConfig = { operationalDbPath: "/x/db", vaultRootPaths: { a: "/vaultA", b: "/vaultB" } };
    // The git fake dispatches on the per-vault cwd (repoDir = the vault dir).
    const gitFor = (perVault: (cwd: string) => string): RunCommand => (req) =>
      req.bin === "git"
        ? Promise.resolve({ ok: true, stdout: perVault(req.cwd ?? "") })
        : Promise.resolve(notFound);

    // vaultB has no remote (empty `git remote -v`) ⇒ folded git_remotes finding (localBackupAccepted false).
    let out = "";
    await runInstallDoctor(
      deps({
        config,
        localBackupAccepted: false,
        run: gitFor((cwd) => (cwd === "/vaultB" ? "" : "origin\tgit@h:v.git (fetch)\n")),
        write: (o) => (out = o),
      }),
    );
    expect(out).toContain("[finding] git_remotes");

    // POSITIVE anchor: BOTH vaults have a remote ⇒ git_remotes ok (the fold isn't an always-finding mutant).
    let bothRemote = "";
    await runInstallDoctor(
      deps({ config, run: gitFor(() => "origin\tgit@h:v.git (fetch)\n"), write: (o) => (bothRemote = o) }),
    );
    expect(bothRemote).toContain("[ok] git_remotes");

    // A missing remote is TOLERATED when localBackupAccepted ⇒ git_remotes ok (§16 owner-accepted local backup).
    let accepted = "";
    await runInstallDoctor(
      deps({
        config,
        localBackupAccepted: true,
        run: gitFor((cwd) => (cwd === "/vaultB" ? "" : "origin\tgit@h:v.git (fetch)\n")),
        write: (o) => (accepted = o),
      }),
    );
    expect(accepted).toContain("[ok] git_remotes");
  });
});

// ── gated: the real adapters end-to-end ─────────────────────────────────────
const REAL = process.env.SOW_DOCTOR_REAL === "1";
describe.skipIf(!REAL)("doctor-cli — REAL adapters end-to-end (gated)", () => {
  it("real_doctor_end_to_end — the entry with real adapters yields a well-formed report + valid exit code (a dev-vault finding is EXPECTED) — spec(§13)", async () => {
    let out = "";
    const code = await runInstallDoctor({
      config: baseConfig,
      run: createLocalCommandRunner(),
      bindLoopback: createLoopbackBindProbe(),
      write: (o) => (out += o),
      workerPrincipal: "definitely-not-the-owner",
      canonicalBrainPath: "/nonexistent/canonical/brain",
      repoDir: process.cwd(),
    });
    expect(out).toContain("overall:");
    expect([0, 1]).toContain(code); // 0 (all ok/degraded) or 1 (a finding) — both well-formed
  });
});
