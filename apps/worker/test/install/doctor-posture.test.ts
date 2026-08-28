// Install-doctor write-through one-writer POSTURE checks (task 11.5, §13 / REQ-S-NEW-008 / safety rule 1) —
// SAFETY-CRITICAL. vault-ACL (worker = sole write principal), gbrain read-only-mount, and stray-gbrain-process
// are three DISTINCT DoctorCheckResults that FAIL CLOSED to `finding`: a writable/mispointed mount or a detected
// stray writer re-opens GO #1 and must NEVER resolve to a silent `ok`; an absent/unknown/malformed posture probe
// also defaults to `finding`. The stray-process finding names the op label ONLY (redaction-safe by construction).
import { describe, it, expect } from "vitest";
import { doctorReportSchema } from "@sow/contracts";
import type { DoctorReport, DoctorCheckId } from "@sow/contracts";
import { runDoctor } from "../../src/install/doctor";
import { doctorExitCode } from "../../src/install/doctor-cli";
import type { ProbeSnapshotWithLock } from "../../src/install/doctor";

const POSTURE_CHECKS: readonly DoctorCheckId[] = ["vault_acl", "gbrain_readonly_mount", "stray_gbrain_process"];
const find = (r: DoctorReport, id: DoctorCheckId) => r.checks.find((c) => c.check === id);

const greenSnapshot = (): ProbeSnapshotWithLock => ({
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
  singleOwnerLock: { acquired: true },
});

describe("runDoctor — one-writer posture (REQ-S-NEW-008, safety rule 1)", () => {
  it("all_green_snapshot_reports_all_ok", () => {
    const r = runDoctor(greenSnapshot());
    expect(r.checks).toHaveLength(11); // every named check present (task 24.1 / 11.1 adds single_owner_lock)
    for (const c of r.checks) expect(c.status, `check ${c.check}`).toBe("ok");
    expect(r.overall).toBe("ok");
    expect(doctorReportSchema.safeParse(r).success).toBe(true);
  });

  it("all_failing_repairs_are_pairwise_distinct", () => {
    // every one of the 11 checks fails ⇒ 11 DISTINCT repair strings (no shared/generic catch-all anywhere)
    const allFailing: ProbeSnapshotWithLock = {
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
      singleOwnerLock: { acquired: false },
    };
    const r = runDoctor(allFailing);
    expect(r.checks).toHaveLength(11);
    const repairs = r.checks.map((c) => c.repair);
    for (const rep of repairs) expect(rep).toBeTruthy();
    expect(new Set(repairs).size).toBe(11); // ALL pairwise-distinct
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
    const absent: ProbeSnapshotWithLock = {
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
    } as unknown as ProbeSnapshotWithLock;
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
    } as unknown as ProbeSnapshotWithLock;
    expect(() => runDoctor(nulls)).not.toThrow();
    const rNull = runDoctor(nulls);
    expect(find(rNull, "vault_acl")?.failureVariant).toBe("vault_acl_not_worker_exclusive");
    expect(find(rNull, "gbrain_readonly_mount")?.failureVariant).toBe("gbrain_mount_writable_or_mispointed");
    expect(find(rNull, "stray_gbrain_process")?.failureVariant).toBe("stray_gbrain_writer_detected");
  });
});

describe("runDoctor — REQ-D-005 single-owner-lock check WIRING (task 24.1 / 11.1, safety rule 1)", () => {
  it("single_owner_lock_wired_ok_only_on_acquired_true", () => {
    const r = runDoctor({ ...greenSnapshot(), singleOwnerLock: { acquired: true } });
    expect(find(r, "single_owner_lock")?.status).toBe("ok");
    expect(r.overall).toBe("ok");
  });

  it("single_owner_lock_wired_fails_closed_when_absent_from_the_snapshot", () => {
    const withoutLock: ProbeSnapshotWithLock = { ...greenSnapshot(), singleOwnerLock: undefined };
    const r = runDoctor(withoutLock);
    expect(find(r, "single_owner_lock")?.status).toBe("finding");
    expect(find(r, "single_owner_lock")?.failureVariant).toBe("single_owner_lock_not_held");
    expect(r.overall).toBe("finding"); // NEVER ok — an unconfirmed lock hold re-opens GO #1
  });

  it("single_owner_lock_UNOBSERVABLE_is_degraded_not_a_finding — a standalone process must not assert a verdict it cannot take", () => {
    // ⛔ THE DEFECT THIS PINS. `sow-doctor` is a SEPARATE PROCESS from the worker, and this probe is
    // BY DEFINITION the outcome of the worker's BOOT-TIME `acquireSingleOwnerLock` call. A standalone
    // CLI cannot observe it — and it cannot take it either: acquiring the lock itself would report a
    // finding exactly when a healthy worker holds it, and ok exactly when none is running. The INVERSE
    // of the truth.
    // So the CLI had no value to supply, supplied none, and the fail-closed diagnoser turned the
    // absence into `single_owner_lock_not_held` — a verdict about the lock that nothing measured.
    // `degraded` is the honest third state: the app runs, this check could not be taken here.
    const withoutLock: ProbeSnapshotWithLock = { ...greenSnapshot(), singleOwnerLock: undefined };
    const r = runDoctor(withoutLock, { lockObservable: false });
    expect(find(r, "single_owner_lock")?.status).toBe("degraded");
    // ⛔ A DISTINCT variant, never `single_owner_lock_not_held` — that one asserts a policy verdict this process did
    // not earn (24.67's reasoning: a failure code must not claim a check that never ran).
    expect(find(r, "single_owner_lock")?.failureVariant).toBe("single_owner_lock_not_observable");
    expect(find(r, "single_owner_lock")?.repair).toBeTruthy(); // still tells the operator where to look
    expect(r.overall).toBe("degraded");
    expect(doctorExitCode(r.overall)).toBe(0); // THE HEADLINE: a healthy install exits 0
    expect(doctorReportSchema.safeParse(r).success).toBe(true);
  });

  it("NON-VACUITY: the same snapshot WITHOUT the flag still fails closed — the boot path is untouched", () => {
    // Without this, a "fix" that simply stopped failing closed everywhere would pass the pin above
    // while deleting the guarantee the sibling test exists for. The default is byte-equivalent to
    // before the option existed.
    const withoutLock: ProbeSnapshotWithLock = { ...greenSnapshot(), singleOwnerLock: undefined };
    expect(find(runDoctor(withoutLock), "single_owner_lock")?.status).toBe("finding");
    expect(find(runDoctor(withoutLock, {}), "single_owner_lock")?.status).toBe("finding");
    expect(find(runDoctor(withoutLock, { lockObservable: true }), "single_owner_lock")?.status).toBe("finding");
    // And an OBSERVABLE process with a genuinely unheld lock is still a finding, flag or no flag.
    const unheld: ProbeSnapshotWithLock = { ...greenSnapshot(), singleOwnerLock: { acquired: false } };
    expect(find(runDoctor(unheld, { lockObservable: true }), "single_owner_lock")?.status).toBe("finding");
  });

  it("single_owner_lock_wired_fails_closed_when_acquired_false", () => {
    const r = runDoctor({ ...greenSnapshot(), singleOwnerLock: { acquired: false, holderPid: 4242 } });
    expect(find(r, "single_owner_lock")?.status).toBe("finding");
    expect(find(r, "single_owner_lock")?.repair).toBeTruthy();
    expect(doctorReportSchema.safeParse(r).success).toBe(true);
  });
});
