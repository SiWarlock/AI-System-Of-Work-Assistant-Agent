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

/**
 * A `projectionType` ⇒ permitted-`VisibilityLevel`-set DERIVATION (task 24.18 /
 * WS-1 finding F14). §5/§6 arch_gap: the full `projectionType` taxonomy is
 * unspecified upstream (see `@sow/contracts` `gcl-projection.ts`) — this map is
 * deliberately EXTENSIBLE, not exhaustive. A `projectionType` absent from it has
 * no known derivation yet, so {@link isVisibilityConsistentWithProjectionType}
 * returns `true` (no opinion) for it — the workspace-default CEILING
 * ({@link isWithinDefault}) remains its sole gate until an entry is added here.
 */
export type ProjectionTypeVisibilityTaxonomy = Readonly<Record<string, readonly VisibilityLevel[]>>;

/**
 * The production default taxonomy — EMPTY. No `projectionType` category is
 * specified upstream today (the finding's own severity reasoning: self-disclosed
 * `arch_gap`, zero concrete `ProjectionSource` implementations), so asserting any
 * real category here would be an invented classification this package has no
 * authority to make. The derivation MECHANISM below is real and tested; this
 * constant is what makes it a no-op in production until a real taxonomy lands.
 */
export const DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY: ProjectionTypeVisibilityTaxonomy = {};

/**
 * The §5/§6 derivation check: does `level` belong to the permitted set for
 * `projectionType`? A `projectionType` with NO entry in `taxonomy` has no
 * derivation opinion — returns `true` (fail-OPEN for the unknown case only,
 * matching this module's `arch_gap` convention; the ceiling check is the
 * fail-closed floor for every projectionType regardless of taxonomy coverage).
 * A `projectionType` WITH an entry is fail-closed: `level` must be a member.
 */
export function isVisibilityConsistentWithProjectionType(
  projectionType: string,
  level: VisibilityLevel,
  taxonomy: ProjectionTypeVisibilityTaxonomy = DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY,
): boolean {
  // `projectionType` is a fully open, producer-controlled string — a bare
  // `taxonomy[projectionType]` bracket lookup on a plain-object taxonomy would
  // resolve a prototype-colliding name ("constructor", "__proto__", ...) to an
  // INHERITED Object.prototype member instead of `undefined`, defeating the
  // `undefined` short-circuit below and throwing on `.includes` — never throw
  // across this boundary (§16 / this module's own fail-closed contract).
  // `Object.hasOwn` checks OWN membership only (desktop Lesson 15's family).
  if (!Object.hasOwn(taxonomy, projectionType)) return true;
  const permitted = taxonomy[projectionType];
  return permitted !== undefined && permitted.includes(level);
}

/**
 * §9.4 Global-Today drill-down gate: does a projection's visibility level permit
 * opening WORKSPACE-SCOPED RAW context from the global surface?
 *
 * ONLY `full` — the top of the lattice, the sole level that authorizes raw/full
 * exposure. Every level below (`isolated`/`coordination`/`sanitized`) is a
 * sanitized-only cross-workspace exposure, so drilling to raw would exceed what the
 * workspace authorized for the global surface; it is denied (the owner can still open
 * that workspace directly via its own scope — a within-workspace read — but the GLOBAL
 * drill is a deliberate boundary crossing and stays conservative).
 *
 * FAIL-CLOSED: the strict `=== "full"` returns false for ANY other value, including a
 * malformed/unrecognized one — never permits raw on a bad input. Shared by the worker
 * UI-safe projector (the `drillable` affordance HINT) AND the worker drill-down query
 * (the ENFORCEMENT) so the hint can never diverge from the gate.
 */
