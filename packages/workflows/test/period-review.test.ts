// spec(§9) — task 7.11 WEEKLY / MONTHLY REVIEW — the PURE orchestration driver.
//
// These tests drive `runPeriodReview` (the pure driver) over the period-review
// activity-port FAKES (test/support/period-review-fakes.ts) + the foundation
// FakeClock + InMemoryWorkflowRunRepo + InMemoryScheduleStore + a
// FakePeriodReviewHealthSink. The driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(), so it runs entirely
// in-memory with no Temporal server (root CLAUDE.md ★ two-layer split).
//
// The 7.11 workflow is a sibling of the 7.10 daily brief (same leakage-safe GCL +
// derive-from-validated commit) but PERIOD-WINDOWED and DISTINCT (BRF-1): its
// inputs are the period's meetings/decisions/commitments, the project-progress
// deltas, and recurring-blocker detection over the window. The suite pins:
//   • PERIOD WINDOW is CLOCK-JUMP-SAFE (LIFE-5): the review window is computed from
//     clock-jump-safe bookkeeping (the 7.2 helpers), NOT naive wall-clock — a
//     forward wall/NTP jump cannot inflate the window; a backward jump cannot
//     produce an inverted/negative window.
//   • MISSED SCHEDULE collapses to ONE run (LIFE-2): a wake after many missed
//     recurrences drives exactly one review; a wake with nothing due parks in
//     no_run_due with no durable write.
//   • LEAKAGE-SAFETY (REQ-F-005/008): a raw cross-workspace string NEVER appears in
//     the global review plan / dashboard / telegram — only sanitized projections
//     cross the gate; a gate rejection parks in projection_stale.
//   • RECURRING-BLOCKER surfaces in the review outputs (the window signal).
//   • DERIVED commit: the global review commits to Global/Coordination; each
//     workspace review commits to its own repo (WS-2/WS-4).
//   • provider failure / stale connector / stale projection / write conflict →
//     typed failure states → a 7.5 health item (nothing silent).
//   • replay-safety: a re-drive reuses the commits + the telegram write (each once).
import { describe, it, expect } from "vitest";
import { isOk, workflowId } from "@sow/contracts";
import { runPeriodReview } from "../src/workflows/periodReview";
import { computeReviewWindow } from "../src/activities/periodWindow";
import type { PeriodReviewInput, PeriodReviewDeps } from "../src/workflows/periodReview";
import {
  FakeRefreshConnectorsPort,
  FakeUpdateProjectionsPort,
  FakeReviewAgentPort,
  FakeValidateReviewPort,
  FakeBuildGlobalReviewPort,
  FakeBuildWorkspaceReviewPort,
  FakeCommitReviewPort,
  FakeUpdateDashboardPort,
  FakeNotifyPort,
  FakePeriodReviewHealthSink,
  makePeriodReviewContext,
  makeGlobalReviewDraft,
  makeProjection,
  GLOBAL_WS,
  RAW_EMPLOYER_SECRET,
  RECURRING_BLOCKER,
} from "./support/period-review-fakes";
import { FakeClock, InMemoryWorkflowRunRepo, InMemoryScheduleStore } from "./support/fakes";
import type { ReviewRefreshConnectorsErrorCode } from "../src/workflows/periodReview";
import type { ReviewUpdateProjectionsErrorCode } from "../src/workflows/periodReview";
import type { ReviewAgentFailureCode } from "../src/workflows/periodReview";
import type { ReviewCommitFailureCode } from "../src/workflows/periodReview";
import type { ReviewNotifyErrorCode } from "../src/workflows/periodReview";
import type { BuildReviewFailureCode } from "../src/workflows/periodReview";
import { advanceBookkeeping } from "../src/runtime/clock";

// --- fixtures --------------------------------------------------------------

const SCHEDULE_ID = "period-review";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The period-review input. The run is a durable SCHEDULE trigger; the schedule
 * catch-up window + interval (a WEEK for the weekly review) are supplied so the
 * driver can collapse a missed schedule to one run (LIFE-2) and compute the
 * clock-jump-safe review window. The context is the bound workspace set + the
 * global target workspace.
 */
function makeInput(partial: Partial<PeriodReviewInput> = {}): PeriodReviewInput {
  return {
    run: {
      workflowId: workflowId("wf-pr-1"),
      trigger: "schedule",
      idempotencyKey: "idem-run-pr-1",
      workspaceId: GLOBAL_WS,
    },
    scheduleId: SCHEDULE_ID,
    period: "weekly",
    intervalMs: WEEK_MS,
    catchUpWindowMs: 4 * WEEK_MS,
    globalWorkspaceId: GLOBAL_WS,
    context: makePeriodReviewContext(),
    ...partial,
  };
}

