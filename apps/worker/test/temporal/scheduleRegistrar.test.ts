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
// NOTHING here ASKS to unpause a schedule — `update` never carries a `paused`
// field, so `ensure` cannot REQUEST a pause-state change through this seam.
// That is not the same as a guarantee that pause state survives on the wire:
// the fake port below is intentionally NAIVE about `update` (it never touches
// `existingById`'s `paused` key), which is exactly why every assertion here
// checks `create`'s `paused: true`, never a live "still paused after update"
// claim against this fake. The real adapter's wire encoding is what actually
// decides whether an update preserves pause state — see
// apps/worker/src/temporal/scheduleRegistrar.ts's module header (task F2: a
// real SDK update is a full REPLACE, so a naive absent-`paused` forward
// silently unpauses; `createRealScheduleClientPort.update` in boot.ts fixes it
// by echoing `previous.state.paused` back) and boot.ts's own adapter tests for
// that guarantee — it is NOT provable from this port-shape alone, and this
// module's tests do not claim it is.
//
// WP1 (25.2/25.4): dailyBrief/periodReview/crossCalendarScheduling now emit REAL
// per-tick `args` (a single frozen-contract envelope from `./scheduleArgs`) and
// point `action.workflowType` at the SCHEDULED entry-point name, not the
// direct-start one. `ingestionTriage`/`projectSync` are DELIBERATELY untouched —
// the `args: []`-length + direct-start-workflowType assertions on those two
// families are POSITIVE CONTROLS proving this slice's scope stayed narrow.
import { describe, it, expect } from "vitest";
import { isOk, isErr, workspaceId } from "@sow/contracts";
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
  DAILY_BRIEF_WORKFLOW_TYPE,
  gatePeriodReviewWeeklySchedule,
  buildPeriodReviewWeeklyScheduleSpec,
  PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
  gatePeriodReviewMonthlySchedule,
  buildPeriodReviewMonthlyScheduleSpec,
  PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
  PERIOD_REVIEW_WORKFLOW_TYPE,
  gateCrossCalendarSchedulingSchedule,
  buildCrossCalendarSchedulingScheduleSpec,
  CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
  CROSS_CALENDAR_SCHEDULING_WORKFLOW_TYPE,
  type ScheduleClientPort,
  type TemporalScheduleSpec,
} from "../../src/temporal/scheduleRegistrar";
import {
  type DailyBriefScheduleArgs,
  type PeriodReviewScheduleArgs,
  type CrossCalendarSchedulingScheduleArgs,
  type ScheduledWorkspaceScope,
  type ScheduledAvailabilitySource,
} from "../../src/temporal/scheduleArgs";