export function permitsRawDrillDown(level: VisibilityLevel): boolean {
  return level === "full";
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
  taxonomy: ProjectionTypeVisibilityTaxonomy = DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY,
): PolicyDecision<GclProjection> {
  const wsId: unknown = projection?.workspaceId;
  const level: unknown = projection?.visibilityLevel;
  // ⛔ VALIDATE BEFORE INTERPOLATING (task 24.45, safety rules 4 + 7). `wsId` is the
  // CANDIDATE's own, still-unvalidated claim, and the mismatch branch below fires
  // PRECISELY when it is foreign — so interpolating it here would write untrusted
  // candidate data into the audit of the very check that exists to reject it.
  // `isRedactionSafe` cannot catch that: a workspace id (an employer project codename,
  // a person's name) is not credential-shaped — `contracts L5`. Mirrors the closed-set
  // discipline the visibility ref below already applies.
  //
  // Affects THREE deny branches, each of which previously emitted the raw candidate
  // value: "omits workspaceId" (its empty-string sub-case), "omits visibilityLevel",
  // and the mismatch itself. The allow / exceeds-source / type-mismatch paths run only
  // AFTER the equality check, so their ref is byte-identical to before.
  //
  // ⚠ `srcId` is read ONCE and reused by both this ref and the equality test below. A
  // second read could disagree with the first (a getter-backed, Proxy-backed or lazily
  // hydrated workspace record), which would render the raw foreign id into `refs` while
  // STILL taking the mismatch branch — reinstating precisely this leak. One read makes the
  // property hold over DATA PROPERTIES — ⛔ NOT "total", which is what this line said until
  // `24.65` measured it: a throwing accessor or a Proxy `get` trap still escapes (measured on
  // `Workspace.id` and `GclProjection.workspaceId`; ⚠ `visibilityLevel`, `projectionType` and
  // `defaultVisibility` are the same shape and are neither pinned nor excluded — filed, see
  // the scoped note below). Same class as the §5 / task-9.33 accessor precedent
  // already adjudicated at `ARCHITECTURE.md:204-205` — accessor-bearing inputs to a policy
  // gate are in scope even when unreachable from a `JSON.parse`d row.
  // ⛔ 24.65 — a NULL/UNDEFINED workspace cannot throw here: `?.` yields `srcId === undefined`,
  // so the referential pin below denies before the unguarded `defaultVisibility` read. An
  // earlier comment here claimed the opposite; it was never measured. Both that guarantee and
  // the unguarded read's reachability (via a REAL workspace) are pinned in `visibility.test.ts`.
  // ⚠ SCOPED TO WHAT WAS MEASURED — null and undefined ONLY. `?.` guards a nullish LEFT side,
  // NOT a throwing getter: a workspace whose `id` getter throws still throws here, as does a
  // projection whose `workspaceId` getter throws. Both measured (`24.65`) and filed — §16
  // never-throw does NOT hold for hostile accessor shapes.
  // ⛔ RESIDUAL, stated so it cannot decay (`contracts L100`): on the equality branch this ref
  // still renders the RAW `srcId`. That is trusted PROVENANCE (config-sourced via
  // `workspaceConfig`), NOT validated SHAPE — a credential-shaped id in the workspace
  // config still reaches the audit. ⇒ ⛔ ONE residual, TWO sites (`24.65`): the sibling is
  // `denyDirectCrossWorkspaceRaw`'s `from`/`to` interpolation below, which carries the full
  // lead ruling. **Closing one site does NOT shut the class.** Remedy filed as `#54`.
  const srcId: unknown = sourceWorkspace?.id;
  const refs: readonly string[] = [
    `ref:workspace:${
      typeof wsId !== "string" || wsId === "" ? "MISSING" : wsId === srcId ? wsId : "UNVALIDATED"
    }`,
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
  // Referential pin: a projection must name its own source workspace. Uses the SAME
  // single read as the audit ref above (24.45) — see the note there.
  if (wsId !== srcId) {
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

  // §5/§6 DERIVATION check (task 24.18 / WS-1 finding F14) — a SEPARATE,
  // INDEPENDENT gate alongside the ceiling check above, not a replacement for
  // it: a ceiling breach still denies even when the type/level pair is
  // consistent (the check above), and a type/level mismatch still denies here
  // even when the ceiling would have permitted the declared level. Raising
  // `sourceWorkspace.defaultVisibility` can never retroactively validate a
  // mismatched declaration — this check does not consult the ceiling at all.
  if (!isVisibilityConsistentWithProjectionType(projection.projectionType, level, taxonomy)) {
    return denyDecision(
      "VISIBILITY_TYPE_MISMATCH",
      "projection visibility level is not permitted for its projectionType",
      buildAuditSignal({
        actor: "policy",
        event: "visibility.projection.denied",
        refs,
        payloadHash: VISIBILITY_PAYLOAD_MARKER,
        beforeSummary: "projection visibility not validated",
        afterSummary: "projection level not permitted for its projectionType",
        denialCode: "VISIBILITY_TYPE_MISMATCH",
      }),
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

  // ⛔ RESIDUAL — the SAME one `24.45` recorded, SECOND SITE, not a second accepted risk
  // (`24.65`). `from`/`to` render RAW below after only a typeof/non-empty check, so a
  // credential-shaped workspace id reaches the audit. This is **`contracts L147`** — trusted
  // PROVENANCE is not validated SHAPE. The sibling site is the `srcId` interpolation in
  // `validateProjectionVisibility`, which points back here: ⛔ **closing one does NOT shut
  // the class.**
  // ⛔ NO FIX HERE — lead ruling (option D): `24.45`'s remedy is REFERENTIAL, interpolating
  // only a value proven equal to a trusted counterpart in scope. This function receives ONLY
  // `req`, so `from` and `to` are BOTH caller-supplied and no counterpart exists to prove
  // anything against. Reusing that sentinel without the validation that earns it would be a
  // weaker second spelling of a control `24.45` proved insufficient ⇒ false assurance, which
  // costs more than a documented gap: a documented gap gets re-checked, a control nobody
  // knows is weak does not.
  // ⭐ THE ACTUAL REMEDY — pass a trusted counterpart in so the referential check can apply —
  // is tracked as session task `#54`. Recorded rather than merely accepted, because an
  // accepted residual with no filed remedy becomes permanent: the acceptance is otherwise the
  // last thing anyone writes about it. ⚠ `#54` is a SESSION-SCOPED id (`contracts L51`) and
  // the id space is reused across sessions — a durable `IMPLEMENTATION_PLAN.md` entry is owed
  // and flagged; cite that once it exists rather than this number.
  // ⚠ Reachability MEASURED 2026-08-13 — and stated as REACHABILITY, not as "no caller",
  // because it HAS two production callers: `← guardCrossWorkspaceRawRead`
  // (`packages/knowledge/src/gcl/visibility-gate.ts:255`) `← CrossWorkspaceLinkMap`'s
  // `authorizeCrossWorkspaceRawRead` (`packages/knowledge/src/gcl/cross-workspace-links.ts:237`)
  // `← NOTHING`. ⛔ NOT production-REACHABLE from any entry point — but BOTH hops are exported
  // from `@sow/knowledge`'s public barrel, so a SINGLE import makes this live with fully
  // caller-supplied values, with `CrossWorkspaceLinkMap` never constructed. ⇒ the dormancy
  // this residual was accepted under is ONE IMPORT away from ending, and that is NOT the
  // condition the acceptance was argued on.
  // ⚠ The four `packages/workflows/src` appearances are COMMENTS, not calls
  // (`contracts L104`, use-vs-mention; filed as `#53`).
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
