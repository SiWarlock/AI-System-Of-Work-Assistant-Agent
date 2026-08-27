// @sow/worker — the FROZEN per-tick schedule-argument contract (25.2 / 25.4).
//
// ⛔ WHY THIS FILE EXISTS. Every 25.2/25.3/25.4/25.5 schedule spec emitted
// `action.args: []`, which the source itself called a placeholder — "not a
// functioning daily brief". A registered schedule whose action starts a workflow
// with NO input is not a schedule that runs: the wrapper dereferences
// `input.run` and the execution dies on the first occurrence. This module is the
// contract that closes that gap, and it is deliberately a SEPARATE file so the
// spec builder (scheduleRegistrar.ts) and the workflow wrappers (workflows.ts)
// depend on ONE frozen shape rather than on each other.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING FACT, MEASURED NOT ASSUMED
// ---------------------------------------------------------------------------
// A schedule's `action.args` is STATIC: it is fixed when the schedule is created
// and is byte-identical on every occurrence. So the per-occurrence identity a
// run needs (a DISTINCT `idempotencyKey` per tick) CANNOT come from args.
//
// It comes from the workflow id instead. Temporal appends the occurrence's
// scheduled time to the action's configured `workflowId`. That is not an
// assumption read off documentation — it was MEASURED against a real ephemeral
// server (`schedule-occurrence-identity.test.ts`), which observed:
//
//     configured workflowId : "probe-fixed-id"
//     started   workflowId : "probe-fixed-id-2026-08-27T18:22:52Z"
//
// ⇒ `workflowInfo().workflowId` inside a scheduled run is UNIQUE PER OCCURRENCE
//   and STABLE across replay and across retries of that same occurrence — which
//   is exactly the property an idempotency key must have. {@link deriveScheduledRunInput}
//   is the single place that derivation happens.
//
// ⚠ Do NOT switch the key to `workflowInfo().runId`: a runId changes on retry and
//   on continue-as-new, so a retried occurrence would admit a SECOND run and the
//   7.4 idempotency seam would silently stop deduplicating.
//
// ---------------------------------------------------------------------------
// WHAT ARGS MAY AND MAY NOT CARRY
// ---------------------------------------------------------------------------
// MAY:  static per-schedule configuration — cadence, catch-up window, the bound
//       workspace scopes, the Global coordination target. These are owner
//       configuration; they do not vary tick to tick.
// MUST NOT: anything per-occurrence (run identity, timestamps, cursors). Those
//       are derived in-sandbox, where they are replay-safe.
import type { WorkspaceId } from "@sow/contracts";
import type { ResolveRunInput } from "@sow/workflows";

// ---------------------------------------------------------------------------
// (1) the per-occurrence run-identity derivation
// ---------------------------------------------------------------------------

/**
 * The narrow slice of Temporal's `workflowInfo()` {@link deriveScheduledRunInput}
 * reads. Injected as a plain value rather than imported from `@temporalio/workflow`
 * so this module stays pure + unit-testable outside a workflow sandbox (the same
 * narrow-port convention `ScheduleClientPort` follows in scheduleRegistrar.ts).
 */
export interface ScheduledWorkflowIdentity {
  /** The per-occurrence workflow id — the configured id plus Temporal's scheduled-time suffix. */
  readonly workflowId: string;
}

/**
 * Derive the 7.4 {@link ResolveRunInput} for ONE scheduled occurrence.
 *
 * `idempotencyKey` is the per-occurrence workflow id itself (see the module
 * header for why that is the correct source and `runId` is not). `trigger` is
 * pinned to the closed-taxonomy `"schedule"` value — a scheduled occurrence is
 * never an `owner_action`, and mislabelling it would corrupt the §9 run ledger's
 * provenance.
 *
 * `workspaceId` is REQUIRED by WS-2: `createWorkflowRun` rejects an unscoped
 * submission fail-closed (`unscoped_run`), so a schedule that omitted its bound
 * workspace would fail on every tick rather than silently running unscoped. That
 * is the correct posture, and it is why every envelope below carries a workspace.
 */
export function deriveScheduledRunInput(
  identity: ScheduledWorkflowIdentity,
  boundWorkspaceId: WorkspaceId,
): ResolveRunInput {
  return {
    workflowId: identity.workflowId as ResolveRunInput["workflowId"],
    trigger: "schedule",
    idempotencyKey: identity.workflowId,
    workspaceId: boundWorkspaceId,
  };
}

// ---------------------------------------------------------------------------
// (2) the per-family STATIC argument envelopes
// ---------------------------------------------------------------------------

/** A workspace a scheduled output run is authorized to read over (WS-2, bound at admission). */
export interface ScheduledWorkspaceScope {
  readonly workspaceId: WorkspaceId;
  /** The workspace's GBrain brain id — the in-scope brain the agent may query. */
  readonly brainId?: string;
}

/**
 * 25.2 — the static configuration a scheduled `dailyBrief` occurrence needs.
 * `catchUpWindowMs` feeds the LIFE-2 collapse decision; `globalWorkspaceId` is the
 * Global/Coordination target the global brief commits to; `scopes` is the WS-2
 * authorized set (cross-workspace content still reaches the global brief ONLY as
 * GCL projections — safety rule 4 — never as raw bodies).
 */
export interface DailyBriefScheduleArgs {
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}

/** 25.2 — the static configuration a scheduled `periodReview` occurrence needs. */
export interface PeriodReviewScheduleArgs {
  readonly scheduleId: string;
  /** Which cadence this schedule drives. BOTH cadences share one workflow type. */
  readonly period: "weekly" | "monthly";
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly scopes: readonly ScheduledWorkspaceScope[];
}

/** One calendar availability source a scheduled cross-calendar occurrence reads across. */
export interface ScheduledAvailabilitySource {
  readonly sourceId: string;
  readonly workspaceId: WorkspaceId;
}

/**
 * 25.4 — the static configuration a scheduled `crossCalendarScheduling` occurrence
 * needs. `sources` is the FULL set REQ-F-009 requires be read across (an unread
 * source is a typed gather failure, never an empty/free assumption);
 * `organizerWorkspaceId` is the WS-2 workspace an auto-created event belongs to.
 */
export interface CrossCalendarSchedulingScheduleArgs {
  readonly scheduleId: string;
  readonly organizerWorkspaceId: WorkspaceId;
  readonly sources: readonly ScheduledAvailabilitySource[];
}

// ---------------------------------------------------------------------------
// (3) the SCHEDULED entry-point type names
// ---------------------------------------------------------------------------

/**
 * ⭐ The scheduled entry points are DISTINCT exports from the direct-start
 * wrappers, not a signature change to them. A schedule starts
 * `dailyBriefScheduledWorkflow(args)` — which derives the occurrence's run
 * identity and composes the full `DailyBriefInput` — while
 * `dailyBriefWorkflow(input)` keeps taking a complete input for a direct
 * owner-triggered start. Two entry points, one driver body.
 *
 * Collapsing these into one polymorphic entry would force a runtime discriminator
 * on the input and make "was this occurrence scheduled or owner-triggered?"
 * a guess rather than a fact the type system carries.
 */
export const DAILY_BRIEF_SCHEDULED_WORKFLOW_TYPE = "dailyBriefScheduledWorkflow" as const;
export const PERIOD_REVIEW_SCHEDULED_WORKFLOW_TYPE = "periodReviewScheduledWorkflow" as const;
export const CROSS_CALENDAR_SCHEDULING_SCHEDULED_WORKFLOW_TYPE =
  "crossCalendarSchedulingScheduledWorkflow" as const;
