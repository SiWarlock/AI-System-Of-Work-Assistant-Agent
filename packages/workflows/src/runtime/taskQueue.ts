// @sow/workflows — FOUNDATION: the Temporal task-queue name constant(s) +
// registration types (§9 durability spine, LIFE-1).
//
// PURE + workflow-safe: this module imports NOTHING from @temporalio, NOTHING
// from node:crypto, and calls NO Date.now()/Math.random(). It pins the ONE
// canonical task-queue name the worker binding registers on and the lease
// (LIFE-1) is keyed to, plus the small type surface a caller uses to describe a
// registration. Keeping the name here — not inline in the worker bootstrap —
// means the pure lease decision, the worker bootstrap, and (later) the Temporal
// workflow/client code all agree on ONE string with no drift.

/**
 * The single canonical Temporal task queue for the SoW control-plane worker.
 * There is exactly ONE active worker instance per queue (LIFE-1: the
 * single-active-instance lease is keyed on this name), so a stray second worker
 * cannot double-process. Any additional queues (should §9 later split work) get
 * their own named constant here — the name is never a bare string literal at a
 * call site.
 */
export const SOW_CONTROL_PLANE_TASK_QUEUE = "sow-control-plane" as const;

/** The closed set of task-queue names this package knows about (LIFE-1 keys). */
export const SOW_TASK_QUEUES = [SOW_CONTROL_PLANE_TASK_QUEUE] as const;

/** A task-queue name — an element of {@link SOW_TASK_QUEUES}. */
export type SowTaskQueue = (typeof SOW_TASK_QUEUES)[number];

/**
 * The description a worker binding uses to register on a task queue: the queue
 * name plus the workflow-module bundle path and the activity names it will
 * serve. This is a pure DESCRIPTOR — the actual @temporalio Worker.create call
 * that consumes it lives in the (gated) worker bootstrap, never here.
 */
export interface TaskQueueRegistration {
  readonly taskQueue: SowTaskQueue;
  /** Resolved path to the compiled workflow-definitions module bundle. */
  readonly workflowsPath: string;
  /** The activity names this worker registers (wired at the binding edge). */
  readonly activityNames: readonly string[];
}