/** Build a fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<PeriodReviewDeps> = {}): PeriodReviewDeps {
  return {
    refreshConnectors: new FakeRefreshConnectorsPort(),
    updateProjections: new FakeUpdateProjectionsPort(),
    agent: new FakeReviewAgentPort({ result: "accepted" }),
    validate: new FakeValidateReviewPort(),
    buildGlobal: new FakeBuildGlobalReviewPort(),
    buildWorkspace: new FakeBuildWorkspaceReviewPort(),
    commit: new FakeCommitReviewPort(),
    dashboard: new FakeUpdateDashboardPort(),
    notify: new FakeNotifyPort(),
    health: new FakePeriodReviewHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    schedule: new InMemoryScheduleStore(),
    clock: new FakeClock(),
    ...overrides,
  };
}

/** Seed schedule bookkeeping so a run IS due (lastRun far enough back). */
function seedDueSchedule(
  schedule: InMemoryScheduleStore,
  clock: FakeClock,
  msAgo: number,
): void {
  const nowMs = Date.parse(clock.now());
  const last = new Date(nowMs - msAgo).toISOString();
  void schedule.put({ scheduleId: SCHEDULE_ID, lastRunWall: last });
}

// --- the periodWindow ACTIVITY: clock-jump-safe window computation ----------
//
// The window is the distinct 7.11 seam vs the daily brief: the review reasons
// over [windowStart, windowEnd]. It MUST be clock-jump-safe (LIFE-5) — computed
// from the jump-safe elapsed bookkeeping, not a naive wall subtraction.

describe("computeReviewWindow — clock-jump-safe period window (LIFE-5)", () => {
  it("computes a weekly window ending at the clock reading, spanning one interval", () => {
    const clock = new FakeClock({ now: "2026-07-08T00:00:00.000Z" });
    const window = computeReviewWindow(
      { scheduleId: SCHEDULE_ID, lastRunWall: "2026-07-01T00:00:00.000Z" },
      clock,
      { period: "weekly", intervalMs: WEEK_MS },
    );
    expect(window.windowEnd).toBe("2026-07-08T00:00:00.000Z");
    // Non-inverted: start strictly before end.
    expect(Date.parse(window.windowStart)).toBeLessThan(Date.parse(window.windowEnd));
    expect(window.period).toBe("weekly");
  });

  it("a FORWARD wall jump cannot inflate the window past one interval (monotonic-bounded)", () => {
    // The monotonic delta says only ONE interval elapsed, but the wall clock has
    // jumped far forward. A naive `now - lastRun` would blow the window up to the
    // whole gap; the jump-safe window stays bounded by the monotonic elapsed.
    const clock = new FakeClock({
      now: "2027-01-01T00:00:00.000Z", // wall jumped ~6 months forward
      monotonicMs: WEEK_MS, // but only one week actually elapsed
      monotonicEpoch: "boot-1",
    });
    const bookkeeping = {
      scheduleId: SCHEDULE_ID,
      lastRunWall: "2026-07-01T00:00:00.000Z",
      lastRunMonotonicMs: 0,
      lastRunMonotonicEpoch: "boot-1",
    };
    const window = computeReviewWindow(bookkeeping, clock, {
      period: "weekly",
      intervalMs: WEEK_MS,
    });
    // The window span is bounded by the (monotonic) elapsed — ~one week — NOT the
    // ~6-month naive wall gap.
    const spanMs = Date.parse(window.windowEnd) - Date.parse(window.windowStart);
    expect(spanMs).toBeLessThanOrEqual(WEEK_MS + DAY_MS);
    expect(spanMs).toBeGreaterThan(0);
  });

  it("a BACKWARD wall jump never produces an inverted / negative window", () => {
    // now is BEFORE lastRun on the wall (a backward NTP step). The window must not
    // invert; the jump-safe elapsed clamps to >= 0 so windowStart <= windowEnd.
    const clock = new FakeClock({ now: "2026-06-01T00:00:00.000Z" }); // before lastRun
    const window = computeReviewWindow(
      { scheduleId: SCHEDULE_ID, lastRunWall: "2026-07-01T00:00:00.000Z" },
      clock,
      { period: "weekly", intervalMs: WEEK_MS },
    );
    expect(Date.parse(window.windowStart)).toBeLessThanOrEqual(Date.parse(window.windowEnd));
  });

  it("computes a monthly window over a 30-day interval", () => {
    const clock = new FakeClock({ now: "2026-07-31T00:00:00.000Z" });
    const window = computeReviewWindow(
      { scheduleId: SCHEDULE_ID, lastRunWall: "2026-07-01T00:00:00.000Z" },
      clock,
      { period: "monthly", intervalMs: 30 * DAY_MS },
    );
    expect(window.period).toBe("monthly");
    expect(Date.parse(window.windowStart)).toBeLessThan(Date.parse(window.windowEnd));
  });
});

