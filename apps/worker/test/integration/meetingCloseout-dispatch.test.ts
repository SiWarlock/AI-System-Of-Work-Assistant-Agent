// @sow/worker — the degraded-safe MEETING-CLOSEOUT dispatch entry unit tests (15.9, G1 flagship).
//
// dispatchMeetingCloseout STARTS a meetingCloseout run via a Temporal Client (the 15.9 connector
// bridge calls it when a completed-meeting record arrives). It MIRRORS dispatchSourceIngestion
// exactly — these fast-unit cases inject a fake startRun port to pin the boundary behaviors:
//   • DEGRADED-SAFE (§16): no client / a start throw → a typed err + a surfaced health item,
//     NEVER a throw across the boundary (must never crash boot).
//   • IDEMPOTENT BY CONSTRUCTION (rule 3): the run's deterministic idempotencyKey IS the Temporal
//     workflowId, so a re-dispatch of the same meeting dedupes (already_started → no-op).
//   • trigger passthrough: the caller's trigger reaches the run verbatim (no coercion).
// The live dispatch + REJECT_DUPLICATE dedupe are proven under SOW_TEMPORAL (the flagship e2e).
import { describe, it, expect } from "vitest";
import { workflowId, sourceId, workspaceId, auditId } from "@sow/contracts";
import type { AuditId } from "@sow/contracts";
import type { MeetingCloseoutInput } from "@sow/workflows";
import type { WorkflowTrigger } from "@sow/workflows";
import { SOW_CONTROL_PLANE_TASK_QUEUE } from "@sow/workflows/runtime/taskQueue";
import type {
  StartWorkflowRun,
  StartRunOutcome,
  DispatchHealthSink,
} from "../../src/temporal/dispatchSourceIngestion";
import {
  dispatchMeetingCloseout,
  MEETING_CLOSEOUT_WORKFLOW_TYPE,
  type DispatchMeetingCloseoutDeps,
} from "../../src/temporal/dispatchMeetingCloseout";

const AUDIT: AuditId = auditId("meeting-dispatch:test");

// The bridge builds the meeting's deterministic identity (the connector's canonical meeting id) as
// BOTH the run's idempotencyKey AND the Temporal workflowId (mirror dispatchSourceIngestion).
const makeInput = (trigger: WorkflowTrigger, idempotencyKey: string): MeetingCloseoutInput => ({
  run: {
    workflowId: workflowId("wf-meeting-dispatch"),
    trigger,
    idempotencyKey,
    workspaceId: "ws-mtg",
  },
  context: {
    source: {
      sourceId: sourceId("mtg-dispatch-1"),
      workspaceId: workspaceId("ws-mtg"),
      origin: "connector:granola",
      contentHash: "sha256:meeting-1",
      type: "transcript",
      sensitivity: "internal",
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

describe("dispatchMeetingCloseout — degraded-safe + idempotent + trigger passthrough (fast unit, 15.9)", () => {
  it("targets the registered meetingCloseoutWorkflow type — spec(§9)", () => {
    expect(MEETING_CLOSEOUT_WORKFLOW_TYPE).toBe("meetingCloseoutWorkflow");
  });

  it("returns a typed err + surfaces a §16 health item when Temporal is unavailable, never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const deps: DispatchMeetingCloseoutDeps = {
      // startRun ABSENT ⇒ Temporal unavailable (degraded boot).
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };
    const res = await dispatchMeetingCloseout(makeInput("connector_event", "meeting:ws-mtg:m-degraded"), deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("temporal_unavailable");
    expect(health.surfaced.length).toBe(1);
    expect(health.surfaced[0]?.failureClass).toBe("worker_down");
    expect(health.surfaced[0]?.subjectRef).toBe("meeting-dispatch:meeting:ws-mtg:m-degraded");
  });

  it("fails closed (typed err + health item) when the start THROWS (transport fault), never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const throwingStart: StartWorkflowRun = () => Promise.reject(new Error("connection refused"));
    const deps: DispatchMeetingCloseoutDeps = {
      startRun: throwingStart,
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };
    const res = await dispatchMeetingCloseout(makeInput("owner_action", "meeting:ws-mtg:m-throw"), deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("dispatch_failed");
    expect(health.surfaced.length).toBe(1);
    expect(health.surfaced[0]?.failureClass).toBe("worker_down");
  });

  it("fails closed (typed err + health item) on a MALFORMED input (missing run.idempotencyKey), never throwing — spec(§16)", async () => {
    const health = recordingHealth();
    const deps: DispatchMeetingCloseoutDeps = {
      startRun: () => Promise.reject(new Error("must not be called")),
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };
    const res = await dispatchMeetingCloseout({} as unknown as MeetingCloseoutInput, deps);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("dispatch_failed");
    expect(health.surfaced.length).toBe(1);
  });

  it("starts the run with the deterministic meeting key as the Temporal workflowId + carries the trigger verbatim — spec(§9)", async () => {
    const captured: Array<{ workflowType: string; workflowId: string; args: readonly unknown[] }> = [];
    const capturingStart: StartWorkflowRun = (args): Promise<StartRunOutcome> => {
      captured.push({ workflowType: args.workflowType, workflowId: args.workflowId, args: args.args });
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
    const deps: DispatchMeetingCloseoutDeps = {
      startRun: capturingStart,
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };
    const res = await dispatchMeetingCloseout(makeInput("connector_event", "meeting:ws-mtg:m-1"), deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.dispatched).toBe(true);
    // The Temporal workflowId IS the run's deterministic idempotencyKey (dedupe by construction).
    expect(res.value.workflowId).toBe("meeting:ws-mtg:m-1");
    expect(captured[0]?.workflowType).toBe("meetingCloseoutWorkflow");
    expect(captured[0]?.workflowId).toBe("meeting:ws-mtg:m-1");
    // The FULL MeetingCloseoutInput is passed to the workflow (transcript flows through its gate).
    expect((captured[0]?.args[0] as MeetingCloseoutInput).run.trigger).toBe("connector_event");
    expect(health.surfaced.length).toBe(0); // happy dispatch surfaces nothing
  });

  it("a re-dispatch of the SAME meeting key is an idempotent no-op (already_started → deduped, no duplicate closeout) — spec(§9 / rule 3)", async () => {
    const started = new Set<string>();
    const dedupingStart: StartWorkflowRun = (args): Promise<StartRunOutcome> => {
      if (started.has(args.workflowId)) {
        return Promise.resolve({ kind: "already_started", workflowId: args.workflowId });
      }
      started.add(args.workflowId);
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
    const deps: DispatchMeetingCloseoutDeps = {
      startRun: dedupingStart,
      surfaceHealth: health.sink,
      taskQueue: SOW_CONTROL_PLANE_TASK_QUEUE,
      auditRef: AUDIT,
    };
    const first = await dispatchMeetingCloseout(makeInput("connector_event", "meeting:ws-mtg:dup"), deps);
    const second = await dispatchMeetingCloseout(makeInput("connector_event", "meeting:ws-mtg:dup"), deps);
    expect(first.ok && first.value.dispatched).toBe(true);
    expect(second.ok && second.value.deduped).toBe(true); // ONE closeout stands (rule 3)
    expect(started.size).toBe(1);
    expect(health.surfaced.length).toBe(0);
  });
});
