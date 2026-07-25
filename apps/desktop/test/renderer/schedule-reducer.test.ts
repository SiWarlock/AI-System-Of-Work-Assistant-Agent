import { describe, it, expect } from "vitest";
import type { UiSafeScheduleEntry } from "@sow/contracts/api/ui-safe";
import { replaceSchedule } from "../../renderer/store/projections";
import { initialStoreState } from "../../renderer/store";

// 9.9b — the GLOBAL availability slice reducer (mirror `replaceIngestion`): a whole-list REPLACE hydrated
// on cold-load, with an empty→empty ref-stable no-op. Node tier (window-free).

const e: UiSafeScheduleEntry = { start: "2026-07-06T09:00:00.000Z", end: "2026-07-06T10:00:00.000Z", busy: true };

describe("replaceSchedule — global availability slice replace", () => {
  it("replaces the slice with the snapshot (new state)", () => {
    const next = replaceSchedule(initialStoreState, [e]);
    expect(next.schedule).toEqual([e]);
    expect(next).not.toBe(initialStoreState);
  });

  it("empty→empty is a ref-stable no-op (no needless re-render)", () => {
    const same = replaceSchedule(initialStoreState, []);
    expect(same).toBe(initialStoreState);
  });

  it("non-empty→empty replaces (clears the slice)", () => {
    const populated = replaceSchedule(initialStoreState, [e]);
    const cleared = replaceSchedule(populated, []);
    expect(cleared.schedule).toEqual([]);
    expect(cleared).not.toBe(populated);
  });
});
