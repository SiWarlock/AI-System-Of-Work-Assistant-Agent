// P3 — createBuildSyncOutputsActivity: the derived KnowledgeMutationPlan carries the correct provenance. P1
// added the `project_sync` ProvenanceOrigin member, so this closes the arch_gap the activity previously
// defaulted to "ingestion" for. (First direct test of this built-but-untested activity.)
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result, WorkspaceId, SourceId } from "@sow/contracts";
import { createBuildSyncOutputsActivity } from "../src/activities/deterministicProgress";
import type { SyncOutputsProjection } from "../src/activities/deterministicProgress";
import type {
  ValidatedNarrative,
  DeterministicProgress,
  BuildSyncOutputsFailure,
} from "../src/ports/projectSync";

const validated: ValidatedNarrative = { validated: true, fields: {} };
const progress: DeterministicProgress = { completedCount: 1, totalCount: 2, percentComplete: 50, perProvider: [] };
const WS = "personal-business" as WorkspaceId;

/** A minimal projection that returns a fixed note/dashboard/no-actions (the activity wraps it into the plan). */
const projection: SyncOutputsProjection = {
  project(): Result<
    { readonly note: import("@sow/contracts").NoteCreate; readonly dashboard: Record<string, unknown>; readonly actions: readonly never[] },
    BuildSyncOutputsFailure
  > {
    return ok({
      note: { path: "personal-business/projects/x.md", body: "## Status\n50%" },
      dashboard: {},
      actions: [],
    });
  },
};
const sourceRef = { sourceId: "src-1" as SourceId };
const deps = { projection, sourceRef, planIdentity: { project: "x" } };
const identity = { projectId: "x", title: "X", slug: "personal-business/x", lifecycleState: "active" as const };
const AT = "2026-07-07T00:00:00.000Z";

describe("createBuildSyncOutputsActivity — derived-plan provenance (§13.5)", () => {
  it("defaults the derived plan's provenanceOrigin to project_sync (the arch_gap P1 closed)", async () => {
    const port = createBuildSyncOutputsActivity(deps);
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan.provenanceOrigin).toBe("project_sync");
  });

  it("respects an explicit provenanceOrigin override", async () => {
    const port = createBuildSyncOutputsActivity({ ...deps, provenanceOrigin: "project_capture" });
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.plan.provenanceOrigin).toBe("project_capture");
  });

  it("stamps the plan's workspaceId from the PASSED workspace (WS-2/WS-4) + cites the sourceRef (REQ-F-006)", async () => {
    const port = createBuildSyncOutputsActivity(deps);
    const r = await port.build(validated, progress, WS, identity, AT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(String(r.value.plan.workspaceId)).toBe("personal-business");
      expect(r.value.plan.sourceRefs.map((s) => String(s.sourceId))).toEqual(["src-1"]);
      expect(r.value.plan.confidence).toBe(1); // deterministic facts, not a model estimate (REQ-F-011)
    }
  });
});
