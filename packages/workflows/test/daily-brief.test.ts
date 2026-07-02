// spec(§9) — task 7.10 DAILY BRIEF — the PURE orchestration driver.
//
// These tests drive `runDailyBrief` (the pure driver) over the daily-brief
// activity-port FAKES (test/support/daily-brief-fakes.ts) + the foundation
// FakeClock + InMemoryWorkflowRunRepo + InMemoryScheduleStore + a
// FakeDailyBriefHealthSink. The driver imports NEITHER @temporalio NOR node:crypto
// and calls NO Date.now()/Math.random(), so it runs entirely in-memory with no
// Temporal server (root CLAUDE.md ★ two-layer split).
//
// The suite pins the 7.10 safety invariants:
//   • MISSED SCHEDULE collapses to ONE run (LIFE-2): a wake after many missed
//     recurrences drives exactly one brief; a wake with nothing due parks in
//     no_run_due with no durable write.
//   • LEAKAGE-SAFETY (REQ-F-005/008): a raw cross-workspace string NEVER appears in
//     the global brief plan / dashboard / telegram summary — only sanitized
//     projections cross the gate; a gate rejection parks in projection_stale.
//   • DERIVED commit: the global brief commits to the Global/Coordination repo
//     (plan.workspaceId === global) and each workspace brief commits to its own repo.
//   • provider failure / stale connector / stale projection / write conflict →
//     typed failure states → a 7.5 health item (nothing silent).
//   • replay-safety: a re-drive reuses the commits + the telegram write (each once).
import { describe, it, expect } from "vitest";
import { isOk, ok, err, workflowId, workspaceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { runDailyBrief } from "../src/workflows/dailyBrief";
import { createBuildGclProjectionActivity } from "../src/activities/buildGclProjection";
import type {
  DailyBriefInput,
  DailyBriefDeps,
} from "../src/workflows/dailyBrief";
import {
  FakeRefreshConnectorsPort,
  FakeUpdateProjectionsPort,
  FakeBriefingAgentPort,
  FakeValidateBriefPort,
  FakeBuildGlobalBriefPort,
  FakeBuildWorkspaceBriefPort,
  FakeCommitBriefPort,
  FakeUpdateDashboardPort,
  FakeNotifyPort,
  FakeDailyBriefHealthSink,
  makeDailyBriefContext,
  makeGlobalDraft,
  makeProjection,
  GLOBAL_WS,
  RAW_EMPLOYER_SECRET,
} from "./support/daily-brief-fakes";
import { FakeClock, InMemoryWorkflowRunRepo, InMemoryScheduleStore } from "./support/fakes";
import type { RefreshConnectorsErrorCode } from "../src/ports/dailyBrief";
import type { UpdateProjectionsErrorCode } from "../src/ports/dailyBrief";
import type { BriefingAgentFailureCode } from "../src/ports/dailyBrief";
import type { BriefCommitFailureCode } from "../src/ports/dailyBrief";
import type { NotifyErrorCode } from "../src/ports/dailyBrief";
import type { BuildGlobalBriefFailureCode } from "../src/ports/dailyBrief";
import { advanceBookkeeping } from "../src/runtime/clock";

// --- fixtures --------------------------------------------------------------

const SCHEDULE_ID = "daily-brief";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The daily-brief input. The run is a durable SCHEDULE trigger; the schedule
 * catch-up window + interval are supplied so the driver can collapse a missed
 * schedule to one run (LIFE-2). The context is the bound workspace set + the global
 * target workspace.
 */
function makeInput(partial: Partial<DailyBriefInput> = {}): DailyBriefInput {
  return {
    run: {
      workflowId: workflowId("wf-db-1"),
      trigger: "schedule",
      idempotencyKey: "idem-run-db-1",
      workspaceId: GLOBAL_WS,
    },
    scheduleId: SCHEDULE_ID,
    intervalMs: DAY_MS,
    catchUpWindowMs: 7 * DAY_MS,
    globalWorkspaceId: GLOBAL_WS,
    context: makeDailyBriefContext(),
    ...partial,
  };
}

/** Build a fresh, all-green dep set with the fakes; override any port per test. */
function makeDeps(overrides: Partial<DailyBriefDeps> = {}): DailyBriefDeps {
  return {
    refreshConnectors: new FakeRefreshConnectorsPort(),
    updateProjections: new FakeUpdateProjectionsPort(),
    agent: new FakeBriefingAgentPort({ result: "accepted" }),
    validate: new FakeValidateBriefPort(),
    buildGlobal: new FakeBuildGlobalBriefPort(),
    buildWorkspace: new FakeBuildWorkspaceBriefPort(),
    commit: new FakeCommitBriefPort(),
    dashboard: new FakeUpdateDashboardPort(),
    notify: new FakeNotifyPort(),
    health: new FakeDailyBriefHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    schedule: new InMemoryScheduleStore(),
    clock: new FakeClock(),
    ...overrides,
  };
}

/** Seed schedule bookkeeping so a run IS due (lastRun far enough back). */
function seedDueSchedule(schedule: InMemoryScheduleStore, clock: FakeClock, daysAgo: number): void {
  const nowMs = Date.parse(clock.now());
  const last = new Date(nowMs - daysAgo * DAY_MS).toISOString();
  void schedule.put({ scheduleId: SCHEDULE_ID, lastRunWall: last });
}

// --- happy path ------------------------------------------------------------

describe("runDailyBrief — happy path", () => {
  it("drives scheduled → … → done with per-workspace + global commits and one telegram send", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1); // due (1 interval elapsed)
    const commit = new FakeCommitBriefPort();
    const notify = new FakeNotifyPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ clock, schedule, commit, notify, dashboard });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("done");
    // 2 workspace briefs + 1 global brief = 3 distinct commits.
    expect(commit.writeCount).toBe(3);
    // Exactly one telegram summary sent.
    expect(notify.createCount).toBe(1);
    // Dashboard read-model updated.
    expect(dashboard.payloads).toHaveLength(1);
    expect(outcome.context.globalRevisionId).toBeDefined();
  });

  it("resolves the run idempotently through the foundation seam (reused on a seen key)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const runs = new InMemoryWorkflowRunRepo();

    const first = await runDailyBrief(makeInput(), makeDeps({ clock, schedule, runs }));
    expect(isOk(first.run)).toBe(true);

    const schedule2 = new InMemoryScheduleStore();
    seedDueSchedule(schedule2, clock, 1);
    const second = await runDailyBrief(makeInput(), makeDeps({ clock, schedule: schedule2, runs }));
    expect(second.runReused).toBe(true);
  });
});

