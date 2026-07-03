import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import { applyStreamEvent, withConnection, isGap } from "../../renderer/store/projections";
import { approvalEvent, healthEvent, workflowEvent, cardEvent } from "./fixtures";

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
