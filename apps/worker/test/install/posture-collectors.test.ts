// Install-doctor one-writer POSTURE collectors (task 11.5-c, §13 / REQ-S-NEW-008 / safety rule 1).
//
// The final install-doctor collector slice — SAFETY-CRITICAL. Three real LOCAL macOS posture
// checks over the reused injected RunCommand: vaultAcl (`ls -lde` fs-ACL sole-write) · gbrainMount
// (`mount` read-only + canonical) · strayGbrainProcess (`ps` scan → closed STRAY_GBRAIN_OPS labels
// only). Every probe never-throws + fail-closes to the assume-worst shape (which the pure
// checks/posture.ts engine maps to a finding); a stray writer is classified into a closed label —
// redaction-safe by construction. Fast-unit (injected fakes) + a SOW_DOCTOR_REAL-gated real case.
import { describe, it, expect } from "vitest";
import { collectPostureProbes, type PostureProbeInput } from "../../src/install/posture-collectors";
import {
  runPrerequisiteDoctor,
  type CommandRequest,
  type CommandOutcome,
  type RunCommand,
  type ProbeLoopbackBind,
} from "../../src/install/probe-collectors";
import { createLocalCommandRunner } from "../../src/install/probe-adapters";

const found = (stdout: string): CommandOutcome => ({ ok: true, stdout });
const notFound: CommandOutcome = { ok: false, code: "not_found", message: "not_found" };

/** Dispatch a fake outcome per posture tool (ls / mount / ps); any unmatched bin ⇒ notFound. */
function byBin(m: { ls?: CommandOutcome; mount?: CommandOutcome; ps?: CommandOutcome }): RunCommand {
  return (req) => {
    if (req.bin.endsWith("/ls")) return Promise.resolve(m.ls ?? notFound);
    if (req.bin.endsWith("mount")) return Promise.resolve(m.mount ?? notFound);
    if (req.bin.endsWith("/ps")) return Promise.resolve(m.ps ?? notFound);
    return Promise.resolve(notFound);
  };
}

function postureInput(over: Partial<PostureProbeInput> & { readonly run: RunCommand }): PostureProbeInput {
  return { vaultDir: "/vault", canonicalBrainPath: "/brain", workerPrincipal: "worker", ...over };
}

