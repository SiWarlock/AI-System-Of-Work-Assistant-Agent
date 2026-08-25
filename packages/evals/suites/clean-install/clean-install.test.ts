// spec(§12 · §13 clean-install/doctor · REQ-NF-005 · REQ-I-002/003 · §7 DoD) — tasks 11.7 + 12.20
// (the "live clean-install e2e leg" 12.20 names as deferred).
//
// The live clean-install ACCEPTANCE e2e (the OPEN_SOURCE_INSTALL §20.1 row): runs the documented
// install path — a real `bootWorker` + a real install-doctor — against an ISOLATED root (never
// the developer's own `~/.sow`/vault/config), via `../../src/install/clean-install.acceptance.ts`.
// "Clean environment" here means state isolation (see that module's header for the exact
// boundary), NOT a fresh Mac.
//
// Two legs open real I/O (a shell-out + a loopback bind) and are gated EXACTLY like apps/worker's
// own conventions (`SOW_DOCTOR_REAL` / `SOW_API`) — the default `@sow/evals` suite never shells
// out or opens a socket. The single-owner-lock mechanism leg is pure fs and always runs. A
// skipped leg is asserted as `kind:"skipped"` (visible, not silently absorbed) — this file never
// claims a real-integration result it did not measure.
//
// ⛔ §ARM-GBRAIN — nothing here arms anything: `config/gbrain.pin` is a read-only copy (see the
// fixture), gbrain is probed read-only (`--version`/`doctor --json`), `write_through_enabled`
// is never touched.
import { describe, it, expect } from "vitest";
import {
  runIsolatedPrerequisiteDoctorLeg,
  runBootToServingLeg,
  runSingleOwnerLockLeg,
  runCleanInstallAcceptance,
  KNOWN_GAPS,
} from "../../src/install/clean-install.acceptance";
import { createIsolatedInstallRoot } from "../../src/install/fixtures/isolated-root";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const DOCTOR_REAL = process.env.SOW_DOCTOR_REAL === "1";
const API_REAL = process.env.SOW_API === "1";

