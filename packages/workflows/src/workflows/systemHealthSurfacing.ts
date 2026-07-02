// @sow/workflows — slice 7.5: System-Health SURFACING orchestration (§9 / §16).
//
// This is the FAILURE SINK every later §9 workflow (7.6–7.18) routes its
// cross-subsystem failures through. Its load-bearing invariant is §16: NOTHING
// FAILS SILENTLY. Every failure is routed to the retry/write-OUTBOX AND/OR a
// persisted HealthItem — AT LEAST ONE, never neither. It also exposes read-model
// PROJECTIONS (last/next/failed run status, queue + outbox depth, blocked
// write-throughs, open health-item count) for §10/§11 to render.
//
// NOTE (per the brief): this file is ORCHESTRATION logic — kept PURE + injected
// here (deterministic, importing NEITHER @temporalio NOR node:crypto, and NEVER
// calling Date.now()/Math.random() — time is the injected Clock). It is NOT a
// live @temporalio/workflow definition; the thin @temporalio wrapper (proxying
// the healthItem activity + the outbox repo) is deferred to the worker wiring.
// Keeping the decision logic pure makes it Vitest-unit-testable with no Temporal
// server AND safe to import into deterministic workflow code later.
//
// §16 error convention: never throws across the boundary — returns a typed
// Result<T, SurfaceError> whose `code` is an ENUMERABLE closed set. Fail-closed:
// if the health surfacing itself fails to persist, that is a typed err (a failure
// to record a failure is the ONE thing we must not swallow).
import { ok, err } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem, Result } from "@sow/contracts";
import type { Clock, HealthItemStore, OutboxEntry } from "../ports/operational";
import { materializeHealthItem } from "../activities/healthItem";

// --- injected ports ---------------------------------------------------------

/**
 * The retry / write-outbox sink. A retryable failure (one carrying an
 * {@link OutboxEntry}) is enqueued here for the §8 external-write envelope /
 * outbox drain to re-drive. Narrow on purpose — the surfacing path only ENQUEUES;
 * it never dispatches. Concrete impl (worker wiring) wraps the P2 OutboxRepository.
 */
export interface OutboxSink {
  enqueueRetry(entry: OutboxEntry): Promise<void>;
}

/** The injected ports the surfacing path needs (health store + outbox + clock). */
export interface SurfaceDeps {
  readonly health: HealthItemStore;
  readonly outbox: OutboxSink;
  readonly clock: Clock;
}

// --- the failure-surfacing input + outcome ---------------------------------

/**
 * A cross-subsystem workflow failure to surface. `retry` is present IFF the
 * failure is RETRYABLE (a re-drivable external write): its presence routes the
 * failure to the outbox. A health item is ALWAYS surfaced (operator visibility)
 * unless a caller opts out — but even then the outbox route must be taken, so a
 * failure is never silent.
 */
export interface WorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
  /** Present IFF the failure is retryable — routes to the outbox. */
  readonly retry?: OutboxEntry;
}

/** What the surfacing did — proof that the failure was NOT swallowed (§16). */
export interface SurfaceOutcome {
  readonly routedToOutbox: boolean;
  readonly routedToHealth: boolean;
  /** The surfaced/updated health item, when one was materialized. */
  readonly healthItem?: HealthItem;
}

/** Closed, enumerable failure taxonomy for the surfacing path (never thrown). */
export type SurfaceErrorCode =
  | "outbox_failed" // the retry enqueue rejected
  | "surface_failed"; // the health materialization rejected (§16 — must not swallow)

