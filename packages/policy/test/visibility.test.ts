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

// task 24.45 — the MALFORMED_POLICY_INPUT path embedded the candidate's OWN,
// UNVALIDATED workspaceId into audit.refs. `refs` is built at the top of the
// function, BEFORE any validation; the mismatch branch ("projection workspaceId
// does not match source workspace") fires precisely when that value is FOREIGN —
// so by the time the denial is constructed, the foreign value is already in the
// audit. Safety rules 4 (workspace isolation) + 7 (redaction).
//
// ⚠ not-tested-because: the READ path (`serveProjection`) cannot be driven from
// packages/policy — it lives in packages/knowledge, outside this track's territory.
// Coverage there is STRUCTURAL rather than asserted, and the structure is the
// argument: `serveProjection` and `admitAndPersistProjection` BOTH call
// `admitProjection`, which calls `validateProjectionVisibility` — the single
// chokepoint these tests pin. A fix here therefore covers both reach paths by
// construction, not by luck. Traced 2026-08-13 by SYMBOL, not line number (a
// cross-package line citation rots on the other track's first edit):
// `admitAndPersistProjection` and `serveProjection` (packages/knowledge/src/gcl/
// projection.ts) → `admitProjection` → `validateProjectionVisibility`.
describe("validateProjectionVisibility — audit refs never carry an unvalidated workspaceId (task 24.45)", () => {
  // Sensitive but NOT credential-shaped: no key prefix, no sensitive keyword, no
  // URL userinfo ⇒ it passes all three isRedactionSafe regexes. That is the whole
  // point — the heuristic structurally cannot be the defense here.
  const FOREIGN_SENSITIVE_WS_ID = "ws-employer-projectatlas-acquisition";

  it("visibility_malformed_denial_does_not_leak_unvalidated_workspace_id: a FOREIGN workspaceId never reaches audit.refs verbatim [spec(§5)]", () => {
    const w = wsWithDefault("full");
    const d = validateProjectionVisibility(projection(FOREIGN_SENSITIVE_WS_ID, "isolated"), w);

    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      // ⚠ `reason` does NOT discriminate — MALFORMED_POLICY_INPUT is shared by five
      // branches. `message` is what pins the mismatch branch specifically.
      expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
      expect(d.message).toBe("projection workspaceId does not match source workspace");
      // Pin the emitted shape, not merely the absence: `not.toContain` alone would
      // also pass if the ref were deleted, hashed or truncated.
      expect(d.audit.refs).toEqual(["ref:workspace:UNVALIDATED", "ref:visibility:isolated"]);
      expect(d.audit.refs.join("|")).not.toContain(FOREIGN_SENSITIVE_WS_ID);
    }
  });

  it("a foreign workspaceId is withheld on the omits-visibilityLevel branch too [spec(§5)]", () => {
    const w = wsWithDefault("full");
    const p = {
      workspaceId: FOREIGN_SENSITIVE_WS_ID,
      projectionType: "summary",
      sanitizedPayload: {},
      sourceRefs: [],
    } as unknown as GclProjection;
    const d = validateProjectionVisibility(p, w);
    // A SECOND leak the same expression plugs — pinned so a refactor can't regress it
    // silently while the mismatch test stays green.
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.message).toBe("projection omits visibilityLevel");
      expect(d.audit.refs).toEqual(["ref:workspace:UNVALIDATED", "ref:visibility:UNRECOGNIZED"]);
    }
  });

  it("the withheld value is NOT credential-shaped, so isRedactionSafe passes either way — the gate cannot catch this [spec(§16)]", () => {
    const w = wsWithDefault("full");
    const d = validateProjectionVisibility(projection(FOREIGN_SENSITIVE_WS_ID, "isolated"), w);
    // GREEN before and after the fix. This is the characterization that justifies
    // fixing the PRODUCER rather than tightening the heuristic (route (a) rejected
    // — it would invert secret-scan.ts's contentContainsSecret repo-wide).
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(isRedactionSafe(d.audit)).toBe(true);
  });

  // The over-tight-fix controls (`L80`). Both post-equality paths are pinned, not just
  // one — the branches execute only AFTER `wsId === srcId`, so their refs must be
  // byte-identical to pre-fix. These are what fail if the fix over-reaches.
  it("visibility_allow_path_refs_are_byte_identical: the ALLOW path still names its validated workspace [spec(§5)]", () => {
    const w = wsWithDefault("full");
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), w);
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") {
      expect(d.audit.refs).toEqual(["ref:workspace:ws-1", "ref:visibility:isolated"]);
    }
  });

  it("the EXCEEDS-SOURCE path also still names its validated workspace [spec(§5)]", () => {
    const w = wsWithDefault("isolated");
    const d = validateProjectionVisibility(projection("ws-1", "full"), w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
      expect(d.audit.refs).toEqual(["ref:workspace:ws-1", "ref:visibility:full"]);
    }
  });

  it("an absent workspaceId still reports MISSING — the pre-existing sentinel is preserved [spec(§5)]", () => {
    const w = wsWithDefault("full");
    const p = {
      visibilityLevel: "isolated",
      projectionType: "summary",
      sanitizedPayload: {},
      sourceRefs: [],
    } as unknown as GclProjection;
    const d = validateProjectionVisibility(p, w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.audit.refs).toContain("ref:workspace:MISSING");
  });

  it("the source workspace id getter is NEVER invoked, so a split read cannot disagree [spec(§5)]", () => {
    // Adversarial, from security review: when the audit ref and the equality test read
    // `sourceWorkspace.id` SEPARATELY, a getter/Proxy-backed or lazily-hydrated record
    // can return the candidate's value on read 1 and the real value on read 2 — writing
    // the RAW foreign id into refs while still taking the mismatch branch.
    //
    // ⭐ MODIFIED at 24.65/#58, and the pin is STRICTLY STRONGER, not relaxed. 24.45 closed
    // this by reading ONCE (expected `reads === 1`). `readOwnData` reads the property
    // DESCRIPTOR, which never invokes an accessor at all ⇒ expected `reads === 0`. The
    // split-read attack is no longer merely prevented, it is unrepresentable — a getter that
    // is never called cannot return two values. The original intent is preserved and the
    // count moved DOWN; if this ever reads 1 again, an accessor is being invoked somewhere
    // and both 24.45's and 24.65's guarantees have regressed together.
    let reads = 0;
    const w = {
      ...wsWithDefault("full"),
      get id() {
        reads += 1;
        return reads === 1 ? FOREIGN_SENSITIVE_WS_ID : "ws-1";
      },
    } as unknown as Workspace;
    const d = validateProjectionVisibility(projection(FOREIGN_SENSITIVE_WS_ID, "isolated"), w);
    expect(reads).toBe(0);
    // Non-vacuity: `reads === 0` alone would also hold if the function did nothing. The
    // accessor-bearing workspace must still be REFUSED, and the foreign id must still be
    // withheld from the audit — 24.45's property, surviving 24.65's change.
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.audit.refs.join("|")).not.toContain(FOREIGN_SENSITIVE_WS_ID);
    }
  });

  it("an EMPTY-STRING workspaceId reports MISSING, matching its denial message [spec(§5)]", () => {
    const w = wsWithDefault("full");
    const d = validateProjectionVisibility(projection("", "isolated"), w);
    // `""` is a string, so it would otherwise fall to the UNVALIDATED arm and disagree
    // with its own denial message ("projection omits workspaceId").
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.message).toBe("projection omits workspaceId");
      expect(d.audit.refs).toContain("ref:workspace:MISSING");
    }
  });
});

