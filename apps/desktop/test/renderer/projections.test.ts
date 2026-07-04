import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import {
  applyStreamEvent,
  withConnection,
  setScope,
  isGap,
  hydrateCards,
  replaceCards,
  hydrateHealth,
  hydrateGlobal,
  groupGlobalByWorkspace,
  replaceRecentChanges,
} from "../../renderer/store/projections";
import type { UiSafeGclProjection } from "@sow/contracts/api/ui-safe";
import {
  approvalEvent,
  healthEvent,
  workflowEvent,
  cardEvent,
  uiSafeCard,
  uiSafeHealthItem,
  uiSafeRecentChange,
} from "./fixtures";

describe("initial hydrate (9.4b — fold a read-model query snapshot)", () => {
  it("hydrateCards upserts cards by cardId; a later stream event stays a clean upsert", () => {
    let s = initialStoreState;
    s = hydrateCards(s, [uiSafeCard("card-1"), uiSafeCard("card-2")]);
    expect([...s.cards.keys()].sort()).toEqual(["card-1", "card-2"]);
    // A subsequent stream change for card-1 upserts (no duplicate, no lastEventId drift from hydrate).
    s = applyStreamEvent(s, cardEvent(1, "e1", "card-1"));
    expect(s.cards.size).toBe(2);
    expect(s.lastEventId).toBe("e1");
  });

  it("replaceCards REPLACES (no blend) — a scope change clears the prior scope's cards", () => {
    // Populate with a "global" scope's cards, then replace with a workspace's — the
    // global card must NOT linger under the workspace scope (§9.5 no cross-scope blend).
    const global = hydrateCards(initialStoreState, [uiSafeCard("global-1"), uiSafeCard("global-2")]);
    const workspace = replaceCards(global, [uiSafeCard("ws-1")]);
    expect([...workspace.cards.keys()]).toEqual(["ws-1"]);
    // Replacing with empty clears entirely; empty→empty is a ref-stable no-op.
    const cleared = replaceCards(workspace, []);
    expect(cleared.cards.size).toBe(0);
    expect(replaceCards(cleared, [])).toBe(cleared);
  });

  it("hydrateHealth upserts items by id", () => {
    let s = initialStoreState;
    s = hydrateHealth(s, [uiSafeHealthItem("h-1"), uiSafeHealthItem("h-2")]);
    expect([...s.health.keys()].sort()).toEqual(["h-1", "h-2"]);
  });

  it("replaceRecentChanges REPLACES the scoped recent-activity list (no blend across scopes)", () => {
    // A workspace scope's recent changes must fully replace the prior scope's — never merge
    // (§9.5 workspace isolation; the list is workspace-scoped, Global shows nothing).
    const a = replaceRecentChanges(initialStoreState, [uiSafeRecentChange("chg-a1"), uiSafeRecentChange("chg-a2")]);
    expect(a.recentChanges.map((c) => c.changeId)).toEqual(["chg-a1", "chg-a2"]);
    const b = replaceRecentChanges(a, [uiSafeRecentChange("chg-b1")]);
    expect(b.recentChanges.map((c) => c.changeId)).toEqual(["chg-b1"]); // replaced, not merged
    // Clearing (scope→Global) empties it; empty→empty is a ref-stable no-op.
    const cleared = replaceRecentChanges(b, []);
    expect(cleared.recentChanges).toEqual([]);
    expect(replaceRecentChanges(cleared, [])).toBe(cleared);
  });

  it("replaceRecentChanges leaves unrelated slices ref-stable", () => {
    const s = replaceRecentChanges(initialStoreState, [uiSafeRecentChange("chg-1")]);
    expect(s.cards).toBe(initialStoreState.cards);
    expect(s.health).toBe(initialStoreState.health);
    expect(s.global).toBe(initialStoreState.global);
  });

  it("an empty snapshot is a no-op (same reference — no needless re-render)", () => {
    const s = initialStoreState;
    expect(hydrateCards(s, [])).toBe(s);
    expect(hydrateHealth(s, [])).toBe(s);
  });

  it("hydrate does NOT advance the resume cursor (it is a snapshot, not a stream event)", () => {
    const s = hydrateCards(initialStoreState, [uiSafeCard("card-1")]);
    expect(s.lastEventId).toBeNull();
    expect(s.lastSeq).toBeNull();
  });
});

