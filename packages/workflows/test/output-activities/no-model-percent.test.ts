// spec(§13.5 REQ-F-011) — PKG-W3 25.3: the projectSync NO-MODEL-PERCENT
// invariant, driven end-to-end through `runProjectSync` (the real pure driver)
// with the REAL `parse` + `buildOutputs` activities —
// `createDeterministicProgressActivity` (the SOLE numeric source) +
// `createBuildSyncOutputsActivity` (the derive-from-facts commit deriver) —
// everything else the SAME all-green fakes project-sync.test.ts already uses.
//
// A `synthesize` STUB returns a candidate narrative whose `fields` carry a
// MODEL-SUPPLIED `percent` field (99% — evidence-backed, so it clears the
// no-inference gate on its own terms). The test asserts the COMMITTED
// dashboard payload's percent equals the DETERMINISTIC parser's value (50%,
// derived from real checkbox counting) and never the model's 99% — proving
// REQ-F-011 holds through the real activity wiring, not merely by convention.
// A second case (mutation-verification) wires `parse` to the MODEL's number
// instead of the deterministic reader and shows the committed percent then
// DOES read 99% — the counterfactual proving the first assertion is
// load-bearing, not vacuously green.
import { describe, it, expect } from "vitest";
import { ok, err, sourceId, workflowId } from "@sow/contracts";
import type { Result, SourceRef } from "@sow/contracts";
import { runProjectSync } from "../../src/workflows/projectSync";
import type { ProjectSyncInput, ProjectSyncDeps } from "../../src/workflows/projectSync";
import { createDeterministicProgressActivity, createBuildSyncOutputsActivity } from "../../src/activities/deterministicProgress";
import type { RawProgressReader, SyncOutputsProjection } from "../../src/activities/deterministicProgress";
import { buildProjectDashboardPayload } from "../../src/activities/projectDashboard";
import type {
  ParseProgressError,
  DeterministicProgress,
  ValidatedNarrative,
  ProjectIdentity,
} from "../../src/ports/projectSync";
import {
  FakeResolveRegistryPort,
  FakeSynthesizeNarrativePort,
  FakeValidateNarrativePort,
  FakeCommitStatusPort,
  FakeUpdateDashboardPort,
  FakeNoteExistsReader,
  FakeProposePort,
  FakeProjectSyncHealthSink,
  makeProjectSyncContext,
  makeRegistryEntry,
} from "../support/project-sync-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "../support/fakes";

/** Checkbox text with a DETERMINISTIC 50% (2 of 4 done) — the ONLY numeric source. */
const PLAN_TEXT = "- [x] wire the reader\n- [x] wire the deriver\n- [ ] wire the propose leg\n- [ ] ship it";

function makeReader(): RawProgressReader {
  return {
    read: () => Promise.resolve(ok([{ source: "plan", text: PLAN_TEXT }])),
  };
}

/** A minimal REAL projection: the dashboard's percent is RE-DERIVED (via
 *  buildProjectDashboardPayload, REQ-F-011's own render-time enforcement) from
 *  the DETERMINISTIC `progress` — it never reads `validated.fields`. */
const projection: SyncOutputsProjection = {
  project(
    _validated: ValidatedNarrative,
    progress: DeterministicProgress,
    _workspaceId,
    identity: ProjectIdentity,
    updatedAt: string,
    noteExists: boolean,
  ) {
    const dashboard = buildProjectDashboardPayload({
      projectId: identity.projectId,
      title: identity.title,
      status: identity.lifecycleState,
      progress,
      prose: { blockers: [], waitingItems: [], nextActions: [] },
      updatedAt,
    });
    if (dashboard === null) {
      return err({ code: "build_failed" as const, message: "dashboard build failed" });
    }
    return ok({
      mutation: noteExists
        ? { kind: "patch" as const, patch: { path: "projects/acme-api.md", regionId: "project-status", newBody: "status" } }
        : { kind: "create" as const, note: { path: "projects/acme-api.md", body: "status" } },
      dashboard: dashboard as unknown as Record<string, unknown>,
      actions: [],
    });
  },
};