// task 24.65 — §16 never-throw at this predicate's boundary.
//
// ⚠ THESE PINS ARE GREEN ON FIRST WRITE. They are NOT a TDD red-first pair and are
// recorded as such deliberately: `24.65` was filed asserting a never-throw VIOLATION here,
// and there is none. `24.45`'s `?.` on the `srcId` read makes a null/undefined workspace
// yield `srcId === undefined`, so the referential-pin branch returns a typed denial BEFORE
// the unguarded `sourceWorkspace.defaultVisibility` read is reached.
//
// ⭐ The hardening that closed it was made for an UNRELATED reason (single-read / getter-split
// defence), and the comment documenting the residual outlived the residual by one commit.
// ⇒ when you fix something, ask what it incidentally fixed.
describe("validateProjectionVisibility — §16 never-throw on a null source workspace, + the guard's real reachability (task 24.65)", () => {
  const nullWs = null as unknown as Workspace;
  const undefWs = undefined as unknown as Workspace;

  it("null_source_workspace_returns_a_typed_denial: denies, never throws [spec(§16)]", () => {
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), nullWs)).not.toThrow();
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), nullWs);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
      // The REFERENTIAL PIN catches it — not the defaultVisibility guard. Pinning the
      // message records WHICH branch provides the guarantee, so a refactor that moves the
      // guarantee elsewhere fails here rather than silently relocating it.
      expect(d.message).toBe("projection workspaceId does not match source workspace");
      expect(d.audit.refs).toContain("ref:workspace:UNVALIDATED");
    }
  });

  it("an undefined source workspace behaves identically [spec(§16)]", () => {
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), undefWs)).not.toThrow();
    // "Identically" has to be pinned as identity, not as decision+reason: `reason` cannot
    // discriminate (MALFORMED_POLICY_INPUT is shared by five branches — see the mismatch test
    // above), so a weaker assertion would pass even if `undefined` routed through a different
    // branch. `validateProjectionVisibility` is pure (clock-free signal, plain constructor),
    // so whole-decision equality is exact rather than merely convenient.
    expect(validateProjectionVisibility(projection("ws-1", "isolated"), undefWs)).toEqual(
      validateProjectionVisibility(projection("ws-1", "isolated"), nullWs),
    );
  });

  it("the defaultVisibility guard IS reachable with a REAL workspace — it is not dead code [spec(§5)]", () => {
    // `24.65` established that guard can never be reached with a NULL workspace. That is
    // exactly the shape someone deletes as unreachable three rounds later, so pin the input
    // that DOES reach it: a real workspace carrying an unrecognized level.
    const w = { ...wsWithDefault("full"), defaultVisibility: "bogus" } as unknown as Workspace;
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), w);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") {
      expect(d.message).toBe("source workspace defaultVisibility is unrecognized");
    }
  });
});

