// @sow/workflows — task 25.2/25.3/25.4 (PKG-W3) ACTIVITY: a GENERIC health-sink
// wrapper over the 7.5 `surfaceWorkflowFailure`, reused across all four
// families' *HealthSink ports (DailyBriefHealthSink, PeriodReviewHealthSink,
// ProjectSyncHealthSink, SchedulingHealthSink). Every one of the four declares
// `surface(failure: {failureClass, subjectRef, severity?, message, auditRef}):
// Promise<Result<{routedToHealth, routedToOutbox}, {code:"surface_failed"|
// "outbox_failed", message, cause?}>>` — a STRUCTURAL SUBSET of
// `surfaceWorkflowFailure`'s own `WorkflowFailure`/`SurfaceOutcome`/`SurfaceError`
// (WorkflowFailure additionally carries an optional `retry`; SurfaceOutcome
// additionally carries an optional `healthItem`; SurfaceErrorCode is the
// IDENTICAL two-member set) — so one thin wrapper satisfies all four directly,
// never a re-implementation of the 7.5 sink.
//
// This is an ACTIVITY, NOT workflow code. Never throws (surfaceWorkflowFailure
// itself never throws — see workflows/systemHealthSurfacing.ts).
import { surfaceWorkflowFailure } from "../workflows/systemHealthSurfacing";
import type { SurfaceDeps, WorkflowFailure, SurfaceOutcome, SurfaceError } from "../workflows/systemHealthSurfacing";
import type { Result } from "@sow/contracts";

/** The minimal failure shape every one of the four *HealthSink ports declares. */
export interface OutputWorkflowFailure {
  readonly failureClass: WorkflowFailure["failureClass"];
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: WorkflowFailure["auditRef"];
}

/**
 * Build a generic `{surface(failure): Promise<Result<SurfaceOutcome, SurfaceError>>}`
 * over the 7.5 `surfaceWorkflowFailure`. Structurally satisfies every one of the
 * four families' HealthSink port interfaces (the returned `SurfaceOutcome`/
 * `SurfaceError` are supersets/identical of what each port declares). Never throws.
 */
export function createOutputWorkflowHealthSink(deps: SurfaceDeps): {
  surface(failure: OutputWorkflowFailure): Promise<Result<SurfaceOutcome, SurfaceError>>;
} {
  return {
    surface(failure: OutputWorkflowFailure): Promise<Result<SurfaceOutcome, SurfaceError>> {
      return surfaceWorkflowFailure(failure, deps);
    },
  };
}
