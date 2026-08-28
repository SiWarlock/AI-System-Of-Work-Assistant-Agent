// @sow/worker — 25.1 SMOKE TEST (SOW_TEMPORAL-gated): each newly-exposed output workflow
// (dailyBriefWorkflow / periodReviewWorkflow / projectSyncWorkflow /
// crossCalendarSchedulingWorkflow) STARTS and RESOLVES over a REAL @temporalio Worker
// (an ephemeral TestWorkflowEnvironment + the SAME bundled workflow sandbox the real
// worker registers — proofSpineWorkflowsPath/PROOF_SPINE_IGNORE_MODULES/
// proofSpineWebpackConfigHook, unmodified, imported from registerWorker.ts).
//
// This is a SMOKE test, not a happy-path proof (that is 25.2-25.5's job, once the
// composition root binds real activities — a crossTerritoryNeed this task's own
// workflows.ts doc comments name). Each fake activities object implements ONLY the
// family's first-step activity (returning a typed refusal immediately) + its
// surfaceFailure sink — the driver short-circuits on the refusal and rests at a
// failure/park state, which is a genuine RESOLVE (the workflow execution completes;
// nothing hangs, nothing throws across the sandbox boundary). Proves:
//   (1) the sandbox bundle compiles with all four new exports present (bundleWorkflowCode
//       succeeds — the same stub/ignoreModules config the real worker uses);
//   (2) `client.workflow.execute("dailyBriefWorkflow", ...)` etc. resolve each new
//       TYPE NAME to workflows.ts's real export (a wrong/missing export fails to start,
//       not silently);
//   (3) the FIRST proxied activity name each wrapper calls is exactly what
//       `OutputWorkflowActivities`/`projectSyncRegistryActivities` declares (a typo in
//       the activity-name string only workflows.ts owns would surface as an
//       "activity not registered" fault here, not at typecheck time).
//
// (WP2 addition) — the SAME three proofs, for the SCHEDULED entry points
// (dailyBriefScheduledWorkflow / periodReviewScheduledWorkflow /
// crossCalendarSchedulingScheduledWorkflow): each resolves its TYPE NAME to a real
// export (a mismatch with scheduleArgs.ts's DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE etc.
// fails to START, not silently), and each reaches its family's first refused activity
// ONLY after successfully driving the DURABLE `SCHEDULED_RUNTIME_ACTIVITY_NAMES`
// proxies (resolveRun's idempotency lookup+create, and — for dailyBrief/periodReview —
// the LIFE-2 catch-up bookkeeping read) — proving those proxy names are exactly what
// the composition root must register, not a typo only surfacing live.
//
// GATED: `describe.skipIf(!SOW_TEMPORAL)` — the default suite must never need a live
// Temporal server (mirrors test/integration/proof-spine.test.ts's own gating exactly).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ok, err, workspaceId, workflowId } from "@sow/contracts";
import type {
  DailyBriefInput,
  DailyBriefOutcome,
  PeriodReviewInput,
  PeriodReviewOutcome,
  ProjectSyncInput,
  ProjectSyncOutcome,
  CrossCalendarSchedulingInput,
  CrossCalendarSchedulingOutcome,
} from "@sow/workflows";

import { SOW_TEMPORAL } from "../support/temporalGate";
import {
  proofSpineWorkflowsPath,
  PROOF_SPINE_IGNORE_MODULES,
  proofSpineWebpackConfigHook,
} from "../../src/temporal/registerWorker";
import {
  SCHEDULED_RUNTIME_ACTIVITY_NAMES,
  DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE,
  PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE,
  CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE,
} from "../../src/temporal/scheduleArgs";
import type {
  DailyBriefScheduleArgs,
  PeriodReviewScheduleArgs,
  CrossCalendarSchedulingScheduleArgs,
} from "../../src/temporal/scheduleArgs";

const TASK_QUEUE = "sow-control-plane";
const WS = workspaceId("ws-output-smoke");

/**
 * The MINIMAL fake activities object: one first-step activity per family (an
 * immediate typed refusal — no real backend, no I/O) + that family's surfaceFailure
 * sink (an `ok` acknowledgement). Every OTHER `OutputWorkflowActivities` member is
 * deliberately ABSENT — the drivers short-circuit before reaching them, so they are
 * never scheduled and their absence never surfaces (Temporal only errors on an
 * activity that is actually CALLED and not registered).
 */