const GLOBAL_WS = workspaceId("ws-global");
const SCOPE_WS = workspaceId("ws-scope-1");
const ORGANIZER_WS = workspaceId("ws-organizer");

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
    // The load-bearing invariant THIS ASSERTION checks, no broader: every
    // `create` call this FAKE port received carries `paused: true`. That is a
    // claim about `create` only, against a fake — it does NOT establish
    // "nothing in this package ever unpauses a schedule" (see the file
    // header above: whether a `paused` state SURVIVES an `update`/converge on
    // the real wire is the adapter's job, not provable from this port-shape
    // alone, and this file's tests do not claim it is).
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
    // Literal, deliberately — comparing against the module's own constant is
    // tautological (a corrupted constant would still equal itself). The literal
    // pins the WIRE NAME independently: it must match the real registered
    // export `ingestionTriageWorkflow` (temporal/workflows.ts:650), which a
    // renamed constant can silently drift away from without failing typecheck.
    expect(spec?.action.workflowType).toBe("ingestionTriageWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  // POSITIVE CONTROL (WP1 scope): ingestionTriage is DELIBERATELY untouched by the
  // WP1 real-args slice — it still emits the args:[] placeholder shape. If a later
  // change accidentally extends the WP1 pattern to this family, this assertion is
  // the tripwire that catches it.
  it("WP1 positive control: STILL emits args:[] — this family is out of WP1 scope", () => {
    const spec = gateIngestionTriageSchedule({ ...base, enabled: true });
    expect(spec?.action.args).toEqual([]);
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
    // Literal, deliberately — see the ingestionTriage positive control above for
    // why a constant-to-constant comparison is a tautology. Must match the real
    // registered export `projectSyncWorkflow` (temporal/workflows.ts:1019).
    expect(spec?.action.workflowType).toBe("projectSyncWorkflow");
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  // POSITIVE CONTROL (WP1 scope): projectSync is DELIBERATELY untouched by the WP1
  // real-args slice — see the ingestionTriage positive control above for why.
  it("WP1 positive control: STILL emits args:[] — this family is out of WP1 scope", () => {
    const spec = gateProjectSyncSchedule({ ...base, enabled: true });
    expect(spec?.action.args).toEqual([]);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true, then a repeat ensure() converges via update — never a second create", async () => {
    const spec = gateProjectSyncSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const first = await registrar.ensure(spec as TemporalScheduleSpec);
    const second = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first)) expect(first.value.action).toBe("created");
    if (isOk(second)) expect(second.value.action).toBe("updated");
    // The load-bearing invariant THIS ASSERTION checks, no broader: across a
    // create-then-converge round trip through the REAL gated builder output,
    // `create` fires exactly once (carrying `paused: true`) and a repeat
    // `ensure()` takes the converge branch — never a second create. That is a
    // call-count claim against this FAKE port; it does NOT establish that a
    // paused state SURVIVES the real wire on converge (see the file header
    // above and scheduleRegistrar.ts's module header, task F2: that guarantee
    // lives in the adapter, pinned by schedule-update-preserves-pause.test.ts,
    // not here).
    expect(client.calls.create).toHaveLength(1); // never re-created on converge
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
    expect(client.calls.update).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 25.2 — the dailyBrief schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

describe("gateDailyBriefSchedule — 25.2 default-OFF, strict === true arming gate", () => {
  const SCOPES: readonly ScheduledWorkspaceScope[] = [{ workspaceId: SCOPE_WS, brainId: "brain-scope-1" }];
  const base = {
    taskQueue: "sow-control-plane" as const,
    intervalMs: 86_400_000,
    catchUpWindowMs: 3_600_000,
    globalWorkspaceId: GLOBAL_WS,
    scopes: SCOPES,
  };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateDailyBriefSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateDailyBriefSchedule(hostile)).toBeUndefined();
  });

  // Extends the truthy-not-true pin onto the WP1-widened opts shape (catchUpWindowMs/
  // globalWorkspaceId/scopes now present alongside enabled) — a numeric 1 must not
  // arm either, on the SAME strict `=== true` guard.
  it("is undefined for a truthy-not-boolean 1 on the WP1-widened opts shape — strict === true survives the widening", () => {
    const hostile = { ...base, enabled: 1 as unknown as boolean };
    expect(gateDailyBriefSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable daily-brief schedule spec only when enabled === true", () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildDailyBriefScheduleSpec(base));
    expect(spec?.scheduleId).toBe(DAILY_BRIEF_SCHEDULE_ID);
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  // WP1 — the args-content assertion. Mutation-proved: swapping `catchUpWindowMs:
  // opts.catchUpWindowMs` for a different field value in buildDailyBriefScheduleSpec
  // was verified to turn this RED before being reverted (see WP1 verification notes).
  it("WP1: emits action.args of length 1 whose element deep-equals the expected DailyBriefScheduleArgs envelope", () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    const expected: DailyBriefScheduleArgs = {
      scheduleId: DAILY_BRIEF_SCHEDULE_ID,
      intervalMs: base.intervalMs,
      catchUpWindowMs: base.catchUpWindowMs,
      globalWorkspaceId: base.globalWorkspaceId,
      scopes: base.scopes,
    };
    expect(spec?.action.args).toHaveLength(1);
    expect(spec?.action.args[0]).toEqual(expected);
  });

  it("WP1: action.workflowType is the SCHEDULED entry-point name, never the direct-start type", () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    // Literal, deliberately — a constant-to-constant comparison against
    // DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE would be tautological (the builder and
    // this test import the SAME constant from ./scheduleArgs, so a corrupted
    // constant still equals itself here). The literal pins the WIRE NAME to the
    // real registered export `dailyBriefScheduledWorkflow` (temporal/workflows.ts:914).
    expect(spec?.action.workflowType).toBe("dailyBriefScheduledWorkflow");
    expect(spec?.action.workflowType).not.toBe(DAILY_BRIEF_WORKFLOW_TYPE);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true, then a repeat ensure() converges via update — never a second create", async () => {
    const spec = gateDailyBriefSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const first = await registrar.ensure(spec as TemporalScheduleSpec);
    const second = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first)) expect(first.value.action).toBe("created");
    if (isOk(second)) expect(second.value.action).toBe("updated");
    // The load-bearing invariant THIS ASSERTION checks, no broader: across a
    // create-then-converge round trip through the REAL gated builder output,
    // `create` fires exactly once (carrying `paused: true`) and a repeat
    // `ensure()` takes the converge branch — never a second create. That is a
    // call-count claim against this FAKE port; it does NOT establish that a
    // paused state SURVIVES the real wire on converge (see the file header
    // above and scheduleRegistrar.ts's module header, task F2: that guarantee
    // lives in the adapter, pinned by schedule-update-preserves-pause.test.ts,
    // not here).
    expect(client.calls.create).toHaveLength(1); // never re-created on converge
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
    expect(client.calls.update).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 25.2 — the periodReview WEEKLY + MONTHLY schedule specs + their default-OFF
// arming gates (two independent cadences over the SAME workflow)
// ---------------------------------------------------------------------------

describe("gatePeriodReviewWeeklySchedule / gatePeriodReviewMonthlySchedule — 25.2 default-OFF, strict === true arming gates", () => {
  const SCOPES: readonly ScheduledWorkspaceScope[] = [{ workspaceId: SCOPE_WS, brainId: "brain-scope-1" }];
  const base = {
    taskQueue: "sow-control-plane" as const,
    intervalMs: 604_800_000,
    catchUpWindowMs: 3_600_000,
    globalWorkspaceId: GLOBAL_WS,
    scopes: SCOPES,
  };

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

  // Extends the truthy-not-true pin onto the WP1-widened opts shape for BOTH cadences.
  it("weekly is undefined for a truthy-not-boolean 1 on the WP1-widened opts shape", () => {
    const hostile = { ...base, enabled: 1 as unknown as boolean };
    expect(gatePeriodReviewWeeklySchedule(hostile)).toBeUndefined();
  });

  it("monthly is undefined for a truthy-not-boolean 1 on the WP1-widened opts shape", () => {
    const hostile = { ...base, enabled: 1 as unknown as boolean };
    expect(gatePeriodReviewMonthlySchedule(hostile)).toBeUndefined();
  });

  it("weekly returns a durable period-review spec distinct from monthly's (different scheduleId, SAME scheduled workflowType)", () => {
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
    // WP1: both cadences point at the SCHEDULED entry point, never the direct-start type —
    // args[0].period is what distinguishes them (asserted below), not the type name.
    // Literal, deliberately — see the dailyBrief positive control above for why a
    // constant-to-constant comparison is a tautology. Must match the real registered
    // export `periodReviewScheduledWorkflow` (temporal/workflows.ts:997).
    expect(weekly?.action.workflowType).toBe("periodReviewScheduledWorkflow");
    expect(monthly?.action.workflowType).toBe("periodReviewScheduledWorkflow");
    expect(weekly?.action.workflowType).not.toBe(PERIOD_REVIEW_WORKFLOW_TYPE);
    expect(monthly?.action.workflowType).not.toBe(PERIOD_REVIEW_WORKFLOW_TYPE);
  });

  // WP1 — the args-content assertion for BOTH cadences. Mutation-proved: swapping
  // `period: opts.period` for a hardcoded wrong literal in buildPeriodReviewScheduleSpec
  // was verified to turn this RED before being reverted (see WP1 verification notes).
  it("WP1: weekly emits args of length 1 deep-equaling its PeriodReviewScheduleArgs envelope with period:\"weekly\"", () => {
    const weekly = gatePeriodReviewWeeklySchedule({ ...base, enabled: true });
    const expected: PeriodReviewScheduleArgs = {
      scheduleId: PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
      period: "weekly",
      intervalMs: base.intervalMs,
      catchUpWindowMs: base.catchUpWindowMs,
      globalWorkspaceId: base.globalWorkspaceId,
      scopes: base.scopes,
    };
    expect(weekly?.action.args).toHaveLength(1);
    expect(weekly?.action.args[0]).toEqual(expected);
  });

  it("WP1: monthly emits args of length 1 deep-equaling its PeriodReviewScheduleArgs envelope with period:\"monthly\"", () => {
    const monthly = gatePeriodReviewMonthlySchedule({ ...base, enabled: true });
    const expected: PeriodReviewScheduleArgs = {
      scheduleId: PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
      period: "monthly",
      intervalMs: base.intervalMs,
      catchUpWindowMs: base.catchUpWindowMs,
      globalWorkspaceId: base.globalWorkspaceId,
      scopes: base.scopes,
    };
    expect(monthly?.action.args).toHaveLength(1);
    expect(monthly?.action.args[0]).toEqual(expected);
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
  const SOURCES: readonly ScheduledAvailabilitySource[] = [
    { sourceId: "cal-1", workspaceId: SCOPE_WS },
    { sourceId: "cal-2", workspaceId: ORGANIZER_WS },
  ];
  const base = {
    taskQueue: "sow-control-plane" as const,
    intervalMs: 3_600_000,
    organizerWorkspaceId: ORGANIZER_WS,
    sources: SOURCES,
  };

  it("is undefined by default (enabled: false) — no spec, no schedule attachable", () => {
    expect(gateCrossCalendarSchedulingSchedule({ ...base, enabled: false })).toBeUndefined();
  });

  it("is undefined for a truthy-but-not-literal-true value — strict === true, never a coercion", () => {
    const hostile = { ...base, enabled: "true" as unknown as boolean };
    expect(gateCrossCalendarSchedulingSchedule(hostile)).toBeUndefined();
  });

  // Extends the truthy-not-true pin onto the WP1-widened opts shape (organizerWorkspaceId/
  // sources now present alongside enabled).
  it("is undefined for a truthy-not-boolean 1 on the WP1-widened opts shape — strict === true survives the widening", () => {
    const hostile = { ...base, enabled: 1 as unknown as boolean };
    expect(gateCrossCalendarSchedulingSchedule(hostile)).toBeUndefined();
  });

  it("returns the durable cross-calendar-scheduling schedule spec only when enabled === true", () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    expect(spec).toEqual(buildCrossCalendarSchedulingScheduleSpec(base));
    expect(spec?.scheduleId).toBe(CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID);
    expect(spec?.action.taskQueue).toBe("sow-control-plane");
    expect(spec?.intervalMs).toBe(base.intervalMs);
  });

  // WP1 — the args-content assertion. Mutation-proved: swapping `sources: opts.sources`
  // for a differently-ordered/truncated array in buildCrossCalendarSchedulingScheduleSpec
  // was verified to turn this RED before being reverted (see WP1 verification notes).
  it("WP1: emits args of length 1 whose element deep-equals the expected CrossCalendarSchedulingScheduleArgs envelope", () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    const expected: CrossCalendarSchedulingScheduleArgs = {
      scheduleId: CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
      organizerWorkspaceId: base.organizerWorkspaceId,
      sources: base.sources,
    };
    expect(spec?.action.args).toHaveLength(1);
    expect(spec?.action.args[0]).toEqual(expected);
  });

  it("WP1: action.workflowType is the SCHEDULED entry-point name, never the direct-start type", () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    // Literal, deliberately — see the dailyBrief positive control above for why a
    // constant-to-constant comparison is a tautology. Must match the real registered
    // export `crossCalendarSchedulingScheduledWorkflow` (temporal/workflows.ts:1141).
    expect(spec?.action.workflowType).toBe("crossCalendarSchedulingScheduledWorkflow");
    expect(spec?.action.workflowType).not.toBe(CROSS_CALENDAR_SCHEDULING_WORKFLOW_TYPE);
  });

  it("ensure() over the gated spec creates a NEW schedule paused:true, then a repeat ensure() converges via update — never a second create", async () => {
    const spec = gateCrossCalendarSchedulingSchedule({ ...base, enabled: true });
    expect(spec).toBeDefined();
    const client = fakeClient();
    const registrar = createTemporalScheduleRegistrar({ client });

    const first = await registrar.ensure(spec as TemporalScheduleSpec);
    const second = await registrar.ensure(spec as TemporalScheduleSpec);

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (isOk(first)) expect(first.value.action).toBe("created");
    if (isOk(second)) expect(second.value.action).toBe("updated");
    // The load-bearing invariant THIS ASSERTION checks, no broader: across a
    // create-then-converge round trip through the REAL gated builder output,
    // `create` fires exactly once (carrying `paused: true`) and a repeat
    // `ensure()` takes the converge branch — never a second create. That is a
    // call-count claim against this FAKE port; it does NOT establish that a
    // paused state SURVIVES the real wire on converge (see the file header
    // above and scheduleRegistrar.ts's module header, task F2: that guarantee
    // lives in the adapter, pinned by schedule-update-preserves-pause.test.ts,
    // not here).
    expect(client.calls.create).toHaveLength(1); // never re-created on converge
    expect(client.calls.create[0]?.opts).toEqual({ paused: true });
    expect(client.calls.update).toHaveLength(1);
  });
});
