// spec(§6) — GCL Visibility Gate: single cross-workspace read path; sanitized,
// visibility-validated GclProjections; raw-content / over-visibility HARD reject
// (never downgrade-and-store); direct cross-workspace raw retrieval denied (WS-8).
import { describe, it, expect } from "vitest";
import { defaultWorkspace, type GclProjection, type Workspace } from "@sow/contracts";
import type { ProjectionTypeVisibilityTaxonomy, DenialReason } from "@sow/policy";
import {
  admitProjection,
  guardCrossWorkspaceRawRead,
  denialToGateError,
  denialToCrossWorkspaceRawDenial,
  auditOf,
} from "../src/gcl/visibility-gate";

// A workspace whose default visibility admits `coordination`-level projections.
function wsWithDefault(level: Workspace["defaultVisibility"]): Workspace {
  return defaultWorkspace({
    id: "ws-001",
    name: "Acme",
    type: "personal_business",
    markdownRepoPath: "/vault/acme",
    gbrainBrainId: "brain-acme",
    defaultVisibility: level,
  });
}

const validCandidate: GclProjection = {
  workspaceId: "ws-001" as GclProjection["workspaceId"],
  visibilityLevel: "coordination",
  projectionType: "calendar_busy",
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
};

describe("admitProjection — composed candidate-data gate + visibility validation", () => {
  it("admits a sanitized projection within the source default visibility", () => {
    const r = admitProjection(validCandidate, wsWithDefault("sanitized"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Echoes the projection unchanged — the gate never mutates it.
      expect(r.value).toEqual(validCandidate);
    }
  });

  it("HARD-rejects a projection carrying a raw-content-shaped key (no downgrade-and-store)", () => {
    const rawBearing = {
      ...validCandidate,
      sanitizedPayload: { body: "raw employer transcript text" },
    };
    const r = admitProjection(rawBearing, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("raw_content_present");
    }
  });

  it("HARD-rejects a projection whose visibility exceeds the source default (never downgraded)", () => {
    // projection declares `coordination`; source default is the most-restrictive `isolated`.
    const r = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("visibility_exceeds_source");
      if (r.error.code === "visibility_exceeds_source") {
        expect(r.error.declaredLevel).toBe("coordination");
        expect(r.error.sourceDefault).toBe("isolated");
      }
    }
  });

  // task 24.33 (spec §5, §16, safety rule 4): validateProjectionVisibility's PolicyDecision
  // carries a mandatory AuditSignal on every deny — admitProjection built it and dropped it.
  // Pinned through the REAL entry point (not denialToGateError directly) because the defect
  // is specifically that the real call site never threaded decision.audit through.
  it("admit_projection_deny_carries_its_audit_signal: a real policy-decision denial's AuditSignal survives to the caller instead of being dropped", () => {
    const r = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok && "audit" in r.error) {
      expect(r.error.audit).toBeDefined();
      expect(r.error.audit?.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
      // redaction-safe by construction (policy-authored refs/codes only) — sanity, not the gate itself.
      expect(r.error.audit?.refs.length).toBeGreaterThan(0);
    } else {
      expect.fail("expected a policy-decision deny variant carrying an audit field");
    }
  });

  // task 24.33 (code-quality review) — the negative control: auditOf's "no audit" branch
  // (schema_rejected / raw_content_present) is the one this function most needs pinned, since
  // its whole job is discriminating "has audit" from "doesn't."
  it("auditOf returns undefined for the two variants that never carry a PolicyDecision (schema_rejected, raw_content_present)", () => {
    const rawBearing = { ...validCandidate, sanitizedPayload: { body: "raw employer transcript text" } };
    const rawResult = admitProjection(rawBearing, wsWithDefault("full"));
    expect(rawResult.ok).toBe(false);
    if (!rawResult.ok) {
      expect(rawResult.error.code).toBe("raw_content_present");
      expect(auditOf(rawResult.error)).toBeUndefined();
    }

    const extra = { ...validCandidate, smuggled: "x" };
    const schemaResult = admitProjection(extra, wsWithDefault("full"));
    expect(schemaResult.ok).toBe(false);
    if (!schemaResult.ok) {
      expect(schemaResult.error.code).toBe("schema_rejected");
      expect(auditOf(schemaResult.error)).toBeUndefined();
    }
  });

  it("rejects at the ajv stage when a top-level unknown field rides the candidate", () => {
    const extra = { ...validCandidate, smuggled: "x" };
    const r = admitProjection(extra, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("schema_rejected");
      if (r.error.code === "schema_rejected") expect(r.error.stage).toBe("ajv");
    }
  });

  it("rejects when visibilityLevel is missing (schema gate)", () => {
    const { visibilityLevel: _drop, ...noVis } = validCandidate;
    void _drop;
    const r = admitProjection(noVis, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("schema_rejected");
  });

  it("rejects when the projection names a different workspace than the source (malformed policy input)", () => {
    const foreign = { ...validCandidate, workspaceId: "ws-999" as GclProjection["workspaceId"] };
    const r = admitProjection(foreign, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_policy_input");
  });

  // task 24.18 (WS-1/F14): an INJECTED taxonomy wires the projectionType
  // derivation through the real gate entry point — production's default taxonomy
  // is empty (arch_gap), so these tests inject one to prove the mapping is real,
  // not merely declared.
  it("HARD-rejects a projection whose visibility level is inconsistent with its projectionType's derivation, even when the workspace ceiling would permit it (task 24.18)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    // validCandidate declares "coordination" for projectionType "calendar_busy";
    // the "full" ceiling would permit it, but the taxonomy caps calendar_busy at
    // "isolated" — the derivation check must independently deny.
    const r = admitProjection(validCandidate, wsWithDefault("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("visibility_type_mismatch");
      if (r.error.code === "visibility_type_mismatch") {
        expect(r.error.declaredLevel).toBe("coordination");
        expect(r.error.projectionType).toBe("calendar_busy");
      }
    }
  });

  it("an injected taxonomy that does not cover this candidate's projectionType leaves the ceiling as the sole gate (no regression)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { "some-other-type": ["isolated"] };
    const r = admitProjection(validCandidate, wsWithDefault("sanitized"), undefined, taxonomy);
    expect(r.ok).toBe(true);
  });
});

// task 24.36 (L134, third instance): admitProjection's DenialReason narrowing was
// an un-guarded if/if/trailing-return — any DenialReason other than the two
// explicit checks silently fell into "malformed_policy_input", contradicting its
// own adjacent comment ("never a default:/trailing-else absorb... avoided here on
// purpose"). Tests target the extracted `denialToGateError` directly (mirroring
// 24.30's `gateReason` extraction) so every one of DenialReason's 12 members is
// exercisable, not only the 3 validateProjectionVisibility can actually emit.
describe("denialToGateError — exhaustive over DenialReason (task 24.36 / L134)", () => {
  it("admit_projection_visibility_exceeds_source_unchanged: VISIBILITY_EXCEEDS_SOURCE maps byte-identically to before", () => {
    const r = denialToGateError("VISIBILITY_EXCEEDS_SOURCE", "exceeds", validCandidate, wsWithDefault("isolated"));
    expect(r).toEqual({
      code: "visibility_exceeds_source",
      declaredLevel: "coordination",
      sourceDefault: "isolated",
      message: "exceeds",
    });
  });

  it("admit_projection_visibility_type_mismatch_unchanged: VISIBILITY_TYPE_MISMATCH maps byte-identically to before", () => {
    const r = denialToGateError("VISIBILITY_TYPE_MISMATCH", "mismatch", validCandidate, wsWithDefault("isolated"));
    expect(r).toEqual({
      code: "visibility_type_mismatch",
      declaredLevel: "coordination",
      projectionType: "calendar_busy",
      message: "mismatch",
    });
  });

  it("admit_projection_malformed_policy_input_still_explicit: MALFORMED_POLICY_INPUT, and every other DenialReason validateProjectionVisibility can never emit, still maps to malformed_policy_input", () => {
    const ws = wsWithDefault("isolated");
    // MALFORMED_POLICY_INPUT: the one this function's real caller actually emits.
    expect(denialToGateError("MALFORMED_POLICY_INPUT", "bad input", validCandidate, ws)).toEqual({
      code: "malformed_policy_input",
      message: "bad input",
    });
    // The other 9 members are genuinely impossible from validateProjectionVisibility
    // (verified by reading its full body) but must still map explicitly, not via a
    // trailing fallthrough — fail-closed to the same reason, per FAIL_CLOSED_DENIAL.
    const impossibleButExhaustivelyHandled: readonly DenialReason[] = [
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
      "UNTRUSTED_CONTENT_MUTATING_TOOL",
      "WRITE_ADAPTER_OUTSIDE_GATEWAY",
      "PROVIDER_NOT_ALLOWED",
      "NO_ROUTE_FOR_CAPABILITY",
      "PROCESSOR_NOT_ALLOWED",
      "LOCAL_ENDPOINT_NOT_CONFIGURED",
      "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
      "APPROVAL_REQUIRED",
      "AUTH_TOKEN_INVALID",
      "ORIGIN_NOT_ALLOWED",
    ];
    for (const reason of impossibleButExhaustivelyHandled) {
      expect(denialToGateError(reason, "n/a", validCandidate, ws)).toEqual({
        code: "malformed_policy_input",
        message: "n/a",
      });
    }
  });

  // admitProjection's own OBSERVABLE behavior is unchanged by the extraction —
  // pinned end-to-end through the real function, not just the extracted helper.
  it("admitProjection's own output is byte-identical after the extraction, for both real deny reasons", () => {
    const exceeds = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(exceeds.ok).toBe(false);
    if (!exceeds.ok) expect(exceeds.error.code).toBe("visibility_exceeds_source");

    const foreign = { ...validCandidate, workspaceId: "ws-999" as GclProjection["workspaceId"] };
    const malformed = admitProjection(foreign, wsWithDefault("full"));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("malformed_policy_input");
  });
});

describe("guardCrossWorkspaceRawRead — the direct cross-brain raw-retrieval denial (WS-8)", () => {
  it("denies a direct cross-workspace raw retrieval with no approved link", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("permits a same-workspace read (not a cross-workspace request)", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-a" });
    expect(r.ok).toBe(true);
  });

  it("permits raw retrieval only via a recorded Level-3 owner-approved link", () => {
    const r = guardCrossWorkspaceRawRead({
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      approvedLink: { level3: true, recordedApprovalRef: "appr-777" },
    });
    expect(r.ok).toBe(true);
  });

  it("fail-closed: denies on malformed (empty) workspace ids", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "", toWorkspaceId: "ws-b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_policy_input");
  });
});

