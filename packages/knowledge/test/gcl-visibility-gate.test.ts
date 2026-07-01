// spec(§6) — GCL Visibility Gate: single cross-workspace read path; sanitized,
// visibility-validated GclProjections; raw-content / over-visibility HARD reject
// (never downgrade-and-store); direct cross-workspace raw retrieval denied (WS-8).
import { describe, it, expect } from "vitest";
import { defaultWorkspace, type GclProjection, type Workspace } from "@sow/contracts";
import {
  admitProjection,
  guardCrossWorkspaceRawRead,
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
