// spec(§12 · §13 · safety-rule-1 · REQ-NF-005) — task 12.20 (doctor-prereqs acceptance leg).
//
// §12 DoD acceptance-altitude eval for the install-doctor safety/isolation POSTURE: drives the landed PURE
// `runDoctor(snapshot)` engine over hand-built `ProbeSnapshot`s and pins that the one-writer posture, loopback-only
// binding, and pin/startability checks fail CLOSED (assume-worst) with a DERIVED worst-of `overall` that never masks
// a finding. Deterministic, provider-free, gbrain-free (no real collectors / OS / network). IMPORTS the worker's
// pure surface (evals CONSUMES, never edits the worker — Lesson 29); the worker units own each diagnoser's detail —
// this asserts the roll-up + the fail-closed set. The live `clean-install` e2e leg is deferred (clean-install.test.ts).
import { describe, it, expect } from "vitest";
import { DOCTOR_CHECK_IDS } from "@sow/contracts";
import type { DoctorReport, DoctorStatus, DoctorCheckId, DoctorCheckResult } from "@sow/contracts";
import { runDoctor } from "@sow/worker/install/doctor";
import type { ProbeSnapshot } from "@sow/worker/install/probe-snapshot";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// A fully-green snapshot — every prerequisite confirmed (the positive anchor, L7 non-vacuity).
const ALL_OK: ProbeSnapshot = {
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
};

const checkOf = (r: DoctorReport, id: DoctorCheckId): DoctorCheckResult | undefined =>
  r.checks.find((c) => c.check === id);
const statusOf = (r: DoctorReport, id: DoctorCheckId): DoctorStatus | undefined => checkOf(r, id)?.status;

// The 3 write-through one-writer POSTURE checks — each must reach `finding` on three
// distinct bad inputs: an ABSENT probe (can't-confirm-safe), a structurally MALFORMED
// probe (can't-confirm-safe), and a well-formed CONFIRMED-UNSAFE posture (the actual
// GO-#1 re-opener: a non-exclusive ACL / writable mount / a detected live gbrain writer).
const POSTURE: ReadonlyArray<{
  id: DoctorCheckId;
  field: keyof ProbeSnapshot;
  malformed: Partial<ProbeSnapshot>;
  unsafe: Partial<ProbeSnapshot>;
}> = [
  {
    id: "vault_acl",
    field: "vaultAcl",
    malformed: { vaultAcl: {} as ProbeSnapshot["vaultAcl"] },
    unsafe: { vaultAcl: { workerIsSoleWritePrincipal: false } }, // vault writable by others
  },
  {
    id: "gbrain_readonly_mount",
    field: "gbrainMount",
    malformed: { gbrainMount: {} as ProbeSnapshot["gbrainMount"] },
    unsafe: { gbrainMount: { readOnly: false, mountPointCanonical: true } }, // writable mount
  },
  {
    id: "stray_gbrain_process",
    field: "strayGbrainProcess",
    malformed: { strayGbrainProcess: {} as ProbeSnapshot["strayGbrainProcess"] },
    unsafe: { strayGbrainProcess: { strayProcesses: [{ op: "serve" }] } }, // a detected live writer
  },
];

