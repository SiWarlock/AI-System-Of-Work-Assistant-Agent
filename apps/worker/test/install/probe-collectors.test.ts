// Install-doctor REAL prerequisite-probe collectors (task 11.5-a, §13).
//
// The first Phase-11 real-I/O slice: collectPrerequisiteProbes maps injected exec/net port
// results into 5 ProbeSnapshot fields (nodePnpm / temporalStartable / gbrainStartable /
// gitRemotes / loopbackPorts) that feed the already-built pure runDoctor. Every collector
// NEVER throws + fail-closes to the assume-worst shape (which runDoctor maps to a finding).
//
// Two tiers: fast-unit (default suite, injected FAKE exec/bind — no real subprocess) + an
// OPTIONAL gated (SOW_DOCTOR_REAL=1) test exercising the REAL execFile/bind adapters.
import { describe, it, expect } from "vitest";
import {
  collectPrerequisiteProbes,
  collectSecurityProbes,
  runPrerequisiteDoctor,
  type CommandRequest,
  type CommandOutcome,
  type RunCommand,
  type ProbeLoopbackBind,
  type InstallDoctorInput,
} from "../../src/install/probe-collectors";
import { createLocalCommandRunner, createLoopbackBindProbe } from "../../src/install/probe-adapters";
import { createServer as netCreateServer } from "node:net";

// ── fast-unit fakes ─────────────────────────────────────────────────────────
const okBind: ProbeLoopbackBind = () => Promise.resolve({ bindable: true });

/** A recording fake exec port that dispatches an outcome per (bin,args) via `map`. */
function fakeRun(map: (req: CommandRequest) => CommandOutcome): {
  readonly run: RunCommand;
  readonly calls: CommandRequest[];
} {
  const calls: CommandRequest[] = [];
  const run: RunCommand = (req) => {
    calls.push(req);
    return Promise.resolve(map(req));
  };
  return { run, calls };
}

const found = (stdout: string): CommandOutcome => ({ ok: true, stdout });
const notFound: CommandOutcome = { ok: false, code: "not_found", message: "not_found" };

/** Build a full install-doctor input from a run map + overrides (sane defaults for the other fields). */
function inputWith(
  over: Partial<InstallDoctorInput> & { readonly run: RunCommand },
): InstallDoctorInput {
  return {
    bindLoopback: okBind,
    loopbackPorts: [],
    repoDir: "/repo",
    localBackupAccepted: false,
    vaultDir: "/vault",
    canonicalBrainPath: "/brain",
    workerPrincipal: "worker",
    ...over,
  };
}

/** The default all-present map (each probe succeeds) — overridden per test. */
const allPresent = (req: CommandRequest): CommandOutcome => {
  if (req.bin === "node") return found("v22.4.1\n");
  if (req.bin === "pnpm") return found("9.6.0\n");
  if (req.bin === "temporal") return found("temporal version 1.2.0\n");
  if (req.bin === "gbrain") return found("gbrain 0.35.1\n");
  if (req.bin === "git") return found("origin\tgit@host:vault.git (fetch)\norigin\tgit@host:vault.git (push)\n");
  return notFound;
};

