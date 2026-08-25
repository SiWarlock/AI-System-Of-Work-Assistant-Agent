// Tasks 24.1 + 11.1 — widens the CLOSED DoctorCheckId enum + doctorFailureVariantSchema with the
// REQ-D-005 single-owner-lock posture check (safety rule 1), unblocking apps/worker's
// `diagnoseSingleOwnerLock` registration into `runDoctor`'s checks array (previously blocked on
// this package's frozen enum — see apps/worker/src/install/lock/singleOwnerLockDoctorCheck.ts).
//
// This module is an ADDITIVE local result contract, NOT an Appendix-A frozen seam (its own header
// says so) — no schema-snapshot/ajv-registry ceremony applies here; this is the first dedicated
// test file for it.
import { describe, it, expect } from "vitest";
import {
  DOCTOR_CHECK_IDS,
  doctorCheckIdSchema,
  doctorFailureVariantSchema,
  doctorCheckResultSchema,
} from "../../src/install/doctor-result";

describe("doctor-result — single_owner_lock enum widening (task 24.1 / 11.1)", () => {
  it("DOCTOR_CHECK_IDS includes single_owner_lock — the closed enum accepts the new check id", () => {
    expect(DOCTOR_CHECK_IDS).toContain("single_owner_lock");
    expect(doctorCheckIdSchema.safeParse("single_owner_lock").success).toBe(true);
  });

  it("doctorFailureVariantSchema accepts single_owner_lock_not_held", () => {
    expect(doctorFailureVariantSchema.safeParse("single_owner_lock_not_held").success).toBe(true);
  });

  it("a single_owner_lock finding round-trips through doctorCheckResultSchema (non-ok requires failureVariant+repair)", () => {
    const finding = {
      check: "single_owner_lock",
      status: "finding",
      failureVariant: "single_owner_lock_not_held",
      repair:
        "Another process holds the canonical brain/vault lock, or this worker never acquired it. Ensure no " +
        "other SoW worker instance (or a stray gbrain process) is running against this vault/brain, then restart.",
    };
    expect(doctorCheckResultSchema.safeParse(finding).success).toBe(true);
  });

  it("a single_owner_lock ok result carries neither failureVariant nor repair", () => {
    expect(doctorCheckResultSchema.safeParse({ check: "single_owner_lock", status: "ok" }).success).toBe(
      true,
    );
  });

  it("an unknown check id is still rejected — the enum stays CLOSED, not widened to a free string", () => {
    expect(doctorCheckIdSchema.safeParse("not_a_real_check").success).toBe(false);
  });

  it("an unknown failure variant is still rejected — the variant enum stays CLOSED", () => {
    expect(doctorFailureVariantSchema.safeParse("not_a_real_variant").success).toBe(false);
  });
});
