// Tasks 11.1 + 24.1 — the install-doctor posture diagnoser for the single-owner lock. Standalone (not yet
// wired into runDoctor — see the doc block in the module under test for why + the exact wiring line
// pending the packages/contracts DOCTOR_CHECK_IDS extension). Fail-closed: `ok` ONLY on an explicit
// `acquired === true`.
import { describe, it, expect } from "vitest";
import {
  diagnoseSingleOwnerLock,
  type SingleOwnerLockProbe,
} from "../../src/install/lock/singleOwnerLockDoctorCheck";
import { acquireSingleOwnerLock } from "../../src/install/lock/singleOwnerLock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("diagnoseSingleOwnerLock — the install-doctor posture check (standalone, pending contracts wiring)", () => {
  it("acquired === true ⇒ ok, no failureVariant/repair", () => {
    const r = diagnoseSingleOwnerLock({ acquired: true });
    expect(r).toEqual({ check: "single_owner_lock", status: "ok" });
  });

  it("acquired === false ⇒ finding with the distinct failureVariant + a concrete repair", () => {
    const r = diagnoseSingleOwnerLock({ acquired: false, holderPid: 4242 });
    expect(r.check).toBe("single_owner_lock");
    expect(r.status).toBe("finding");
    expect(r.failureVariant).toBe("single_owner_lock_not_held");
    expect(r.repair).toBeDefined();
    expect(r.repair).not.toContain("4242"); // rule 7 — no raw pid echoed into the repair message
  });

  it("an absent (undefined) probe fails CLOSED to finding — never a silent ok", () => {
    const r = diagnoseSingleOwnerLock(undefined);
    expect(r.status).toBe("finding");
    expect(r.failureVariant).toBe("single_owner_lock_not_held");
  });

  it("a truthy-not-true acquired value (defense-in-depth against a malformed probe) still fails closed", () => {
    const malformed = { acquired: 1 } as unknown as SingleOwnerLockProbe;
    const r = diagnoseSingleOwnerLock(malformed);
    expect(r.status).toBe("finding");
  });

  it("wired end-to-end over the REAL acquireSingleOwnerLock: held ⇒ ok, refused ⇒ finding", () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-doctor-"));
    try {
      const lockPath = join(dir, "brain.lock");
      const held = acquireSingleOwnerLock(lockPath);
      expect(held.ok).toBe(true);
      expect(diagnoseSingleOwnerLock({ acquired: held.ok }).status).toBe("ok");

      const refused = acquireSingleOwnerLock(lockPath); // this same process races itself — refused
      expect(refused.ok).toBe(false);
      expect(diagnoseSingleOwnerLock({ acquired: refused.ok }).status).toBe("finding");

      if (held.ok) held.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