const SOURCE_REF: SourceRef = { sourceId: sourceId("src-project-sync-no-model-percent") };

function makeInput(): ProjectSyncInput {
  return {
    run: {
      workflowId: workflowId("wf-no-model-percent"),
      trigger: "owner_action",
      idempotencyKey: "idem-no-model-percent",
    },
    context: makeProjectSyncContext(),
  };
}

/** A narrative carrying a MODEL-SUPPLIED `percent` field (evidence-backed, so
 *  it clears no-inference on its own — the point is that the COMMIT never
 *  reads it, not that validation would have caught it). */
const MODEL_PERCENT = 99;
function narrativeWithModelPercent() {
  return {
    fields: {
      explanation: { value: "Nearly done per the model.", evidenceRef: "agent://synthesis" },
      percent: { value: MODEL_PERCENT, evidenceRef: "agent://model-guess" },
    },
    schemaId: "sow:project-sync-output",
  };
}

function makeDeps(overrides: Partial<ProjectSyncDeps> = {}): ProjectSyncDeps {
  return {
    registry: new FakeResolveRegistryPort({ result: "resolved", entry: makeRegistryEntry() }),
    parse: createDeterministicProgressActivity({ reader: makeReader() }),
    synthesize: new FakeSynthesizeNarrativePort({ result: "accepted", draft: narrativeWithModelPercent() }),
    validate: new FakeValidateNarrativePort(),
    buildOutputs: createBuildSyncOutputsActivity({
      projection,
      sourceRef: SOURCE_REF,
      planIdentity: { seed: "no-model-percent-test" },
      noteExists: new FakeNoteExistsReader(),
    }),
    commit: new FakeCommitStatusPort(),
    dashboard: new FakeUpdateDashboardPort(),
    propose: new FakeProposePort(),
    health: new FakeProjectSyncHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

describe("projectSync no-model-percent invariant (25.3, REQ-F-011)", () => {
  it("the committed dashboard percent equals the DETERMINISTIC parser's value, never the model's", async () => {
    const dashboardSink = new FakeUpdateDashboardPort();
    const outcome = await runProjectSync(makeInput(), makeDeps({ dashboard: dashboardSink }));

    expect(outcome.state).toBe("done");
    expect(dashboardSink.payloads).toHaveLength(1);
    const payload = dashboardSink.payloads[0] as { progress: { percentComplete: number } };
    // Deterministic: 2 of 4 checkboxes = 50%.
    expect(payload.progress.percentComplete).toBe(50);
    // The model's 99% is nowhere in the committed payload under any path.
    expect(JSON.stringify(payload)).not.toContain(String(MODEL_PERCENT));
  });

  it("MUTATION CHECK: wiring parse to the model's number instead of the deterministic reader REDS the same assertion", async () => {
    // Simulate the mistake the invariant exists to forbid: `parse` returns the
    // MODEL's percentage (bypassing the deterministic checkbox count).
    const modelWiredParse = {
      parse: (): Promise<Result<DeterministicProgress, ParseProgressError>> =>
        Promise.resolve(
          ok({
            completedCount: MODEL_PERCENT,
            totalCount: 100,
            percentComplete: MODEL_PERCENT,
            perProvider: [{ source: "model", completedCount: MODEL_PERCENT, totalCount: 100 }],
          }),
        ),
    };
    const dashboardSink = new FakeUpdateDashboardPort();
    const outcome = await runProjectSync(
      makeInput(),
      makeDeps({ parse: modelWiredParse, dashboard: dashboardSink }),
    );

    expect(outcome.state).toBe("done");
    const payload = dashboardSink.payloads[0] as { progress: { percentComplete: number } };
    // With `parse` mis-wired to the model's number, the committed percent is
    // NO LONGER 50 — the exact assertion in the test above would RED here,
    // proving it is load-bearing (not vacuously green under the real wiring).
    expect(payload.progress.percentComplete).toBe(MODEL_PERCENT);
    expect(payload.progress.percentComplete).not.toBe(50);
  });
});
