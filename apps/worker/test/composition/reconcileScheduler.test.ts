// Task 13.10 — reconcile-TRIGGER arc, piece E: createReconcileScheduler. spec(§6) spec(§12)
//
// The pure worker-side trigger-origin scheduler (WORKFLOW-WEIGHT = the lighter worker-scheduled pass, NOT a
// Temporal workflow — the reconcile is idempotent read+record, so durability is over-engineering): enqueue(ws,
// PendingTrigger) accumulates per-workspace; flush(ws) BURST-COLLAPSES via collapseToMaxRevision (LIFE-2 — a
// burst fires ONE max-seq reconcile, never one-per-change), dispatches the injected never-throwing driver
// runReconcile(ws, origin) ONCE, clears the queue, isolates per-workspace, and routes the outcome through a
// REDACTED log (safety rule 7 — pass_faulted.cause + skipped_derive_error.error stripped to a code/marker).
// DORMANT + fakes only; the real trigger source + flush timing + health surface + arming bind at piece F.
import { describe, it, expect, vi } from "vitest";
import { validParityReport, REDACTED_RAW } from "@sow/contracts";
import type { PendingTrigger, ReconcileTriggerOrigin } from "@sow/knowledge";
import type { ReconcileDriverOutcome } from "../../src/composition/reconcileDriver";
import type { ParityRecordDisposition } from "../../src/composition/parityReportStore";
import { createReconcileScheduler, type LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";

function trigger(origin: ReconcileTriggerOrigin, revisionId: string, seq: number): PendingTrigger {
  return { origin, revisionId, seq };
}

const RECORDED: ParityRecordDisposition = { kind: "recorded", report: validParityReport };
const RECONCILED: ReconcileDriverOutcome = { kind: "reconciled", disposition: RECORDED };

/** A scheduler over a spied runReconcile (canned outcome) + a spied log capturing the redacted summaries. */
function makeScheduler(opts: { outcome?: ReconcileDriverOutcome } = {}) {
  const runReconcile = vi.fn(
    async (_ws: string, _origin: ReconcileTriggerOrigin): Promise<ReconcileDriverOutcome> => opts.outcome ?? RECONCILED,
  );
  const logged: LoggedReconcileOutcome[] = [];
  const log = vi.fn((s: LoggedReconcileOutcome) => {
    logged.push(s);
  });
  const scheduler = createReconcileScheduler({ runReconcile, log });
  return { scheduler, runReconcile, log, logged };
}

describe("createReconcileScheduler — LIFE-2 burst-collapse (spec §12)", () => {
  it("burst_collapses_to_one_dispatch", async () => {
    // 3 enqueues at rising seq → ONE flush ⇒ runReconcile ONCE with the max-seq (seq 3) trigger's origin
    const { scheduler, runReconcile, logged } = makeScheduler();
    scheduler.enqueue("ws-a", trigger("post_commit", "rev:1", 1));
    scheduler.enqueue("ws-a", trigger("fs_watch", "rev:2", 2));
    scheduler.enqueue("ws-a", trigger("schedule", "rev:3", 3));
    await scheduler.flush("ws-a");
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(runReconcile).toHaveBeenCalledWith("ws-a", "schedule");
    // the log summary carries the max-seq WINNER's workspace + revision (pins the summarizeOutcome arg threading —
    // a ws/rev swap or a wrong-trigger revision would pass without this)
    expect(logged[0]).toMatchObject({ kind: "reconciled", workspaceId: "ws-a", revisionId: "rev:3", detail: "recorded" });
  });

  it("empty_flush_no_dispatch", async () => {
    // no accumulated triggers ⇒ collapseToMaxRevision([]) → undefined ⇒ runReconcile NOT called (and not logged)
    const { scheduler, runReconcile, log } = makeScheduler();
    await scheduler.flush("ws-a");
    expect(runReconcile).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("flush_clears_queue", async () => {
    // the burst is CONSUMED on flush — a second flush with no new enqueues is a no-op (not a re-run)
    const { scheduler, runReconcile } = makeScheduler();
    scheduler.enqueue("ws-a", trigger("schedule", "rev:1", 1));
    await scheduler.flush("ws-a");
    await scheduler.flush("ws-a");
    expect(runReconcile).toHaveBeenCalledTimes(1);
  });

  it("per_workspace_isolation", async () => {
    // flush(A) dispatches ONLY A's collapsed trigger; B's queue stays intact until its own flush
    const { scheduler, runReconcile } = makeScheduler();
    scheduler.enqueue("ws-a", trigger("schedule", "rev:a", 5));
    scheduler.enqueue("ws-b", trigger("post_commit", "rev:b", 9));
    await scheduler.flush("ws-a");
    expect(runReconcile).toHaveBeenCalledTimes(1);
    expect(runReconcile).toHaveBeenCalledWith("ws-a", "schedule");
    await scheduler.flush("ws-b");
    expect(runReconcile).toHaveBeenCalledTimes(2);
    expect(runReconcile).toHaveBeenLastCalledWith("ws-b", "post_commit");
  });

  it("enqueue_during_dispatch_survives_to_next_flush", async () => {
    // pins the snapshot+DELETE-before-await design (Q5): an enqueue arriving DURING a flush's in-flight dispatch
    // accumulates in a FRESH queue — NOT lost, NOT folded into the in-flight burst, NOT double-dispatched.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runReconcile = vi.fn(async (_ws: string, _origin: ReconcileTriggerOrigin): Promise<ReconcileDriverOutcome> => {
      await gate; // block the FIRST dispatch until released (an already-resolved gate is immediate for later calls)
      return RECONCILED;
    });
    const scheduler = createReconcileScheduler({ runReconcile, log: () => {} });

    scheduler.enqueue("ws-a", trigger("post_commit", "rev:1", 1));
    const firstFlush = scheduler.flush("ws-a"); // runs synchronously to the await: snapshots + DELETES, then dispatches

    // mid-flight enqueue → lands in a FRESH queue (the original burst was already consumed by the snapshot+delete)
    scheduler.enqueue("ws-a", trigger("schedule", "rev:2", 2));

    release();
    await firstFlush;
    expect(runReconcile).toHaveBeenCalledTimes(1); // ONLY the original burst has dispatched
    expect(runReconcile).toHaveBeenNthCalledWith(1, "ws-a", "post_commit");

    await scheduler.flush("ws-a"); // the mid-flight enqueue is still pending ⇒ dispatches now (not double, not lost)
    expect(runReconcile).toHaveBeenCalledTimes(2);
    expect(runReconcile).toHaveBeenNthCalledWith(2, "ws-a", "schedule");
  });
});

describe("createReconcileScheduler — redacted outcome routing (safety rule 7, spec §12)", () => {
  it("outcome_redacted_before_log", async () => {
    // a pass_faulted whose cause embeds a marker secret ⇒ the log payload carries the canonical RedactedError
    // projection (message scrubbed to REDACTED_RAW), NEVER the raw cause
    const cause = new Error("record failed: MARKER_SECRET_zzz leaked here");
    const pf = makeScheduler({ outcome: { kind: "pass_faulted", cause } });
    pf.scheduler.enqueue("ws-a", trigger("schedule", "rev:1", 1));
    await pf.scheduler.flush("ws-a");
    expect(pf.log).toHaveBeenCalledTimes(1);
    const summary = pf.logged[0]!;
    expect(summary.kind).toBe("pass_faulted");
    expect(JSON.stringify(summary)).not.toContain("MARKER_SECRET_zzz"); // the raw cause never reaches the sink
    expect(summary.redactedCause?.message).toBe(REDACTED_RAW);

    // a skipped_derive_error ⇒ the error is stripped to its safe code; path (which can carry content) is dropped
    const de = makeScheduler({
      outcome: { kind: "skipped_derive_error", error: { code: "invalid_page_path", path: "SECRET_PATH_MARKER/x.md" } },
    });
    de.scheduler.enqueue("ws-a", trigger("schedule", "rev:1", 1));
    await de.scheduler.flush("ws-a");
    const s2 = de.logged[0]!;
    expect(s2.kind).toBe("skipped_derive_error");
    expect(s2.detail).toBe("invalid_page_path");
    expect(JSON.stringify(s2)).not.toContain("SECRET_PATH_MARKER");
  });

  it("flush_never_throws", async () => {
    // every outcome kind ⇒ flush RESOLVES (the scheduler is fail-safe; the driver never throws)
    const outcomes: ReconcileDriverOutcome[] = [
      { kind: "reconciled", disposition: RECORDED },
      { kind: "skipped_absent" },
      { kind: "skipped_derive_error", error: { code: "duplicate_fact_identity", factIdentity: "page:x", paths: ["a.md", "b.md"] } },
      { kind: "pass_faulted", cause: new Error("boom") },
    ];
    for (const outcome of outcomes) {
      const { scheduler, log } = makeScheduler({ outcome });
      scheduler.enqueue("ws-a", trigger("schedule", "rev:1", 1));
      await expect(scheduler.flush("ws-a")).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1); // every dispatched outcome is routed through the redacted log
    }
  });
});
