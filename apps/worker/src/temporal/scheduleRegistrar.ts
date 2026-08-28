// @sow/worker — 25.SCHED leg 1: the DURABLE Temporal schedule registrar + the 25.5
// ingestionTriage schedule attachment (default-OFF).
//
// This is the ONE machinery gap the 25.2/25.3/25.4/25.5 plan tasks silently
// depend on and none of them build: a repo-wide search finds `ScheduleClient`/
// `createSchedule` only inside prose comments (temporal/workflows.ts:55,496;
// composition/connectorPolling.ts:16,39) — every one deferring the live START.
// This module IS that primitive: `createTemporalScheduleRegistrar(deps).ensure(spec)`
// performs an IDEMPOTENT create-or-update per scheduleId against an injected,
// narrow {@link ScheduleClientPort} — never the concrete `@temporalio/client`
// `ScheduleClient` class directly, so the registrar stays pure + fake-testable
// (mirroring the `StartWorkflowRun` port / `createTemporalClientStartRun` split
// in dispatchSourceIngestion.ts: the injected port is the seam, a concrete
// SDK-backed adapter is a separate, later concern).
//
// ⛔ NOTHING ARMS HERE. Two independent facts keep this package's machinery
// inert (facts 1 and 3 below); fact 2 sits between them as necessary context,
// not a third independent reason — by its own text it does NOT establish
// pause-safety on its own:
//   1. `ensure` ALWAYS creates a NEW schedule PAUSED (`{ paused: true }`) — there
//      is no code path in this module that can CREATE a schedule live. That
//      WIRE property holds only because the real adapter
//      (`createRealScheduleClientPort.create`, apps/worker/src/boot.ts:2386-2393)
//      forwards `state: { paused: opts.paused }` verbatim onto the SDK's create
//      call — the exact same "the type alone proves nothing, the adapter's
//      forwarding does" pattern fact 2 below names for `update`; this module's
//      own type (`opts: { readonly paused: true }`) only fixes what a CALLER
//      can ask for at this seam, same caveat as fact 2's port-type observation.
//      That is the full claim, no stronger: a CONVERGE of an EXISTING schedule (fact 2,
//      `update`) is a DIFFERENT code path that does not go through `create` at
//      all, and by design PRESERVES whatever pause state the schedule already
//      had — so a converge over a schedule the owner (or the adapter) left
//      unpaused correctly LEAVES IT LIVE; that is intended behavior, pinned by
//      schedule-update-preserves-pause.test.ts, not a gap. "Nothing arms here"
//      describes what this module's own code can newly SET IN MOTION (a fresh
//      schedule is always born paused) — it is not a claim that a live
//      schedule can never be observed after a converge.
//   2. `update` never carries a `paused` field at all in this PORT'S TYPE — but
//      that fact, by itself, does NOT establish pause-safety. Port shape only
//      binds what a CALLER can ask for at this seam; it says nothing about what
//      the ADAPTER underneath does with an absent field on the wire. This exact
//      inference — "the type has no paused field, therefore nothing here can
//      unpause a schedule" — was WRONG and produced a live CRITICAL bug (task
//      F2): the real `@temporalio/client` schedule update is a full REPLACE, not
//      a merge, so proto3 fills an absent `paused` with its zero-value
//      (`false`). MEASURED against a real ephemeral server, twice independently:
//        UNPAUSE_PROBE afterCreate.paused=true afterUpdate.paused=false
//      Every second boot of an armed config was silently turning a deliberately-
//      paused schedule live. Pause-safety through this module rests on the
//      ADAPTER, not on the port's missing field: the real adapter
//      (`createRealScheduleClientPort.update`, apps/worker/src/boot.ts) closes
//      the gap by reading back `previous.state.paused` from the schedule's
//      current description and echoing it into the replacement — never
//      hardcoding either direction. General lesson: an absence in a port's TYPE
//      is not an absence on the WIRE.
//   3. The registrar is constructed ONLY when a caller supplies a real
//      {@link ScheduleClientPort}. Nothing in this package constructs one or
//      calls `ensure` with a real client — that wiring is a boot-level decision
//      (apps/worker/src/boot.ts), out of this package's territory (see the
//      Step-9 crossTerritoryNeeds note). So on a shipped-default boot, ZERO
//      schedules are registered by construction, not by a runtime check.
//
// The 25.5 leg (`gateIngestionTriageSchedule`) is the SAME default-OFF gate-
// helper shape worker LESSONS §2 names: `gate(opts) → wiring | undefined`,
// strict `=== true`, returning `undefined` on anything else (including a
// truthy-but-not-boolean value — no coercion).
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId } from "@sow/contracts";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";
import {
  DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE,
  PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE,
  CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE,
  type DailyBriefScheduleArgs,
  type PeriodReviewScheduleArgs,
  type CrossCalendarSchedulingScheduleArgs,
  type ScheduledWorkspaceScope,
  type ScheduledAvailabilitySource,
} from "./scheduleArgs";

