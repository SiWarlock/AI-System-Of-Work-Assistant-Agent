import { describe, it, expect } from "vitest";
import type { UiSafeTaskRollupItem } from "@sow/contracts/api/ui-safe";
import { replaceTaskRollup } from "../../renderer/store/projections";
import { initialStoreState } from "../../renderer/store";

// 13.16 — the workspace-scoped task-rollup slice reducer (mirror `replaceRecentChanges`/`replaceIngestion`):
// a whole-list REPLACE (preserving the served pre-ranked order), scope-cleared to [] (WS-8), empty→empty
// ref-stable no-op. Node tier (window-free).

const t: UiSafeTaskRollupItem = { taskId: "t1", title: "Ship the thing", status: "todo", priority: "p0" };

describe("replaceTaskRollup — workspace-scoped highest-priority slice replace", () => {
  it("replaces the slice with the snapshot (new state, order preserved)", () => {
    const t2: UiSafeTaskRollupItem = { taskId: "t2", title: "Second", status: "in_progress" };
    const next = replaceTaskRollup(initialStoreState, [t, t2]);
    expect(next.taskRollup).toEqual([t, t2]);
    expect(next).not.toBe(initialStoreState);
  });

  it("empty→empty is a ref-stable no-op (no needless re-render)", () => {
    const same = replaceTaskRollup(initialStoreState, []);
    expect(same).toBe(initialStoreState);
  });

  it("non-empty→empty replaces (clears the slice — the Global / non-onboarded WS-8 case)", () => {
    const populated = replaceTaskRollup(initialStoreState, [t]);
    const cleared = replaceTaskRollup(populated, []);
    expect(cleared.taskRollup).toEqual([]);
    expect(cleared).not.toBe(populated);
  });
});