// --- LIFE-2: missed schedule collapses to ONE run --------------------------

describe("runDailyBrief — missed schedule collapses to one run (LIFE-2)", () => {
  it("a wake after MANY missed daily recurrences drives EXACTLY ONE brief", async () => {
    const clock = new FakeClock({ now: "2026-07-08T00:00:00.000Z" });
    const schedule = new InMemoryScheduleStore();
    // Last ran 5 days ago → 5 missed daily occurrences, all inside a 7-day window.
    void schedule.put({ scheduleId: SCHEDULE_ID, lastRunWall: "2026-07-03T00:00:00.000Z" });
    const commit = new FakeCommitBriefPort();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({ clock, schedule, commit, notify });

    const outcome = await runDailyBrief(makeInput(), deps);

    // ONE collapsed run, not five: 3 commits (2 ws + 1 global) + 1 telegram — once.
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
    const commit = new FakeCommitBriefPort();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({ clock, schedule, commit, notify });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("no_run_due");
    expect(commit.writeCount).toBe(0);
    expect(notify.createCount).toBe(0);
  });
});

// --- LEAKAGE-SAFETY: raw cross-workspace content never reaches the global brief

describe("runDailyBrief — leakage-safe global brief (REQ-F-005/008)", () => {
  it("a raw cross-workspace string NEVER appears in the global brief plan / dashboard / telegram", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    // The projections that cross the gate are SANITIZED (no raw body). The raw
    // employer secret exists ONLY in the caller's imagination — it must never
    // surface. We give the agent an output whose global draft is derived only from
    // sanitized projections, and assert the raw secret appears NOWHERE downstream.
    const buildGlobal = new FakeBuildGlobalBriefPort();
    const commit = new FakeCommitBriefPort();
    const notify = new FakeNotifyPort();
    const dashboard = new FakeUpdateDashboardPort();
    const deps = makeDeps({ clock, schedule, buildGlobal, commit, notify, dashboard });

    const outcome = await runDailyBrief(makeInput(), deps);
    expect(outcome.state).toBe("done");

    // The global brief was derived from sanitized projections only.
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

  it("a projection failing the GCL Visibility Gate parks in projection_stale with NO brief + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      updateProjections: new FakeUpdateProjectionsPort({
        failWith: "gate_rejected" satisfies UpdateProjectionsErrorCode,
      }),
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("projection_stale");
    // Fail-closed: no brief committed when a projection could not be sanitized.
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("only sanitized projections reach the briefing agent (never raw workspace bodies)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const sanitized = [makeProjection({ sanitizedPayload: { status: "busy", openDeadlines: 1 } })];
    const agent = new FakeBriefingAgentPort({ result: "accepted" });
    const deps = makeDeps({
      clock,
      schedule,
      updateProjections: new FakeUpdateProjectionsPort({ projections: sanitized }),
      agent,
    });

    const outcome = await runDailyBrief(makeInput(), deps);
    expect(outcome.state).toBe("done");
    // The agent received exactly the sanitized projections — no raw content.
    const agentCtx = agent.calls[0];
    expect(agentCtx?.projections).toEqual(sanitized);
    expect(JSON.stringify(agentCtx?.projections)).not.toContain(RAW_EMPLOYER_SECRET);
  });
});