// --- happy path ------------------------------------------------------------

describe("runPeriodReview — happy path", () => {
  it("drives scheduled → … → done with per-workspace + global commits and one telegram send", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS); // due (1 interval elapsed)
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ clock, schedule, commit, notify, dashboard });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("done");
    // 2 workspace reviews + 1 global review = 3 distinct commits.
    expect(commit.writeCount).toBe(3);
    // Exactly one telegram summary sent.
    expect(notify.createCount).toBe(1);
    // Dashboard read-model updated.
    expect(dashboard.payloads).toHaveLength(1);
    expect(outcome.context.globalRevisionId).toBeDefined();
    // The review window is threaded onto the context (period-scoped).
    expect(outcome.context.window).toBeDefined();
    expect(outcome.context.window?.period).toBe("weekly");
  });

  it("resolves the run idempotently through the foundation seam (reused on a seen key)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runPeriodReview(makeInput(), makeDeps({ clock, schedule, runs }));
    expect(isOk(first.run)).toBe(true);

    const schedule2 = new InMemoryScheduleStore();
    seedDueSchedule(schedule2, clock, WEEK_MS);
    const second = await runPeriodReview(makeInput(), makeDeps({ clock, schedule: schedule2, runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- RECURRING-BLOCKER surfaces in the review (BRF-1 window signal) ---------

describe("runPeriodReview — recurring blocker surfaces in the review", () => {
  it("a recurring blocker detected over the window appears in the committed review + telegram", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ clock, schedule, commit, notify, dashboard });

    const outcome = await runPeriodReview(makeInput(), deps);
    expect(outcome.state).toBe("done");

    // The recurring-blocker signal is present in the committed global plan …
    const globalPlan = commit.committedPlans.find((p) => p.workspaceId === GLOBAL_WS);
    expect(JSON.stringify(globalPlan)).toContain(RECURRING_BLOCKER);
    // … in the dashboard read-model …
    expect(JSON.stringify(dashboard.payloads)).toContain(RECURRING_BLOCKER);
    // … and in the telegram summary.
    expect(JSON.stringify(notify.sentPayloads)).toContain(RECURRING_BLOCKER);
  });
});

// --- LIFE-2: missed schedule collapses to ONE run --------------------------

describe("runPeriodReview — missed schedule collapses to one run (LIFE-2)", () => {
  it("a wake after MANY missed weekly recurrences drives EXACTLY ONE review", async () => {
    const clock = new FakeClock({ now: "2026-07-29T00:00:00.000Z" });
    const schedule = new InMemoryScheduleStore();
    // Last ran 3 weeks ago → 3 missed weekly occurrences, all inside a 4-week window.
    void schedule.put({ scheduleId: SCHEDULE_ID, lastRunWall: "2026-07-08T00:00:00.000Z" });
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({ clock, schedule, commit, notify });

    const outcome = await runPeriodReview(makeInput(), deps);

    // ONE collapsed run, not three: 3 commits (2 ws + 1 global) + 1 telegram — once.
    expect(outcome.state).toBe("done");
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);
    expect(outcome.collapsed).toBe(true);
  });

  it("a wake with NOTHING due parks in no_run_due with NO durable write", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    // Last ran at "now" — not even one interval elapsed → nothing due.
    void schedule.put(advanceBookkeeping(SCHEDULE_ID, clock));
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({ clock, schedule, commit, notify });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("no_run_due");
    expect(commit.writeCount).toBe(0);
    expect(notify.createCount).toBe(0);
  });
});

// --- LEAKAGE-SAFETY: raw cross-workspace content never reaches the global review

