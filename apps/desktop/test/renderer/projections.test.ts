import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import {
  applyStreamEvent,
  withConnection,
  setScope,
  isGap,
  hydrateCards,
  hydrateHealth,
} from "../../renderer/store/projections";
import {
  approvalEvent,
  healthEvent,
  workflowEvent,
  cardEvent,
  uiSafeCard,
  uiSafeHealthItem,
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

  it("hydrateHealth upserts items by id", () => {
    let s = initialStoreState;
    s = hydrateHealth(s, [uiSafeHealthItem("h-1"), uiSafeHealthItem("h-2")]);
    expect([...s.health.keys()].sort()).toEqual(["h-1", "h-2"]);
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
