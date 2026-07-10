// Install-doctor write-through one-writer POSTURE checks (task 11.5, §13 / REQ-S-NEW-008 / safety rule 1) —
// SAFETY-CRITICAL. vault-ACL (worker = sole write principal), gbrain read-only-mount, and stray-gbrain-process
// are three DISTINCT DoctorCheckResults that FAIL CLOSED to `finding`: a writable/mispointed mount or a detected
// stray writer re-opens GO #1 and must NEVER resolve to a silent `ok`; an absent/unknown/malformed posture probe
// also defaults to `finding`. The stray-process finding names the op label ONLY (redaction-safe by construction).
import { describe, it, expect } from "vitest";
import { doctorReportSchema } from "@sow/contracts";
import type { DoctorReport, DoctorCheckId } from "@sow/contracts";
import { runDoctor } from "../../src/install/doctor";
import type { ProbeSnapshot } from "../../src/install/probe-snapshot";

const POSTURE_CHECKS: readonly DoctorCheckId[] = ["vault_acl", "gbrain_readonly_mount", "stray_gbrain_process"];
const find = (r: DoctorReport, id: DoctorCheckId) => r.checks.find((c) => c.check === id);

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

describe("runDoctor — one-writer posture (REQ-S-NEW-008, safety rule 1)", () => {
  it("all_green_snapshot_reports_all_ok", () => {
    const r = runDoctor(greenSnapshot());
    expect(r.checks).toHaveLength(10); // every named check present
    for (const c of r.checks) expect(c.status, `check ${c.check}`).toBe("ok");
    expect(r.overall).toBe("ok");
    expect(doctorReportSchema.safeParse(r).success).toBe(true);
  });

  it("all_failing_repairs_are_pairwise_distinct", () => {
    // every one of the 10 checks fails ⇒ 10 DISTINCT repair strings (no shared/generic catch-all anywhere)
    const allFailing: ProbeSnapshot = {
      nodePnpm: { nodeSatisfied: false, pnpmSatisfied: false },
      filevault: { enabled: false },
      keychain: { reachable: false },
      temporalStartable: { startable: false },
      gbrainStartable: { startable: false },
      loopbackPorts: { occupiedPorts: [7233] },
      gitRemotes: { hasRemote: false, localBackupAccepted: false },
      vaultAcl: { workerIsSoleWritePrincipal: false },
      gbrainMount: { readOnly: false, mountPointCanonical: false },
      strayGbrainProcess: { strayProcesses: [{ op: "serve" }] },
    };
    const r = runDoctor(allFailing);
    expect(r.checks).toHaveLength(10);
    const repairs = r.checks.map((c) => c.repair);
    for (const rep of repairs) expect(rep).toBeTruthy();
    expect(new Set(repairs).size).toBe(10); // ALL pairwise-distinct
    expect(r.checks.every((c) => c.status !== "ok")).toBe(true);
    expect(r.overall).toBe("finding");
  });

  it("posture_writable_mount_is_distinct_finding", () => {
    const writableMount = runDoctor({ ...greenSnapshot(), gbrainMount: { readOnly: false, mountPointCanonical: true } });
    expect(find(writableMount, "gbrain_readonly_mount")?.status).toBe("finding");
    expect(find(writableMount, "gbrain_readonly_mount")?.failureVariant).toBe("gbrain_mount_writable_or_mispointed");
    const mispointed = runDoctor({ ...greenSnapshot(), gbrainMount: { readOnly: true, mountPointCanonical: false } });
    expect(find(mispointed, "gbrain_readonly_mount")?.status).toBe("finding");
    const writableAcl = runDoctor({ ...greenSnapshot(), vaultAcl: { workerIsSoleWritePrincipal: false } });
    expect(find(writableAcl, "vault_acl")?.status).toBe("finding");
    expect(find(writableAcl, "vault_acl")?.failureVariant).toBe("vault_acl_not_worker_exclusive");
    // the vault-acl / mount findings are DISTINCT from each other and from the stray-process finding
    const stray = runDoctor({ ...greenSnapshot(), strayGbrainProcess: { strayProcesses: [{ op: "serve" }] } });
    const aclRepair = find(writableAcl, "vault_acl")?.repair;
    const mountRepair = find(writableMount, "gbrain_readonly_mount")?.repair;
    const strayRepair = find(stray, "stray_gbrain_process")?.repair;
    expect(new Set([aclRepair, mountRepair, strayRepair]).size).toBe(3);
  });

  it("posture_stray_gbrain_process_is_finding_redaction_safe", () => {
    const SECRET = "sk-SECRET-raw-args-token";
    const r = runDoctor({
      ...greenSnapshot(),
      strayGbrainProcess: {
        // a legit op + a MALFORMED op embedding a secret (only a bounded classified label may surface)
        strayProcesses: [{ op: "serve" }, { op: `autopilot ${SECRET}` } as unknown as { op: "autopilot" }],
      },
    });
    const stray = find(r, "stray_gbrain_process");
    expect(stray?.status).toBe("finding");
    expect(stray?.failureVariant).toBe("stray_gbrain_writer_detected");
    expect(stray?.detail).toContain("serve"); // the recognized op is named
    expect(stray?.detail).toContain("unrecognized-writer"); // the malformed op is CLASSIFIED, not echoed
    expect(JSON.stringify(stray)).not.toContain(SECRET); // no raw args/secret bytes leak into the finding
    expect(doctorReportSchema.safeParse(r).success).toBe(true); // detail still satisfies the single-line bound
  });

  it("posture_absent_probe_fails_closed_to_finding", () => {
    // absent posture probes
    const absent: ProbeSnapshot = {
      ...greenSnapshot(),
      vaultAcl: undefined,
      gbrainMount: undefined,
      strayGbrainProcess: undefined,
    };
    const rAbsent = runDoctor(absent);
    for (const id of POSTURE_CHECKS) {
      expect(find(rAbsent, id)?.status, `${id} absent`).toBe("finding"); // NEVER ok
    }
    // unknown / malformed posture probes ⇒ also finding (never ok, never a throw)
    const malformed = {
      ...greenSnapshot(),
      vaultAcl: {},
      gbrainMount: "nope",
      strayGbrainProcess: { strayProcesses: "not-an-array" },
    } as unknown as ProbeSnapshot;
    expect(() => runDoctor(malformed)).not.toThrow();
    const rMal = runDoctor(malformed);
    for (const id of POSTURE_CHECKS) {
      expect(find(rMal, id)?.status, `${id} malformed`).toBe("finding");
    }
    // a NULL posture probe fails closed to the check's OWN variant (individually null-safe — not the generic
    // probe_error from the safeCheck backstop), so the operator still gets the specific repair.
    const nulls = {
      ...greenSnapshot(),
      vaultAcl: null,
      gbrainMount: null,
      strayGbrainProcess: null,
    } as unknown as ProbeSnapshot;
    expect(() => runDoctor(nulls)).not.toThrow();
    const rNull = runDoctor(nulls);
    expect(find(rNull, "vault_acl")?.failureVariant).toBe("vault_acl_not_worker_exclusive");
    expect(find(rNull, "gbrain_readonly_mount")?.failureVariant).toBe("gbrain_mount_writable_or_mispointed");
    expect(find(rNull, "stray_gbrain_process")?.failureVariant).toBe("stray_gbrain_writer_detected");
  });
});