describe("§20.1 Open-source install — clean-install acceptance", () => {
  describe("leg: real install-doctor over an isolated root (SOW_DOCTOR_REAL-gated)", () => {
    it.skipIf(!DOCTOR_REAL)(
      "the REAL production install-doctor runs against the isolated vault, never throws, and reports the isolated vault's HONEST state (no configured git remote → a finding, not a fabricated pass)",
      async () => {
        const iso = await createIsolatedInstallRoot();
        try {
          const result = await runIsolatedPrerequisiteDoctorLeg(iso);
          expect(result.kind).toBe("ran");
          if (result.kind !== "ran") return;
          expect(result.exitCode === 0 || result.exitCode === 1).toBe(true);
          // The isolated vault genuinely has no git remote configured — the doctor must report
          // that HONESTLY as a finding, never mask it (a hard-coded "ok" here would defeat the
          // whole point of driving the REAL collectors over a REAL, uncommitted vault dir).
          expect(result.rendered).toContain("[finding] git_remotes");
          // All ten checks are rendered (never a silently-dropped check).
          for (const id of [
            "node_pnpm",
            "filevault",
            "keychain",
            "temporal_startable",
            "gbrain_startable",
            "loopback_ports",
            "git_remotes",
            "vault_acl",
            "gbrain_readonly_mount",
            "stray_gbrain_process",
          ]) {
            expect(result.rendered).toContain(id);
          }
        } finally {
          await iso.cleanup();
        }
      },
    );

    it.skipIf(DOCTOR_REAL)("SKIPS explicitly (not silently) when SOW_DOCTOR_REAL is not opted into", async () => {
      const iso = await createIsolatedInstallRoot();
      try {
        const result = await runIsolatedPrerequisiteDoctorLeg(iso);
        expect(result.kind).toBe("skipped");
        if (result.kind === "skipped") expect(result.reason).toContain("SOW_DOCTOR_REAL");
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe("leg: boot-to-serving — REQ-I-002/003 (default runtime, no Hermes) + 11.1 lock acquire + 11.2 migration + 11.3 pin verify (SOW_API-gated)", () => {
    it.skipIf(!API_REAL)(
      "bootWorker reaches a serving state on the isolated root WITHOUT any Hermes/runtime config, acquires the real single-owner lock (11.1), migrates a genesis sqlite from nothing (11.2), and honestly verifies the gbrain pin (11.3, degrade-or-serve, never a silent unpinned pass)",
      async () => {
        const iso = await createIsolatedInstallRoot();
        try {
          const result = await runBootToServingLeg(iso);
          expect(result.kind).toBe("ran");
          if (result.kind !== "ran") return;

          // Serving state: a real loopback port is bound. No Hermes/runtime/provider config was
          // ever supplied to bootWorker — the default runtime is exercised by CONSTRUCTION, not
          // by an assertion that could drift (there is nothing to disable).
          expect(result.apiPort).toBeGreaterThan(0);

          // 11.2 — the genesis migration ran against a sqlite file that did not exist a moment
          // ago; a non-empty file IS the migrated schema (an unmigrated/never-opened file would
          // not exist at all).
          expect(result.dbFileCreated).toBe(true);

          // Temporal degrades cleanly rather than crashing boot — a typed, non-throwing outcome
          // either way (this environment has no local Temporal dev-server running).
          expect(typeof result.temporalDegraded).toBe("boolean");

          // 11.3 — the REAL installed gbrain was probed against the isolated pin copy. Either
          // outcome is honest: "serving" (a live match) or "degraded" WITH a distinct health
          // item (never a silent unpinned pass — the exact GO-#1 property REQ-NF-005 requires).
          expect(["serving", "degraded"]).toContain(result.gbrainPinOutcome);
          if (result.gbrainPinOutcome === "degraded") {
            expect(result.gbrainPinHealthItemIds.length).toBeGreaterThan(0);
            expect(result.gbrainPinHealthItemIds.every((id) => id.startsWith("gbrain-version-pin:"))).toBe(
              true,
            );
          } else {
            expect(result.gbrainPinHealthItemIds).toHaveLength(0);
          }

          // 11.1 — bootWorker's real single-owner-lock acquire (bound live at `68ec73c9`,
          // worker track). A fresh isolated root has no lock held, so the acquire must succeed.
          expect(result.lockAcquiredAtBoot).toBe(true);
        } finally {
          await iso.cleanup();
        }
      },
    );

    it.skipIf(API_REAL)("SKIPS explicitly (not silently) when SOW_API is not opted into", async () => {
      const iso = await createIsolatedInstallRoot();
      try {
        const result = await runBootToServingLeg(iso);
        expect(result.kind).toBe("skipped");
        if (result.kind === "skipped") expect(result.reason).toContain("SOW_API");
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe("leg: single-owner-lock MECHANISM (11.1) — always runs, over its own isolated lockfile path", () => {
    it("the real OS-atomic lock acquires and refuses a concurrent second acquire — this leg pins the primitive; the boot-to-serving leg above pins its live use at boot", async () => {
      const iso = await createIsolatedInstallRoot();
      try {
        const result = runSingleOwnerLockLeg(iso);
        expect(result.acquired).toBe(true);
        expect(result.secondAcquireRefused).toBe(true);
        expect(result.diagnosis.status).toBe("ok");
        expect(result.boundAtBoot).toBe(false); // this leg's OWN scope — see lockAcquiredAtBoot above
      } finally {
        await iso.cleanup();
      }
    });
  });

  describe("§7 DoD honesty — known, named gaps (never asserted around)", () => {
    it("the harness names its own PARTIAL dependencies (11.1, 11.6) rather than silently passing over them", () => {
      const joined = KNOWN_GAPS.join("\n");
      expect(joined).toContain("11.1");
      expect(joined).toContain("11.6");
    });

    it("OPEN_SOURCE_INSTALL is NOT reported DoD-passing — a provider-matrix/capability leg + 11.1/11.6 remain open, and this suite says so rather than certifying past them (§7 — install must not falsely claim capability)", () => {
      const out = scoreById({ criterionId: "OPEN_SOURCE_INSTALL", value: false, fromRealIntegration: false });
      expect(out.functionalPass).toBe(false);
      expect(out.dodPass).toBe(false);
    });

    it("registry still marks OPEN_SOURCE_INSTALL real-integration-required", () => {
      expect(criterionById("OPEN_SOURCE_INSTALL")?.requiresRealIntegration).toBe(true);
    });
  });

  describe("the top-level orchestration wires all three legs and always tears its own root down", () => {
    it("runs end-to-end (real legs run/skip per env, the lock leg always runs) and leaves nothing behind", async () => {
      const result = await runCleanInstallAcceptance();
      expect(result.singleOwnerLock.acquired).toBe(true);
      expect(["ran", "skipped"]).toContain(result.prerequisiteDoctor.kind);
      expect(["ran", "skipped"]).toContain(result.bootToServing.kind);
      expect(result.knownGaps.length).toBeGreaterThan(0);
    });
  });
});
