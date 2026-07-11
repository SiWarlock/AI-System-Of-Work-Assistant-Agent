// @sow/worker — the degraded-safe DISPATCH entry unit tests (make-it-real C3a).
//
// dispatchSourceIngestion STARTS a sourceIngestion run via a Temporal Client (the C3b
// file-watcher will call it). These fast-unit cases need NO Temporal server — they inject
// a fake startRun port to pin the two boundary behaviors that must hold on the live path:
//   • DEGRADED-SAFE (§16): no client / a start throw → a typed err + a surfaced health
//     item, NEVER a throw across the boundary (must never crash boot).
//   • trigger passthrough: the caller's WorkflowRunRef.trigger (a connector_event/owner_action)
//     reaches the run verbatim — no coercion/remapping.
// The live dispatch + dedupe are proven under SOW_TEMPORAL in sourceIngestion-live.test.ts.
import { describe, it, expect } from "vitest";
import { workflowId, sourceId, workspaceId, auditId } from "@sow/contracts";
import type { AuditId } from "@sow/contracts";
import type { SourceIngestionInput, WorkflowTrigger } from "@sow/workflows";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import {
  dispatchSourceIngestion,
  type StartWorkflowRun,
  type StartRunOutcome,
  type DispatchHealthSink,
  type DispatchSourceIngestionDeps,
} from "../../src/temporal/dispatchSourceIngestion";

const AUDIT: AuditId = auditId("source-dispatch:test");

// A watcher event dispatches trigger `connector_event`; a manual/CLI trigger `owner_action`
// (the run's trigger is the CLOSED WorkflowTrigger taxonomy — the dispatch carries whatever
// the caller passes through VERBATIM, no coercion).
const makeInput = (trigger: WorkflowTrigger, idempotencyKey: string): SourceIngestionInput => ({
  run: {
    workflowId: workflowId("wf-dispatch"),
    trigger,
    idempotencyKey,
    workspaceId: "ws-src",
  },
  context: {
    source: {
      sourceId: sourceId("src-dispatch-1"),
      workspaceId: workspaceId("ws-src"),
      origin: "file:///vault/note.md",
      contentHash: "sha256:dispatch-1",
      type: "file",
      sensitivity: "normal",
      routingHints: {},
    },
    envelopes: [],
  },
});

/** A health sink that records every surfaced failure (proof nothing is silent). */
function recordingHealth(): {
  readonly sink: DispatchHealthSink;
  readonly surfaced: Array<{ failureClass: string; subjectRef: string; message: string }>;
} {
  const surfaced: Array<{ failureClass: string; subjectRef: string; message: string }> = [];
  return {
    surfaced,
    sink: (failure) => {
      surfaced.push({
        failureClass: failure.failureClass,
        subjectRef: failure.subjectRef,
        message: failure.message,
      });
      return Promise.resolve();
    },
  };
}

describe("dispatchSourceIngestion — degraded-safe + trigger passthrough (fast unit)", () => {
  it("returns a typed err + surfaces a §16 health item when Temporal is unavailable, never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const deps: DispatchSourceIngestionDeps = {
      // startRun ABSENT ⇒ Temporal unavailable (degraded boot).
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };

    const res = await dispatchSourceIngestion(makeInput("connector_event", "run:src:degraded"), deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("temporal_unavailable");
    // nothing silent — a health item was surfaced (worker_down, matching the degraded controller).
    expect(health.surfaced.length).toBe(1);
    expect(health.surfaced[0]?.failureClass).toBe("worker_down");
  });

  it("fails closed (typed err + health item) when the start THROWS (transport fault), never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const throwingStart: StartWorkflowRun = () => Promise.reject(new Error("connection refused"));
    const deps: DispatchSourceIngestionDeps = {
      startRun: throwingStart,
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };

    const res = await dispatchSourceIngestion(makeInput("owner_action", "run:src:throw"), deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("dispatch_failed");
    expect(health.surfaced.length).toBe(1);
    expect(health.surfaced[0]?.failureClass).toBe("worker_down"); // same §16 class on both degraded paths
  });

  it("fails closed (typed err + health item) on a MALFORMED input (missing run.idempotencyKey), never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const deps: DispatchSourceIngestionDeps = {
      startRun: () => Promise.reject(new Error("must not be called")),
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };

    // A caller bypassing the type with a run-less input must still fail closed, never throw.
    const res = await dispatchSourceIngestion({} as unknown as SourceIngestionInput, deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("dispatch_failed");
    expect(health.surfaced.length).toBe(1);
  });

  it("carries the caller trigger through to the run verbatim (no coercion) — spec(§9)", async () => {
    const captured: SourceIngestionInput[] = [];
    const capturingStart: StartWorkflowRun = (args): Promise<StartRunOutcome> => {
      captured.push(args.args[0] as SourceIngestionInput);
      return Promise.resolve({
        kind: "started",
        handle: {
          workflowId: args.workflowId,
          firstExecutionRunId: "run-1",
          result: <R>() => Promise.resolve(undefined as R),
        },
      });
    };
    const health = recordingHealth();
    const deps: DispatchSourceIngestionDeps = {
      startRun: capturingStart,
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };

    const res = await dispatchSourceIngestion(makeInput("connector_event", "run:src:trigger"), deps);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.dispatched).toBe(true);
    // The Temporal workflowId IS the run's deterministic idempotencyKey (dedupe by construction).
    expect(res.value.workflowId).toBe("run:src:trigger");
    // The caller's trigger reached the run unchanged (no coercion/remapping).
    expect(captured[0]?.run.trigger).toBe("connector_event");
    expect(health.surfaced.length).toBe(0); // happy dispatch surfaces nothing
  });
});