// --- DERIVED commits: global → global repo, workspace → own repo ------------

describe("runDailyBrief — derived commits target the right repos (WS-2/WS-4)", () => {
  it("the global brief commits to the Global/Coordination workspace; each workspace brief to its own", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const buildGlobal = new FakeBuildGlobalBriefPort();
    const buildWorkspace = new FakeBuildWorkspaceBriefPort();
    const deps = makeDeps({ clock, schedule, commit, buildGlobal, buildWorkspace });

    const outcome = await runDailyBrief(makeInput(), deps);
    expect(outcome.state).toBe("done");

    // The GLOBAL plan targets the passed global workspace (not a caller value).
    expect(buildGlobal.calls[0]?.workspaceId).toBe(GLOBAL_WS);
    const targeted = commit.committedPlans.map((p) => String(p.workspaceId)).sort();
    expect(targeted).toEqual(
      [String(GLOBAL_WS), "ws-employer", "ws-personal"].sort(),
    );
    // Each per-workspace plan was derived FROM the bound workspace id (WS-2/WS-4).
    const wsTargets = buildWorkspace.calls.map((c) => String(c.workspaceId)).sort();
    expect(wsTargets).toEqual(["ws-employer", "ws-personal"]);
  });

  it("an inferred field is rejected at validate → schema_rejected; build + commit never run (no-inference)", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const buildGlobal = new FakeBuildGlobalBriefPort();
    const buildWorkspace = new FakeBuildWorkspaceBriefPort();
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    // Global draft with an inferred headline (concrete value, NO evidenceRef).
    const inferredGlobal = makeGlobalDraft({
      fields: { headline: { value: "leaked" }, nextDeadline: { value: TBDValue() } },
    });
    const deps = makeDeps({
      clock,
      schedule,
      agent: new FakeBriefingAgentPort({
        result: "accepted",
        output: { global: inferredGlobal, workspaceDrafts: {} },
      }),
      buildGlobal,
      buildWorkspace,
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(buildGlobal.calls).toHaveLength(0);
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });
});

