// spec(§12 · §13 clean-install/doctor · REQ-NF-005) — task 12.20 (clean-install e2e leg — DEFERRED).
//
// The live clean-install ACCEPTANCE e2e (the OPEN_SOURCE_INSTALL §20.1 row): run the documented install path on
// the DEFAULT provider runtime WITHOUT Hermes, bind all local services loopback-only, enforce session-token +
// Origin auth post-install, and verify gbrain pin-integrity — against a REAL install path + live services
// (Phase-11 / live-services gated). Tracked as an `it.todo` so the acceptance row is VISIBLY pending, not silently
// missing; the deterministic posture/loopback/pin fail-closed leg lands in `doctor-prereqs.test.ts`.
import { describe, it } from "vitest";

describe("§20.1 Open-source install — clean-install acceptance (live infra, deferred)", () => {
  it.todo("runs the documented clean install on the default runtime (no Hermes) end-to-end");
  it.todo("binds all local services loopback-only + enforces session-token/Origin auth post-install");
  it.todo("verifies gbrain version-pin integrity (blocks/degrades on a SHA mismatch, never runs unpinned)");
});
