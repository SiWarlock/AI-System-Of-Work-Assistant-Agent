// Task 14.7 (desktop leg) — the cross-workspace-links store slice.
//
// The rule-4 owner-approval surface tracks links OPTIMISTICALLY from each mutation's returned
// UiSafeCrossWorkspaceLink, keyed by linkId (no cold-load list read yet — a Future-TODO). A status
// transition (create→approve→revoke) re-upserts the SAME linkId, so the list reflects the latest
// authoritative status. Every stored field is UI-safe (ids / scope descriptors / status / timestamps);
// there is NO raw cross-workspace content in the shape.
import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import {
  upsertCrossWorkspaceLink,
  crossWorkspaceLinksList,
} from "../../renderer/store/projections";
import {
  mintCrossWorkspaceLinkId,
  type UiSafeCrossWorkspaceLinkView,
} from "../../renderer/store/cross-workspace-links";

const link = (linkId: string, over: Partial<UiSafeCrossWorkspaceLinkView> = {}): UiSafeCrossWorkspaceLinkView => ({
  linkId,
  fromWorkspaceId: "ws_a",
  toWorkspaceId: "ws_b",
  scopeProjectionType: "calendar_busy",
  scopeVisibilityLevel: "coordination",
  status: "pending",
  createdAt: "2026-07-15T00:00:00.000Z",
  approvedAt: null,
  revokedAt: null,
  ...over,
});

describe("cross-workspace-links store slice", () => {
  it("starts empty", () => {
    expect(initialStoreState.crossWorkspaceLinks.size).toBe(0);
    expect(crossWorkspaceLinksList(initialStoreState)).toEqual([]);
  });

  it("upserts a link by linkId, immutably", () => {
    const next = upsertCrossWorkspaceLink(initialStoreState, link("l1"));
    expect(next).not.toBe(initialStoreState);
    expect(initialStoreState.crossWorkspaceLinks.size).toBe(0);
    expect(next.crossWorkspaceLinks.get("l1")?.status).toBe("pending");
  });

  it("a status transition re-upserts the SAME linkId (latest status wins), never duplicates", () => {
    const created = upsertCrossWorkspaceLink(initialStoreState, link("l1", { status: "pending" }));
    const approved = upsertCrossWorkspaceLink(created, link("l1", { status: "approved", approvedAt: "2026-07-15T01:00:00.000Z" }));
    expect(approved.crossWorkspaceLinks.size).toBe(1);
    expect(approved.crossWorkspaceLinks.get("l1")?.status).toBe("approved");
    expect(approved.crossWorkspaceLinks.get("l1")?.approvedAt).toBe("2026-07-15T01:00:00.000Z");
  });

  it("an approved link is overwritten by its revoked transition (terminal status wins)", () => {
    const approved = upsertCrossWorkspaceLink(initialStoreState, link("l1", { status: "approved", approvedAt: "2026-07-15T01:00:00.000Z" }));
    const revoked = upsertCrossWorkspaceLink(approved, link("l1", { status: "revoked", approvedAt: "2026-07-15T01:00:00.000Z", revokedAt: "2026-07-15T02:00:00.000Z" }));
    expect(revoked.crossWorkspaceLinks.size).toBe(1);
    expect(revoked.crossWorkspaceLinks.get("l1")?.status).toBe("revoked");
    expect(revoked.crossWorkspaceLinks.get("l1")?.revokedAt).toBe("2026-07-15T02:00:00.000Z");
  });

  it("lists all links (the coordination surface shows every session link)", () => {
    let s = upsertCrossWorkspaceLink(initialStoreState, link("l1"));
    s = upsertCrossWorkspaceLink(s, link("l2", { fromWorkspaceId: "ws_c", toWorkspaceId: "ws_a" }));
    expect(crossWorkspaceLinksList(s).map((l) => l.linkId).sort()).toEqual(["l1", "l2"]);
  });
});

describe("mintCrossWorkspaceLinkId — deterministic + collision-free by construction", () => {
  it("is deterministic per (from,to,scope) anchor (idempotent — re-authorizing is a no-op)", () => {
    expect(mintCrossWorkspaceLinkId("ws_a", "ws_b", "calendar_busy", "coordination")).toBe(
      mintCrossWorkspaceLinkId("ws_a", "ws_b", "calendar_busy", "coordination"),
    );
  });

  it("a scope CHANGE yields a DIFFERENT id (a new link needing its own approval — Lesson 32)", () => {
    const base = mintCrossWorkspaceLinkId("ws_a", "ws_b", "calendar_busy", "coordination");
    expect(mintCrossWorkspaceLinkId("ws_a", "ws_b", "calendar_busy", "full")).not.toBe(base);
    expect(mintCrossWorkspaceLinkId("ws_a", "ws_b", "deadlines", "coordination")).not.toBe(base);
    expect(mintCrossWorkspaceLinkId("ws_b", "ws_a", "calendar_busy", "coordination")).not.toBe(base); // direction matters
  });

  it("is collision-free even when a component contains the `~` delimiter (percent-escaped, injective)", () => {
    // Two distinct anchors that would collide under a naive join must NOT collide.
    const a = mintCrossWorkspaceLinkId("a~b", "c", "calendar_busy", "coordination");
    const b = mintCrossWorkspaceLinkId("a", "b~c", "calendar_busy", "coordination");
    expect(a).not.toBe(b);
    // A literal `~` never appears unescaped inside a component's encoded form.
    expect(mintCrossWorkspaceLinkId("a~b", "c", "d", "e").split("~")).toHaveLength(4);
  });
});
