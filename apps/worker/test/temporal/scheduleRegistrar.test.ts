// @sow/worker — 25.SCHED leg 1: the DURABLE Temporal schedule registrar (RED-first).
//
// `createTemporalScheduleRegistrar` performs an IDEMPOTENT create-or-update per
// scheduleId against an injected {@link ScheduleClientPort} (a narrow port shaped
// after the real `@temporalio/client` `ScheduleClient` — see scheduleRegistrar.ts
// for why it is not the SDK class directly). Every unit here runs over a FAKE
// port; no Temporal server, no I/O. Three properties are load-bearing:
//   (a) an UNKNOWN scheduleId is CREATED exactly once, always `paused: true`;
//   (b) a REPEAT `ensure` of the SAME spec issues exactly one create + one no-op
//       update — never a second create (idempotent, safe to call every boot);
//   (c) a client fault (describe/create/update all throw) folds to a typed
//       refusal — never a throw across the boundary (§16).
// NOTHING here unpauses a schedule — `update` never carries a `paused` field, so
// there is no code path in this module that can flip one to live.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  createTemporalScheduleRegistrar,
  gateIngestionTriageSchedule,
  buildIngestionTriageScheduleSpec,
  INGESTION_TRIAGE_SCHEDULE_ID,
  gateProjectSyncSchedule,
  buildProjectSyncScheduleSpec,
  PROJECT_SYNC_SCHEDULE_ID,
  gateDailyBriefSchedule,
  buildDailyBriefScheduleSpec,
  DAILY_BRIEF_SCHEDULE_ID,
  gatePeriodReviewWeeklySchedule,
  buildPeriodReviewWeeklyScheduleSpec,
  PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
  gatePeriodReviewMonthlySchedule,
  buildPeriodReviewMonthlyScheduleSpec,
  PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
  gateCrossCalendarSchedulingSchedule,
  buildCrossCalendarSchedulingScheduleSpec,
  CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
  type ScheduleClientPort,
  type TemporalScheduleSpec,
} from "../../src/temporal/scheduleRegistrar";

const SPEC: TemporalScheduleSpec = {
  scheduleId: "sched-1",
  intervalMs: 60_000,
  action: {
    workflowType: "someWorkflow",
    workflowId: "sched-1-workflow",
    taskQueue: "sow-control-plane",
    args: [],
  },
};

interface FakeClientCalls {
  readonly describe: string[];
  readonly create: Array<{ spec: TemporalScheduleSpec; opts: { readonly paused: true } }>;
  readonly update: TemporalScheduleSpec[];
}

/** A controllable fake ScheduleClientPort that records every call it receives. */
function fakeClient(overrides: Partial<ScheduleClientPort> = {}): ScheduleClientPort & {
  readonly calls: FakeClientCalls;
} {
  const calls: FakeClientCalls = { describe: [], create: [], update: [] };
  // Keyed by scheduleId (not a single shared slot) — the real ScheduleClientPort tracks each
  // schedule independently; a test driving TWO scheduleIds through the SAME fake must not have
  // the second collide with the first's existing-state.
  const existingById = new Map<string, { paused: boolean }>();
  return {
    calls,
    async describe(scheduleId) {
      calls.describe.push(scheduleId);
      return existingById.get(scheduleId);
    },
    async create(spec, opts) {
      calls.create.push({ spec, opts });
      existingById.set(spec.scheduleId, { paused: opts.paused });
    },
    async update(spec) {
      calls.update.push(spec);
    },
    ...overrides,
  };
}

describe("createTemporalScheduleRegistrar — idempotent create-or-update (25.SCHED leg 1)", () => {
  it("(a) ensure on an unknown scheduleId calls create exactly once with paused:true", async () => {
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(SPEC);

    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({ scheduleId: "sched-1", action: "created" });
    expect(client.calls.describe).toEqual(["sched-1"]);
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.update).toHaveLength(0);
    // The load-bearing invariant: every create is paused. NOTHING in this
    // package ever unpauses a schedule.
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
    expect(client.calls.create[0]?.spec).toEqual(SPEC);
  });

  it("(b) ensure called twice with the same spec issues exactly one create and one no-op update — never two creates", async () => {
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const first = await registrar.ensure(SPEC);
    const second = await registrar.ensure(SPEC);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value).toEqual({ scheduleId: "sched-1", action: "updated" });
    expect(client.calls.create).toHaveLength(1); // NEVER a second create
    expect(client.calls.update).toHaveLength(1);
  });

  it("(c) a client fault on describe folds to a typed refusal, never a throw", async () => {
    const client = fakeClient({
      describe: () => Promise.reject(new Error("temporal unreachable")),
    });
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(SPEC);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("schedule_client_fault");
      expect(r.error.cause).toBeInstanceOf(Error);
      // rule 7: the message names the schedule, never the raw driver detail.
      expect(r.error.message).toContain("sched-1");
    }
  });

  it("(c') a client fault on create ALSO folds to a typed refusal, never a throw", async () => {
    const client = fakeClient({
      create: () => Promise.reject(new Error("create rejected")),
    });
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(SPEC);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("schedule_client_fault");
  });

  it("(c'') a client fault on update ALSO folds to a typed refusal, never a throw", async () => {
    const client = fakeClient({
      update: () => Promise.reject(new Error("update rejected")),
    });
    const registrar = createTemporalScheduleRegistrar({ client });
    await registrar.ensure(SPEC); // seeds `existing` via the first (successful) create

    const r = await registrar.ensure(SPEC);

    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("schedule_client_fault");
  });
});

// ---------------------------------------------------------------------------
// 25.5 — the ingestionTriage schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

