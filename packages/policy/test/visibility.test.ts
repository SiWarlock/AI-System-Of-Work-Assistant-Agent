// spec(§5) — visibility levels: rank ordering; within-default predicate; projection
// visibility validation (fail-closed MALFORMED + VISIBILITY_EXCEEDS_SOURCE); hard
// denial #2 — direct cross-workspace/cross-brain RAW retrieval DENY (REQ-F-005/F-020).
import { describe, it, expect } from "vitest";
import { defaultWorkspace, type GclProjection, type Workspace } from "@sow/contracts";
import {
  visibilityRank,
  isWithinDefault,
  validateProjectionVisibility,
  denyDirectCrossWorkspaceRaw,
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