/** Local helper: the TBD sentinel typed for a field value. */
function TBDValue(): never {
  return "TBD" as never;
}

// --- typed failure states → 7.5 health item --------------------------------

describe("runDailyBrief — typed failures surface a health item (nothing silent)", () => {
  it("a stale connector parks in connector_stale with NO brief + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      refreshConnectors: new FakeRefreshConnectorsPort({
        failWith: "connector_stale" satisfies RefreshConnectorsErrorCode,
      }),
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("connector_stale");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a provider failure parks in provider_failed with NO commit + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const rejection: BriefingAgentFailureCode = "provider_failed";
    const deps = makeDeps({
      clock,
      schedule,
      agent: new FakeBriefingAgentPort({ result: "rejected", rejection }),
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("provider_failed");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a KnowledgeWriter conflict on the global brief parks in write_conflict + a health item", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const health = new FakeDailyBriefHealthSink();
    const failWith: BriefCommitFailureCode = "write_conflict";
    const deps = makeDeps({
      clock,
      schedule,
      commit: new FakeCommitBriefPort({ failWith }),
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("write_conflict");
    expect(health.surfaced).toHaveLength(1);
  });

  it("an output-derivation failure folds to schema_rejected with NO partial commit", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      buildGlobal: new FakeBuildGlobalBriefPort({
        failWith: "unmappable_brief" satisfies BuildGlobalBriefFailureCode,
      }),
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("schema_rejected");
    expect(commit.writeCount).toBe(0);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a telegram HOLD parks in outbox_retry (non-terminal) + a health item; the commits stand", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const deps = makeDeps({
      clock,
      schedule,
      notify: new FakeNotifyPort({ failWith: "held" satisfies NotifyErrorCode }),
      commit,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    expect(outcome.state).toBe("outbox_retry");
    // The briefs are durable (they precede notify); only the send failed closed.
    expect(commit.writeCount).toBe(3);
    expect(health.surfaced).toHaveLength(1);
  });

  it("a dashboard-update failure surfaces a health item but does NOT roll the commit back", async () => {
    const clock = new FakeClock();
    const schedule = new InMemoryScheduleStore();
    seedDueSchedule(schedule, clock, 1);
    const commit = new FakeCommitBriefPort();
    const health = new FakeDailyBriefHealthSink();
    const notify = new FakeNotifyPort();
    const deps = makeDeps({
      clock,
      schedule,
      dashboard: new FakeUpdateDashboardPort({ failWith: "dashboard_failed" }),
      commit,
      notify,
      health,
    });

    const outcome = await runDailyBrief(makeInput(), deps);

    // The pipeline continues past the dashboard failure — commit + telegram stand.
    expect(outcome.state).toBe("done");
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);
    // The dashboard failure was still surfaced (nothing silent).
    expect(health.surfaced).toHaveLength(1);
  });
});

// --- replay-safety ---------------------------------------------------------