const fakeActivities = {
  dailyBriefRefreshConnectors: () =>
    Promise.resolve(err({ code: "connector_unreachable", message: "smoke: no real connector" })),
  dailyBriefSurfaceFailure: () => Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false })),

  periodReviewRefreshConnectors: () =>
    Promise.resolve(err({ code: "connector_unreachable", message: "smoke: no real connector" })),
  periodReviewSurfaceFailure: () => Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false })),

  projectSyncResolveRegistry: () =>
    Promise.resolve(err({ code: "project_unknown", message: "smoke: registry not bound (25.1 crossTerritoryNeed)" })),
  projectSyncSurfaceFailure: () => Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false })),

  crossCalendarGatherAvailability: () =>
    Promise.resolve(err({ code: "calendar_unreachable", message: "smoke: no real calendar source" })),
  crossCalendarSurfaceFailure: () => Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false })),

  // (WP2 addition) the DURABLE run-repo + schedule-store activities the THREE
  // scheduled entry points drive via resolveRun (7.4) + the LIFE-2 catch-up check —
  // BEFORE reaching each family's first refused activity above. Keyed off the SAME
  // frozen SCHEDULED_RUNTIME_ACTIVITY_NAMES constant workflows.ts's `scheduledRunRepo`/
  // `scheduledScheduleStore` proxy against: a name here drifted from that constant
  // would surface as an "activity not registered" fault, which is exactly what this
  // smoke test exists to catch (see proof (3) in the module header).
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGetByIdempotencyKey]: () =>
    Promise.resolve(err({ code: "not_found", message: "smoke: novel idempotency key" })),
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate]: (ref: unknown) => Promise.resolve(ok(ref)),
  // First-run bookkeeping (undefined) — the LIFE-2 catch-up treats it as due and lets
  // the daily-brief/period-review driver proceed to its first refused activity, same
  // as the direct-start smoke cases above.
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]: () => Promise.resolve(undefined),
};

interface Rig {
  readonly execute: <R>(workflowType: string, wfId: string, arg: unknown) => Promise<R>;
}

let rig: Rig | undefined;
let teardown: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!SOW_TEMPORAL) return;
  const { TestWorkflowEnvironment } = await import("@temporalio/testing");
  const { Worker, bundleWorkflowCode } = await import("@temporalio/worker");

  const bundle = await bundleWorkflowCode({
    workflowsPath: proofSpineWorkflowsPath(),
    ignoreModules: [...PROOF_SPINE_IGNORE_MODULES],
    webpackConfigHook: proofSpineWebpackConfigHook,
  });
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowBundle: bundle,
    activities: fakeActivities as unknown as Record<string, unknown>,
  });
  const runPromise = worker.run();

  rig = {
    execute: <R>(workflowType: string, wfId: string, arg: unknown): Promise<R> =>
      env.client.workflow.execute(workflowType, {
        workflowId: wfId,
        taskQueue: TASK_QUEUE,
        args: [arg],
      }) as Promise<R>,
  };
  teardown = async (): Promise<void> => {
    worker.shutdown();
    await runPromise.catch(() => undefined);
    await env.teardown();
  };
}, 120_000);

afterAll(async () => {
  await teardown?.();
  rig = undefined;
  teardown = undefined;
});

function getRig(): Rig {
  if (rig === undefined) throw new Error("output-workflow smoke rig not initialised");
  return rig;
}