describe("runPeriodReview — leakage-safe global review (REQ-F-005/008)", () => {
  it("a raw cross-workspace string NEVER appears in the global review plan / dashboard / telegram", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const buildGlobal = new FakeBuildGlobalReviewPort();
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ clock, schedule, buildGlobal, commit, notify, dashboard });

    const outcome = await runPeriodReview(makeInput(), deps);
    expect(outcome.state).toBe("done");

    // The global review was derived from sanitized projections only.
    expect(buildGlobal.calls).toHaveLength(1);
    for (const p of buildGlobal.calls[0]?.projections ?? []) {
      expect(JSON.stringify(p)).not.toContain(RAW_EMPLOYER_SECRET);
    }
    // The committed GLOBAL plan carries no raw content.
    const globalPlan = commit.committedPlans.find((pl) => pl.workspaceId === GLOBAL_WS);
    expect(globalPlan).toBeDefined();
    expect(JSON.stringify(globalPlan)).not.toContain(RAW_EMPLOYER_SECRET);
    // Neither the dashboard read-model nor the telegram summary carries it.
    expect(JSON.stringify(dashboard.payloads)).not.toContain(RAW_EMPLOYER_SECRET);
    expect(JSON.stringify(notify.sentPayloads)).not.toContain(RAW_EMPLOYER_SECRET);
  });

  it("a projection failing the GCL Visibility Gate parks in projection_stale with NO review + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      updateProjections: new FakeUpdateProjectionsPort({
        failWith: "gate_rejected" satisfies ReviewUpdateProjectionsErrorCode,
      }),
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("projection_stale");
    // Fail-closed: no review committed when a projection could not be sanitized.
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("only sanitized projections reach the review agent (never raw workspace bodies)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const sanitized = [makeProjection({ sanitizedPayload: { status: "busy", closedTasks: 5 } })];
    const agent = new FakeReviewAgentPort({ result: "accepted" });
    const deps = makeDeps({
      clock,
      schedule,
      updateProjections: new FakeUpdateProjectionsPort({ projections: sanitized }),
      agent,
    });

    const outcome = await runPeriodReview(makeInput(), deps);
    expect(outcome.state).toBe("done");
    // The agent received exactly the sanitized projections — no raw content.
    const agentCtx = agent.calls[0];
    expect(agentCtx?.projections).toEqual(sanitized);
    expect(JSON.stringify(agentCtx?.projections)).not.toContain(RAW_EMPLOYER_SECRET);
  });
});

// --- DERIVED commits: global → global repo, workspace → own repo ------------