describe("store projections (9.3 — fold UI-safe events)", () => {
  it("routes each event class into its keyed collection", () => {
    let s = initialStoreState;
    s = applyStreamEvent(s, approvalEvent(1, "e1", "a1"));
    s = applyStreamEvent(s, healthEvent(2, "e2", "h1"));
    s = applyStreamEvent(s, workflowEvent(3, "e3", "w1"));
    s = applyStreamEvent(s, cardEvent(4, "e4", "c1"));
    expect(s.approvals.get("a1")?.id).toBe("a1");
    expect(s.health.get("h1")?.id).toBe("h1");
    expect(s.workflows.get("w1")?.workflowId).toBe("w1");
    expect(s.cards.get("c1")?.cardId).toBe("c1");
  });

  it("advances the resume cursor (lastEventId + lastSeq)", () => {
    const s = applyStreamEvent(initialStoreState, approvalEvent(7, "e7"));
    expect(s.lastEventId).toBe("e7");
    expect(s.lastSeq).toBe(7);
  });

  it("is immutable — new state returned, prior untouched", () => {
    const before = initialStoreState;
    const after = applyStreamEvent(before, approvalEvent(1, "e1", "a1"));
    expect(after).not.toBe(before);
    expect(before.approvals.size).toBe(0);
    expect(after.approvals.size).toBe(1);
  });

  it("upserts by id (a later event for the same id replaces it)", () => {
    let s = applyStreamEvent(initialStoreState, approvalEvent(1, "e1", "a1"));
    s = applyStreamEvent(s, approvalEvent(2, "e2", "a1"));
    expect(s.approvals.size).toBe(1);
  });

  it("setScope changes only the scope field (no-op returns same ref)", () => {
    expect(initialStoreState.scope).toBe("global");
    const scoped = setScope(initialStoreState, "personal-business");
    expect(scoped.scope).toBe("personal-business");
    // Unrelated slices are untouched; a no-op returns the same reference.
    expect(scoped.cards).toBe(initialStoreState.cards);
    expect(setScope(scoped, "personal-business")).toBe(scoped);
  });

  it("withConnection changes only the connection field (no-op returns same ref)", () => {
    const live = withConnection(initialStoreState, "live");
    expect(live.connection).toBe("live");
    expect(withConnection(live, "live")).toBe(live);
  });

  it("isGap detects a non-consecutive seq", () => {
    const s = applyStreamEvent(initialStoreState, approvalEvent(1, "e1"));
    expect(isGap(s, approvalEvent(2, "e2"))).toBe(false);
    expect(isGap(s, approvalEvent(5, "e5"))).toBe(true);
  });
});

