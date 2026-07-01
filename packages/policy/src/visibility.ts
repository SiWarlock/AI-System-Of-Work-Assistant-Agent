// §5 visibility levels + hard denial #2 (REQ-F-005 / REQ-F-020 / WS-8).
//
// Two responsibilities:
//   1. The visibility-level lattice (isolated < coordination < sanitized < full)
//      and the "within workspace default" predicate + the projection-visibility
//      gate §6 GCL-reconcile calls before serving a cross-workspace projection.
//   2. `denyDirectCrossWorkspaceRaw` — the fail-closed refusal of ANY direct
//      cross-workspace / cross-brain RAW retrieval (safety rule 4). The ONLY
//      permitted cross-workspace path is a sanitized GclProjection; the SOLE
//      exception is a recorded Level-3 owner-approved link.
//
// PURE + FAIL-CLOSED: missing / unrecognized / malformed input ⇒ DENY. Every
// decision emits a redaction-safe AuditSignal (refs / hashes / codes only).
import type { GclProjection, Workspace, VisibilityLevel } from "@sow/contracts";
import { isVisibilityLevel } from "@sow/contracts";
import { allowDecision, denyDecision, type PolicyDecision } from "./decision";
import { buildAuditSignal, POLICY_DENIAL_HEALTH_CLASS } from "./audit-signal";

// The visibility lattice: strictly increasing exposure. A closed map keyed by the
// four levels — total over VisibilityLevel, so the lookup is never undefined.
const RANK: Readonly<Record<VisibilityLevel, number>> = {
  isolated: 0,
  coordination: 1,
  sanitized: 2,
  full: 3,
};

/** Numeric rank of a visibility level: isolated(0) < coordination(1) < sanitized(2) < full(3). */
export function visibilityRank(l: VisibilityLevel): number {
  return RANK[l];
}

/**
 * True iff a projection's level does NOT exceed the workspace default — i.e. the
 * projection exposes no more than the workspace permits by default.
 */
export function isWithinDefault(
  projectionLevel: VisibilityLevel,
  workspaceDefault: VisibilityLevel,
): boolean {
  return visibilityRank(projectionLevel) <= visibilityRank(workspaceDefault);
}

// A payloadHash-shaped code (not a real content hash — policy is pure and has no
// hasher outside session-auth). Redaction-safe: a fixed decision-kind marker; the
// projection/workspace identity rides the refs.
const VISIBILITY_PAYLOAD_MARKER = "policy:visibility-decision" as const;
const CROSS_WS_PAYLOAD_MARKER = "policy:cross-workspace-raw-decision" as const;

/**
 * Projection-visibility gate (§6 GCL-reconcile predicate). FAIL-CLOSED:
 *  - projection omits visibilityLevel or workspaceId, or workspaceId mismatches the
 *    source workspace, or the source default is itself malformed ⇒ MALFORMED_POLICY_INPUT.
 *  - level exceeds the workspace default, or falls outside the closed level set ⇒
 *    VISIBILITY_EXCEEDS_SOURCE.
 *  - otherwise ALLOW, echoing the projection.
 */
export function validateProjectionVisibility(
  projection: GclProjection,
  sourceWorkspace: Workspace,
): PolicyDecision<GclProjection> {
  const wsId: unknown = projection?.workspaceId;
  const level: unknown = projection?.visibilityLevel;
  const refs: readonly string[] = [
    `ref:workspace:${typeof wsId === "string" ? wsId : "MISSING"}`,
    `ref:visibility:${isVisibilityLevel(level) ? level : "UNRECOGNIZED"}`,
  ];

  const denyMalformed = (afterSummary: string): PolicyDecision<GclProjection> =>
    denyDecision(
      "MALFORMED_POLICY_INPUT",
      afterSummary,
      buildAuditSignal({
        actor: "policy",
        event: "visibility.projection.denied",
        refs,
        payloadHash: VISIBILITY_PAYLOAD_MARKER,
        beforeSummary: "projection visibility not validated",
        afterSummary,
        denialCode: "MALFORMED_POLICY_INPUT",
      }),
    );

  // Fail-closed: absent identity fields (omits visibilityLevel / workspaceId).
  if (projection == null || wsId === undefined || wsId === null || wsId === "") {
    return denyMalformed("projection omits workspaceId");
  }
  if (typeof wsId !== "string") {
    return denyMalformed("projection workspaceId is not a string");
  }
  if (level === undefined || level === null) {
    return denyMalformed("projection omits visibilityLevel");
  }
  // Referential pin: a projection must name its own source workspace.
  if (wsId !== sourceWorkspace.id) {
    return denyMalformed("projection workspaceId does not match source workspace");
  }
  // Guard the source default too — a malformed source posture is fail-closed input.
  if (!isVisibilityLevel(sourceWorkspace.defaultVisibility)) {
    return denyMalformed("source workspace defaultVisibility is unrecognized");
  }

  const exceedsSignal = (afterSummary: string) =>
    buildAuditSignal({
      actor: "policy",
      event: "visibility.projection.denied",
      refs,
      payloadHash: VISIBILITY_PAYLOAD_MARKER,
      beforeSummary: "projection visibility not validated",
      afterSummary,
      denialCode: "VISIBILITY_EXCEEDS_SOURCE",
    });

  // Present but outside the closed level set ⇒ exceeds-source (unrecognized level
  // is treated as an over-exposure, fail-closed — never silently permitted).
  if (!isVisibilityLevel(level)) {
    return denyDecision(
      "VISIBILITY_EXCEEDS_SOURCE",
      "projection visibilityLevel falls outside the closed visibility set",
      exceedsSignal("projection visibilityLevel outside closed set"),
    );
  }
  if (!isWithinDefault(level, sourceWorkspace.defaultVisibility)) {
    return denyDecision(
      "VISIBILITY_EXCEEDS_SOURCE",
      "projection visibility level exceeds the workspace default",
      exceedsSignal("projection level exceeds workspace default"),
    );
  }

  return allowDecision(
    projection,
    buildAuditSignal({
      actor: "policy",
      event: "visibility.projection.allowed",
      refs,
      payloadHash: VISIBILITY_PAYLOAD_MARKER,
      beforeSummary: "projection visibility not validated",
      afterSummary: "projection within workspace default visibility",
    }),
  );
}

