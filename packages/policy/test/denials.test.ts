// spec(§5) — DenialReason union: four hard denials present + isHardDenial true for them / false for support codes; MALFORMED_POLICY_INPUT is the fail-closed default
import { describe, it, expect } from "vitest";
import {
  HARD_DENIALS,
  isHardDenial,
  type DenialReason,
} from "../src/denials";

describe("HARD_DENIALS", () => {
  it("contains exactly the four §5 hard denials", () => {
    expect([...HARD_DENIALS].sort()).toEqual(
      [
        "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
        "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
        "UNTRUSTED_CONTENT_MUTATING_TOOL",
        "WRITE_ADAPTER_OUTSIDE_GATEWAY",
      ].sort(),
    );
  });

  it("isHardDenial returns true for every hard denial", () => {
    for (const r of HARD_DENIALS) {
      expect(isHardDenial(r)).toBe(true);
    }
  });
});

describe("isHardDenial for support codes", () => {
  const supportCodes: DenialReason[] = [
    "PROVIDER_NOT_ALLOWED",
    "NO_ROUTE_FOR_CAPABILITY",
    "PROCESSOR_NOT_ALLOWED",
    "LOCAL_ENDPOINT_NOT_CONFIGURED",
    "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
    "VISIBILITY_EXCEEDS_SOURCE",
    "APPROVAL_REQUIRED",
    "AUTH_TOKEN_INVALID",
    "ORIGIN_NOT_ALLOWED",
    "MALFORMED_POLICY_INPUT",
  ];

  it("returns false for every support code", () => {
    for (const r of supportCodes) {
      expect(isHardDenial(r)).toBe(false);
    }
  });

  it("MALFORMED_POLICY_INPUT is a valid support denial (fail-closed default)", () => {
    const failClosed: DenialReason = "MALFORMED_POLICY_INPUT";
    expect(isHardDenial(failClosed)).toBe(false);
  });
});