// ---------------------------------------------------------------------------
// (1) the schedule spec + the injected ScheduleClient-shaped port
// ---------------------------------------------------------------------------

/** The recurring Temporal Workflow the schedule starts on each due occurrence. */
export interface TemporalScheduleAction {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly taskQueue: SowTaskQueue;
  readonly args: readonly unknown[];
}

/** A durable schedule's identity + cadence + the action it takes. */
export interface TemporalScheduleSpec {
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly action: TemporalScheduleAction;
}

/** The subset of a live schedule's state this module reads back. */
export interface ScheduleDescription {
  readonly paused: boolean;
}

/**
 * The narrow, injected ScheduleClient-SHAPED port `createTemporalScheduleRegistrar`
 * drives — NOT the `@temporalio/client` `ScheduleClient` class itself (that
 * coupling belongs in a concrete adapter built at the same seam as
 * `createTemporalClientStartRun`, a later wiring step). `describe` folds a
 * genuine "no schedule with this id" to `undefined` — a miss, not a fault,
 * mirroring the not_found→undefined convention this codebase uses throughout
 * (composition/store-adapters.ts, lifecycle/last-run.ts).
 */
export interface ScheduleClientPort {
  /** `undefined` ⇔ no schedule exists yet with this id (a miss, not a fault). */
  describe(scheduleId: string): Promise<ScheduleDescription | undefined>;
  /**
   * Create a NEW schedule. `opts.paused` is always the literal `true` — the type
   * itself makes an unpaused create unrepresentable at this seam.
   */
  create(spec: TemporalScheduleSpec, opts: { readonly paused: true }): Promise<void>;
  /**
   * Converge an EXISTING schedule's spec/action. This port's TYPE carries no
   * `paused` field — `ensure` (the sole caller) can never ASK to unpause or
   * re-pause a schedule through this seam. That constrains what `ensure` can
   * REQUEST; it does not, by itself, guarantee the schedule's pause state
   * SURVIVES a converge on the wire. The real SDK's update is a full REPLACE:
   * an implementation that forwards an absent `paused` verbatim gets it zeroed
   * to `false` (proto3's absent-bool default), silently unpausing a paused
   * schedule — see the module header for the measured transcript (task F2).
   * Every implementation of this method MUST read the schedule's own current
   * pause state and echo it back explicitly; this type alone cannot enforce
   * that. The production adapter (`createRealScheduleClientPort.update`,
   * apps/worker/src/boot.ts) does exactly this.
   */
  update(spec: TemporalScheduleSpec): Promise<void>;
}

/** The closed, enumerable §16 failure set — never thrown; folded into a Result. */
export type ScheduleRegistrarErrorCode = "schedule_client_fault";