/** A recorded Level-3 owner-approved cross-workspace link (REQ-F-020 / WS-5). */
export interface ApprovedLink {
  readonly level3: true;
  readonly recordedApprovalRef: string;
}

/** Request shape for the direct cross-workspace raw-retrieval gate. */
export interface CrossWorkspaceRawRequest {
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  /** Present ⇒ a recorded Level-3 owner link (the SOLE permitted exception). */
  readonly approvedLink?: ApprovedLink;
}

/**
 * Hard denial #2 (safety rule 4): DENY any DIRECT cross-workspace / cross-brain RAW
 * retrieval. The only permitted cross-workspace path is a sanitized GclProjection
 * (validated above) — raw retrieval is never permitted directly. The SOLE exception
 * is a recorded Level-3 owner-approved link; ABSENT or malformed ⇒ deny (the link is
 * never auto-created). Same-workspace (from === to) is not a cross-workspace request.
 *
 * FAIL-CLOSED: missing / empty workspace ids ⇒ MALFORMED_POLICY_INPUT.
 */
export function denyDirectCrossWorkspaceRaw(
  req: CrossWorkspaceRawRequest,
): PolicyDecision<{ permitted: true }> {
  const from: unknown = req?.fromWorkspaceId;
  const to: unknown = req?.toWorkspaceId;

  if (
    req == null ||
    typeof from !== "string" ||
    from === "" ||
    typeof to !== "string" ||
    to === ""
  ) {
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "cross-workspace request omits a workspace id",
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.denied",
        refs: ["ref:workspace:from:MISSING", "ref:workspace:to:MISSING"],
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "cross-workspace request malformed",
        denialCode: "MALFORMED_POLICY_INPUT",
      }),
    );
  }

  const refs: readonly string[] = [`ref:workspace:from:${from}`, `ref:workspace:to:${to}`];

  // Same-workspace: not a cross-workspace request — the hard denial does not apply.
  if (from === to) {
    return allowDecision(
      { permitted: true },
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.same_workspace",
        refs,
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "same-workspace request — not a cross-workspace retrieval",
      }),
    );
  }

  // SOLE exception: a recorded Level-3 owner-approved link. Validate structurally;
  // absent OR malformed ⇒ deny (never auto-create the link).
  const link = req.approvedLink;
  const linkValid =
    link != null &&
    link.level3 === true &&
    typeof link.recordedApprovalRef === "string" &&
    link.recordedApprovalRef !== "";

  if (linkValid) {
    return allowDecision(
      { permitted: true },
      buildAuditSignal({
        actor: "policy",
        event: "visibility.cross_workspace_raw.permitted_via_link",
        // Record only that a link was present + recorded — never the raw approval ref.
        refs: [...refs, "ref:approved-link:level3:recorded"],
        payloadHash: CROSS_WS_PAYLOAD_MARKER,
        beforeSummary: "cross-workspace raw retrieval not evaluated",
        afterSummary: "cross-workspace raw retrieval permitted via recorded Level-3 link",
      }),
    );
  }

  return denyDecision(
    "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
    "direct cross-workspace raw retrieval is denied absent a recorded Level-3 owner-approved link",
    buildAuditSignal({
      actor: "policy",
      event: "visibility.cross_workspace_raw.denied",
      refs,
      payloadHash: CROSS_WS_PAYLOAD_MARKER,
      beforeSummary: "cross-workspace raw retrieval not evaluated",
      afterSummary: "direct cross-workspace raw retrieval denied (no recorded Level-3 link)",
      denialCode: "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    }),
  );
}