describe("collectPrerequisiteProbes — real prerequisite probes (fast unit, no subprocess)", () => {
  it("node_pnpm_probe_from_versions — maps node/pnpm --version to the nodePnpm probe; a missing/old tool ⇒ unsatisfied — spec(§13)", async () => {
    const both = await collectPrerequisiteProbes(inputWith({ run: fakeRun(allPresent).run }));
    expect(both.nodePnpm).toEqual({ nodeSatisfied: true, pnpmSatisfied: true });

    // A missing pnpm ⇒ pnpmSatisfied false (the assume-worst shape → runDoctor finding).
    const noPnpm = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "pnpm" ? notFound : allPresent(r))).run }),
    );
    expect(noPnpm.nodePnpm).toEqual({ nodeSatisfied: true, pnpmSatisfied: false });

    // An OLD node (major < NODE_MIN_MAJOR) ⇒ nodeSatisfied false (version parsed, not just presence).
    const oldNode = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "node" ? found("v18.19.0\n") : allPresent(r))).run }),
    );
    expect(oldNode.nodePnpm?.nodeSatisfied).toBe(false);

    // An OLD pnpm (major < PNPM_MIN_MAJOR=8) ⇒ pnpmSatisfied false (the floor is applied to pnpm too).
    const oldPnpm = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "pnpm" ? found("7.33.6\n") : allPresent(r))).run }),
    );
    expect(oldPnpm.nodePnpm?.pnpmSatisfied).toBe(false);
  });

  it("temporal_gbrain_startable_present_vs_absent — a --version hit ⇒ startable; ENOENT ⇒ not startable — spec(§13)", async () => {
    const present = await collectPrerequisiteProbes(inputWith({ run: fakeRun(allPresent).run }));
    expect(present.temporalStartable).toEqual({ startable: true });
    expect(present.gbrainStartable).toEqual({ startable: true });

    const absent = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "temporal" || r.bin === "gbrain" ? notFound : allPresent(r))).run }),
    );
    expect(absent.temporalStartable).toEqual({ startable: false });
    expect(absent.gbrainStartable).toEqual({ startable: false });
  });

  it("git_remotes_from_local_config — reads `git remote -v` (NO network fetch); empty ⇒ no remote; passes localBackupAccepted — spec(§13)", async () => {
    const { run, calls } = fakeRun(allPresent);
    const probe = await collectPrerequisiteProbes(inputWith({ run, repoDir: "/vault", localBackupAccepted: true }));
    expect(probe.gitRemotes).toEqual({ hasRemote: true, localBackupAccepted: true });

    // The git invocation is the FIXED local, no-network argv — never fetch/ls-remote/update.
    const gitCall = calls.find((c) => c.bin === "git");
    expect(gitCall?.args).toEqual(["remote", "-v"]);
    // `git` stays BARE (PATH-resolved) by design — it's a version/remote check, not a security-state
    // probe; users legitimately run a newer non-`/usr/bin/git` (11.5-e Step-2.5 #3). The repoDir rides
    // as `cwd` (not a positional argv), so there is no `--`-flag-confusion vector to close here.
    expect(gitCall?.bin).toBe("git");
    expect(gitCall?.cwd).toBe("/vault");
    expect(gitCall?.args).not.toContain("fetch");
    expect(gitCall?.args).not.toContain("ls-remote");
    expect(gitCall?.args).not.toContain("update");

    // An empty remote list ⇒ hasRemote false (the assume-worst → runDoctor finding unless accepted).
    const noRemote = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "git" ? found("") : allPresent(r))).run }),
    );
    expect(noRemote.gitRemotes).toEqual({ hasRemote: false, localBackupAccepted: false });
  });

  it("loopback_ports_bindable_vs_in_use — a free loopback port ⇒ not occupied; an in-use port ⇒ occupied — spec(§13)", async () => {
    const bindLoopback: ProbeLoopbackBind = (port) => Promise.resolve({ bindable: port !== 7233 });
    const probe = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun(allPresent).run, bindLoopback, loopbackPorts: [7233, 3000] }),
    );
    expect(probe.loopbackPorts).toEqual({ occupiedPorts: [7233] });
  });

  it("collector_never_throws_on_exec_fault — a thrown/timeout/nonzero/malformed result ⇒ the assume-worst shape, NEVER a throw — spec(§16)", async () => {
    const throwingRun: RunCommand = () => Promise.reject(new Error("boom"));
    const throwingBind: ProbeLoopbackBind = () => Promise.reject(new Error("bind boom"));
    // The WHOLE collect resolves (never rejects) despite both ports throwing.
    const snap = await collectPrerequisiteProbes(
      inputWith({ run: throwingRun, bindLoopback: throwingBind, loopbackPorts: [7233, 3000] }),
    );
    expect(snap.nodePnpm).toEqual({ nodeSatisfied: false, pnpmSatisfied: false });
    expect(snap.temporalStartable).toEqual({ startable: false });
    expect(snap.gbrainStartable).toEqual({ startable: false });
    expect(snap.gitRemotes).toEqual({ hasRemote: false, localBackupAccepted: false });
    // A bind fault fail-closes to "occupied" (assume-worst) for every probed port.
    expect(snap.loopbackPorts).toEqual({ occupiedPorts: [7233, 3000] });

    // A malformed version string ⇒ unsatisfied (never a fabricated "ok").
    const malformed = await collectPrerequisiteProbes(
      inputWith({ run: fakeRun((r) => (r.bin === "node" ? found("banana\n") : allPresent(r))).run }),
    );
    expect(malformed.nodePnpm?.nodeSatisfied).toBe(false);

    // A timeout / nonzero exit ⇒ unsatisfied.
    const timedOut = await collectPrerequisiteProbes(
      inputWith({
        run: fakeRun((r) =>
          r.bin === "temporal" ? { ok: false, code: "timeout", message: "timeout" } : allPresent(r),
        ).run,
      }),
    );
    expect(timedOut.temporalStartable).toEqual({ startable: false });
  });

  it("runPrerequisiteDoctor_composes_collector_into_engine — the collected probes feed runDoctor; deferred probes stay findings — spec(§13)", async () => {
    const report = await runPrerequisiteDoctor(
      inputWith({ run: fakeRun(allPresent).run, bindLoopback: okBind, loopbackPorts: [3000], localBackupAccepted: true }),
    );
    const status = (id: string): string | undefined => report.checks.find((c) => c.check === id)?.status;
    // The 5 collected prerequisite checks are ok (the real collector fed the real engine).
    expect(status("node_pnpm")).toBe("ok");
    expect(status("temporal_startable")).toBe("ok");
    expect(status("gbrain_startable")).toBe("ok");
    expect(status("loopback_ports")).toBe("ok");
    expect(status("git_remotes")).toBe("ok");
    // Both filevault (11.5-b) and vault_acl (11.5-c) are now collected but fault-closed here — the
    // all-present PREREQ map doesn't mock fdesetup/security/ls, so both fall to notFound ⇒ finding.
    expect(status("filevault")).not.toBe("ok");
    expect(status("vault_acl")).not.toBe("ok");
  });
});

