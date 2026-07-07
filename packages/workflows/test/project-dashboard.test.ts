// P3 — the pure Project-dashboard payload builder. Pins REQ-F-011 (percent re-derived from counts, never
// trusted) + the no-inference prose mapping (TBD skipped, single-lined, capped) + fail-closed identity.
import { describe, it, expect } from "vitest";
import { UiSafeProjectDashboardSchema, MANAGED_DOC_SLOTS } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { buildProjectDashboardPayload } from "../src/activities/projectDashboard";
import type { ProjectDashboardInput } from "../src/activities/projectDashboard";

const f = (value: string, evidenceRef = "canonical:ref"): ExtractionField<string> => ({ value, evidenceRef });

const baseInput: ProjectDashboardInput = {
  projectId: "proj-1",
  title: "Launch",
  status: "active",
  progress: { completedCount: 2, totalCount: 4, percentComplete: 50, perProvider: [] },
  prose: {
    blockers: [f("waiting on legal review")],
    waitingItems: [f("PR #42 approval")],
    nextActions: [f("draft the migration")],
  },
  evidenceRefs: ["canonical:evidence-1"],
  updatedAt: "2026-07-06T00:00:00.000Z",
};

describe("buildProjectDashboardPayload", () => {
  it("builds a schema-valid UiSafeProjectDashboard", () => {
    const d = buildProjectDashboardPayload(baseInput)!;
    expect(d).not.toBeNull();
    expect(() => UiSafeProjectDashboardSchema.parse(d)).not.toThrow();
    expect(d.projectId).toBe("proj-1");
    expect(d.status).toBe("active");
    expect(d.blockers).toEqual(["waiting on legal review"]);
    expect(d.nextActions).toEqual(["draft the migration"]);
    expect(d.evidenceRefs).toEqual(["canonical:evidence-1"]);
  });

  it("REQ-F-011: percentComplete is RE-DERIVED from the counts, never trusted from the input", () => {
    // input claims 99% but the counts say 2/4 = 50% — the deterministic value wins.
    const d = buildProjectDashboardPayload({
      ...baseInput,
      progress: { completedCount: 2, totalCount: 4, percentComplete: 99, perProvider: [] },
    })!;
    expect(d.progress).toEqual({ completedCount: 2, totalCount: 4, percentComplete: 50 });
  });

  it("REQ-F-011: totalCount 0 → 0% (never a divide-by-zero or a guess)", () => {
    const d = buildProjectDashboardPayload({
      ...baseInput,
      progress: { completedCount: 0, totalCount: 0, percentComplete: 0, perProvider: [] },
    })!;
    expect(d.progress.percentComplete).toBe(0);
  });

  it("no-inference: a TBD (unstated) prose entry is SKIPPED, not rendered as a guess", () => {
    const d = buildProjectDashboardPayload({
      ...baseInput,
      prose: {
        blockers: [{ value: TBD }, f("real blocker")],
        waitingItems: [{ value: TBD }],
        nextActions: [],
      },
    })!;
    expect(d.blockers).toEqual(["real blocker"]); // the TBD dropped
    expect(d.waitingItems).toEqual([]); // all TBD → empty
    expect(d.nextActions).toEqual([]);
  });

  it("collapses a multi-line prose value to a single line (defense-in-depth)", () => {
    const d = buildProjectDashboardPayload({
      ...baseInput,
      prose: { ...baseInput.prose, blockers: [f("line one\nline two\r\nline three")] },
    })!;
    expect(d.blockers[0]).not.toContain("\n");
    expect(d.blockers[0]).not.toContain("\r");
    expect(() => UiSafeProjectDashboardSchema.parse(d)).not.toThrow();
  });

  it("caps each prose array at 50 entries", () => {
    const many = Array.from({ length: 80 }, (_, i) => f(`blocker ${i}`));
    const d = buildProjectDashboardPayload({ ...baseInput, prose: { ...baseInput.prose, blockers: many } })!;
    expect(d.blockers).toHaveLength(50);
  });

  it("emits the 5 default doc-pack slots (unlinked/unknown — honest pre-connector state)", () => {
    const d = buildProjectDashboardPayload(baseInput)!;
    expect(d.docPack.map((x) => x.slot)).toEqual(MANAGED_DOC_SLOTS.map((s) => s.slot));
    expect(d.docPack.every((x) => x.linkState === "unlinked" && x.syncState === "unknown")).toBe(true);
  });

  it("fail-closed: an unservable identity (empty projectId / non-ISO updatedAt) → null", () => {
    expect(buildProjectDashboardPayload({ ...baseInput, projectId: "" })).toBeNull();
    expect(buildProjectDashboardPayload({ ...baseInput, updatedAt: "not-a-date" })).toBeNull();
    expect(buildProjectDashboardPayload({ ...baseInput, status: "" })).toBeNull();
  });
});
