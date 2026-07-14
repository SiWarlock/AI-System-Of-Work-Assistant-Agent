// Task 13.10 (reconcile-TRIGGER arc, piece E) — the pure worker-side reconcile SCHEDULER (trigger-origin). spec(§6) spec(§12)
//
// WORKFLOW-WEIGHT RESOLVED here → the lighter worker-scheduled pass (NOT a Temporal workflow): the reconcile is
// idempotent read+record (not an external side effect), so exactly-once/durability is over-engineering;
// collapseToMaxRevision IS the LIFE-2 catch-up-collapse; a crash → degrade → next-trigger-recovers is fail-safe
// (the serving coverage reader already degrades on a stale/absent report).
//
// createReconcileScheduler returns { enqueue, flush }:
//   • enqueue(ws, trigger)  — accumulate a PendingTrigger in the workspace's queue.
//   • flush(ws)             — BURST-COLLAPSE (LIFE-2): collapseToMaxRevision picks the max-seq trigger, so a
//                             burst of vault changes fires ONE reconcile at the newest revision, never one-per-
//                             change; dispatch the injected never-throwing driver ONCE; route the outcome through
//                             a REDACTED log; the queue is CONSUMED (snapshot + delete BEFORE the await, so an
//                             enqueue arriving mid-dispatch lands in a fresh queue + a re-flush is a no-op).
//
// Safety rule 7 (constraint b): every outcome is summarized to a LOG-SAFE LoggedReconcileOutcome BEFORE the log
// sink — pass_faulted.cause runs through the canonical @sow/domain `redactError` (message/stack → REDACTED_RAW,
// only a typed causeCode surfaces); skipped_derive_error is stripped to its safe `code` (path/detail dropped).
// A SINGLE redacted `log` sink is the sole chokepoint — the raw cause/error never leaves this module, so the
// downstream (piece F: health materialization) literally cannot leak it. `flush` never throws GIVEN a non-throwing
// driver (piece D — guaranteed) + a non-throwing `log` sink (F binds a trivially-serializable redacted sink);
// redaction completes BEFORE the log call, so even a throwing sink cannot leak raw content.
//
// DORMANT + reachability-waivered: no production caller — piece F (a gateReconcile-style default-OFF boot gate)
// binds the real trigger source (startVaultWatcher / schedule / post-`sourceIngestion`-commit), the flush timing,
// the never-reject collaborators (constraint a), the health surface (constraint c), and the arming flag — all
// default-OFF byte-equivalent. No boot/Temporal/real-fs/timer here; the driver + log are injected (fakes in tests).
import { collapseToMaxRevision } from "@sow/knowledge";
import type { PendingTrigger, ReconcileTriggerOrigin } from "@sow/knowledge";
import { redactError } from "@sow/domain";
import type { RedactedError } from "@sow/domain";
import type { ReconcileDriverOutcome } from "./reconcileDriver";

/** The log-safe projection of a reconcile pass's outcome (safety rule 7 — no raw cause/error/content). */
export interface LoggedReconcileOutcome {
  readonly kind: ReconcileDriverOutcome["kind"];
  readonly workspaceId: string;
  readonly revisionId: string;
  /** A SAFE sub-tag — the disposition kind (reconciled) or the DeriveError code (skipped_derive_error); NEVER raw. */
  readonly detail?: string;
  /** pass_faulted ONLY: the canonical redacted projection of the cause (message/stack → markers, typed causeCode only). */
  readonly redactedCause?: RedactedError;
}

/** The injected collaborators — the driver (bound to the never-reject builders at F) + the redacted log sink. */
export interface ReconcileSchedulerDeps {
  readonly runReconcile: (workspaceId: string, origin: ReconcileTriggerOrigin) => Promise<ReconcileDriverOutcome>;
  readonly log: (summary: LoggedReconcileOutcome) => void;
}

/** The pure trigger-origin scheduler: accumulate triggers, burst-collapse + dispatch on an externally-driven flush. */
export interface ReconcileScheduler {
  enqueue(workspaceId: string, trigger: PendingTrigger): void;
  flush(workspaceId: string): Promise<void>;
}

export function createReconcileScheduler(deps: ReconcileSchedulerDeps): ReconcileScheduler {
  const queues = new Map<string, PendingTrigger[]>();

  return {
    enqueue(workspaceId: string, trigger: PendingTrigger): void {
      const q = queues.get(workspaceId);
      if (q === undefined) queues.set(workspaceId, [trigger]);
      else q.push(trigger);
    },

    async flush(workspaceId: string): Promise<void> {
      // Snapshot + DELETE synchronously BEFORE the await: the burst is consumed atomically, so an enqueue arriving
      // during the dispatch accumulates in a fresh queue (not lost / not folded in) and a re-flush is a no-op.
      const pending = queues.get(workspaceId) ?? [];
      queues.delete(workspaceId);

      const winner = collapseToMaxRevision(pending); // LIFE-2: max-seq wins; [] ⇒ undefined
      if (winner === undefined) return; // nothing to reconcile

      const outcome = await deps.runReconcile(workspaceId, winner.origin); // never throws (piece D)
      deps.log(summarizeOutcome(outcome, workspaceId, winner.revisionId));
    },
  };
}

/** Project a driver outcome to its log-safe summary (safety rule 7 — the raw cause/error never crosses). */
function summarizeOutcome(
  outcome: ReconcileDriverOutcome,
  workspaceId: string,
  revisionId: string,
): LoggedReconcileOutcome {
  const base = { kind: outcome.kind, workspaceId, revisionId };
  switch (outcome.kind) {
    case "reconciled":
      return { ...base, detail: outcome.disposition.kind }; // the disposition kind is a safe enum tag
    case "skipped_absent":
      return base;
    case "skipped_derive_error":
      return { ...base, detail: outcome.error.code }; // ONLY the safe DeriveError code; path/detail dropped
    case "pass_faulted":
      return { ...base, redactedCause: redactError(outcome.cause) }; // message/stack → markers; typed causeCode only
  }
}
