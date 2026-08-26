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
// ⛔ NOTHING ARMS HERE. Three independent facts keep this package's machinery
// inert:
//   1. `ensure` ALWAYS creates a NEW schedule PAUSED (`{ paused: true }`) — there
//      is no code path in this module that can create (or leave) a schedule live.
//   2. `update` never carries a `paused` field at all — re-`ensure`-ing an
//      existing schedule can converge its spec/action but can NEVER unpause it.
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
import type { Result } from "@sow/contracts";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";

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
   * Converge an EXISTING schedule's spec/action. Deliberately carries NO
   * `paused` field — `ensure` can update spec/action but can never unpause (or
   * re-pause) a schedule through this seam.
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
   * paused); a KNOWN scheduleId is UPDATED (spec/action converges; pause state
   * is never touched by this call). A client fault at any step folds to a typed
   * `err` — never a throw across the boundary (§16).
   */
  ensure(spec: TemporalScheduleSpec): Promise<Result<EnsureOutcome, ScheduleRegistrarError>>;
}

export interface CreateTemporalScheduleRegistrarDeps {
  readonly client: ScheduleClientPort;
}

/**
 * Build the durable Temporal schedule registrar over an injected
 * {@link ScheduleClientPort}. See the module header for the three independent
 * reasons nothing arms through this constructor.
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
 * arch_gap (Phase 25, flagged not silently assumed — mirrors {@link buildIngestionTriageScheduleSpec}'s
 * own note above): `dailyBriefWorkflow`'s input is a full `DailyBriefInput` (`run`, `scheduleId`,
 * `globalWorkspaceId`, `context`, …) — there is no per-tick input for a periodic schedule to supply, so
 * this spec's `args: []` is a PLACEHOLDER action shape, not a functioning daily brief. Defining the
 * real per-tick input construction (resolving the owner's registered workspaces + the Global
 * coordination target) is a follow-up once the composition-root binds `OutputWorkflowActivities`
 * (task 25.2's own cited crossTerritoryNeed); this function's job is the DORMANT schedule-attachment
 * machinery + the default-OFF gate, per the 25.SCHED leg-1 brief. Never armed by this package.
 */
export function buildDailyBriefScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return {
    scheduleId: DAILY_BRIEF_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: DAILY_BRIEF_WORKFLOW_TYPE,
      workflowId: `${DAILY_BRIEF_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [],
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
 * arch_gap (Phase 25, flagged not silently assumed — mirrors {@link buildDailyBriefScheduleSpec}'s own
 * note above): `periodReviewWorkflow`'s input is a full `PeriodReviewInput` (`run`, `scheduleId`,
 * `period`, `globalWorkspaceId`, `context`, …) — there is no per-tick input for a periodic schedule to
 * supply, so BOTH cadences' `args: []` are PLACEHOLDER action shapes, not a functioning review.
 * Deferred to the same composition-root follow-up as {@link buildDailyBriefScheduleSpec}. Never armed
 * by this package.
 */
function buildPeriodReviewScheduleSpec(opts: {
  readonly scheduleId: typeof PERIOD_REVIEW_WEEKLY_SCHEDULE_ID | typeof PERIOD_REVIEW_MONTHLY_SCHEDULE_ID;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return {
    scheduleId: opts.scheduleId,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: PERIOD_REVIEW_WORKFLOW_TYPE,
      workflowId: `${opts.scheduleId}-workflow`,
      taskQueue: opts.taskQueue,
      args: [],
    },
  };
}

/** The weekly-cadence period-review schedule spec. See {@link buildPeriodReviewScheduleSpec}. */
export function buildPeriodReviewWeeklyScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return buildPeriodReviewScheduleSpec({ ...opts, scheduleId: PERIOD_REVIEW_WEEKLY_SCHEDULE_ID });
}

/** The monthly-cadence period-review schedule spec. See {@link buildPeriodReviewScheduleSpec}. */
export function buildPeriodReviewMonthlyScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return buildPeriodReviewScheduleSpec({ ...opts, scheduleId: PERIOD_REVIEW_MONTHLY_SCHEDULE_ID });
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
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildPeriodReviewWeeklyScheduleSpec(opts);
}

/** The 25.2 monthly arming gate. See {@link gatePeriodReviewWeeklySchedule}. */
export function gatePeriodReviewMonthlySchedule(opts: {
  readonly enabled: boolean;
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
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
 * arch_gap (Phase 25, flagged not silently assumed — mirrors {@link buildDailyBriefScheduleSpec}'s own
 * note above): `crossCalendarSchedulingWorkflow`'s input is a full `CrossCalendarSchedulingInput` —
 * there is no per-tick input for a periodic schedule to supply, so this spec's `args: []` is a
 * PLACEHOLDER action shape, not a functioning periodic scheduling sweep. Deferred to the same
 * composition-root follow-up as {@link buildDailyBriefScheduleSpec}. Never armed by this package.
 */
export function buildCrossCalendarSchedulingScheduleSpec(opts: {
  readonly taskQueue: SowTaskQueue;
  readonly intervalMs: number;
}): TemporalScheduleSpec {
  return {
    scheduleId: CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
    intervalMs: opts.intervalMs,
    action: {
      workflowType: CROSS_CALENDAR_SCHEDULING_WORKFLOW_TYPE,
      workflowId: `${CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID}-workflow`,
      taskQueue: opts.taskQueue,
      args: [],
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
}): TemporalScheduleSpec | undefined {
  if (opts.enabled !== true) return undefined;
  return buildCrossCalendarSchedulingScheduleSpec(opts);
}