describe("read_model.change scope isolation (§9.5 — push path never blends across workspaces)", () => {
  it("Global scope: a read_model.change upserts the card (the cross-workspace dashboard stays live)", () => {
    // Default scope is Global; `cards` holds the query.dashboard aggregate that
    // read_model.change emits, so folding the push in is correct.
    expect(initialStoreState.scope).toBe("global");
    const s = applyStreamEvent(initialStoreState, cardEvent(1, "e1", "c1"));
    expect(s.cards.get("c1")?.cardId).toBe("c1");
    expect(s.lastEventId).toBe("e1");
    expect(s.lastSeq).toBe(1);
  });

  it("workspace scope: a read_model.change does NOT blend the card, but DOES advance the resume cursor", () => {
    // In a workspace scope `cards` holds ONE workspace's query.workspace read-model;
    // a pushed dashboard card carries no workspaceId, so folding it in could surface a
    // FOREIGN workspace's card under this tab. It must be dropped — never blended.
    const scoped = setScope(initialStoreState, "employer-work");
    const s = applyStreamEvent(scoped, cardEvent(1, "e1", "foreign-card"));
    expect(s.cards.size).toBe(0); // NOT blended
    // The cursor still advances — never re-request a dropped event / never a false gap.
    expect(s.lastEventId).toBe("e1");
    expect(s.lastSeq).toBe(1);
    expect(s).not.toBe(scoped); // cursor changed → new state
  });

  it("workspace scope: a push never adds a foreign card to an already-scoped card set", () => {
    // Populate the workspace scope with its OWN card (via the scope-change replace path),
    // then a push for a different card must leave the scoped set exactly as-is.
    let s = setScope(initialStoreState, "personal-business");
    s = replaceCards(s, [uiSafeCard("ws-own")]);
    s = applyStreamEvent(s, cardEvent(4, "e4", "foreign"));
    expect([...s.cards.keys()]).toEqual(["ws-own"]); // foreign card rejected
    expect(s.lastSeq).toBe(4);
  });

  it("workspace scope: a suppressed read_model.change leaves NO false gap for the next event", () => {
    // Because the cursor advances even when the card is suppressed, the following event
    // is still the consecutive successor — no phantom gap / no needless resubscribe.
    const scoped = setScope(initialStoreState, "personal-life");
    const s = applyStreamEvent(scoped, cardEvent(1, "e1", "c1"));
    expect(isGap(s, cardEvent(2, "e2", "c2"))).toBe(false);
  });

  it("scope gating is read_model.change-ONLY — other event classes apply in any scope", () => {
    // Approvals/health/workflows are not workspace-scoped card data; they must keep
    // flowing regardless of the active scope (over-broad suppression would be a bug).
    const scoped = setScope(initialStoreState, "employer-work");
    let s = applyStreamEvent(scoped, approvalEvent(1, "e1", "a1"));
    s = applyStreamEvent(s, healthEvent(2, "e2", "h1"));
    s = applyStreamEvent(s, workflowEvent(3, "e3", "w1"));
    expect(s.approvals.get("a1")?.id).toBe("a1");
    expect(s.health.get("h1")?.id).toBe("h1");
    expect(s.workflows.get("w1")?.workflowId).toBe("w1");
  });

  it("suppressing in a workspace scope leaves unrelated slices ref-stable", () => {
    const scoped = setScope(initialStoreState, "employer-work");
    const s = applyStreamEvent(scoped, cardEvent(1, "e1", "c1"));
    expect(s.approvals).toBe(scoped.approvals);
    expect(s.health).toBe(scoped.health);
    expect(s.workflows).toBe(scoped.workflows);
    expect(s.global).toBe(scoped.global);
    expect(s.cards).toBe(scoped.cards); // untouched map (empty) — same reference
  });
});

describe("Global (§9.4) surface — hydrate + group", () => {
  const gcl = (workspaceId: string, projectionType: string, drillable = false): UiSafeGclProjection => ({
    workspaceId,
    visibilityLevel: drillable ? "full" : "sanitized",
    projectionType,
    summary: `${projectionType} summary`,
    drillable,
  });

  it("hydrateGlobal REPLACES the snapshot (a dropped projection disappears)", () => {
    const s1 = hydrateGlobal(initialStoreState, [gcl("ws-a", "deadlines"), gcl("ws-b", "calendar")]);
    expect(s1.global).toHaveLength(2);
    // A later snapshot with fewer items REPLACES — not merges.
    const s2 = hydrateGlobal(s1, [gcl("ws-a", "deadlines")]);
    expect(s2.global.map((p) => p.workspaceId)).toEqual(["ws-a"]);
  });

  it("hydrateGlobal empty→empty is a ref-stable no-op", () => {
    expect(hydrateGlobal(initialStoreState, [])).toBe(initialStoreState);
  });

  it("hydrateGlobal non-empty→empty RETRACTS (a full retraction replaces with [], new state)", () => {
    const populated = hydrateGlobal(initialStoreState, [gcl("ws-a", "deadlines")]);
    const retracted = hydrateGlobal(populated, []);
    expect(retracted).not.toBe(populated); // a real change → new state (needed re-render)
    expect(retracted.global).toEqual([]);
  });

  it("groupGlobalByWorkspace groups by workspaceId, preserving first-seen order", () => {
    const groups = groupGlobalByWorkspace([
      gcl("ws-b", "calendar"),
      gcl("ws-a", "deadlines"),
      gcl("ws-b", "blockers"),
    ]);
    expect(groups.map((g) => g.workspaceId)).toEqual(["ws-b", "ws-a"]);
    expect(groups[0]?.items.map((i) => i.projectionType)).toEqual(["calendar", "blockers"]);
    expect(groups[1]?.items).toHaveLength(1);
  });

  it("groupGlobalByWorkspace on an empty surface is an empty group list", () => {
    expect(groupGlobalByWorkspace([])).toEqual([]);
  });
});
