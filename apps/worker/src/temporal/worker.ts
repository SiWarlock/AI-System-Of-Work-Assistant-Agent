// 7.1 — the Temporal worker bootstrap (LIFE-1 / §16 supervision).
//
// Two layers in one file, split by testability:
//
//   • PURE, deterministic decision logic (default-suite Vitest, no Temporal
//     server): `decideBootstrap` maps a connect OUTCOME to a typed bootstrap
//     Result, and `buildWorkerDownHealthItem` builds the distinct 'worker_down'
//     System Health item. These import NEITHER @temporalio NOR node:crypto and
//     call NO Date.now() — "now" is injected. Temporal-UNAVAILABLE is a
//     first-class DEGRADED mode: dispatch blocked, a worker_down item raised, a
//     BOUNDED-backoff reconnect requested — never a crash-loop.
//
//   • The THIN gated bootstrap (`bootstrapWorker`): connects to the local
//     Temporal dev server (persistent, never in-memory), registers the task
//     queue, and drives the connect/degrade loop through the pure decision. The
//     @temporalio Worker.create + connect calls are pulled in via a DYNAMIC
//     import so this module's PURE exports do not drag @temporalio into the
//     default test's module graph; the live path runs only under SOW_TEMPORAL.

import { ok, err, auditId } from "@sow/contracts";
import type { Result, HealthItem } from "@sow/contracts";
import type { Clock } from "@sow/workflows/ports/operational";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";

// --- pure degraded-mode / bootstrap-failure decision ----------------------

/** The result of attempting to reach the Temporal server. */
export type ConnectOutcome =
  | { readonly connected: true }
  | { readonly connected: false; readonly reason: string };

/** Pure inputs to the bootstrap decision (clock injected via `now`). */
export interface BootstrapDecisionInput {
  readonly now: string;
  readonly taskQueue: SowTaskQueue;
  /** Zero-based reconnect attempt index — drives the bounded backoff curve. */
  readonly attempt: number;
}

/** A successful bootstrap: the worker is connected and may dispatch. */
export interface BootstrapReady {
  readonly taskQueue: SowTaskQueue;
  readonly dispatchEnabled: true;
}

/**
 * The closed bootstrap failure set (§16). `temporal_unavailable` is the
 * first-class degraded mode; the variant carries everything the supervisor needs
 * to degrade safely WITHOUT crashing: dispatch blocked, a worker_down health
 * item to raise, and a bounded reconnect delay.
 */
export type BootstrapErrorCode = "temporal_unavailable";

export interface BootstrapDegraded {
  readonly code: BootstrapErrorCode;
  /** Always false in degraded mode — no processing while Temporal is down. */
  readonly dispatchEnabled: false;
  readonly degraded: true;
  /** Ask the supervisor to reconnect (bounded backoff), never crash-loop. */
  readonly shouldReconnect: true;
  /** Bounded, monotonic-non-decreasing reconnect delay (ms). */
  readonly backoffMs: number;
  /** The distinct System Health item to raise (OBS-1). */
  readonly healthItem: HealthItem;
  readonly message: string;
}

// Backoff curve: exponential (base 500ms, doubling per attempt) hard-capped so a
// long outage never produces an unbounded wait — and Math.pow never overflows to
// Infinity — while staying monotonic non-decreasing in `attempt`.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 60_000;

/** Bounded exponential backoff for reconnect attempt `attempt` (>= 0). */
export function reconnectBackoffMs(attempt: number): number {
  const a = attempt < 0 ? 0 : Math.floor(attempt);
  // Cap the EXPONENT before Math.pow so huge attempt counts can't overflow to
  // Infinity; then cap the product. min() keeps it monotonic + finite.
  const cappedExp = Math.min(a, 20);
  const raw = BACKOFF_BASE_MS * Math.pow(2, cappedExp);
  return Math.min(raw, BACKOFF_CAP_MS);
}

/** The deterministic dedupe id for the worker_down item ((class, queue)). */
function workerDownId(taskQueue: SowTaskQueue): string {
  // §10.3 dedupe: one DISTINCT item per (failureClass, subject). No node:crypto
  // — a stable readable composite id keyed on the queue is sufficient and pure.
  return `worker_down:${taskQueue}`;
}

/** Build the distinct 'worker_down' System Health item (OBS-1). Pure. */
export function buildWorkerDownHealthItem(args: {
  readonly now: string;
  readonly taskQueue: SowTaskQueue;
  readonly reason: string;
}): HealthItem {
  return {
    id: workerDownId(args.taskQueue),
    failureClass: "worker_down",
    // severity is an OPEN string upstream (arch_gap); 'error' is the worker-down
    // level — the process cannot dispatch until Temporal returns.
    severity: "error",
    message: `Temporal worker for task queue ${args.taskQueue} cannot reach the server: ${args.reason}`,
    // No AuditRecord is minted in the pure layer; a synthetic, valid non-empty
    // audit ref anchors the item until the binding wires a real AuditRecord.
    auditRef: auditId(`worker-down-${args.taskQueue}`),
    openedAt: args.now,
    state: "open",
  };
}

