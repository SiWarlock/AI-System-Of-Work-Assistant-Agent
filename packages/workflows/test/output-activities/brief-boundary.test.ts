// spec(§9 REQ-F-005/008, safety rule 4) — PKG-W3 25.2: the daily-brief LEAKAGE
// BOUNDARY, driven end-to-end through `runDailyBrief` (the real pure driver)
// with the REAL `updateProjections` activity — `createBuildGclProjectionActivity`
// bound to the REAL `createGclProjectionGate` (activities/gclProjectionGate.ts,
// wrapping @sow/knowledge's `serveProjection`) — everything else the SAME
// all-green fakes daily-brief.test.ts already uses.
//
// The test feeds an Employer-Work workspace's candidate projection carrying a
// RAW body under a raw-content-shaped key (`body`), drives a GLOBAL brief run,
// and asserts the raw employer secret NEVER appears anywhere in the drive
// outcome — proving the real GCL Visibility Gate, not a fake, is what blocks it.
// A second case swaps the REAL gate for a bypass stub (simulating a caller that
// skips the projection adapter) and shows the SAME marker DOES leak through —
// the mutation-verification that the first assertion is load-bearing, not
// vacuously green.
import { describe, it, expect } from "vitest";
import { ok, sourceId, workspaceId, workflowId, defaultWorkspace } from "@sow/contracts";
import type { Workspace, WorkspaceId } from "@sow/contracts";
import { runDailyBrief } from "../../src/workflows/dailyBrief";
import type { DailyBriefInput, DailyBriefDeps } from "../../src/workflows/dailyBrief";
import { createBuildGclProjectionActivity } from "../../src/activities/buildGclProjection";
import type { ProjectionSource, ProjectionGate, CandidateProjection } from "../../src/activities/buildGclProjection";
import { createGclProjectionGate } from "../../src/activities/gclProjectionGate";
import {
  FakeRefreshConnectorsPort,
  FakeBriefingAgentPort,
  FakeValidateBriefPort,
  FakeBuildGlobalBriefPort,
  FakeBuildWorkspaceBriefPort,
  FakeCommitBriefPort,
  FakeUpdateDashboardPort,
  FakeNotifyPort,
  FakeDailyBriefHealthSink,
  makeDailyBriefContext,
  GLOBAL_WS,
  RAW_EMPLOYER_SECRET,
} from "../support/daily-brief-fakes";
import { FakeClock, InMemoryWorkflowRunRepo, InMemoryScheduleStore } from "../support/fakes";

const EMPLOYER_WS = workspaceId("ws-employer-boundary");

const EMPLOYER_WORKSPACE: Workspace = defaultWorkspace({
  id: String(EMPLOYER_WS),
  name: "Acme (Employer-Work)",
  type: "employer_work",
  markdownRepoPath: "/vault/acme-boundary",
  gbrainBrainId: "brain-acme-boundary",
});

/** A hostile candidate: employer-work content whose `sanitizedPayload` carries
 *  the marker under a raw-content-shaped key (`body`) — exactly the shape the
 *  real GCL Visibility Gate's raw-content refine exists to reject. */
function hostileCandidate(): CandidateProjection {
  return {
    workspaceId: EMPLOYER_WS,
    visibilityLevel: "coordination",
    projectionType: "daily-summary",
    sanitizedPayload: { body: RAW_EMPLOYER_SECRET },
    sourceRefs: [{ sourceId: sourceId("src-employer-boundary-1") }],
  };
}

const hostileSource: ProjectionSource = {
  project: () => Promise.resolve(ok([hostileCandidate()])),
};

/** A bypass "gate" that admits any candidate unchanged — simulates a caller
 *  that skips the real projection adapter (never wired in production; used
 *  ONLY to prove the first assertion is load-bearing). */
const bypassGate: ProjectionGate = {
  admit: (c) => Promise.resolve(ok({ ...c, sourceRefs: [...c.sourceRefs] })),
};

function makeInput(): DailyBriefInput {
  return {
    run: {
      workflowId: workflowId("wf-brief-boundary"),
      trigger: "schedule",
      idempotencyKey: "idem-brief-boundary",
      workspaceId: GLOBAL_WS,
    },
    scheduleId: "daily-brief-boundary",
    intervalMs: 24 * 60 * 60 * 1000,
    catchUpWindowMs: 7 * 24 * 60 * 60 * 1000,
    globalWorkspaceId: GLOBAL_WS,
    context: makeDailyBriefContext({
      scopes: [{ workspaceId: EMPLOYER_WS, brainId: "brain-acme-boundary" }],
    }),
  };
}

function makeDeps(gate: ProjectionGate): DailyBriefDeps {
  const clock = new FakeClock();
  const schedule = new InMemoryScheduleStore();
  // Seed bookkeeping so the run is due (LIFE-2 collapse is not what's under test here).
  void schedule.put({
    scheduleId: "daily-brief-boundary",
    lastRunWall: new Date(Date.parse(clock.now()) - 24 * 60 * 60 * 1000).toISOString(),
  });
  return {
    refreshConnectors: new FakeRefreshConnectorsPort(),
    updateProjections: createBuildGclProjectionActivity({ source: hostileSource, gate }),
    agent: new FakeBriefingAgentPort({ result: "accepted" }),
    validate: new FakeValidateBriefPort(),
    buildGlobal: new FakeBuildGlobalBriefPort(),
    buildWorkspace: new FakeBuildWorkspaceBriefPort(),
    commit: new FakeCommitBriefPort(),
    dashboard: new FakeUpdateDashboardPort(),
    notify: new FakeNotifyPort(),
    health: new FakeDailyBriefHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    schedule,
    clock,
  };
}

describe("daily-brief leakage boundary — the REAL GCL Visibility Gate (25.2)", () => {
  it("the REAL gate blocks the raw employer body — zero raw bytes reach the drive outcome", async () => {
    const realGate = createGclProjectionGate((id: WorkspaceId) =>
      id === EMPLOYER_WS ? EMPLOYER_WORKSPACE : undefined,
    );
    const outcome = await runDailyBrief(makeInput(), makeDeps(realGate));

    // The real gate HARD-rejects the raw-content-shaped candidate: the driver
    // parks fail-closed BEFORE any commit — never sanitized-and-stored.
    expect(outcome.state).toBe("projection_stale");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(RAW_EMPLOYER_SECRET);
    // The health surface itself must not have leaked the raw body either.
    expect(outcome.surfaced?.message).not.toContain(RAW_EMPLOYER_SECRET);
  });

  it("MUTATION CHECK: bypassing the projection adapter lets the same marker leak — proves the first assertion is load-bearing", async () => {
    const outcome = await runDailyBrief(makeInput(), makeDeps(bypassGate));

    // With the gate bypassed, the pipeline proceeds past projections_updated and
    // the raw body DOES reach the threaded context — the counterfactual that
    // proves the REAL-gate test above is discriminating, not vacuously green.
    expect(outcome.state).not.toBe("projection_stale");
    const serialized = JSON.stringify(outcome);
    expect(serialized).toContain(RAW_EMPLOYER_SECRET);
  });
});