describe("collectPostureProbes — one-writer posture (fast unit, no subprocess)", () => {
  it("vault_acl_sole_worker_vs_other_writable — sole-worker-owned + no group/other write + no foreign ACL ⇒ true; else false — spec(§13 REQ-S-NEW-008)", async () => {
    const sole = await collectPostureProbes(
      postureInput({ run: byBin({ ls: found("drwx------  5 worker  staff  160 Jul 11 10:00 /vault\n") }) }),
    );
    expect(sole.vaultAcl).toEqual({ workerIsSoleWritePrincipal: true });

    // A group-write bit ⇒ false (another principal can write).
    const groupWrite = await collectPostureProbes(
      postureInput({ run: byBin({ ls: found("drwxrwx---  5 worker  staff  160 Jul 11 10:00 /vault\n") }) }),
    );
    expect(groupWrite.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });

    // A WORLD (other)-write POSIX bit ⇒ false (a world-writable vault is not the sole write principal).
    // "drwxr-xrwx": owner rwx · group r-x · other rwx — the other-write bit is at mode index 8.
    const otherWrite = await collectPostureProbes(
      postureInput({ run: byBin({ ls: found("drwxr-xrwx  5 worker  staff  160 Jul 11 10:00 /vault\n") }) }),
    );
    expect(otherWrite.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });

    // A foreign extended-ACL allow-write entry ⇒ false (the vector fs.stat mode bits miss).
    const foreignAcl = await collectPostureProbes(
      postureInput({
        run: byBin({ ls: found("drwx------+ 5 worker  staff  160 Jul 11 10:00 /vault\n 0: user:alice allow write,delete\n") }),
      }),
    );
    expect(foreignAcl.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });

    // The worker's OWN allow-write ACL entry is fine ⇒ still sole.
    const workerAcl = await collectPostureProbes(
      postureInput({
        run: byBin({ ls: found("drwx------+ 5 worker  staff  160 Jul 11 10:00 /vault\n 0: user:worker allow write\n") }),
      }),
    );
    expect(workerAcl.vaultAcl).toEqual({ workerIsSoleWritePrincipal: true });

    // Owner is not the worker principal ⇒ false.
    const otherOwner = await collectPostureProbes(
      postureInput({ run: byBin({ ls: found("drwx------  5 root  wheel  160 Jul 11 10:00 /vault\n") }) }),
    );
    expect(otherOwner.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });
  });

  it("vault_acl_unparseable_acl_fails_closed — a valid header but an UNRECOGNIZED/malformed extended-ACL entry ⇒ false (unknown grammar ⇒ assume-worst) — spec(§13 REQ-S-NEW-008)", async () => {
    // A foreign allow entry with an UNKNOWN permission token — a naive parser might skip it as
    // "not a write perm"; we must assume it COULD grant write ⇒ not the sole write principal.
    const unknownPerm = await collectPostureProbes(
      postureInput({
        run: byBin({ ls: found("drwx------+ 5 worker  staff  160 Jul 11 10:00 /vault\n 0: user:alice allow frobnicate\n") }),
      }),
    );
    expect(unknownPerm.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });

    // A malformed extended-ACL line the grammar can't parse ⇒ assume-worst (never silently skipped).
    const malformedEntry = await collectPostureProbes(
      postureInput({
        run: byBin({ ls: found("drwx------+ 5 worker  staff  160 Jul 11 10:00 /vault\n 0: garbled acl entry !!!\n") }),
      }),
    );
    expect(malformedEntry.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });
  });

  it("gbrain_mount_readonly_canonical_vs_writable — read-only mount AT the canonical path ⇒ {true,true}; writable or mispointed ⇒ assume-worst — spec(§13)", async () => {
    const roCanonical = await collectPostureProbes(
      postureInput({
        run: byBin({
          mount: found(
            "/dev/disk3s1 on /brain (apfs, local, read-only, journaled)\n/dev/disk1s1 on / (apfs, local, journaled)\n",
          ),
        }),
      }),
    );
    expect(roCanonical.gbrainMount).toEqual({ readOnly: true, mountPointCanonical: true });

    // A dedicated mount at the canonical path but WRITABLE ⇒ not-read-only.
    const writable = await collectPostureProbes(
      postureInput({ run: byBin({ mount: found("/dev/disk3s1 on /brain (apfs, local, journaled)\n") }) }),
    );
    expect(writable.gbrainMount).toEqual({ readOnly: false, mountPointCanonical: true });

    // The brain sits on the writable ROOT mount (no dedicated mount at the canonical path) ⇒ both false.
    const onRoot = await collectPostureProbes(
      postureInput({ run: byBin({ mount: found("/dev/disk1s1 on / (apfs, local, journaled)\n") }) }),
    );
    expect(onRoot.gbrainMount).toEqual({ readOnly: false, mountPointCanonical: false });

    // Two mounts at the SAME canonical path (read-only then WRITABLE) — the LAST/effective wins ⇒ not-read-only.
    const doubleMount = await collectPostureProbes(
      postureInput({
        run: byBin({
          mount: found(
            "/dev/disk3s1 on /brain (apfs, local, read-only)\n/dev/disk9s9 on /brain (apfs, local, journaled)\n",
          ),
        }),
      }),
    );
    expect(doubleMount.gbrainMount).toEqual({ readOnly: false, mountPointCanonical: true });
  });

  it("stray_process_classifies_closed_ops — each write-capable gbrain op bound to the canonical brain ⇒ its closed label; read-only op / no-writer ⇒ not stray — spec(§13)", async () => {
    const ps =
      [
        "/usr/local/bin/gbrain serve --brain /brain --http",
        "gbrain sync --install-cron --brain /brain",
        "gbrain autopilot --brain /brain",
        "gbrain jobs work --brain /brain",
        "gbrain dream --brain /brain",
        'gbrain query "hello" --brain /brain', // read-only ⇒ NOT stray
        "grep gbrain serve", // not a gbrain executable ⇒ NOT stray
      ].join("\n") + "\n";
    const probe = await collectPostureProbes(postureInput({ run: byBin({ ps: found(ps) }) }));
    const ops = (probe.strayGbrainProcess?.strayProcesses ?? []).map((s) => s.op).sort();
    expect(ops).toEqual(["autopilot", "dream", "jobs_work", "serve", "sync_install_cron"]);

    // A clean scan (no write-capable gbrain writer) ⇒ empty array (present, NOT omitted).
    const clean = await collectPostureProbes(
      postureInput({ run: byBin({ ps: found("/sbin/launchd\ngbrain query x --brain /brain\n") }) }),
    );
    expect(clean.strayGbrainProcess).toEqual({ strayProcesses: [] });

    // A write-capable op bound to a DIFFERENT brain ⇒ NOT stray (path-exact, no substring bug).
    const elsewhere = await collectPostureProbes(
      postureInput({ run: byBin({ ps: found("gbrain serve --brain /other/brain\n") }) }),
    );
    expect(elsewhere.strayGbrainProcess).toEqual({ strayProcesses: [] });

    // A write-capable op with NO resolvable brain arg (implicit default) ⇒ fail-closed STRAY.
    const implicit = await collectPostureProbes(
      postureInput({ run: byBin({ ps: found("gbrain serve --http\n") }) }),
    );
    expect(implicit.strayGbrainProcess?.strayProcesses).toEqual([{ op: "serve" }]);

    // A brain flag BEFORE the subcommand (global-flags-first) still classifies (subcommand skips the flag value).
    const flagFirst = await collectPostureProbes(
      postureInput({ run: byBin({ ps: found("gbrain --brain /brain serve --http\n") }) }),
    );
    expect(flagFirst.strayGbrainProcess?.strayProcesses).toEqual([{ op: "serve" }]);

    // A BARE positional canonical-brain path (no flag) ⇒ bound ⇒ stray.
    const barePositional = await collectPostureProbes(
      postureInput({ run: byBin({ ps: found("gbrain serve /brain\n") }) }),
    );
    expect(barePositional.strayGbrainProcess?.strayProcesses).toEqual([{ op: "serve" }]);
  });

  it("stray_process_redaction_safe — the emitted probe carries ONLY closed op labels — no raw ps line / argv / path / secret — spec(§16 safety rule 7)", async () => {
    const ps = "/usr/local/bin/gbrain serve --brain /brain --token SECRETTOKEN --http\n";
    const probe = await collectPostureProbes(postureInput({ run: byBin({ ps: found(ps) }) }));
    expect(probe.strayGbrainProcess?.strayProcesses).toEqual([{ op: "serve" }]);
    const serialized = JSON.stringify(probe.strayGbrainProcess);
    expect(serialized).not.toContain("SECRETTOKEN");
    expect(serialized).not.toContain("/usr/local/bin/gbrain");
    expect(serialized).not.toContain("--http");
    expect(serialized).not.toContain("--brain");
  });

  it("posture_fail_closed_on_fault — a fault (not_found / thrown / malformed) ⇒ assume-worst; ps fault OMITS strayGbrainProcess (→ finding); NEVER a throw — spec(§16)", async () => {
    // Every tool faults (notFound).
    const faulted = await collectPostureProbes(postureInput({ run: byBin({}) }));
    expect(faulted.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });
    expect(faulted.gbrainMount).toEqual({ readOnly: false, mountPointCanonical: false });
    // ps fault ⇒ the field is OMITTED (undefined) so the engine's `p == null` branch fails it closed.
    expect(faulted.strayGbrainProcess).toBeUndefined();
    expect("strayGbrainProcess" in faulted).toBe(false);

    // A thrown port ⇒ collect RESOLVES (never rejects) to assume-worst.
    const throwing: RunCommand = () => Promise.reject(new Error("boom"));
    const thrown = await collectPostureProbes(postureInput({ run: throwing }));
    expect(thrown.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });
    expect(thrown.gbrainMount).toEqual({ readOnly: false, mountPointCanonical: false });
    expect(thrown.strayGbrainProcess).toBeUndefined();

    // A malformed `ls` output (no parseable mode/owner) ⇒ false (never a fabricated ok).
    const malformed = await collectPostureProbes(
      postureInput({ run: byBin({ ls: found("garbage with no mode line\n") }) }),
    );
    expect(malformed.vaultAcl).toEqual({ workerIsSoleWritePrincipal: false });
  });

  it("argv_is_fixed_no_shell — the posture probes use fixed argv ARRAYS; config rides a positional arg, never a shell string — spec(§13)", async () => {
    const calls: CommandRequest[] = [];
    const run: RunCommand = (req) => {
      calls.push(req);
      return Promise.resolve(notFound);
    };
    await collectPostureProbes(postureInput({ run, vaultDir: "/vault", canonicalBrainPath: "/brain" }));
    const ls = calls.find((c) => c.bin.endsWith("/ls"));
    const mount = calls.find((c) => c.bin.endsWith("mount"));
    const ps = calls.find((c) => c.bin.endsWith("/ps"));
    expect(ls?.args).toEqual(["-lde", "/vault"]); // vaultDir a fixed positional arg, not concatenated
    expect(mount?.args).toEqual([]);
    expect(ps?.args).toEqual(["-Axww", "-o", "command="]);
    // No shell metacharacter in any argv (config never enters a command string).
    for (const c of calls) for (const a of c.args) expect(a).not.toMatch(/[;&|`$(){}<>]/);
  });

  it("runPrerequisiteDoctor_includes_posture_probes — the posture probes feed the engine (the full 10-field snapshot) — spec(§13)", async () => {
    const run: RunCommand = (req) => {
      if (req.bin.endsWith("/ls")) return Promise.resolve(found("drwx------  5 worker  staff  160 x /vault\n"));
      if (req.bin.endsWith("mount")) return Promise.resolve(found("/dev/d on /brain (apfs, local, read-only)\n"));
      if (req.bin.endsWith("/ps")) return Promise.resolve(found("/sbin/launchd\n")); // no stray writer
      return Promise.resolve(notFound);
    };
    const input = {
      run,
      bindLoopback: (() => Promise.resolve({ bindable: true })) as ProbeLoopbackBind,
      loopbackPorts: [] as number[],
      repoDir: "/repo",
      localBackupAccepted: false,
      vaultDir: "/vault",
      canonicalBrainPath: "/brain",
      workerPrincipal: "worker",
    };
    const report = await runPrerequisiteDoctor(input);
    const status = (id: string): string | undefined => report.checks.find((c) => c.check === id)?.status;
    expect(status("vault_acl")).toBe("ok");
    expect(status("gbrain_readonly_mount")).toBe("ok");
    expect(status("stray_gbrain_process")).toBe("ok");
  });
});

// ── gated: the REAL ls/mount/ps adapters against this machine ───────────────
const REAL = process.env.SOW_DOCTOR_REAL === "1";
describe.skipIf(!REAL)("posture adapters — REAL ls/mount/ps (gated)", () => {
  it("real_posture_adapter_on_this_machine — well-formed posture probes; a fail-closed result on a dev vault is EXPECTED — spec(§13)", async () => {
    const snap = await collectPostureProbes({
      run: createLocalCommandRunner(),
      vaultDir: process.cwd(),
      canonicalBrainPath: "/nonexistent/canonical/brain",
      workerPrincipal: "definitely-not-the-owner",
    });
    // Well-formed booleans; a dev cwd not owned by a fake principal ⇒ false (fail-closed) is EXPECTED, not green.
    expect(typeof snap.vaultAcl?.workerIsSoleWritePrincipal).toBe("boolean");
    expect(typeof snap.gbrainMount?.readOnly).toBe("boolean");
    expect(typeof snap.gbrainMount?.mountPointCanonical).toBe("boolean");
    // strayGbrainProcess: a well-formed array when `ps` ran, or omitted on a fault — both valid.
    if (snap.strayGbrainProcess !== undefined) {
      expect(Array.isArray(snap.strayGbrainProcess.strayProcesses)).toBe(true);
    }
  });
});