describe("gateIngestionTriageSchedule — 25.5 default-OFF, strict === true arming gate", () => {
  const base = { taskQueue: "sow-control-plane" as const, intervalMs: 3_600_000 };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateIngestionTriageSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateIngestionTriageSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable ingestion-triage schedule spec only when enabled === true", () => {
    const spec = gateIngestionTriageSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildIngestionTriageScheduleSpec(base));
    expect(spec?.scheduleId).toBe(INGESTION_TRIAGE_SCHEDULE_ID);
    expect(spec?.action.workflowType).toBe("ingestionTriageWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });
});

// ---------------------------------------------------------------------------
// 25.3 — the projectSync schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

describe("gateProjectSyncSchedule — 25.3 default-OFF, strict === true arming gate", () => {
  const base = { taskQueue: "sow-control-plane" as const, intervalMs: 3_600_000 };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateProjectSyncSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateProjectSyncSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable project-sync schedule spec only when enabled === true", () => {
    const spec = gateProjectSyncSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildProjectSyncScheduleSpec(base));
    expect(spec?.scheduleId).toBe(PROJECT_SYNC_SCHEDULE_ID);
    expect(spec?.action.workflowType).toBe("projectSyncWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true — the schedule stays inert end to end", async () => {
    const spec = gateProjectSyncSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(r)).toBe(true);
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
  });
});

// ---------------------------------------------------------------------------
// 25.2 — the dailyBrief schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

describe("gateDailyBriefSchedule — 25.2 default-OFF, strict === true arming gate", () => {
  const base = { taskQueue: "sow-control-plane" as const, intervalMs: 86_400_000 };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateDailyBriefSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateDailyBriefSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable daily-brief schedule spec only when enabled === true", () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildDailyBriefScheduleSpec(base));
    expect(spec?.scheduleId).toBe(DAILY_BRIEF_SCHEDULE_ID);
    expect(spec?.action.workflowType).toBe("dailyBriefWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true — the schedule stays inert end to end", async () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(r)).toBe(true);
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
  });
});

// ---------------------------------------------------------------------------
// 25.2 — the periodReview WEEKLY + MONTHLY schedule specs + their default-OFF
// arming gates (two independent cadences over the SAME workflow)
// ---------------------------------------------------------------------------

describe("gatePeriodReviewWeeklySchedule / gatePeriodReviewMonthlySchedule — 25.2 default-OFF, strict === true arming gates", () => {
  const base = { taskQueue: "sow-control-plane" as const, intervalMs: 604_800_000 };

  it("weekly is undefined by default (enabled: false)", () => {
    expect(gatePeriodReviewWeeklySchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("monthly is undefined by default (enabled: false)", () => {
    expect(gatePeriodReviewMonthlySchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("weekly is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gatePeriodReviewWeeklySchedule(hostile)).toBeUndefined();
  });

  it("monthly is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gatePeriodReviewMonthlySchedule(hostile)).toBeUndefined();
  });

  it("weekly returns a durable period-review spec distinct from monthly's (different scheduleId, SAME workflowType)", () => {
    const weekly = gatePeriodReviewWeeklySchedule({ ...base, enabled: true });
    const monthly = gatePeriodReviewMonthlySchedule({ ...base, enabled: true });
    expect(weekly).toBeDefined();
    expect(monthly).toBeDefined();
    expect(weekly).toEqual(buildPeriodReviewWeeklyScheduleSpec(base));
    expect(monthly).toEqual(buildPeriodReviewMonthlyScheduleSpec(base));
    expect(weekly?.scheduleId).toBe(PERIOD_REVIEW_WEEKLY_SCHEDULE_ID);
    expect(monthly?.scheduleId).toBe(PERIOD_REVIEW_MONTHLY_SCHEDULE_ID);
    // distinct schedule ids ⇒ distinct workflow ids too (ensure() never collides the two cadences)
    expect(weekly?.action.workflowId).not.toBe(monthly?.action.workflowId);
    expect(weekly?.action.workflowType).toBe("periodReviewWorkflow");
    expect(monthly?.action.workflowType).toBe("periodReviewWorkflow");
  });

  it("ensure() over EITHER gated spec creates a NEW schedule paused:true, and the two cadences register as TWO independent schedules", async () => {
    const weekly = gatePeriodReviewWeeklySchedule({ ...base, enabled: true });
    const monthly = gatePeriodReviewMonthlySchedule({ ...base, intervalMs: 2_592_000_000, enabled: true });
    expect(weekly).toBeDefined();
    expect(monthly).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const rWeekly = await registrar.ensure(weekly as TemporalScheduleSpec);
    const rMonthly = await registrar.ensure(monthly as TemporalScheduleSpec);

    expect(isOk(rWeekly)).toBe(true);
    expect(isOk(rMonthly)).toBe(true);
    expect(client.calls.create).toHaveLength(2); // two DISTINCT scheduleIds, never collapsed to one
    expect(client.calls.create.every((c) => c.opts.paused === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 25.4 — the crossCalendarScheduling schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

describe("gateCrossCalendarSchedulingSchedule — 25.4 default-OFF, strict === true arming gate", () => {
  const base = { taskQueue: "sow-control-plane" as const, intervalMs: 3_600_000 };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateCrossCalendarSchedulingSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateCrossCalendarSchedulingSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable cross-calendar-scheduling schedule spec only when enabled === true", () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildCrossCalendarSchedulingScheduleSpec(base));
    expect(spec?.scheduleId).toBe(CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID);
    expect(spec?.action.workflowType).toBe("crossCalendarSchedulingWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true — the schedule stays inert end to end", async () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const r = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(r)).toBe(true);
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
  });
});
