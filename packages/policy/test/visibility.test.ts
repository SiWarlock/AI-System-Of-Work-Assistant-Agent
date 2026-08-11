// spec(§5) — visibility levels: rank ordering; within-default predicate; projection
// visibility validation (fail-closed MALFORMED + VISIBILITY_EXCEEDS_SOURCE); hard
// denial #2 — direct cross-workspace/cross-brain RAW retrieval DENY (REQ-F-005/F-020).
import { describe, it, expect } from "vitest";
import {
  defaultWorkspace,
  type GclProjection,
  type Workspace,
  type VisibilityLevel,
} from "@sow/contracts";
import {
  visibilityRank,
  isWithinDefault,
  validateProjectionVisibility,
  denyDirectCrossWorkspaceRaw,
  permitsRawDrillDown,
  isVisibilityConsistentWithProjectionType,
  DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY,
  type ProjectionTypeVisibilityTaxonomy,
} from "../src/visibility";
import { isRedactionSafe } from "../src/audit-signal";

type Vis = "isolated" | "coordination" | "sanitized" | "full";

function wsWithDefault(vis: Vis): Workspace {
  return defaultWorkspace({
    id: "ws-1",
    name: "WS",
    type: "personal_business",
    markdownRepoPath: "/repos/ws1",
    gbrainBrainId: "brain-1",
    defaultVisibility: vis,
  });
}

function projection(workspaceId: string, visibilityLevel: string): GclProjection {
  return {
    workspaceId,
    visibilityLevel,
    projectionType: "summary",
    sanitizedPayload: {},
    sourceRefs: [],
  } as unknown as GclProjection;
}

describe("visibilityRank", () => {
  it("orders isolated(0) < coordination(1) < sanitized(2) < full(3)", () => {
    expect(visibilityRank("isolated")).toBe(0);
    expect(visibilityRank("coordination")).toBe(1);
    expect(visibilityRank("sanitized")).toBe(2);
    expect(visibilityRank("full")).toBe(3);
    expect(visibilityRank("isolated")).toBeLessThan(visibilityRank("coordination"));
    expect(visibilityRank("coordination")).toBeLessThan(visibilityRank("sanitized"));
    expect(visibilityRank("sanitized")).toBeLessThan(visibilityRank("full"));
  });
});

describe("isWithinDefault", () => {
  it("true when projection level ≤ workspace default", () => {
    expect(isWithinDefault("coordination", "sanitized")).toBe(true);
    expect(isWithinDefault("sanitized", "sanitized")).toBe(true);
    expect(isWithinDefault("isolated", "full")).toBe(true);
  });
  it("false when projection level exceeds the workspace default", () => {
    expect(isWithinDefault("full", "sanitized")).toBe(false);
    expect(isWithinDefault("coordination", "isolated")).toBe(false);
  });
});

// task 24.18 (WS-1/F14): a projectionType-derived visibility check, independent
// of the workspace-default CEILING — a producer's self-declared visibilityLevel
// was previously only ever bounded, never derived from what its projectionType
// actually is.
describe("isVisibilityConsistentWithProjectionType — the projectionType derivation (task 24.18)", () => {
  const taxonomy: ProjectionTypeVisibilityTaxonomy = {
    "isolated-only-type": ["isolated"],
    "coordination-and-below": ["isolated", "coordination"],
  };

  it("true when the declared level is in the projectionType's permitted set [spec(§5)]", () => {
    expect(isVisibilityConsistentWithProjectionType("isolated-only-type", "isolated", taxonomy)).toBe(true);
    expect(isVisibilityConsistentWithProjectionType("coordination-and-below", "coordination", taxonomy)).toBe(true);
  });

  it("false when the declared level is NOT in the projectionType's permitted set [spec(§5)]", () => {
    expect(isVisibilityConsistentWithProjectionType("isolated-only-type", "full", taxonomy)).toBe(false);
    expect(isVisibilityConsistentWithProjectionType("coordination-and-below", "sanitized", taxonomy)).toBe(false);
  });

  it("true (no derivation opinion) for a projectionType absent from the taxonomy — the ceiling remains the sole gate for it [spec(§5)]", () => {
    expect(isVisibilityConsistentWithProjectionType("untracked-type", "full", taxonomy)).toBe(true);
  });

  it("the production default taxonomy is empty — arch_gap, no real projectionType taxonomy is specified upstream yet [spec(§5)]", () => {
    expect(DEFAULT_PROJECTION_TYPE_VISIBILITY_TAXONOMY).toEqual({});
    // Confirms the default PARAMETER is genuinely this constant (a no-op today),
    // not a copy that could silently drift from it.
    expect(isVisibilityConsistentWithProjectionType("anything", "full")).toBe(true);
  });

  // security-reviewer (24.18 Step 8): `projectionType` is a fully open,
  // producer-controlled string (no format constraint) bracket-indexed into a
  // plain-object taxonomy. A prototype-colliding name resolves to an INHERITED
  // Object.prototype member instead of `undefined`, silently skipping the
  // `permitted === undefined` short-circuit — never throw across this boundary
  // (§16 / admitProjection's own "never throws" contract). Reproduces even
  // against the EMPTY default taxonomy, so this is live today, not
  // taxonomy-population-gated.
  it("does not throw for a prototype-colliding projectionType — never throws across the boundary (§16) [spec(§5)]", () => {
    const collidingNames = [
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ];
    for (const name of collidingNames) {
      expect(() => isVisibilityConsistentWithProjectionType(name, "full")).not.toThrow();
      // No taxonomy entry actually exists for any of these — true own-property
      // absence reads as "no derivation opinion" (true), same as any other
      // untracked projectionType.
      expect(isVisibilityConsistentWithProjectionType(name, "full")).toBe(true);
    }
  });
});

