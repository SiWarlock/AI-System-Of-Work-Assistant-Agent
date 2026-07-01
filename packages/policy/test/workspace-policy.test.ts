// spec(§5) — workspace policy resolution: flatten a valid Workspace into the typed
// ResolvedWorkspacePolicy view (REQ-F-001); deterministic (same input → same output).
import { describe, it, expect } from "vitest";
import { defaultWorkspace } from "@sow/contracts";
import {
  resolveWorkspacePolicy,
  type ResolvedWorkspacePolicy,
} from "../src/workspace-policy";

function employerWs() {
  return defaultWorkspace({
    id: "ws-emp-1",
    name: "Employer",
    type: "employer_work",
    markdownRepoPath: "/repos/employer",
    gbrainBrainId: "brain-emp",
  });
}

describe("resolveWorkspacePolicy", () => {
  it("flattens a Workspace into the typed policy view, carrying embedded sub-models by reference", () => {
    const w = employerWs();
    const r: ResolvedWorkspacePolicy = resolveWorkspacePolicy(w);
    expect(r.workspaceId).toBe("ws-emp-1");
    expect(r.type).toBe("employer_work");
    expect(r.dataOwner).toBe("employer");
    expect(r.defaultVisibility).toBe("isolated");
    expect(r.egressPolicy).toBe(w.egressPolicy);
    expect(r.providerMatrix).toBe(w.providerMatrix);
  });

  it("carries a non-employer workspace's user data-owner + overridden visibility", () => {
    const w = defaultWorkspace({
      id: "ws-pb-1",
      name: "Side project",
      type: "personal_business",
      markdownRepoPath: "/repos/pb",
      gbrainBrainId: "brain-pb",
      defaultVisibility: "sanitized",
    });
    const r = resolveWorkspacePolicy(w);
    expect(r.dataOwner).toBe("user");
    expect(r.defaultVisibility).toBe("sanitized");
  });

  it("is deterministic: same input → structurally equal output", () => {
    const w = employerWs();
    expect(resolveWorkspacePolicy(w)).toEqual(resolveWorkspacePolicy(w));
  });
});