export interface SurfaceError {
  readonly code: SurfaceErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

const fail = (
  code: SurfaceErrorCode,
  message: string,
  cause?: unknown,
): Result<never, SurfaceError> => err({ code, message, cause });

// --- surfaceWorkflowFailure -------------------------------------------------

/**
 * Route a cross-subsystem workflow failure so it is NEVER silent (§16). Order:
 *   1. If the failure is retryable (carries a `retry` entry), enqueue it on the
 *      outbox for the §8 drain to re-drive.
 *   2. ALWAYS materialize a persisted HealthItem (deduped by (failureClass,
 *      subjectRef); a recurrence updates the existing item — see the materializer)
 *      so the failure is operator-visible.
 * The returned {@link SurfaceOutcome} proves at least one route was taken. A
 * persistence rejection on EITHER route is a typed err — a failure to record a
 * failure is the one thing this sink must not swallow. Never throws.
 */
export async function surfaceWorkflowFailure(
  failure: WorkflowFailure,
  deps: SurfaceDeps,
): Promise<Result<SurfaceOutcome, SurfaceError>> {
  let routedToOutbox = false;

  if (failure.retry !== undefined) {
    try {
      await deps.outbox.enqueueRetry(failure.retry);
      routedToOutbox = true;
    } catch (cause) {
      return fail("outbox_failed", "failed to enqueue the retry on the outbox", cause);
    }
  }

  const materialized = await materializeHealthItem(
    {
      failureClass: failure.failureClass,
      subjectRef: failure.subjectRef,
      severity: failure.severity,
      message: failure.message,
      auditRef: failure.auditRef,
      now: deps.clock.now(),
    },
    deps.health,
  );
  if (!materialized.ok) {
    return fail(
      "surface_failed",
      `failed to surface the health item for a ${failure.failureClass} failure: ${materialized.error.message}`,
      materialized.error,
    );
  }

  return ok({
    routedToOutbox,
    routedToHealth: true,
    healthItem: materialized.value,
  });
}

// --- projectSystemHealth (read-model projection) ---------------------------

/**
 * A workflow-run status row for the projection (a rebuildable read-model view of
 * the WorkflowRunRef registry — SUMMARY only, no raw content). `lastRunAt` is the
 * last observed run time; absent for a run that has not yet completed.
 */
export interface RunStatusRow {
  readonly workflowId: string;
  readonly state: string;
  readonly trigger: string;
  readonly lastRunAt?: string;
}

/** The inputs the §10/§11 System-Health surface feeds into the projection. */
export interface SystemHealthInput {
  readonly runs: readonly RunStatusRow[];
  readonly queueDepth: number;
  readonly outboxDepth: number;
  readonly blockedWriteThroughs: number;
  readonly healthItems: readonly HealthItem[];
  readonly nextScheduledRunAt?: string;
}

/** A count of runs per lifecycle state (rebuildable rollup). */
export interface RunCounts {
  readonly running: number;
  readonly waiting_approval: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Runs whose state is not one of the known §9 states (defensive bucket). */
  readonly other: number;
}

/**
 * The read-model projection §10/§11 renders: run-status rollup + the failed runs,
 * queue/outbox depth, blocked write-throughs, and the count of ACTIVE (unresolved)
 * health items. PURE + total — no clock, no I/O, no throw.
 */
export interface SystemHealthProjection {
  readonly runCounts: RunCounts;
  readonly failedRuns: readonly RunStatusRow[];
  readonly queueDepth: number;
  readonly outboxDepth: number;
  readonly blockedWriteThroughs: number;
  /** Count of open|acknowledged (unresolved) health items — resolved does not count. */
  readonly openHealthItemCount: number;
  readonly nextScheduledRunAt?: string;
}

/**
 * Project the current System-Health read model for §10/§11. PURE + deterministic:
 * a pure fold over the inputs (no clock, no I/O). An item counts as ACTIVE while
 * open OR acknowledged; only `resolved` clears it.
 */
export function projectSystemHealth(
  input: SystemHealthInput,
): SystemHealthProjection {
  const runCounts: RunCounts = {
    running: 0,
    waiting_approval: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
  };
  const failedRuns: RunStatusRow[] = [];

  const counts: Record<string, number> = { ...runCounts };
  for (const run of input.runs) {
    if (Object.prototype.hasOwnProperty.call(counts, run.state) && run.state !== "other") {
      counts[run.state] = (counts[run.state] ?? 0) + 1;
    } else {
      counts.other = (counts.other ?? 0) + 1;
    }
    if (run.state === "failed") failedRuns.push(run);
  }

  const openHealthItemCount = input.healthItems.filter(
    (h) => h.state !== "resolved",
  ).length;

  return {
    runCounts: {
      running: counts.running ?? 0,
      waiting_approval: counts.waiting_approval ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      cancelled: counts.cancelled ?? 0,
      other: counts.other ?? 0,
    },
    failedRuns,
    queueDepth: input.queueDepth,
    outboxDepth: input.outboxDepth,
    blockedWriteThroughs: input.blockedWriteThroughs,
    openHealthItemCount,
    ...(input.nextScheduledRunAt !== undefined
      ? { nextScheduledRunAt: input.nextScheduledRunAt }
      : {}),
  };
}