// task 24.65 / #58 — the FAIL-OPEN and the accessor-throw class, one primitive.
//
// ⛔ THE HEADLINE IS THE FAIL-OPEN, NOT THE THROWS. A throw is loud; a visibility gate
// that returns ALLOW for a malformed workspace is silent and grants access.
//
// Both hazards are prototype-chain hazards and BOTH are closed by reading only OWN DATA
// properties: an inherited property yields no own descriptor (⇒ the fail-open denies), and
// an accessor yields a descriptor with no `value` (⇒ the getter is never invoked, so it
// cannot throw). `Object.hasOwn` alone closes only the first — an own accessor passes it
// and still throws on read, which is why the sibling guard was ALSO incomplete.
describe("validateProjectionVisibility — own-data-property reads (task 24.65 / #58)", () => {
  const realWs = () => wsWithDefault("full");

  it("zero_own_property_workspace_is_denied: a prototype-only workspace must NOT return ALLOW [spec(§5)]", () => {
    // `Object.create({...})` — every field resolves through the prototype chain, so a plain
    // read sees a well-formed workspace while `Object.getOwnPropertyDescriptor` sees nothing.
    const proto = Object.create({ id: "ws-1", defaultVisibility: "full" }) as Workspace;
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), proto);
    expect(d.decision).toBe("deny");
  });

  it("the ALLOW-side control: a real workspace differing ONLY in own-vs-inherited still allows [spec(§5)]", () => {
    // `L80` — without this, the suite cannot tell a working gate from a constant DENY. The
    // fixture differs from the one above in exactly the property the fix decides on.
    const own = { id: "ws-1", defaultVisibility: "full" } as unknown as Workspace;
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), own);
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") expect(d.audit.refs).toContain("ref:workspace:ws-1");
  });

  it("a genuine defaultWorkspace() still allows — the real production producer [spec(§5)]", () => {
    const d = validateProjectionVisibility(projection("ws-1", "isolated"), realWs());
    expect(d.decision).toBe("allow");
  });

  // The six measured throw shapes, each named individually so a regression says WHICH read
  // re-opened. Every one returns a typed denial instead of throwing (§16 never-throw).
  const thrower = (): never => {
    throw new Error("hostile accessor");
  };

  it("throwing_id_getter_on_source_workspace_returns_typed_denial [spec(§16)]", () => {
    const w = { get id() { return thrower(); }, defaultVisibility: "full" } as unknown as Workspace;
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), w)).not.toThrow();
    expect(validateProjectionVisibility(projection("ws-1", "isolated"), w).decision).toBe("deny");
  });

  it("throwing_default_visibility_getter_on_source_workspace_returns_typed_denial [spec(§16)]", () => {
    const w = { id: "ws-1", get defaultVisibility() { return thrower(); } } as unknown as Workspace;
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), w)).not.toThrow();
    expect(validateProjectionVisibility(projection("ws-1", "isolated"), w).decision).toBe("deny");
  });

  it("throwing_workspace_id_getter_on_projection_returns_typed_denial [spec(§16)]", () => {
    const p = { get workspaceId() { return thrower(); }, visibilityLevel: "isolated",
      projectionType: "summary", sanitizedPayload: {}, sourceRefs: [] } as unknown as GclProjection;
    expect(() => validateProjectionVisibility(p, realWs())).not.toThrow();
    expect(validateProjectionVisibility(p, realWs()).decision).toBe("deny");
  });

  it("throwing_visibility_level_getter_on_projection_returns_typed_denial [spec(§16)]", () => {
    const p = { workspaceId: "ws-1", get visibilityLevel() { return thrower(); },
      projectionType: "summary", sanitizedPayload: {}, sourceRefs: [] } as unknown as GclProjection;
    expect(() => validateProjectionVisibility(p, realWs())).not.toThrow();
    expect(validateProjectionVisibility(p, realWs()).decision).toBe("deny");
  });

  it("throwing_projection_type_getter_on_projection_returns_typed_denial [spec(§16)]", () => {
    const p = { workspaceId: "ws-1", visibilityLevel: "isolated",
      get projectionType() { return thrower(); }, sanitizedPayload: {}, sourceRefs: [] } as unknown as GclProjection;
    expect(() => validateProjectionVisibility(p, realWs())).not.toThrow();
    expect(validateProjectionVisibility(p, realWs()).decision).toBe("deny");
  });

  it("throwing_taxonomy_getter_is_ignored_and_never_throws — the SIXTH shape, in the sibling guard [spec(§16)]", () => {
    // ⛔ Found while unifying: `isVisibilityConsistentWithProjectionType`'s `Object.hasOwn`
    // closes the prototype-KEY hazard but NOT an own accessor, so the guard the finding
    // named as the hardened exemplar was itself incomplete.
    const tax = { get summary() { return thrower(); } } as never;
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), realWs(), tax)).not.toThrow();
    expect(isVisibilityConsistentWithProjectionType("summary", "isolated", tax)).toBe(true);
  });

  it("a Proxy that reports one ceiling via getOwnPropertyDescriptor and returns another via get cannot widen visibility [spec(§5)]", () => {
    // ⛔ The split-read fail-open this slice's own review caught: `defaultVisibility` was
    // hardened at the guard and then RE-READ RAW to supply the ceiling, so a Proxy could pass
    // the guard declaring "isolated" and then hand `isWithinDefault` a "full" ceiling —
    // widening exposure on the one gate that decides it. Both sites now read the same hoisted
    // own-descriptor value, so the two can no longer disagree.
    const lying = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: (_t, k) =>
          k === "id"
            ? { value: "ws-1", writable: true, enumerable: true, configurable: true }
            : k === "defaultVisibility"
              ? { value: "isolated", writable: true, enumerable: true, configurable: true }
              : undefined,
        get: (_t, k) => (k === "id" ? "ws-1" : k === "defaultVisibility" ? "full" : undefined),
        has: () => true,
      },
    ) as unknown as Workspace;
    // The workspace DECLARES `isolated`; the projection asks for `full`. The declared ceiling
    // must win, so this denies — if the raw `get` value ("full") reached the ceiling check it
    // would allow.
    const d = validateProjectionVisibility(projection("ws-1", "full"), lying);
    expect(d.decision).toBe("deny");
    if (d.decision === "deny") expect(d.reason).toBe("VISIBILITY_EXCEEDS_SOURCE");
  });

  // ⛔ Proxy `getOwnPropertyDescriptor` traps are ARBITRARY CALLER CODE and the descriptor
  // read invokes them. An earlier version of this fix claimed the throw class was closed
  // "without a try/catch"; these three measured it throwing straight out of the module.
  const hostileTrap = <T extends object>(t: T): T =>
    new Proxy(t, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile gOPD trap");
      },
    });

  it("a hostile getOwnPropertyDescriptor trap on the WORKSPACE returns a typed denial [spec(§16)]", () => {
    const ws = hostileTrap({ id: "ws-1", defaultVisibility: "full" }) as unknown as Workspace;
    expect(() => validateProjectionVisibility(projection("ws-1", "isolated"), ws)).not.toThrow();
    expect(validateProjectionVisibility(projection("ws-1", "isolated"), ws).decision).toBe("deny");
  });

  it("a hostile getOwnPropertyDescriptor trap on the PROJECTION returns a typed denial [spec(§16)]", () => {
    const p = hostileTrap(projection("ws-1", "isolated") as object) as unknown as GclProjection;
    expect(() => validateProjectionVisibility(p, realWs())).not.toThrow();
    expect(validateProjectionVisibility(p, realWs()).decision).toBe("deny");
  });

  it("a hostile getOwnPropertyDescriptor trap on the TAXONOMY never throws [spec(§16)]", () => {
    const tax = hostileTrap({}) as never;
    expect(() => isVisibilityConsistentWithProjectionType("summary", "full", tax)).not.toThrow();
    expect(isVisibilityConsistentWithProjectionType("summary", "full", tax)).toBe(true);
  });

  it("an own taxonomy entry explicitly valued undefined still DENIES — present is not absent [spec(§5)]", () => {
    // Regression pin: reading only the VALUE collapsed absent and present-but-undefined,
    // flipping this input from deny to allow. `found` keeps them distinct.
    expect(isVisibilityConsistentWithProjectionType("summary", "full", { summary: undefined } as never)).toBe(false);
  });

  it("a prototype-only taxonomy is still ignored — no regression on the sibling's existing guard [spec(§5)]", () => {
    const tax = Object.create({ summary: ["isolated"] }) as never;
    expect(isVisibilityConsistentWithProjectionType("summary", "isolated", tax)).toBe(true);
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
