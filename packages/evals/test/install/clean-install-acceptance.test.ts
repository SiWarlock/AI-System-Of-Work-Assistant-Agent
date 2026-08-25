// spec(§12 · §13 clean-install/doctor · REQ-NF-005 · REQ-I-002/003) — task 11.7.
//
// Unit-level pins for `clean-install.acceptance.ts` — the pieces that are deterministic and
// require NO opt-in env flag (no shell-out, no socket): the single-owner-lock mechanism leg
// (real fs, run in isolation over its OWN lockfile path — bootWorker itself now acquires the
// lock for real too, as of `68ec73c9`, observed by the SOW_API-gated boot-to-serving leg
// instead), the explicit SKIP reporting when the real-
// integration legs are not opted into (never a silent no-op), the top-level orchestration
// (creates + tears down its own isolated root), and the recorded known-gaps list. The real-
// integration legs themselves (SOW_DOCTOR_REAL / SOW_API) are exercised in
// suites/clean-install/clean-install.test.ts, gated exactly like apps/worker's own convention.
import { describe, it, expect, afterEach } from "vitest";
import { stat } from "node:fs/promises";
import {
  runSingleOwnerLockLeg,
  runIsolatedPrerequisiteDoctorLeg,
  runBootToServingLeg,
  runCleanInstallAcceptance,
  KNOWN_GAPS,
} from "../../src/install/clean-install.acceptance";
import { createIsolatedInstallRoot } from "../../src/install/fixtures/isolated-root";

const savedEnv: Record<string, string | undefined> = {
  SOW_DOCTOR_REAL: process.env.SOW_DOCTOR_REAL,
  SOW_API: process.env.SOW_API,
};
afterEach(() => {
  if (savedEnv.SOW_DOCTOR_REAL === undefined) delete process.env.SOW_DOCTOR_REAL;
  else process.env.SOW_DOCTOR_REAL = savedEnv.SOW_DOCTOR_REAL;
  if (savedEnv.SOW_API === undefined) delete process.env.SOW_API;
  else process.env.SOW_API = savedEnv.SOW_API;
});

describe("§13/11.7 — the single-owner-lock MECHANISM leg (real fs, always runs, never gated)", () => {
  it("acquires, refuses a concurrent second acquire, and reports the honest boot-binding gap", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      const result = runSingleOwnerLockLeg(iso);
      expect(result.acquired).toBe(true);
      expect(result.secondAcquireRefused).toBe(true);
      expect(result.diagnosis.status).toBe("ok");
      expect(result.boundAtBoot).toBe(false); // THIS leg's own field — it runs the primitive independent of boot
      expect(result.gapNote).toContain("single_owner_lock member");
    } finally {
      await iso.cleanup();
    }
  });

  it("releases after itself — a second, independent leg run over the SAME path re-acquires cleanly", async () => {
    const iso = await createIsolatedInstallRoot();
    try {
      const first = runSingleOwnerLockLeg(iso);
      expect(first.acquired).toBe(true);
      const second = runSingleOwnerLockLeg(iso);
      expect(second.acquired).toBe(true); // only true if the first run released its hold
    } finally {
      await iso.cleanup();
    }
  });
});

describe("§13/11.7 — real-integration legs SKIP explicitly (never a silent no-op) when not opted in", () => {
  it("the prerequisite-doctor leg reports kind:'skipped' with a reason when SOW_DOCTOR_REAL!=1", async () => {
    delete process.env.SOW_DOCTOR_REAL;
    const iso = await createIsolatedInstallRoot();
    try {
      const result = await runIsolatedPrerequisiteDoctorLeg(iso);
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      await iso.cleanup();
    }
  });

  it("the boot-to-serving leg reports kind:'skipped' with a reason when SOW_API!=1", async () => {
    delete process.env.SOW_API;
    const iso = await createIsolatedInstallRoot();
    try {
      const result = await runBootToServingLeg(iso);
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") expect(result.reason.length).toBeGreaterThan(0);
    } finally {
      await iso.cleanup();
    }
  });
});

describe("§13/11.7 — the top-level orchestration mints and tears down its own isolated root", () => {
  it("runs all three legs and cleans up the isolated root afterward", async () => {
    delete process.env.SOW_DOCTOR_REAL;
    delete process.env.SOW_API;
    const result = await runCleanInstallAcceptance();
    expect(result.singleOwnerLock.acquired).toBe(true);
    expect(result.prerequisiteDoctor.kind).toBe("skipped");
    expect(result.bootToServing.kind).toBe("skipped");
    await expect(stat(result.isolatedRoot)).rejects.toThrow(); // cleaned up, not left behind
  });
});

describe("§13/11.7 — the known-gaps ledger names the two documented PARTIAL dependencies", () => {
  it("names 11.1 (single-owner lock unbound at boot) and 11.6 (no gbrain subprocess spawn)", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    const joined = KNOWN_GAPS.join("\n");
    expect(joined).toContain("11.1");
    expect(joined).toContain("single-owner lock");
    expect(joined).toContain("11.6");
    expect(joined).toContain("gbrain subprocess");
  });
});
