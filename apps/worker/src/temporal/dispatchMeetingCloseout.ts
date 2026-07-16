// @sow/worker — the degraded-safe programmatic DISPATCH entry for meetingCloseout (15.9, G1 flagship).
//
// The meetingCloseout workflow (temporal/workflows.ts) was registered so it CAN execute, but until
// now it started ONLY in test/fakes — so the owner's flagship "meeting transcript → closeout note →
// propose tasks" had NO production trigger. This module adds the CLIENT-side path that STARTS a run
// (the 15.1 connector→ingestion bridge calls it when a completed-meeting record arrives). It is the
// EXACT analog of dispatchSourceIngestion — same two design pins, same degraded-safe convention:
//
//   • IDEMPOTENT BY CONSTRUCTION (rule 3) — the run's deterministic `idempotencyKey` (the meeting's
//     canonical identity) IS the Temporal `workflowId`, so a re-dispatch of the SAME meeting dedupes
//     at the Temporal layer (workflowId-reuse REJECT_DUPLICATE → an idempotent no-op). One closeout
//     per meeting, even across a re-poll / an edited transcript.
//   • DEGRADED-SAFE (§16) — when Temporal is unavailable (no client) OR a start throws, the dispatch
//     returns a typed `err` AND surfaces a §16 health item (never a silent drop), and NEVER throws
//     across the boundary — it must never crash boot.
//
// PURE over the injected {@link StartWorkflowRun} port (shared with dispatchSourceIngestion — the
// concrete @temporalio/client wrapper is `createTemporalClientStartRun`), so this dispatch is
// client-agnostic + degraded-testable. The MeetingCloseoutInput carries the registered transcript as
// candidate data (`context.source`); the workflow's own gate (correlate → agent → validate) governs
// it — the dispatch never touches content, it only starts the run.
import { ok, err } from "@sow/contracts";
import type { Result, AuditId, FailureClass } from "@sow/contracts";
import type { MeetingCloseoutInput } from "@sow/workflows";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";
// Reuse the source dispatcher's shared, workflow-type-agnostic ports + outcome types + the
// production Temporal-client adapter (`createTemporalClientStartRun` takes the workflowType as an
// argument, so it starts meetingCloseout runs unchanged) — one dispatch substrate, no duplication.
import type {
  StartWorkflowRun,
  DispatchHealthSink,
  DispatchError,
  DispatchOutcome,
} from "./dispatchSourceIngestion";

/** The registered sandbox workflow type name (see temporal/workflows.ts `meetingCloseoutWorkflow`). */
export const MEETING_CLOSEOUT_WORKFLOW_TYPE = "meetingCloseoutWorkflow" as const;

export interface DispatchMeetingCloseoutDeps {
  /** The start port; UNDEFINED when Temporal is unavailable (degraded boot) ⇒ fail-closed. */
  readonly startRun?: StartWorkflowRun;
  readonly surfaceHealth: DispatchHealthSink;
  readonly taskQueue: SowTaskQueue;
  readonly auditRef: AuditId;
}

// A Temporal-unavailable dispatch failure is genuine INFRA down (the class reserved for `worker_down`)
// — NOT a transcript-content cause, so NOT a security/policy/egress member.
const DISPATCH_DEGRADED_CLASS: FailureClass = "worker_down";

/**
 * Start a `meetingCloseout` run — degraded-safe, idempotent by the meeting's canonical key. Returns
 * the started run's handle on a fresh start; a deduped no-op on a same-meeting re-dispatch; a typed
 * `err` (+ a surfaced §16 health item) when Temporal is unavailable or the start faults. NEVER throws
 * across the boundary (§16). Mirrors {@link dispatchSourceIngestion} exactly.
 */
export async function dispatchMeetingCloseout(
  input: MeetingCloseoutInput,
  deps: DispatchMeetingCloseoutDeps,
): Promise<Result<DispatchOutcome, DispatchError>> {
  // The deterministic dedupe key IS the run's idempotencyKey → the Temporal workflowId. Deref
  // defensively so even a malformed input (a bridge construction bug bypassing the type) fails
  // closed to a typed Result — the §16 never-throw guarantee has NO escape hatch.
  const workflowId = input?.run?.idempotencyKey;
  if (typeof workflowId !== "string" || workflowId.length === 0) {
    await surfaceDegraded(deps, "unknown", "meetingCloseout dispatch rejected — malformed input (missing run.idempotencyKey)");
    return err({ code: "dispatch_failed", message: "malformed dispatch input; missing run.idempotencyKey" });
  }

  if (deps.startRun === undefined) {
    await surfaceDegraded(
      deps,
      workflowId,
      `meetingCloseout dispatch skipped — Temporal unavailable (trigger:${input.run.trigger})`,
    );
    return err({
      code: "temporal_unavailable",
      message: "temporal client unavailable; meetingCloseout dispatch fail-closed",
    });
  }

  try {
    const started = await deps.startRun({
      workflowType: MEETING_CLOSEOUT_WORKFLOW_TYPE,
      workflowId,
      taskQueue: deps.taskQueue,
      args: [input],
    });
    if (started.kind === "already_started") {
      // Idempotent no-op — a duplicate dispatch of the same meeting; ONE closeout stands (rule 3).
      return ok({ workflowId, dispatched: false, deduped: true });
    }
    return ok({ workflowId, dispatched: true, deduped: false, handle: started.handle });
  } catch (cause) {
    // The catch covers ANY start throw (connect fault, transport error, …) — the specific cause rides
    // `cause`; the message does not over-assert "Temporal unavailable".
    await surfaceDegraded(
      deps,
      workflowId,
      `meetingCloseout dispatch failed (trigger:${input.run.trigger})`,
    );
    return err({
      code: "dispatch_failed",
      message: "meetingCloseout dispatch failed; fail-closed",
      cause,
    });
  }
}

/** Surface the degraded §16 health item — swallow a sink fault so the dispatch never throws. */
async function surfaceDegraded(
  deps: DispatchMeetingCloseoutDeps,
  workflowId: string,
  message: string,
): Promise<void> {
  try {
    await deps.surfaceHealth({
      failureClass: DISPATCH_DEGRADED_CLASS,
      subjectRef: `meeting-dispatch:${workflowId}`,
      message,
      auditRef: deps.auditRef,
    });
  } catch {
    // Even a health-sink fault must NOT crash boot (§16 — nothing throws across the boundary).
  }
}