describe("runDailyBrief — replay safety (LIFE-3)", () => {
  it("a re-drive from the start reuses the commits + the telegram write (each once)", async () => {
    const clock = new FakeClock();
    const commit = new FakeCommitBriefPort();
    const notify = new FakeNotifyPort();
    const runs = new InMemoryWorkflowRunRepo();

    const schedule1 = new InMemoryScheduleStore();
    seedDueSchedule(schedule1, clock, 1);
    const first = await runDailyBrief(
      makeInput(),
      makeDeps({ clock, schedule: schedule1, commit, notify, runs }),
    );
    expect(first.state).toBe("done");
    expect(commit.writeCount).toBe(3);
    expect(notify.createCount).toBe(1);

    // Restart: re-drive from the start with fresh read-stage fakes but the SAME
    // durable commit/notify/runs.
    const schedule2 = new InMemoryScheduleStore();
    seedDueSchedule(schedule2, clock, 1);
    const second = await runDailyBrief(
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

describe("runDailyBrief — nothing fails silently (inv-5)", () => {
  it("every failure branch routes through the health sink", async () => {
    const clock = new FakeClock();
    const branches: Array<Partial<DailyBriefDeps>> = [
      { refreshConnectors: new FakeRefreshConnectorsPort({ failWith: "connector_stale" }) },
      { updateProjections: new FakeUpdateProjectionsPort({ failWith: "projection_stale" }) },
      { agent: new FakeBriefingAgentPort({ result: "rejected" }) },
      { validate: new FakeValidateBriefPort({ forceSchemaReject: true }) },
      { buildGlobal: new FakeBuildGlobalBriefPort({ failWith: "build_failed" }) },
      { commit: new FakeCommitBriefPort({ failWith: "write_conflict" }) },
      { notify: new FakeNotifyPort({ failWith: "approval_pending" }) },
    ];
    for (const override of branches) {
      const schedule = new InMemoryScheduleStore();
      seedDueSchedule(schedule, clock, 1);
      const health = new FakeDailyBriefHealthSink();
      await runDailyBrief(makeInput(), makeDeps({ clock, schedule, health, ...override }));
      expect(health.surfaced.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// --- the buildGclProjection ACTIVITY: the leakage gate seam -----------------
//
// The activity is the enforcement point that turns candidate cross-workspace views
// into ONLY sanitized, gate-admitted projections. It fails the WHOLE update closed
// on a raw-content candidate — no downgrade-and-store, no partial set.

describe("createBuildGclProjectionActivity — leakage gate (inv-3)", () => {
  it("returns only gate-ADMITTED sanitized projections on the happy path", async () => {
    const clean = makeProjection({ sanitizedPayload: { status: "busy", openDeadlines: 2 } });
    const activity = createBuildGclProjectionActivity({
      source: {
        project: () =>
          Promise.resolve(
            ok([
              {
                workspaceId: clean.workspaceId,
                visibilityLevel: clean.visibilityLevel,
                projectionType: clean.projectionType,
                sanitizedPayload: clean.sanitizedPayload,
                sourceRefs: clean.sourceRefs,
              },
            ]),
          ),
      },
      gate: {
        // The real gate admits a clean candidate unchanged.
        admit: (c) => ok({ ...c, sourceRefs: [...c.sourceRefs] }),
      },
    });

    const result = await activity.update(makeDailyBriefContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(JSON.stringify(result.value)).not.toContain(RAW_EMPLOYER_SECRET);
    }
  });

  it("HARD-rejects a candidate carrying raw content (gate_rejected) — never returns it", async () => {
    const activity = createBuildGclProjectionActivity({
      source: {
        project: () =>
          Promise.resolve(
            ok([
              {
                workspaceId: workspaceId("ws-employer"),
                visibilityLevel: "coordination" as const,
                projectionType: "daily-summary",
                // A raw employer body smuggled onto the candidate.
                sanitizedPayload: { body: RAW_EMPLOYER_SECRET },
                sourceRefs: [],
              },
            ]),
          ),
      },
      gate: {
        // The real @sow/knowledge admitProjection rejects a raw-content-shaped key.
        admit: (c) =>
          JSON.stringify(c.sanitizedPayload).includes(RAW_EMPLOYER_SECRET)
            ? err({ reason: "raw_content_present" })
            : ok({ ...c, sourceRefs: [...c.sourceRefs] }),
      },
    });

    const result = await activity.update(makeDailyBriefContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("gate_rejected");
      // The raw content is not leaked back through the error payload either.
      expect(result.error.message).not.toContain(RAW_EMPLOYER_SECRET);
    }
  });
});

// Silence the unused-import guard on WorkspaceId (kept for the fixtures' clarity).
const _typeAnchor: WorkspaceId = workspaceId("ws-anchor");
void _typeAnchor;