describe.skipIf(!SOW_TEMPORAL)("25.1 output-workflow bundle — smoke start resolves", () => {
  it("dailyBriefWorkflow starts and resolves (parks on the refused connector refresh)", async () => {
    const input: DailyBriefInput = {
      run: { workflowId: workflowId("wf-brief-smoke"), trigger: "owner_action", idempotencyKey: "run:brief:smoke" },
      scheduleId: "smoke-daily-brief",
      intervalMs: 86_400_000,
      catchUpWindowMs: 3_600_000,
      globalWorkspaceId: WS,
      context: { scopes: [] },
    };
    const outcome = await getRig().execute<DailyBriefOutcome>("dailyBriefWorkflow", "wf-brief-smoke", input);
    expect(outcome.state).toBe("connector_stale");
    expect(outcome.surfaced).toBeDefined();
  });

  it("periodReviewWorkflow starts and resolves (parks on the refused connector refresh)", async () => {
    const input: PeriodReviewInput = {
      run: { workflowId: workflowId("wf-review-smoke"), trigger: "owner_action", idempotencyKey: "run:review:smoke" },
      scheduleId: "smoke-period-review",
      period: "weekly",
      intervalMs: 604_800_000,
      catchUpWindowMs: 3_600_000,
      globalWorkspaceId: WS,
      context: { scopes: [] },
    };
    const outcome = await getRig().execute<PeriodReviewOutcome>(
      "periodReviewWorkflow",
      "wf-review-smoke",
      input,
    );
    expect(outcome.state).toBe("connector_stale");
    expect(outcome.surfaced).toBeDefined();
  });

  it("projectSyncWorkflow starts and resolves (parks on the unbound registry — the 25.1 crossTerritoryNeed)", async () => {
    const input: ProjectSyncInput = {
      run: { workflowId: workflowId("wf-sync-smoke"), trigger: "owner_action", idempotencyKey: "run:sync:smoke" },
      context: { projectRef: "smoke-project" },
    };
    const outcome = await getRig().execute<ProjectSyncOutcome>("projectSyncWorkflow", "wf-sync-smoke", input);
    expect(outcome.state).toBe("provider_unmapped");
    expect(outcome.surfaced).toBeDefined();
  });

  it("crossCalendarSchedulingWorkflow starts and resolves (parks on the refused availability gather)", async () => {
    const input: CrossCalendarSchedulingInput = {
      run: { workflowId: workflowId("wf-cal-smoke"), trigger: "owner_action", idempotencyKey: "run:cal:smoke" },
      context: { sources: [], organizerWorkspaceId: WS },
    };
    const outcome = await getRig().execute<CrossCalendarSchedulingOutcome>(
      "crossCalendarSchedulingWorkflow",
      "wf-cal-smoke",
      input,
    );
    expect(outcome.state).toBe("calendar_unreachable");
    expect(outcome.surfaced).toBeDefined();
  });

  // (WP2 addition) — the SCHEDULED entry points. Each takes the STATIC *ScheduleArgs
  // envelope (never a pre-built *Input — that is exactly the point: the scheduled
  // wrapper derives `run` in-sandbox from `workflowInfo().workflowId`, see
  // scheduleArgs.ts's header), drives the durable run-repo/schedule-store proxies
  // registered above, and rests at the SAME failure/park state as its direct-start
  // sibling once it reaches the family's first refused activity — proving the whole
  // durable seam (resolveRun + LIFE-2 bookkeeping where applicable) actually ran
  // rather than being skipped or silently failing to start.

  it("dailyBriefScheduledWorkflow starts and resolves (parks on the refused connector refresh)", async () => {
    const args: DailyBriefScheduleArgs = {
      scheduleId: "smoke-daily-brief-scheduled",
      intervalMs: 86_400_000,
      catchUpWindowMs: 3_600_000,
      globalWorkspaceId: WS,
      scopes: [],
    };
    const outcome = await getRig().execute<DailyBriefOutcome>(
      DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE,
      "wf-brief-scheduled-smoke",
      args,
    );
    expect(outcome.state).toBe("connector_stale");
    expect(outcome.surfaced).toBeDefined();
  });

  it("periodReviewScheduledWorkflow starts and resolves (parks on the refused connector refresh)", async () => {
    const args: PeriodReviewScheduleArgs = {
      scheduleId: "smoke-period-review-scheduled",
      period: "weekly",
      intervalMs: 604_800_000,
      catchUpWindowMs: 3_600_000,
      globalWorkspaceId: WS,
      scopes: [],
    };
    const outcome = await getRig().execute<PeriodReviewOutcome>(
      PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE,
      "wf-review-scheduled-smoke",
      args,
    );
    expect(outcome.state).toBe("connector_stale");
    expect(outcome.surfaced).toBeDefined();
  });

  it("crossCalendarSchedulingScheduledWorkflow starts and resolves (parks on the refused availability gather)", async () => {
    const args: CrossCalendarSchedulingScheduleArgs = {
      scheduleId: "smoke-cross-calendar-scheduled",
      organizerWorkspaceId: WS,
      sources: [],
    };
    const outcome = await getRig().execute<CrossCalendarSchedulingOutcome>(
      CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE,
      "wf-cal-scheduled-smoke",
      args,
    );
    expect(outcome.state).toBe("calendar_unreachable");
    expect(outcome.surfaced).toBeDefined();
  });
});