describe("validateProjectionVisibility", () => {
  it("allows a projection within the workspace default (audit redaction-safe)", () => {
    const w = wsWithDefault("sanitized");
    const p = projection("ws-1", "coordination");
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") {
      expect(d.value).toBe(p);
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("does not deny the sanitized projection cross-workspace read path", () => {
    const w = wsWithDefault("full");
    const p = projection("ws-1", "sanitized");
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("allow");
  });

  it("denies MALFORMED_POLICY_INPUT when visibilityLevel is omitted", () => {
    const w = wsWithDefault("full");
    const p = {
      workspaceId: "ws-1",
      projectionType: "summary",
      sanitizedPayload: {},
      sourceRefs: [],
    } as unknown as GclProjection;
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies MALFORMED_POLICY_INPUT when workspaceId is omitted", () => {
    const w = wsWithDefault("full");
    const p = {
      visibilityLevel: "isolated",
      projectionType: "summary",
      sanitizedPayload: {},
      sourceRefs: [],
    } as unknown as GclProjection;
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies MALFORMED_POLICY_INPUT when projection.workspaceId !== sourceWorkspace.id", () => {
    const w = wsWithDefault("full");
    const p = projection("ws-OTHER", "isolated");
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies VISIBILITY_EXCEEDS_SOURCE when the level exceeds the workspace default", () => {
    const w = wsWithDefault("coordination");
    const p = projection("ws-1", "full");
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("denies VISIBILITY_EXCEEDS_SOURCE when the level falls outside the closed set", () => {
    const w = wsWithDefault("full");
    const p = projection("ws-1", "public");
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
  });

  // task 24.18 (WS-1/F14): the projectionType DERIVATION check — a separate,
  // independent gate alongside the ceiling check above, not a replacement.
  describe("the projectionType derivation check (task 24.18)", () => {
    const isolatedOnly: ProjectionTypeVisibilityTaxonomy = { "isolated-only-type": ["isolated"] };
    const coordAndBelow: ProjectionTypeVisibilityTaxonomy = {
      "coordination-and-below": ["isolated", "coordination"],
    };

    it("projection_visibility_matches_declared_type: allows when the declared level is permitted by the projectionType's taxonomy [spec(§5)]", () => {
      const w = wsWithDefault("full"); // ceiling would allow anything up to full
      const p = { ...projection("ws-1", "isolated"), projectionType: "isolated-only-type" } as GclProjection;
      const d = validateProjectionVisibility(p, w, isolatedOnly);
      expect(d.decision).toBe("allow");
    });

    it("projection_visibility_mismatched_type_rejected: denies VISIBILITY_TYPE_MISMATCH even when the workspace ceiling would have permitted the declared level [spec(§5)(§6)]", () => {
      const w = wsWithDefault("full"); // ceiling permits `full`
      const p = { ...projection("ws-1", "full"), projectionType: "isolated-only-type" } as GclProjection;
      const d = validateProjectionVisibility(p, w, isolatedOnly);
      expect(d.decision).toBe("deny");
      if (d.decision === "deny") {
        expect(d.reason).toBe("VISIBILITY_TYPE_MISMATCH");
        expect(isRedactionSafe(d.audit)).toBe(true);
      }
    });

    it("ceiling_check_still_applies_independently: a correctly-derived level is still denied VISIBILITY_EXCEEDS_SOURCE when it exceeds the workspace ceiling [spec(§5)]", () => {
      const w = wsWithDefault("isolated"); // ceiling permits only isolated
      const p = { ...projection("ws-1", "coordination"), projectionType: "coordination-and-below" } as GclProjection;
      const d = validateProjectionVisibility(p, w, coordAndBelow);
      expect(d.decision).toBe("deny");
      if (d.decision === "deny") expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
    });

    it("raising_workspace_ceiling_does_not_retroactively_validate_a_mismatched_declaration: the mismatch denial holds at both a narrow AND a widened workspace default [spec(§5)]", () => {
      const p = { ...projection("ws-1", "sanitized"), projectionType: "isolated-only-type" } as GclProjection;
      const narrow = validateProjectionVisibility(p, wsWithDefault("sanitized"), isolatedOnly);
      const widened = validateProjectionVisibility(p, wsWithDefault("full"), isolatedOnly);
      expect(narrow.decision).toBe("deny");
      expect(widened.decision).toBe("deny");
      if (narrow.decision === "deny") expect(narrow.reason).toBe("VISIBILITY_TYPE_MISMATCH");
      if (widened.decision === "deny") expect(widened.reason).toBe("VISIBILITY_TYPE_MISMATCH");
    });

    it("a projectionType absent from the injected taxonomy is unaffected — the ceiling remains its sole gate (no regression for untracked types) [spec(§5)]", () => {
      const w = wsWithDefault("sanitized");
      const p = { ...projection("ws-1", "coordination"), projectionType: "untracked-type" } as GclProjection;
      const d = validateProjectionVisibility(p, w, isolatedOnly);
      expect(d.decision).toBe("allow");
    });
  });
});

describe("denyDirectCrossWorkspaceRaw (hard denial #2)", () => {
  it("denies DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL for cross-ws raw with no approvedLink", () => {
    const d = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b" });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("permits cross-ws raw ONLY with a recorded Level-3 approved link", () => {
    const d = denyDirectCrossWorkspaceRaw({
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      approvedLink: { level3: true, recordedApprovalRef: "approval-7" },
    });
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") {
      expect(d.value.permitted).toBe(true);
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("treats same-workspace (from===to) as not-a-cross-workspace request → permitted", () => {
    const d = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-a" });
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") expect(d.value.permitted).toBe(true);
  });

  it("fail-closed MALFORMED_POLICY_INPUT on missing / empty workspace ids", () => {
    const d = denyDirectCrossWorkspaceRaw({ fromWorkspaceId: "", toWorkspaceId: "ws-b" });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("denies (never auto-creates the link) when approvedLink is present but recordedApprovalRef is empty", () => {
    const d = denyDirectCrossWorkspaceRaw({
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      approvedLink: { level3: true, recordedApprovalRef: "" },
    });
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL");
  });
});

// The §9.4 Global-Today drill-down gate: whether a projection's visibility level
// permits opening WORKSPACE-SCOPED RAW context. Only `full` (the top of the lattice —
// the sole level authorizing raw/full exposure) permits it; everything below is a
// sanitized-only cross-workspace exposure, so a raw drill-down is denied. FAIL-CLOSED
// on any unrecognized value. Shared by the worker projector (affordance hint) AND the
// worker drill-down query (enforcement) so the hint can never diverge from the gate.
describe("permitsRawDrillDown", () => {
  it("permits a raw drill-down ONLY at 'full'", () => {
    expect(permitsRawDrillDown("full")).toBe(true);
  });

  it("DENIES a raw drill-down at every level below full", () => {
    expect(permitsRawDrillDown("isolated")).toBe(false);
    expect(permitsRawDrillDown("coordination")).toBe(false);
    expect(permitsRawDrillDown("sanitized")).toBe(false);
  });

  it("fails closed on an unrecognized / malformed level (never permits raw)", () => {
    expect(permitsRawDrillDown("not-a-level" as unknown as VisibilityLevel)).toBe(false);
    expect(permitsRawDrillDown(undefined as unknown as VisibilityLevel)).toBe(false);
    expect(permitsRawDrillDown("" as unknown as VisibilityLevel)).toBe(false);
  });
});
