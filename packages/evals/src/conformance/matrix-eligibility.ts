// spec(§7) — matrix-eligibility gate + meeting.close DoD gate (task 5.10).
// DETERMINISTIC + PURE over ConformanceResult[] (the outputs of the provider/
// runtime conformance runners). Implements "conformance is the contract":
//   - a NON-passing (subject × capability) pair is DISABLED and matrix-INELIGIBLE;
//   - a CLOUD non-conformant pair is release-blocking; a LOCAL (zero-egress)
//     conformance failure is NOT a release gate (optional zero-egress path, §7);
//   - meeting.close is DoD-certifiable only when ≥1 conformant provider/runtime is
//     configured for it in the exercised workspace (Employer-Work adds the egress
//     acknowledgment / conformant-local requirement).
import type { ConformanceResult, ConformanceStatus, WorkspaceType } from "@sow/contracts";

/** The capability whose end-to-end DoD is the §7/PRD §20.2 proof spine. */
export const MEETING_CLOSE_CAPABILITY = "meeting.close" as const;

/** A conformance result is routable iff it PASSED. failing/disabled/unknown ⇒ not. */
export function isConformancePassing(r: ConformanceResult): boolean {
  return r.status === "passing";
}

/** The matrix-eligibility projection of one conformance result. */
export interface EligibilityView {
  readonly subjectKind: ConformanceResult["subjectKind"];
  readonly subjectId: string;
  readonly capability: ConformanceResult["capability"];
  readonly model: string;
  readonly egressClass: ConformanceResult["egressClass"];
  /** Routable in the matrix (passing). */
  readonly eligible: boolean;
  /** Effective matrix status: a non-passing pair is DISABLED (not left ambiguous). */
  readonly effectiveStatus: ConformanceStatus;
}

/**
 * Project conformance results into matrix eligibility: passing ⇒ eligible; every
 * other status ⇒ disabled + ineligible. The Broker (5.2/5.9) routes ONLY over
 * eligible entries; a disabled pair is never a routing target.
 */
export function matrixEligibility(results: readonly ConformanceResult[]): EligibilityView[] {
  return results.map((r) => {
    const eligible = isConformancePassing(r);
    return {
      subjectKind: r.subjectKind,
      subjectId: r.subjectId,
      capability: r.capability,
      model: r.model,
      egressClass: r.egressClass,
      eligible,
      effectiveStatus: eligible ? "passing" : "disabled",
    };
  });
}

/**
 * Release-blocking conformance failures: a CLOUD (egress) subject that did not pass.
 * A LOCAL conformance failure is excluded — the local zero-egress path is optional
 * and NOT a release gate (§7: "Local providers optional zero-egress path, not
 * release gate"). A non-empty result blocks the release.
 */
export function releaseBlockingFailures(
  results: readonly ConformanceResult[],
): ConformanceResult[] {
  return results.filter((r) => r.egressClass === "cloud" && !isConformancePassing(r));
}

/** Does any eligible (passing) subject exist for `capability`? */
export function hasEligibleFor(
  results: readonly ConformanceResult[],
  capability: string,
): boolean {
  return results.some((r) => r.capability === capability && isConformancePassing(r));
}

/** Input to the meeting.close DoD gate. */
export interface MeetingCloseDoDInput {
  /** Conformance results for the subjects configured in the exercised workspace. */
  readonly results: readonly ConformanceResult[];
  /** The exercised workspace's type — the Employer-Work branch adds a requirement. */
  readonly workspaceType: WorkspaceType;
  /** Whether raw Employer-Work egress is acknowledged (matrix `rawCloudEgressEnabled`/ack ON). */
  readonly employerRawEgressAcknowledged: boolean;
}

/** Enumerable DoD-gate reasons (no free-form strings crossing the boundary, §16). */
export const MeetingCloseDoDReason = [
  "ok",
  "no_conformant_meeting_close_subject",
  "employer_work_requires_ack_or_conformant_local",
] as const;
export type MeetingCloseDoDReason = (typeof MeetingCloseDoDReason)[number];

/** Outcome of the meeting.close DoD gate. */
export interface MeetingCloseDoDOutcome {
  readonly certifiable: boolean;
  readonly reason: MeetingCloseDoDReason;
}

/**
 * meeting.close DoD gate (§7): the build certifies the meeting-closeout DoD only if
 * ≥1 conformant provider/runtime is configured for `meeting.close` in the exercised
 * workspace. The Employer-Work branch additionally requires egress acknowledgment ON
 * OR a conformant LOCAL provider/runtime (never a cloud fallback with ack OFF —
 * safety rule 5). PURE + deterministic.
 */
export function meetingCloseDoD(input: MeetingCloseDoDInput): MeetingCloseDoDOutcome {
  const conformant = input.results.filter(
    (r) => r.capability === MEETING_CLOSE_CAPABILITY && r.status === "passing",
  );
  if (conformant.length === 0) {
    return { certifiable: false, reason: "no_conformant_meeting_close_subject" };
  }

  if (input.workspaceType === "employer_work" && !input.employerRawEgressAcknowledged) {
    const hasConformantLocal = conformant.some((r) => r.egressClass === "local");
    if (!hasConformantLocal) {
      return {
        certifiable: false,
        reason: "employer_work_requires_ack_or_conformant_local",
      };
    }
  }

  return { certifiable: true, reason: "ok" };
}
