// spec(§7) — matrix-eligibility + meeting.close DoD gate (task 5.10). Pure data:
// a non-passing pair is disabled + ineligible; a CLOUD failure is release-blocking
// while a LOCAL failure is not (optional zero-egress path); meeting.close certifies
// only with ≥1 conformant subject, and the Employer-Work branch needs egress ack ON
// OR a conformant local subject.
import { describe, expect, it } from "vitest";
import type { Capability, ConformanceResult, ConformanceStatus, EgressClass } from "@sow/contracts";
import {
  matrixEligibility,
  releaseBlockingFailures,
  hasEligibleFor,
  meetingCloseDoD,
  isConformancePassing,
} from "../../src/conformance/matrix-eligibility";

function result(
  overrides: Partial<ConformanceResult> & { status: ConformanceStatus; egressClass: EgressClass },
): ConformanceResult {
  return {
    subjectKind: "provider",
    subjectId: "openrouter",
    capability: "meeting.close" as Capability,
    model: "anthropic/claude-haiku-4.5",
    checkedAt: "2026-06-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("matrixEligibility — spec(§7)", () => {
  it("marks a passing pair eligible and a failing pair disabled + ineligible", () => {
    const views = matrixEligibility([
      result({ status: "passing", egressClass: "cloud" }),
      result({ status: "failing", egressClass: "cloud", subjectId: "openai" }),
    ]);
    expect(views[0]).toMatchObject({ eligible: true, effectiveStatus: "passing" });
    expect(views[1]).toMatchObject({ eligible: false, effectiveStatus: "disabled" });
  });

  it("treats unknown/disabled as ineligible (only passing routes)", () => {
    expect(isConformancePassing(result({ status: "unknown", egressClass: "cloud" }))).toBe(false);
    expect(isConformancePassing(result({ status: "disabled", egressClass: "local" }))).toBe(false);
    expect(isConformancePassing(result({ status: "passing", egressClass: "cloud" }))).toBe(true);
  });
});

describe("releaseBlockingFailures — spec(§7)", () => {
  it("blocks on a CLOUD conformance failure but NOT a local one", () => {
    const blocking = releaseBlockingFailures([
      result({ status: "failing", egressClass: "cloud", subjectId: "openai" }),
      result({ status: "failing", egressClass: "local", subjectId: "ollama" }),
      result({ status: "passing", egressClass: "cloud" }),
    ]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.subjectId).toBe("openai");
  });

  it("is empty when every cloud subject passes (local failures ignored)", () => {
    expect(
      releaseBlockingFailures([
        result({ status: "passing", egressClass: "cloud" }),
        result({ status: "failing", egressClass: "local", subjectId: "lm_studio" }),
      ]),
    ).toHaveLength(0);
  });
});

describe("hasEligibleFor — spec(§7)", () => {
  it("is true only when a passing subject exists for the capability", () => {
    const rs = [
      result({ status: "failing", egressClass: "cloud" }),
      result({ status: "passing", egressClass: "cloud", capability: "notebooklm.sync" as Capability }),
    ];
    expect(hasEligibleFor(rs, "meeting.close")).toBe(false);
    expect(hasEligibleFor(rs, "notebooklm.sync")).toBe(true);
  });
});

describe("meetingCloseDoD — spec(§7)", () => {
  it("is NOT certifiable with zero conformant meeting.close subjects", () => {
    const out = meetingCloseDoD({
      results: [result({ status: "failing", egressClass: "cloud" })],
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(out).toEqual({ certifiable: false, reason: "no_conformant_meeting_close_subject" });
  });

  it("ignores conformant subjects of OTHER capabilities", () => {
    const out = meetingCloseDoD({
      results: [
        result({ status: "passing", egressClass: "cloud", capability: "notebooklm.sync" as Capability }),
      ],
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(out.certifiable).toBe(false);
  });

  it("certifies a non-employer workspace with ≥1 conformant meeting.close subject", () => {
    const out = meetingCloseDoD({
      results: [result({ status: "passing", egressClass: "cloud" })],
      workspaceType: "personal_business",
      employerRawEgressAcknowledged: false,
    });
    expect(out).toEqual({ certifiable: true, reason: "ok" });
  });

  it("Employer-Work with ack OFF and only a CLOUD conformant subject is NOT certifiable", () => {
    const out = meetingCloseDoD({
      results: [result({ status: "passing", egressClass: "cloud" })],
      workspaceType: "employer_work",
      employerRawEgressAcknowledged: false,
    });
    expect(out).toEqual({
      certifiable: false,
      reason: "employer_work_requires_ack_or_conformant_local",
    });
  });

  it("Employer-Work with ack OFF but a conformant LOCAL subject IS certifiable", () => {
    const out = meetingCloseDoD({
      results: [
        result({ status: "passing", egressClass: "local", subjectId: "ollama", subjectKind: "provider" }),
      ],
      workspaceType: "employer_work",
      employerRawEgressAcknowledged: false,
    });
    expect(out).toEqual({ certifiable: true, reason: "ok" });
  });

  it("Employer-Work with ack ON and a cloud conformant subject IS certifiable", () => {
    const out = meetingCloseDoD({
      results: [result({ status: "passing", egressClass: "cloud" })],
      workspaceType: "employer_work",
      employerRawEgressAcknowledged: true,
    });
    expect(out).toEqual({ certifiable: true, reason: "ok" });
  });
});
