// spec(§6) — GCL identity-map cross-workspace links (REQ-F-020 / WS-5, Level-3):
// user-approved links are the ONLY way raw content crosses a workspace; a link
// without a recorded Approval is rejected; recording captures approval ref + the
// two endpoints + the visibility it unlocks; revocation removes the raw path; the
// approval gate is HARD (an unrecorded/unapproved cross-workspace raw read is
// denied even when the feature is active).
import { describe, it, expect } from "vitest";
import type { Approval, VisibilityLevel } from "@sow/contracts";
import { CrossWorkspaceLinkMap } from "../src/gcl/cross-workspace-links";

/** A fully-typed Approval fixture — the module only reads `id` + `status`. */
function approval(status: Approval["status"], id = "appr-1"): Approval {
  return {
    id: id as Approval["id"],
    actionRef: "act-1" as Approval["actionRef"],
    status,
    actor: "owner",
    channel: "mac",
    payloadHash: "hash",
  };
}

const A = "ws-a";
const B = "ws-b";
const C = "ws-c";
const FULL: VisibilityLevel = "full";
const AT = "2026-07-01T00:00:00.000Z";

// spec(§6) — REGRESSION (adversarial verify): a Level-3 raw-crossing link backed
// by a TIME-BOXED owner Approval must stop authorizing once the approval expires;
// the prior gate ignored `Approval.expiresAt` entirely (indefinite raw crossing).
describe("Level-3 link expiry (regression) — a time-boxed grant never authorizes indefinitely", () => {
  const expiring = (expiresAt: string): Approval => ({ ...approval("approved", "appr-exp"), expiresAt });
  const PAST = "2026-06-30T00:00:00.000Z"; // before AT
  const FUTURE = "2026-07-02T00:00:00.000Z"; // after AT
  const LATER = "2026-07-03T00:00:00.000Z"; // after FUTURE

  it("REJECTS recording a link whose approval already expired at record time", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({ fromWorkspaceId: A, toWorkspaceId: B, unlockedVisibility: FULL, approval: expiring(PAST), recordedAt: AT });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("approval_expired");
    expect(map.getLink(A, B)).toBeUndefined();
  });

  it("authorizes BEFORE expiry, DENIES after (time-boxed link)", () => {
    const map = new CrossWorkspaceLinkMap();
    expect(map.recordLink({ fromWorkspaceId: A, toWorkspaceId: B, unlockedVisibility: FULL, approval: expiring(FUTURE), recordedAt: AT }).ok).toBe(true);
    expect(map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B, at: AT }).ok).toBe(true);
    const after = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B, at: LATER });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("a time-boxed link with NO request time is DENIED (fail-closed — cannot verify)", () => {
    const map = new CrossWorkspaceLinkMap();
    map.recordLink({ fromWorkspaceId: A, toWorkspaceId: B, unlockedVisibility: FULL, approval: expiring(FUTURE), recordedAt: AT });
    expect(map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B }).ok).toBe(false);
  });
});

describe("CrossWorkspaceLinkMap.recordLink — recording a Level-3 owner-approved link", () => {
  it("records an approved link capturing the approval ref, both endpoints, and the unlocked visibility", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved", "appr-777"),
      recordedAt: AT,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        fromWorkspaceId: A,
        toWorkspaceId: B,
        unlockedVisibility: FULL,
        approvalRef: "appr-777",
        recordedAt: AT,
      });
    }
    expect(map.getLink(A, B)).toBeDefined();
  });

  it("REJECTS an unapproved link — a pending Approval never crosses raw content", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("pending"),
      recordedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("approval_not_approved");
    expect(map.getLink(A, B)).toBeUndefined();
  });

  it("REJECTS a link with no recorded Approval (empty approval id)", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved", ""),
      recordedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("approval_not_recorded");
  });

  it("REJECTS a same-workspace link (from === to is not a cross-workspace link)", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: A,
      unlockedVisibility: FULL,
      approval: approval("approved"),
      recordedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_endpoints");
  });

  it("REJECTS an empty endpoint id", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: "",
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved"),
      recordedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_endpoints");
  });

  it("REJECTS an unlocked visibility that is not a valid VisibilityLevel", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: "top_secret" as VisibilityLevel,
      approval: approval("approved"),
      recordedAt: AT,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_visibility");
  });
});

describe("CrossWorkspaceLinkMap.authorizeCrossWorkspaceRawRead — the HARD Level-3 gate", () => {
  it("DENIES a cross-workspace raw read when no link is recorded (default-deny)", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("PERMITS raw crossing only via a recorded approved link, surfacing the unlocked visibility", () => {
    const map = new CrossWorkspaceLinkMap();
    map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved"),
      recordedAt: AT,
    });
    const r = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.permitted).toBe(true);
      expect(r.value.unlockedVisibility).toBe(FULL);
    }
  });

  it("is per-link and directional — an A→B link does NOT authorize B→A or A→C (gate stays hard)", () => {
    const map = new CrossWorkspaceLinkMap();
    map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved"),
      recordedAt: AT,
    });
    const reverse = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: B, toWorkspaceId: A });
    const other = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: C });
    expect(reverse.ok).toBe(false);
    if (!reverse.ok) expect(reverse.error.code).toBe("direct_cross_workspace_raw_denied");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("permits a same-workspace read (not a cross-workspace request) with no unlocked visibility", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: A });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.unlockedVisibility).toBeUndefined();
  });

  it("fail-closed: denies on malformed (empty) workspace ids", () => {
    const map = new CrossWorkspaceLinkMap();
    const r = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: "", toWorkspaceId: B });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_policy_input");
  });
});

describe("CrossWorkspaceLinkMap.revokeLink — revocation removes the cross-workspace raw path", () => {
  it("removes the link so a previously-permitted raw read is denied again", () => {
    const map = new CrossWorkspaceLinkMap();
    map.recordLink({
      fromWorkspaceId: A,
      toWorkspaceId: B,
      unlockedVisibility: FULL,
      approval: approval("approved"),
      recordedAt: AT,
    });
    const before = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B });
    expect(before.ok).toBe(true);

    const rev = map.revokeLink(A, B);
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.value.removed).toBe(true);

    const after = map.authorizeCrossWorkspaceRawRead({ fromWorkspaceId: A, toWorkspaceId: B });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("reports removed:false when revoking a link that was never recorded (idempotent)", () => {
    const map = new CrossWorkspaceLinkMap();
    const rev = map.revokeLink(A, B);
    expect(rev.ok).toBe(true);
    if (rev.ok) expect(rev.value.removed).toBe(false);
  });

  it("rejects revocation with malformed (empty) endpoints", () => {
    const map = new CrossWorkspaceLinkMap();
    const rev = map.revokeLink("", B);
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.error.code).toBe("malformed_endpoints");
  });
});