// ===========================================================================
// (1) positive anchor — a fully-ok snapshot passes (machinery CAN pass; L7)
// ===========================================================================
describe("§12/§13 — a fully-ok probe snapshot passes green", () => {
  it("all_ok_snapshot_passes: overall ok, every check ok, all 10 checks reported in order", () => {
    const r = runDoctor(ALL_OK);
    expect(r.overall).toBe("ok");
    expect(r.checks.map((c) => c.check)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(r.checks.every((c) => c.status === "ok")).toBe(true);
  });
});

// ===========================================================================
// (2) write-through posture — absent OR malformed probe FAILS CLOSED (rule-1, L8)
// ===========================================================================
describe("safety-rule-1 — the write-through posture checks fail CLOSED (never a silent ok)", () => {
  for (const p of POSTURE) {
    it(`${p.id}: an ABSENT probe → finding (assume-worst), overall finding`, () => {
      const r = runDoctor({ ...ALL_OK, [p.field]: undefined });
      expect(statusOf(r, p.id)).toBe("finding");
      expect(r.overall).toBe("finding");
    });
    it(`${p.id}: a MALFORMED probe → finding (assume-worst), overall finding`, () => {
      const r = runDoctor({ ...ALL_OK, ...p.malformed });
      expect(statusOf(r, p.id)).toBe("finding");
      expect(r.overall).toBe("finding");
    });
    it(`${p.id}: a CONFIRMED-UNSAFE posture (non-exclusive/writable/detected-writer) → finding`, () => {
      const r = runDoctor({ ...ALL_OK, ...p.unsafe });
      expect(statusOf(r, p.id)).toBe("finding");
      expect(r.overall).toBe("finding");
    });
  }
});

// ===========================================================================
// (3) loopback-only — an occupied loopback port → finding
// ===========================================================================
describe("§13 — loopback-only binding", () => {
  it("loopback_occupied_finding: an occupied loopback port → finding + finding overall", () => {
    const r = runDoctor({ ...ALL_OK, loopbackPorts: { occupiedPorts: [50051] } });
    expect(checkOf(r, "loopback_ports")?.failureVariant).toBe("loopback_port_occupied");
    expect(statusOf(r, "loopback_ports")).toBe("finding");
    expect(r.overall).toBe("finding");
  });
});

// ===========================================================================
// (4) pin/startability — an unstartable gbrain is never green
// ===========================================================================
describe("§13 — gbrain startability/pin integrity", () => {
  it("unpinned_gbrain_never_green: gbrain not startable → NOT ok (degraded, tolerated), never green", () => {
    const r = runDoctor({ ...ALL_OK, gbrainStartable: { startable: false } });
    expect(statusOf(r, "gbrain_startable")).not.toBe("ok");
    expect(statusOf(r, "gbrain_startable")).toBe("degraded");
  });
});

// ===========================================================================
// (5) overall is a DERIVED worst-of — a finding is never masked green
// ===========================================================================
describe("§13 — overall is a derived worst-of (no green mask)", () => {
  it("overall_worst_of_not_masked: one finding among oks → overall finding", () => {
    const r = runDoctor({ ...ALL_OK, vaultAcl: undefined });
    expect(r.checks.filter((c) => c.status === "finding")).toHaveLength(1);
    expect(r.overall).toBe("finding");
  });
  it("a lone degraded (no finding) → overall degraded (not masked to ok, not escalated to finding)", () => {
    const r = runDoctor({ ...ALL_OK, temporalStartable: { startable: false } });
    expect(r.checks.some((c) => c.status === "finding")).toBe(false);
    expect(r.overall).toBe("degraded");
  });
  it("a finding beats a degraded in the worst-of fold", () => {
    const r = runDoctor({ ...ALL_OK, temporalStartable: { startable: false }, vaultAcl: undefined });
    expect(r.overall).toBe("finding");
  });
});

// ===========================================================================
// (6) §16 TOTAL — a throwing probe folds to probe_error, the engine never throws
// ===========================================================================
describe("§16 — a throwing probe folds to probe_error (never throws)", () => {
  it("thrown_probe_folds_to_probe_error: a getter that throws → probe_error finding, no throw", () => {
    const throwing = Object.defineProperty({}, "workerIsSoleWritePrincipal", {
      get() {
        throw new Error("probe boom");
      },
    }) as ProbeSnapshot["vaultAcl"];
    let report: DoctorReport | undefined;
    expect(() => {
      report = runDoctor({ ...ALL_OK, vaultAcl: throwing });
    }).not.toThrow();
    expect(checkOf(report!, "vault_acl")?.failureVariant).toBe("probe_error");
    expect(statusOf(report!, "vault_acl")).toBe("finding");
  });
});

// ===========================================================================
// (7) verify-by-inversion — flipping one posture probe flips the acceptance score (L7)
// ===========================================================================
describe("L7 — the suite is non-vacuous (verify by inverting a posture probe)", () => {
  it("inverted_guard_flips_score: ALL_OK passes (overall ok); invert vault_acl → overall finding", () => {
    expect(runDoctor(ALL_OK).overall).toBe("ok"); // baseline pass
    const inverted = runDoctor({ ...ALL_OK, vaultAcl: { workerIsSoleWritePrincipal: false } });
    expect(inverted.overall).toBe("finding"); // the score flips — a vacuous suite would not
    expect(statusOf(inverted, "vault_acl")).toBe("finding");
  });
});

// ===========================================================================
// (8) HARD 100% floor — every fail-closed scenario produces a finding (safety invariant, L27)
// ===========================================================================
describe("L27 — the posture/loopback fail-closed set scores at a HARD 100% floor", () => {
  it("every fail-closed scenario produces a finding — a single silent ok fails the suite", () => {
    const scenarios: ProbeSnapshot[] = [
      // 3 posture absent (can't-confirm-safe)
      ...POSTURE.map((p) => ({ ...ALL_OK, [p.field]: undefined })),
      // 3 posture malformed (can't-confirm-safe)
      ...POSTURE.map((p) => ({ ...ALL_OK, ...p.malformed })),
      // 3 posture confirmed-unsafe (the actual GO-#1 re-opener)
      ...POSTURE.map((p) => ({ ...ALL_OK, ...p.unsafe })),
      // loopback occupied
      { ...ALL_OK, loopbackPorts: { occupiedPorts: [50051] } },
    ];
    const findings = scenarios.filter((s) => runDoctor(s).overall === "finding").length;
    expect(scenarios.length).toBeGreaterThan(0);
    expect(findings).toBe(scenarios.length); // 100% — no soft ratio
    expect(findings / scenarios.length).toBe(1);
  });
});

// ===========================================================================
// (9) EVAL-1 runner scoring — DoD honesty (real-integration criterion, mock-backed)
// ===========================================================================
describe("Open-source install — EVAL-1 runner scoring (DoD honesty)", () => {
  it("the deterministic doctor-prereqs leg is functionally-passing but NOT DoD-certified (§20.2)", () => {
    // This suite runs over the pure engine + hand-built snapshots — not a real clean install —
    // so §20.2 forbids reporting the real-integration criterion DoD-passing. The live e2e leg
    // (clean-install.test.ts, it.todo) certifies the DoD.
    const out = scoreById({ criterionId: "OPEN_SOURCE_INSTALL", value: true, fromRealIntegration: false });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
  });
  it("registry marks OPEN_SOURCE_INSTALL real-integration-required", () => {
    expect(criterionById("OPEN_SOURCE_INSTALL")?.requiresRealIntegration).toBe(true);
  });
});