describe("runPeriodReview — derived commits target the right repos (WS-2/WS-4)", () => {
  it("the global review commits to the Global/Coordination workspace; each workspace review to its own", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const buildGlobal = new FakeBuildGlobalReviewPort();
    const buildWorkspace = new FakeBuildWorkspaceReviewPort();
    const deps = makeDeps({ clock, schedule, commit, buildGlobal, buildWorkspace });

    const outcome = await runPeriodReview(makeInput(), deps);
    expect(outcome.state).toBe("done");

    // The GLOBAL plan targets the passed global workspace (not a caller value).
    expect(buildGlobal.calls[0]?.workspaceId).toBe(GLOBAL_WS);
    // The global build got the same window bounds the driver computed.
    expect(buildGlobal.calls[0]?.window).toEqual(outcome.context.window);
    const targeted = commit.committedPlans.map((p) => String(p.workspaceId)).sort();
    expect(targeted).toEqual([String(GLOBAL_WS), "ws-employer", "ws-personal"].sort());
    // Each per-workspace plan was derived FROM the bound workspace id (WS-2/WS-4).
    const wsTargets = buildWorkspace.calls.map((c) => String(c.workspaceId)).sort();
    expect(wsTargets).toEqual(["ws-employer", "ws-personal"]);
  });

  it("an inferred field is rejected at validate → schema_rejected; build + commit never run (no-inference)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const buildGlobal = new FakeBuildGlobalReviewPort();
    const buildWorkspace = new FakeBuildWorkspaceReviewPort();
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    // Global draft with an inferred headline (concrete value, NO evidenceRef).
    const inferredGlobal = makeGlobalReviewDraft({
      fields: { headline: { value: "leaked" } },
    });
    const deps = makeDeps({
      clock,
      schedule,
      agent: new FakeReviewAgentPort({
        result: "accepted",
        output: { global: inferredGlobal, workspaceDrafts: {} },
      }),
      buildGlobal,
      buildWorkspace,
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(buildGlobal.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- typed failure states → 7.5 health item --------------------------------

describe("runPeriodReview — typed failures surface a health item (nothing silent)", () => {
  it("a stale connector parks in connector_stale with NO review + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      refreshConnectors: new FakeRefreshConnectorsPort({
        failWith: "connector_stale" satisfies ReviewRefreshConnectorsErrorCode,
      }),
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("connector_stale");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a provider failure parks in provider_failed with NO commit + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const rejection: ReviewAgentFailureCode = "provider_failed";
    const deps = makeDeps({
      clock,
      schedule,
      agent: new FakeReviewAgentPort({ result: "rejected", rejection }),
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a KnowledgeWriter conflict on the global review parks in write_conflict + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const health = new FakePeriodReviewHealthSink();
    const failWith: ReviewCommitFailureCode = "write_conflict";
    const deps = makeDeps({
      clock,
      schedule,
      commit: new FakeCommitReviewPort({ failWith }),
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("write_conflict");
    expect(health.surfaced).toHaveLength(1);
  });

  it("an output-derivation failure folds to schema_rejected with NO partial commit", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      buildGlobal: new FakeBuildGlobalReviewPort({
        failWith: "unmappable_review" satisfies BuildReviewFailureCode,
      }),
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a telegram HOLD parks in outbox_retry (non-terminal) + a health item; the commits stand", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      notify: new FakeNotifyPort({ failWith: "held" satisfies ReviewNotifyErrorCode }),
      commit,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
    // The reviews are durable (they precede notify); only the send failed closed.
    expect(commit.writeCount).toBe(3);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a dashboard-update failure surfaces a health item but does NOT roll the commit back", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, WEEK_MS);
    const commit = new FakeCommitReviewPort();
    const health = new FakePeriodReviewHealthSink();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({
      clock,
      schedule,
      dashboard: new FakeUpdateDashboardPort({ failWith: "dashboard_failed" }),
      commit,
      notify,
      health,
    });

    const outcome = await runPeriodReview(makeInput(), deps);

    // The pipeline continues past the dashboard failure — commit + telegram stand.
    expect(outcome.state).toBe("done");
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);
    // The dashboard failure was still surfaced (nothing silent).
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- replay-safety ---------------------------------------------------------

describe("runPeriodReview — replay safety (LIFE-3)", () => {
  it("a re-drive from the start reuses the commits + the telegram write (each once)", async () => {
    const clock = new FakeClock();
    const commit = new FakeCommitReviewPort();
    const notify = new FakeNotifyPort();
    const runs = new InMemoryWorkflowRunRepo();

    const schedule1 = new InMemoryScheduleStore();
    seedDueSchedule(schedule1, clock, WEEK_MS);
    const first = await runPeriodReview(
      makeInput(),
      makeDeps({ clock, schedule: schedule1, commit, notify, runs }),
    );
    expect(first.state).toBe("done");
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);

    // Restart: re-drive from the start with fresh read-stage fakes but the SAME
    // durable commit/notify/runs.
    const schedule2 = new InMemoryScheduleStore();
    seedDueSchedule(schedule2, clock, WEEK_MS);
    const second = await runPeriodReview(
      makeInput(),
      makeDeps({ clock, schedule: schedule2, commit, notify, runs }),
    );

    expect(second.state).toBe("done");
    // No duplicate durable writes across both drives.
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);
    expect(second.runReused).toBe(true);
  });
});

// --- inv-5: every failure branch surfaces a health item --------------------

describe("runPeriodReview — nothing fails silently (inv-5)", () => {
  it("every failure branch routes through the health sink", async () => {
    const clock = new FakeClock();
    const branches: Array<Partial<PeriodReviewDeps>> = [
      { refreshConnectors: new FakeRefreshConnectorsPort({ failWith: "connector_stale" }) },
      { updateProjections: new FakeUpdateProjectionsPort({ failWith: "projection_stale" }) },
      { agent: new FakeReviewAgentPort({ result: "rejected" }) },
      { validate: new FakeValidateReviewPort({ forceSchemaReject: true }) },
      { buildGlobal: new FakeBuildGlobalReviewPort({ failWith: "build_failed" }) },
      { commit: new FakeCommitReviewPort({ failWith: "write_conflict" }) },
      { notify: new FakeNotifyPort({ failWith: "approval_pending" }) },
    ];
    for (const override of branches) {
      const schedule = new InMemoryScheduleStore();
      seedDueSchedule(schedule, clock, WEEK_MS);
      const health = new FakePeriodReviewHealthSink();
      await runPeriodReview(makeInput(), makeDeps({ clock, schedule, health, ...override }));
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
  });
});