// task 24.38 (L134, fourth instance): guardCrossWorkspaceRawRead's narrowing was
// the SAME un-guarded shape 24.36 just fixed one function above in this file —
// one explicit check against DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL, then a
// trailing return absorbing the other 14 members into malformed_policy_input.
// Mirrors 24.36's denialToGateError extraction for the identical reason:
// denyDirectCrossWorkspaceRaw can only ever emit 2 of the 15 members, so the
// other 13 are otherwise untestable end-to-end.
describe("denialToCrossWorkspaceRawDenial — exhaustive over DenialReason (task 24.38 / L134)", () => {
  it("guard_cross_workspace_raw_read_direct_retrieval_unchanged: DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL maps byte-identically to before", () => {
    expect(denialToCrossWorkspaceRawDenial("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL", "denied")).toEqual({
      code: "direct_cross_workspace_raw_denied",
      message: "denied",
    });
  });

  it("guard_cross_workspace_raw_read_malformed_input_unchanged: MALFORMED_POLICY_INPUT maps byte-identically to before", () => {
    expect(denialToCrossWorkspaceRawDenial("MALFORMED_POLICY_INPUT", "bad input")).toEqual({
      code: "malformed_policy_input",
      message: "bad input",
    });
  });

  // Honesty note (matching 24.36's own): a grouped case-list and a trailing
  // fallthrough are output-identical by construction for every one of these —
  // this is a genuine regression pin, not proof of the structural
  // exhaustiveness property (that's the empirical removal-test below).
  it("guard_cross_workspace_raw_read_non_emittable_reasons_fail_closed: every other DenialReason still maps to malformed_policy_input", () => {
    const nonEmittable: readonly DenialReason[] = [
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "UNTRUSTED_CONTENT_MUTATING_TOOL",
      "WRITE_ADAPTER_OUTSIDE_GATEWAY",
      "PROVIDER_NOT_ALLOWED",
      "NO_ROUTE_FOR_CAPABILITY",
      "PROCESSOR_NOT_ALLOWED",
      "LOCAL_ENDPOINT_NOT_CONFIGURED",
      "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
      "VISIBILITY_EXCEEDS_SOURCE",
      "VISIBILITY_TYPE_MISMATCH",
      "APPROVAL_REQUIRED",
      "AUTH_TOKEN_INVALID",
      "ORIGIN_NOT_ALLOWED",
    ];
    for (const reason of nonEmittable) {
      expect(denialToCrossWorkspaceRawDenial(reason, "n/a")).toEqual({
        code: "malformed_policy_input",
        message: "n/a",
      });
    }
  });

  // guardCrossWorkspaceRawRead's own OBSERVABLE behavior is unchanged by the
  // extraction — pinned end-to-end, not just via the extracted helper.
  it("guardCrossWorkspaceRawRead's own output is byte-identical after the extraction", () => {
    const denied = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("direct_cross_workspace_raw_denied");

    const malformed = guardCrossWorkspaceRawRead({ fromWorkspaceId: "", toWorkspaceId: "ws-b" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("malformed_policy_input");
  });
});
