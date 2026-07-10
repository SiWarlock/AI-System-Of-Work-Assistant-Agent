// Install-doctor check-engine (task 11.5, §13) — the deterministic core + the 7 NON-safety environment
// diagnosers. `runDoctor(snapshot)` is PURE (no I/O, no clock, no throw): each check maps its injected probe
// outcome to a typed DoctorCheckResult with a DISTINCT repair. The 3 write-through one-writer POSTURE checks
// (vault-ACL / gbrain-readonly-mount / stray-gbrain-process) are pinned in the sibling `doctor-posture.test.ts`.
import { describe, it, expect } from "vitest";
import { doctorReportSchema } from "@sow/contracts";
import type { DoctorReport, DoctorCheckId } from "@sow/contracts";
import { runDoctor } from "../../src/install/doctor";
import type { ProbeSnapshot } from "../../src/install/probe-snapshot";

const ENV_CHECKS: readonly DoctorCheckId[] = [
  "node_pnpm",
  "filevault",
  "keychain",
  "temporal_startable",
  "gbrain_startable",
  "loopback_ports",
  "git_remotes",
];

const find = (r: DoctorReport, id: DoctorCheckId) => r.checks.find((c) => c.check === id);

/** A fully-green snapshot (all 10 probes healthy — posture fields harmless here, consumed once posture is wired). */
const greenSnapshot = (): ProbeSnapshot => ({
  nodePnpm: { nodeSatisfied: true, pnpmSatisfied: true },
  filevault: { enabled: true },
  keychain: { reachable: true },
  temporalStartable: { startable: true },
  gbrainStartable: { startable: true },
  loopbackPorts: { occupiedPorts: [] },
  gitRemotes: { hasRemote: true, localBackupAccepted: false },
  vaultAcl: { workerIsSoleWritePrincipal: true },
  gbrainMount: { readOnly: true, mountPointCanonical: true },
  strayGbrainProcess: { strayProcesses: [] },
});

describe("runDoctor — environment checks (task 11.5, §13)", () => {
  it("environment_all_green_reports_ok", () => {
    const r = runDoctor(greenSnapshot());
    for (const id of ENV_CHECKS) {
      const c = find(r, id);
      expect(c, `check ${id} present`).toBeDefined();
      expect(c?.status, `check ${id} ok`).toBe("ok");
    }
    expect(r.overall).toBe("ok");
    expect(doctorReportSchema.safeParse(r).success).toBe(true); // the engine's output satisfies the contract
  });

  it("each_env_failure_variant_has_distinct_repair", () => {
    const failing: ProbeSnapshot = {
      nodePnpm: { nodeSatisfied: false, pnpmSatisfied: true },
      filevault: { enabled: false },
      keychain: { reachable: false },
      temporalStartable: { startable: false },
      gbrainStartable: { startable: false },
      loopbackPorts: { occupiedPorts: [7233] },
      gitRemotes: { hasRemote: false, localBackupAccepted: false },
    };
    const r = runDoctor(failing);
    const repairs = ENV_CHECKS.map((id) => find(r, id)?.repair);
    for (const rep of repairs) expect(rep).toBeTruthy(); // every failing env check carries a repair
    expect(new Set(repairs).size).toBe(ENV_CHECKS.length); // pairwise-DISTINCT — no shared catch-all
    // the 4 hard prereqs ⇒ finding; temporal/gbrain unavailable ⇒ tolerated degraded mode
    expect(find(r, "filevault")?.status).toBe("finding");
    expect(find(r, "keychain")?.status).toBe("finding");
    expect(find(r, "temporal_startable")?.status).toBe("degraded");
    expect(find(r, "gbrain_startable")?.status).toBe("degraded");
    expect(r.overall).toBe("finding"); // worst-of
  });

  it("git_remote_ok_on_remote_or_local_backup_acceptance", () => {
    const withRemote = runDoctor({ ...greenSnapshot(), gitRemotes: { hasRemote: true, localBackupAccepted: false } });
    expect(find(withRemote, "git_remotes")?.status).toBe("ok");
    const withAccept = runDoctor({ ...greenSnapshot(), gitRemotes: { hasRemote: false, localBackupAccepted: true } });
    expect(find(withAccept, "git_remotes")?.status).toBe("ok");
    const neither = runDoctor({ ...greenSnapshot(), gitRemotes: { hasRemote: false, localBackupAccepted: false } });
    expect(find(neither, "git_remotes")?.status).toBe("finding");
    expect(find(neither, "git_remotes")?.failureVariant).toBe("git_remote_missing");
  });

  it("filevault_off_is_nonfatal_finding", () => {
    const r = runDoctor({ ...greenSnapshot(), filevault: { enabled: false } });
    expect(find(r, "filevault")?.status).toBe("finding");
    expect(find(r, "filevault")?.failureVariant).toBe("filevault_off");
    // non-aborting — every OTHER check is still populated + ok
    expect(find(r, "node_pnpm")?.status).toBe("ok");
    expect(find(r, "keychain")?.status).toBe("ok");
    expect(find(r, "loopback_ports")?.status).toBe("ok");
  });

  it("idempotent_purity_no_side_effects", () => {
    const snap = greenSnapshot();
    const frozen = JSON.stringify(snap);
    expect(runDoctor(snap)).toEqual(runDoctor(snap)); // deterministic — same snapshot ⇒ same report
    expect(JSON.stringify(snap)).toBe(frozen); // the engine never mutates its input
    // a previously-failing prereq now green ⇒ that check reports ok (idempotency-as-purity)
    const fixed = runDoctor({ ...greenSnapshot(), keychain: { reachable: true } });
    expect(find(fixed, "keychain")?.status).toBe("ok");
  });

  it("engine_never_throws", () => {
    // a MALFORMED / partial snapshot — wrong-typed probes that would throw on property access
    const malformed = { loopbackPorts: "nope", nodePnpm: 42, gitRemotes: null } as unknown as ProbeSnapshot;
    expect(() => runDoctor(malformed)).not.toThrow();
    const r = runDoctor(malformed);
    for (const id of ENV_CHECKS) {
      const c = find(r, id);
      expect(c, `check ${id} present`).toBeDefined();
      expect(c?.status, `check ${id} non-ok`).not.toBe("ok"); // fail-closed, never silently ok
    }
    expect(doctorReportSchema.safeParse(r).success).toBe(true);
  });
});