export interface ScheduleRegistrarError {
  readonly code: ScheduleRegistrarErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface EnsureOutcome {
  readonly scheduleId: string;
  /** `created` on a fresh (paused) create; `updated` on a converge of an existing schedule. */
  readonly action: "created" | "updated";
}

export interface TemporalScheduleRegistrar {
  /**
   * Idempotent create-or-update: an UNKNOWN scheduleId is CREATED (always
   * paused); a KNOWN scheduleId is UPDATED (spec/action converges). This call
   * never ASKS to change pause state — the port's `update` carries no `paused`
   * field for it to set — but whether pause state actually SURVIVES the
   * converge is decided by the injected {@link ScheduleClientPort}
   * implementation, not by this method: a real adapter's wire encoding can turn
   * an absent field into an unpause (see the module header, task F2). The
   * production adapter (`createRealScheduleClientPort`, apps/worker/src/boot.ts)
   * preserves pause state by echoing it back explicitly. A client fault at any
   * step folds to a typed `err` — never a throw across the boundary (§16).
   */
  ensure(spec: TemporalScheduleSpec): Promise<Result<EnsureOutcome, ScheduleRegistrarError>>;
}

export interface CreateTemporalScheduleRegistrarDeps {
  readonly client: ScheduleClientPort;
}

/**
 * Build the durable Temporal schedule registrar over an injected
 * {@link ScheduleClientPort}. See the module header for the two independent
 * facts (plus the pause-safety caveat between them) that keep nothing arming
 * through this constructor.
 */
export function createTemporalScheduleRegistrar(
  deps: CreateTemporalScheduleRegistrarDeps,
): TemporalScheduleRegistrar {
  return {
    async ensure(spec: TemporalScheduleSpec): Promise<Result<EnsureOutcome, ScheduleRegistrarError>> {
      try {
        const existing = await deps.client.describe(spec.scheduleId);
        if (existing === undefined) {
          await deps.client.create(spec, { paused: true });
          return ok({ scheduleId: spec.scheduleId, action: "created" });
        }
        await deps.client.update(spec);
        return ok({ scheduleId: spec.scheduleId, action: "updated" });
      } catch (cause) {
        // A fault at describe/create/update all land here — the specific cause
        // rides `cause`; the message names only the scheduleId (rule 7 — no raw
        // driver detail is asserted into the message).
        return err({
          code: "schedule_client_fault",
          message: `schedule registrar ensure failed for scheduleId ${spec.scheduleId}`,
          cause,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// (2) 25.5 — the ingestionTriage schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

/**
 * The registered sandbox workflow type name `ingestionTriageWorkflow` runs
 * under (temporal/workflows.ts:379-406 — already a complete, registered bundle
 * entry point; this module does NOT rebuild it, only attaches a durable
 * schedule spec pointed at it).
 */
export const INGESTION_TRIAGE_WORKFLOW_TYPE = "ingestionTriageWorkflow" as const;

/** The durable schedule id the 25.5 ingestion-triage sweep registers under. */
export const INGESTION_TRIAGE_SCHEDULE_ID = "ingestion-triage" as const;

/**
 * arch_gap (Phase 25, flagged not silently assumed): `ingestionTriageWorkflow`'s
 * input is an owner {@link TriageDisposition} — there is no per-tick disposition
 * for a periodic schedule to supply, so this spec's `args: []` is a PLACEHOLDER
 * action shape, not a functioning periodic re-surface. Defining the real
 * periodic "re-surface parked/low-confidence sources" action (per 25.5's
 * Done-when) is a follow-up once 25.1 registers the output-workflow bundle;
 * this function's job is the DORMANT schedule-attachment machinery + the
 * default-OFF gate, per the 25.SCHED leg-1 brief. Never armed by this package.
 */
export function buildIngestionTriageScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return {
    scheduleId: INGESTION_TRIAGE_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: INGESTION_TRIAGE_WORKFLOW_TYPE,
      workflowId: `${INGESTION_TRIAGE_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [],
    },
  };
}

/**
 * The 25.5 arming gate (worker LESSONS §2 shape: `gate(opts) → wiring |
 * undefined`, default-OFF, strict `=== true`). Returns the durable
 * ingestion-triage schedule spec ONLY when the owner armed it; otherwise
 * `undefined` — a truthy-but-not-boolean-`true` value (a stray `"true"`
 * string, a `1`) does NOT arm (no coercion). NOTHING in this package ever
 * calls {@link TemporalScheduleRegistrar.ensure} with this spec — wiring this
 * gate into `bootWorker` (reading the owner config, constructing a real
 * `ScheduleClientPort`, and calling `ensure` only on the armed path) is
 * PKG-W1's `boot.ts`, outside this package's territory.
 */
export function gateIngestionTriageSchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildIngestionTriageScheduleSpec(opts);
}

// ---------------------------------------------------------------------------
// (3) 25.3 — the projectSync schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

/**
 * The registered sandbox workflow type name `projectSyncWorkflow` runs under
 * (temporal/workflows.ts — a complete, registered bundle entry point as of task 25.1; this module
 * does NOT rebuild it, only attaches a durable schedule spec pointed at it).
 */
export const PROJECT_SYNC_WORKFLOW_TYPE = "projectSyncWorkflow" as const;

/** The durable schedule id the 25.3 project-sync tick registers under. */
export const PROJECT_SYNC_SCHEDULE_ID = "project-sync" as const;

/**
 * arch_gap (Phase 25, flagged not silently assumed — mirrors {@link buildIngestionTriageScheduleSpec}'s
 * own note above): `projectSyncWorkflow`'s input is ONE {@link ProjectSyncInput} naming a single
 * `context.projectRef` — there is no per-tick project selection for a periodic schedule to supply
 * (the 14.6 typed-Project registry can hold many projects), so this spec's `args: []` is a
 * PLACEHOLDER action shape, not a functioning periodic "sync every registered project" sweep.
 * Defining the real per-tick fan-out (one execution per registered project, or a dispatcher
 * workflow that lists the registry and starts one child per entry) is a follow-up once the 14.6
 * registry has a production enumeration read — this function's job is the DORMANT
 * schedule-attachment machinery + the default-OFF gate, per the 25.SCHED leg-1 brief. Never armed
 * by this package.
 */
export function buildProjectSyncScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return {
    scheduleId: PROJECT_SYNC_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: PROJECT_SYNC_WORKFLOW_TYPE,
      workflowId: `${PROJECT_SYNC_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [],
    },
  };
}

/**
 * The 25.3 arming gate (same shape as {@link gateIngestionTriageSchedule}: worker LESSONS §2's
 * `gate(opts) → wiring | undefined`, default-OFF, strict `=== true`). Returns the durable
 * project-sync schedule spec ONLY when the owner armed it; otherwise `undefined` — a
 * truthy-but-not-boolean-`true` value does NOT arm (no coercion). NOTHING in this package ever
 * calls {@link TemporalScheduleRegistrar.ensure} with this spec — wiring this gate into
 * `bootWorker` (reading the owner config, constructing a real `ScheduleClientPort`, and calling
 * `ensure` only on the armed path) is PKG-W1's `boot.ts`, outside this package's territory, same
 * as the ingestion-triage gate above.
 */
export function gateProjectSyncSchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildProjectSyncScheduleSpec(opts);
}

// ---------------------------------------------------------------------------
// (4) 25.2 — the dailyBrief schedule spec + its default-OFF arming gate
// ---------------------------------------------------------------------------

/**
 * The registered sandbox workflow type name `dailyBriefWorkflow` runs under
 * (temporal/workflows.ts — a complete, registered bundle entry point as of task 25.1; this module
 * does NOT rebuild it, only attaches a durable schedule spec pointed at it).
 */
export const DAILY_BRIEF_WORKFLOW_TYPE = "dailyBriefWorkflow" as const;

/** The durable schedule id the 25.2 daily-brief tick registers under. */
export const DAILY_BRIEF_SCHEDULE_ID = "daily-brief" as const;

/**
 * 25.2 — emits the REAL per-tick args for a scheduled `dailyBrief` occurrence, closing the gap the
 * prior `args: []` placeholder left (see the module header + `./scheduleArgs`'s header for the full
 * story). `action.args` carries exactly ONE {@link DailyBriefScheduleArgs} envelope — the STATIC
 * per-schedule configuration (`catchUpWindowMs` for the LIFE-2 collapse, the WS-2 `scopes`, the Global
 * `globalWorkspaceId` target) the frozen contract defines; it is byte-identical on every occurrence,
 * exactly as `action.args` must be.
 *
 * `action.workflowType` points at the SCHEDULED entry point {@link DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE}
 * — NOT {@link DAILY_BRIEF_WORKFLOW_TYPE} (the direct-start type, which stays exported unchanged for
 * owner-triggered starts elsewhere). The scheduled entry point takes this static envelope and derives
 * the occurrence's own run identity in-sandbox via `deriveScheduledRunInput` — per-occurrence identity
 * (the `resolveRun` idempotency key) is NEVER carried here, because `action.args` cannot vary tick to
 * tick; see `./scheduleArgs`'s header for the MEASURED fact (`workflowInfo().workflowId` gets Temporal's
 * scheduled-time suffix) that derivation rests on. Composing the SCHEDULED entry point itself
 * (`dailyBriefScheduledWorkflow`, which reads this envelope and calls the existing `dailyBriefWorkflow`
 * driver body) is the next-stage task this builder's output now makes possible, not this function's job.
 */
export function buildDailyBriefScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec {
  const args: DailyBriefScheduleArgs = {
    scheduleId: DAILY_BRIEF_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    catchUpWindowMs: opts.catchUpWindowMs,
    globalWorkspaceId: opts.globalWorkspaceId,
    scopes: opts.scopes,
  };
  return {
    scheduleId: DAILY_BRIEF_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE,
      workflowId: `${DAILY_BRIEF_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [args],
    },
  };
}

/**
 * The 25.2 arming gate (same shape as {@link gateIngestionTriageSchedule} / {@link gateProjectSyncSchedule}:
 * worker LESSONS §2's `gate(opts) → wiring | undefined`, default-OFF, strict `=== true`). Returns the
 * durable daily-brief schedule spec ONLY when the owner armed it; otherwise `undefined` — a
 * truthy-but-not-boolean-`true` value does NOT arm (no coercion). NOTHING in this package ever calls
 * {@link TemporalScheduleRegistrar.ensure} with this spec — wiring this gate into `bootWorker` is
 * PKG-W1's `boot.ts`, outside this package's territory, same as the gates above.
 */
export function gateDailyBriefSchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildDailyBriefScheduleSpec(opts);
}

// ---------------------------------------------------------------------------
// (5) 25.2 — the periodReview WEEKLY + MONTHLY schedule specs + their
// default-OFF arming gates (two independent cadences over ONE workflow)
// ---------------------------------------------------------------------------

/**
 * The registered sandbox workflow type name `periodReviewWorkflow` runs under
 * (temporal/workflows.ts — a complete, registered bundle entry point as of task 25.1). BOTH cadences
 * below point at this SAME workflow type — `PeriodReviewInput.period` (`"weekly" | "monthly"`)
 * distinguishes them at invocation, not the workflow type name.
 */
export const PERIOD_REVIEW_WORKFLOW_TYPE = "periodReviewWorkflow" as const;

/** The durable schedule id the 25.2 weekly period-review tick registers under. */
export const PERIOD_REVIEW_WEEKLY_SCHEDULE_ID = "period-review-weekly" as const;

/** The durable schedule id the 25.2 monthly period-review tick registers under. */
export const PERIOD_REVIEW_MONTHLY_SCHEDULE_ID = "period-review-monthly" as const;

/**
 * 25.2 — emits the REAL per-tick args for a scheduled `periodReview` occurrence (both cadences),
 * closing the gap the prior `args: []` placeholder left (see {@link buildDailyBriefScheduleSpec}'s own
 * note above, which this mirrors). `action.args` carries exactly ONE {@link PeriodReviewScheduleArgs}
 * envelope per cadence — the STATIC per-schedule configuration, INCLUDING `period` (`"weekly" |
 * "monthly"`) so the scheduled entry point can tell the two cadences apart from a byte-identical-per-tick
 * args shape without inspecting the scheduleId string.
 *
 * `action.workflowType` points at the SCHEDULED entry point {@link PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE}
 * — NOT {@link PERIOD_REVIEW_WORKFLOW_TYPE} (the direct-start type, unchanged, still exported for
 * owner-triggered starts). BOTH cadences point at the SAME scheduled entry point, same as they did at
 * the direct-start type — `args[0].period` is what distinguishes them, not the type name. Per-occurrence
 * identity is derived in-sandbox, never carried in `args`; see {@link buildDailyBriefScheduleSpec}'s note
 * (and `./scheduleArgs`'s header) for why.
 */
function buildPeriodReviewScheduleSpec(opts: {
  readonly scheduleId: typeof PERIOD_REVIEW_WEEKLY_SCHEDULE_ID | typeof PERIOD_REVIEW_MONTHLY_SCHEDULE_ID;
  readonly period: PeriodReviewScheduleArgs["period"];
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec {
  const args: PeriodReviewScheduleArgs = {
    scheduleId: opts.scheduleId,
    period: opts.period,
    intervalMs: opts.intervalMs,
    catchUpWindowMs: opts.catchUpWindowMs,
    globalWorkspaceId: opts.globalWorkspaceId,
    scopes: opts.scopes,
  };
  return {
    scheduleId: opts.scheduleId,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE,
      workflowId: `${opts.scheduleId}-workflow`,
      taskQueue: opts.taskQueue,
      args: [args],
    },
  };
}

/** The weekly-cadence period-review schedule spec. See {@link buildPeriodReviewScheduleSpec}. */
export function buildPeriodReviewWeeklyScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec {
  return buildPeriodReviewScheduleSpec({
    ...opts,
    scheduleId: PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
    period: "weekly",
  });
}

/** The monthly-cadence period-review schedule spec. See {@link buildPeriodReviewScheduleSpec}. */
export function buildPeriodReviewMonthlyScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec {
  return buildPeriodReviewScheduleSpec({
    ...opts,
    scheduleId: PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
    period: "monthly",
  });
}

/**
 * The 25.2 weekly arming gate (same shape as {@link gateDailyBriefSchedule}: default-OFF, strict
 * `=== true`). Independent of the monthly gate below — each cadence is its own AND-lock, but a
 * caller may choose to key both off the same owner config field (boot.ts's own composition
 * decision, not this module's).
 */
export function gatePeriodReviewWeeklySchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildPeriodReviewWeeklyScheduleSpec(opts);
}

/** The 25.2 monthly arming gate. See {@link gatePeriodReviewWeeklySchedule}. */
export function gatePeriodReviewMonthlySchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildPeriodReviewMonthlyScheduleSpec(opts);
}

// ---------------------------------------------------------------------------
// (6) 25.4 — the crossCalendarScheduling schedule spec + its default-OFF
// arming gate
// ---------------------------------------------------------------------------

/**
 * The registered sandbox workflow type name `crossCalendarSchedulingWorkflow` runs under
 * (temporal/workflows.ts — a complete, registered bundle entry point as of task 25.1; this module
 * does NOT rebuild it, only attaches a durable schedule spec pointed at it).
 */
export const CROSS_CALENDAR_SCHEDULING_WORKFLOW_TYPE = "crossCalendarSchedulingWorkflow" as const;

/** The durable schedule id the 25.4 cross-calendar-scheduling tick registers under. */
export const CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID = "cross-calendar-scheduling" as const;

/**
 * 25.4 — emits the REAL per-tick args for a scheduled `crossCalendarScheduling` occurrence, closing the
 * gap the prior `args: []` placeholder left (mirrors {@link buildDailyBriefScheduleSpec}'s own note
 * above). `action.args` carries exactly ONE {@link CrossCalendarSchedulingScheduleArgs} envelope — the
 * STATIC `sources` set REQ-F-009 requires be read across (an unread source is a typed gather failure,
 * never an empty/free assumption) and the `organizerWorkspaceId` a WS-2 auto-created event belongs to;
 * byte-identical on every occurrence, as `action.args` must be.
 *
 * `action.workflowType` points at the SCHEDULED entry point
 * {@link CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE} — NOT
 * {@link CROSS_CALENDAR_SCHEDULING_WORKFLOW_TYPE} (the direct-start type, unchanged, still exported for
 * owner-triggered starts). Per-occurrence identity is derived in-sandbox, never carried in `args`; see
 * {@link buildDailyBriefScheduleSpec}'s note (and `./scheduleArgs`'s header) for why.
 */
export function buildCrossCalendarSchedulingScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly organizerWorkspaceId: WorkspaceId;
  readonly sources: readonly ScheduledAvailabilitySource[];
}): TemporalScheduleSpec {
  const args: CrossCalendarSchedulingScheduleArgs = {
    scheduleId: CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
    organizerWorkspaceId: opts.organizerWorkspaceId,
    sources: opts.sources,
  };
  return {
    scheduleId: CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE,
      workflowId: `${CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [args],
    },
  };
}

/**
 * The 25.4 arming gate (same shape as {@link gateIngestionTriageSchedule} / {@link gateProjectSyncSchedule}:
 * worker LESSONS §2's `gate(opts) → wiring | undefined`, default-OFF, strict `=== true`). Returns the
 * durable cross-calendar-scheduling schedule spec ONLY when the owner armed it; otherwise `undefined`
 * — a truthy-but-not-boolean-`true` value does NOT arm (no coercion). NOTHING in this package ever
 * calls {@link TemporalScheduleRegistrar.ensure} with this spec — wiring this gate into `bootWorker`
 * is PKG-W1's `boot.ts`, outside this package's territory, same as the gates above.
 */
export function gateCrossCalendarSchedulingSchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
  readonly organizerWorkspaceId: WorkspaceId;
  readonly sources: readonly ScheduledAvailabilitySource[];
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildCrossCalendarSchedulingScheduleSpec(opts);
}