// ── macOS-security probes (11.5-b) — FileVault + Keychain ───────────────────
const permDenied: CommandOutcome = { ok: false, code: "nonzero_exit", message: "nonzero_exit" };

describe("collectSecurityProbes — macOS-security probes (fast unit, no subprocess)", () => {
  it("filevault_enabled_vs_disabled — `fdesetup status` On ⇒ enabled; Off/unknown ⇒ not enabled — spec(§13)", async () => {
    const on = await collectSecurityProbes({
      run: fakeRun((r) => (r.bin.endsWith("/fdesetup") ? found("FileVault is On.\n") : found("x"))).run,
    });
    expect(on.filevault).toEqual({ enabled: true });

    const off = await collectSecurityProbes({
      run: fakeRun((r) => (r.bin.endsWith("/fdesetup") ? found("FileVault is Off.\n") : found("x"))).run,
    });
    expect(off.filevault).toEqual({ enabled: false });

    // Unknown / malformed output ⇒ not enabled (never a fabricated ok).
    const unknown = await collectSecurityProbes({
      run: fakeRun((r) => (r.bin.endsWith("/fdesetup") ? found("some unexpected output\n") : found("x"))).run,
    });
    expect(unknown.filevault).toEqual({ enabled: false });

    // "On, but Conversion in progress" still counts as ENABLED (it IS on) — pins the \b-before-comma.
    const converting = await collectSecurityProbes({
      run: fakeRun((r) =>
        r.bin.endsWith("/fdesetup") ? found("FileVault is On, but Conversion in progress.\n") : found("x"),
      ).run,
    });
    expect(converting.filevault).toEqual({ enabled: true });

    // A hostile MID-LINE "FileVault is On" substring must NOT fabricate enabled (line-anchored).
    const midline = await collectSecurityProbes({
      run: fakeRun((r) =>
        r.bin.endsWith("/fdesetup") ? found("note: FileVault is On (spoofed); actually FileVault is Off.\n") : found("x"),
      ).run,
    });
    expect(midline.filevault).toEqual({ enabled: false });
  });

  it("keychain_available_vs_locked — a reachable read-only `security` query ⇒ reachable; a fault ⇒ assume-worst — spec(§13)", async () => {
    const reachable = await collectSecurityProbes({
      run: fakeRun((r) =>
        r.bin.endsWith("/security") ? found("/Users/x/Library/Keychains/login.keychain-db\n") : found("x"),
      ).run,
    });
    expect(reachable.keychain).toEqual({ reachable: true });

    // A permission-denied / unreachable security query ⇒ not reachable (→ finding).
    const denied = await collectSecurityProbes({
      run: fakeRun((r) => (r.bin.endsWith("/security") ? permDenied : found("x"))).run,
    });
    expect(denied.keychain).toEqual({ reachable: false });

    // A clean exit but EMPTY/whitespace output ⇒ not reachable (pins the non-empty guard).
    const empty = await collectSecurityProbes({
      run: fakeRun((r) => (r.bin.endsWith("/security") ? found("   \n") : found("x"))).run,
    });
    expect(empty.keychain).toEqual({ reachable: false });
  });

  it("security_probe_fail_closed_on_tcc_denied — a TCC permission-denied / timeout / thrown result ⇒ assume-worst, NEVER a throw — spec(§16)", async () => {
    // macOS TCC "Operation not permitted" surfaces as a nonzero exit — fail-closed, not a crash.
    const tcc = await collectSecurityProbes({ run: fakeRun(() => permDenied).run });
    expect(tcc.filevault).toEqual({ enabled: false });
    expect(tcc.keychain).toEqual({ reachable: false });

    // A thrown exec port ⇒ the whole collect RESOLVES (never rejects) to assume-worst.
    const throwingRun: RunCommand = () => Promise.reject(new Error("boom"));
    const thrown = await collectSecurityProbes({ run: throwingRun });
    expect(thrown.filevault).toEqual({ enabled: false });
    expect(thrown.keychain).toEqual({ reachable: false });

    // A timeout ⇒ assume-worst.
    const timedOut = await collectSecurityProbes({
      run: fakeRun(() => ({ ok: false, code: "timeout", message: "timeout" })).run,
    });
    expect(timedOut.filevault).toEqual({ enabled: false });
    expect(timedOut.keychain).toEqual({ reachable: false });
  });

  it("argv_is_fixed_no_shell — the security probes use a fixed argv ARRAY per probe (no shell / no interpolation) — spec(§13)", async () => {
    const { run, calls } = fakeRun(() => found("FileVault is On.\n"));
    await collectSecurityProbes({ run });
    const fdesetup = calls.find((c) => c.bin.endsWith("/fdesetup"));
    const security = calls.find((c) => c.bin.endsWith("/security"));
    expect(fdesetup?.args).toEqual(["status"]);
    expect(security?.args).toEqual(["list-keychains"]);
    // No shell metacharacters / interpolation anywhere in the argv.
    for (const c of calls) {
      for (const a of c.args) expect(a).not.toMatch(/[;&|`$(){}<>]/);
    }
  });

  it("security_system_probes_use_absolute_bins — fdesetup/security pin their ABSOLUTE macOS system paths so a hostile PATH can't shadow a security-state probe — spec(§13)", async () => {
    const { run, calls } = fakeRun(() => found("FileVault is On.\n"));
    await collectSecurityProbes({ run });
    // The two security-state probes MUST run the fixed-location system tools (PATH-shadow prevention).
    expect(calls.find((c) => c.args[0] === "status")?.bin).toBe("/usr/bin/fdesetup");
    expect(calls.find((c) => c.args[0] === "list-keychains")?.bin).toBe("/usr/bin/security");
    // Neither security probe is left BARE (PATH-resolved) — a bare bin would re-open the shadow vector.
    expect(calls.some((c) => c.bin === "fdesetup")).toBe(false);
    expect(calls.some((c) => c.bin === "security")).toBe(false);
  });

  it("version_presence_bins_stay_bare — node/pnpm/temporal/gbrain stay PATH-resolved (the check IS PATH-presence at the right version); absolutizing would defeat it — spec(§13)", async () => {
    const { run, calls } = fakeRun(allPresent);
    await collectPrerequisiteProbes(inputWith({ run }));
    for (const bin of ["node", "pnpm", "temporal", "gbrain"]) {
      // The prerequisite is "on PATH at the right version" — so the probe MUST use the bare bin.
      expect(calls.some((c) => c.bin === bin)).toBe(true);
      // And it must NOT be over-absolutized to a fixed /…/<bin> path (that would miss a PATH install).
      expect(calls.some((c) => c.bin.startsWith("/") && c.bin.endsWith("/" + bin))).toBe(false);
    }
  });

  it("runPrerequisiteDoctor_includes_security_probes — a real fdesetup/security result feeds the engine (filevault/keychain ok) — spec(§13)", async () => {
    const withSecurity = (req: CommandRequest): CommandOutcome => {
      if (req.bin.endsWith("/fdesetup")) return found("FileVault is On.\n");
      if (req.bin.endsWith("/security")) return found("/Users/x/Library/Keychains/login.keychain-db\n");
      return allPresent(req);
    };
    const report = await runPrerequisiteDoctor(
      inputWith({ run: fakeRun(withSecurity).run, bindLoopback: okBind, loopbackPorts: [3000], localBackupAccepted: true }),
    );
    const status = (id: string): string | undefined => report.checks.find((c) => c.check === id)?.status;
    expect(status("filevault")).toBe("ok");
    expect(status("keychain")).toBe("ok");
  });
});

// ── the REAL loopback-bind adapter (default suite — pure local socket, no subprocess) ──
/** Hold an ephemeral loopback port; returns the assigned port + a release. */
async function holdLoopbackPort(): Promise<{ readonly port: number; readonly release: () => Promise<void> }> {
  const server = netCreateServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { port, release: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("createLoopbackBindProbe — REAL loopback bind (default, no subprocess)", () => {
  it("real_loopback_bind_detects_in_use_and_free — a held port ⇒ not bindable; a free port ⇒ bindable — spec(§13)", async () => {
    const probe = createLoopbackBindProbe();
    const held = await holdLoopbackPort();
    try {
      // The exclusive bind detects the held port as occupied (not a SO_REUSEADDR false-free).
      expect(await probe(held.port)).toEqual({ bindable: false });
    } finally {
      await held.release();
    }
    // Port 0 (OS-assigned ephemeral) is always bindable — and released, not leaked.
    expect(await probe(0)).toEqual({ bindable: true });
  });
});

// ── gated: the REAL execFile adapter against this machine ───────────────────
const REAL = process.env.SOW_DOCTOR_REAL === "1";
describe.skipIf(!REAL)("probe adapters — REAL execFile + loopback bind (gated)", () => {
  it("real_command_runner_reports_missing_binary — a nonexistent binary ⇒ typed not_found, no throw — spec(§13/§16)", async () => {
    const run = createLocalCommandRunner();
    const outcome = await run({ bin: "__sow_no_such_binary_xyz__", args: ["--version"] });
    expect(outcome).toEqual({ ok: false, code: "not_found", message: "not_found" });
  });

  it("real_security_adapter_on_this_machine — the real fdesetup/security adapters yield well-formed filevault/keychain probes (TCC-denied ⇒ fail-closed) — spec(§13)", async () => {
    const snap = await collectSecurityProbes({ run: createLocalCommandRunner() });
    // Well-formed booleans regardless of this machine's actual state / a TCC denial.
    expect(typeof snap.filevault?.enabled).toBe("boolean");
    expect(typeof snap.keychain?.reachable).toBe("boolean");
  });

  it("real_adapter_collects_local_snapshot — the real execFile/bind adapters yield a well-formed partial snapshot — spec(§13)", async () => {
    const run = createLocalCommandRunner();
    const bindLoopback = createLoopbackBindProbe();
    // 0 is the OS-assigned ephemeral port — always bindable — a deterministic "free" probe.
    const snap = await collectPrerequisiteProbes({
      run,
      bindLoopback,
      loopbackPorts: [0],
      repoDir: process.cwd(),
      localBackupAccepted: false,
    });
    // node runs this test, so node is present + satisfied on any CI/dev machine.
    expect(snap.nodePnpm?.nodeSatisfied).toBe(true);
    // Well-formed shapes for every collected field (values are environment-dependent).
    expect(typeof snap.gbrainStartable?.startable).toBe("boolean");
    expect(typeof snap.temporalStartable?.startable).toBe("boolean");
    expect(Array.isArray(snap.loopbackPorts?.occupiedPorts)).toBe(true);
    // Port 0 (ephemeral) is always bindable ⇒ never reported occupied.
    expect(snap.loopbackPorts?.occupiedPorts).toEqual([]);
  });
});