/**
 * Map a connect OUTCOME to a typed bootstrap Result. Pure + clock-injected;
 * never throws (§16). A failed connect is the first-class DEGRADED mode — it
 * blocks dispatch, raises a worker_down item, and requests a bounded reconnect —
 * never a crash.
 */
export function decideBootstrap(
  outcome: ConnectOutcome,
  input: BootstrapDecisionInput,
): Result<BootstrapReady, BootstrapDegraded> {
  if (outcome.connected) {
    return ok({ taskQueue: input.taskQueue, dispatchEnabled: true });
  }
  return err({
    code: "temporal_unavailable",
    dispatchEnabled: false,
    degraded: true,
    shouldReconnect: true,
    backoffMs: reconnectBackoffMs(input.attempt),
    healthItem: buildWorkerDownHealthItem({
      now: input.now,
      taskQueue: input.taskQueue,
      reason: outcome.reason,
    }),
    message: `Temporal unavailable on ${input.taskQueue}: ${outcome.reason}`,
  });
}

// --- the THIN gated live bootstrap ----------------------------------------

/**
 * A live NativeConnection, narrowed to what the registration hook needs. Typed
 * structurally (not as the @temporalio class) so this pure module's type graph does
 * NOT pull @temporalio into the default suite — the concrete connection is created
 * inside the dynamic import below and handed to the hook.
 */
export interface LiveConnection {
  close(): Promise<void>;
}

/**
 * The registration hook the composition root supplies (registerWorker.ts). On a
 * SUCCESSFUL connect the bootstrap hands the live connection to this hook, which
 * does the @temporalio `Worker.create({ connection, taskQueue, workflowsPath,
 * activities })` + `worker.run()` — closing the gap where the bootstrap previously
 * connected then dropped the connection before ever registering workflows +
 * activities. Kept as an INJECTED callback so `worker.ts` stays free of the
 * composition import (backends open a DB / vault) in its pure module graph. It
 * OWNS the connection lifetime once handed it (it closes it on worker shutdown).
 * Returns when the worker has stopped (or rejects if registration/run failed).
 */
export type RegisterWorkerHook = (
  connection: LiveConnection,
  taskQueue: SowTaskQueue,
) => Promise<void>;

/** Options for the live (SOW_TEMPORAL-gated) worker bootstrap. */
export interface BootstrapWorkerOptions {
  /** Temporal dev-server address, e.g. "127.0.0.1:7233" (persistent server). */
  readonly address: string;
  readonly taskQueue: SowTaskQueue;
  /** Injected wall clock — the live path supplies a real ISO clock. */
  readonly now: Clock["now"];
  /** Bound the connect loop so a permanent outage degrades, never spins. */
  readonly maxConnectAttempts: number;
  /**
   * OPTIONAL registration hook (registerWorker.ts). When supplied, a successful
   * connect hands the live connection to it (Worker.create + run) instead of closing
   * it — this is the wiring that makes the worker actually register workflows +
   * activities. When ABSENT the bootstrap keeps its original connect-and-close smoke
   * behavior (the existing default gate), so nothing that omits the hook changes.
   */
  readonly onConnected?: RegisterWorkerHook;
}

/**
 * Connect to the local Temporal dev server + register the task queue. GATED:
 * only ever called from a SOW_TEMPORAL-gated test or the real worker process —
 * the @temporalio modules are pulled in via a DYNAMIC import so this file's pure
 * exports stay free of @temporalio in the default suite's module graph.
 *
 * Returns the same typed bootstrap Result as {@link decideBootstrap}: on a
 * connect failure across all attempts it returns the degraded variant rather
 * than throwing (§16, fail-closed) so the supervisor degrades cleanly.
 */
export async function bootstrapWorker(
  options: BootstrapWorkerOptions,
): Promise<Result<BootstrapReady, BootstrapDegraded>> {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < options.maxConnectAttempts; attempt++) {
    let outcome: ConnectOutcome;
    try {
      // Dynamic import keeps @temporalio out of the pure module graph.
      const { NativeConnection } = await import("@temporalio/worker");
      const connection = await NativeConnection.connect({
        address: options.address,
      });
      // A live connection is the readiness signal. If a registration hook was
      // supplied, HAND IT the connection so it runs Worker.create + run (the hook
      // owns + closes the connection on shutdown) — this is the wiring that actually
      // registers the workflows + activities. If no hook, keep the original
      // connect-and-close smoke behavior (the existing default gate).
      if (options.onConnected !== undefined) {
        await options.onConnected(connection, options.taskQueue);
      } else {
        await connection.close();
      }
      outcome = { connected: true };
    } catch (cause) {
      lastReason = cause instanceof Error ? cause.message : String(cause);
      outcome = { connected: false, reason: lastReason };
    }
    const decision = decideBootstrap(outcome, {
      now: options.now(),
      taskQueue: options.taskQueue,
      attempt,
    });
    if (decision.ok) return decision;
  }
  // All attempts exhausted → degraded (blocks dispatch; supervisor backs off).
  return decideBootstrap(
    { connected: false, reason: lastReason },
    {
      now: options.now(),
      taskQueue: options.taskQueue,
      attempt: options.maxConnectAttempts,
    },
  );
}
