// @sow/worker — the degraded-safe programmatic DISPATCH entry for sourceIngestion (C3a).
//
// C1 registered the `sourceIngestion` workflow so it CAN execute; this module adds the
// CLIENT-side path that STARTS a run on the proof-spine task queue (the C3b file-watcher —
// the Temporal Client's first real caller — will call it; a manual/CLI trigger could too).
//
// Two design pins:
//   • IDEMPOTENT BY CONSTRUCTION — the run's deterministic `idempotencyKey` IS the Temporal
//     `workflowId`, so a re-dispatch of the same source dedupes at the Temporal layer
//     (workflowId-reuse REJECT_DUPLICATE) AND at the driver's `resolveRun` — two guards.
//   • DEGRADED-SAFE (§16) — when Temporal is unavailable (no client) OR a start throws, the
//     dispatch returns a typed `err` AND surfaces a §16 health item (never a silent drop),
//     and it NEVER throws across the boundary — it must never crash boot.
//
// PURE over an injected {@link StartWorkflowRun} port: the concrete @temporalio/client is
// wrapped by {@link createTemporalClientStartRun}, so this dispatch is client-agnostic +
// degraded-testable. The run's `trigger` is the CLOSED `WorkflowTrigger` taxonomy
// (schedule | connector_event | owner_action | hermes_automation) — a watcher event uses
// `connector_event`, a manual/CLI trigger `owner_action`; the dispatch carries whatever the
// caller passes through VERBATIM (no coercion/remapping).
import { ok, err } from "@sow/contracts";
import type { Result, AuditId, FailureClass } from "@sow/contracts";
import type { SourceIngestionInput } from "@sow/workflows";
import type { SowTaskQueue } from "@sow/workflows/runtime/taskQueue";
// The concrete Temporal Client coupling lives ONLY in the adapter below — imported
// composition/activity-side (never in the workflow sandbox bundle, which imports drivers,
// not this dispatch entry). Symbol-based instanceof works across @temporalio package copies.
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { Client } from "@temporalio/client";

/** The registered sandbox workflow type name (see temporal/workflows.ts). */
export const SOURCE_INGESTION_WORKFLOW_TYPE = "sourceIngestionWorkflow" as const;

/** A minimal handle over a started run — decoupled from the @temporalio/client types. */
export interface StartedRunHandle {
  readonly workflowId: string;
  readonly firstExecutionRunId: string;
  result<R>(): Promise<R>;
}

/**
 * The outcome of a start attempt: a fresh `started` run, or an `already_started` dedupe hit
 * (a workflowId with a prior/running execution under REJECT_DUPLICATE — an idempotent no-op,
 * NOT a failure). A transport/connect fault THROWS (→ the dispatch's degraded fail-closed).
 */
export type StartRunOutcome =
  | { readonly kind: "started"; readonly handle: StartedRunHandle }
  | { readonly kind: "already_started"; readonly workflowId: string };

/** The injected start port. Undefined ⇒ Temporal unavailable (degraded boot) ⇒ fail-closed. */
export type StartWorkflowRun = (args: {
  readonly workflowType: string;
  readonly workflowId: string;
  readonly taskQueue: SowTaskQueue;
  readonly args: readonly unknown[];
}) => Promise<StartRunOutcome>;

/** The §16 health sink for the degraded fail-closed item (nothing surfaces silently). */
export type DispatchHealthSink = (failure: {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly message: string;
  readonly auditRef: AuditId;
}) => Promise<void>;

export interface DispatchSourceIngestionDeps {
  /** The start port; UNDEFINED when Temporal is unavailable (degraded boot). */
  readonly startRun?: StartWorkflowRun;
  readonly surfaceHealth: DispatchHealthSink;
  readonly taskQueue: SowTaskQueue;
  readonly auditRef: AuditId;
}

export type DispatchErrorCode = "temporal_unavailable" | "dispatch_failed";
export interface DispatchError {
  readonly code: DispatchErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface DispatchOutcome {
  /** The Temporal workflowId (= the run's deterministic idempotencyKey). */
  readonly workflowId: string;
  /** True when a FRESH run started; false when the dispatch deduped (already running/closed). */
  readonly dispatched: boolean;
  readonly deduped: boolean;
  /** Present only on a fresh start (`dispatched`) — the started run's handle. */
  readonly handle?: StartedRunHandle;
}

// A Temporal-unavailable dispatch failure is genuine INFRA down (the class the C-fix reserved
// `worker_down` for) — NOT a source-content cause, so NOT a security/policy/egress member.
const DISPATCH_DEGRADED_CLASS: FailureClass = "worker_down";

/**
 * Start a `sourceIngestion` run — degraded-safe, idempotent by the source key. Returns the
 * started run's handle on a fresh start; a deduped no-op on a same-key re-dispatch; a typed
 * `err` (+ a surfaced §16 health item) when Temporal is unavailable or the start faults.
 * NEVER throws across the boundary (§16).
 */
export async function dispatchSourceIngestion(
  input: SourceIngestionInput,
  deps: DispatchSourceIngestionDeps,
): Promise<Result<DispatchOutcome, DispatchError>> {
  // The deterministic dedupe key IS the run's idempotencyKey → the Temporal workflowId.
  // Deref defensively so even a malformed input (a C3b construction bug bypassing the type)
  // fails closed to a typed Result — the §16 never-throw guarantee has NO escape hatch.
  const workflowId = input?.run?.idempotencyKey;
  if (typeof workflowId !== "string" || workflowId.length === 0) {
    await surfaceDegraded(deps, "unknown", "sourceIngestion dispatch rejected — malformed input (missing run.idempotencyKey)");
    return err({ code: "dispatch_failed", message: "malformed dispatch input; missing run.idempotencyKey" });
  }

  if (deps.startRun === undefined) {
    await surfaceDegraded(
      deps,
      workflowId,
      `sourceIngestion dispatch skipped — Temporal unavailable (trigger:${input.run.trigger})`,
    );
    return err({
      code: "temporal_unavailable",
      message: "temporal client unavailable; sourceIngestion dispatch fail-closed",
    });
  }

  try {
    const started = await deps.startRun({
      workflowType: SOURCE_INGESTION_WORKFLOW_TYPE,
      workflowId,
      taskQueue: deps.taskQueue,
      args: [input],
    });
    if (started.kind === "already_started") {
      // Idempotent no-op — a duplicate dispatch of the same source key; ONE run stands.
      return ok({ workflowId, dispatched: false, deduped: true });
    }
    return ok({ workflowId, dispatched: true, deduped: false, handle: started.handle });
  } catch (cause) {
    // The catch covers ANY start throw (connect fault, transport error, …) — the specific
    // cause rides `cause`; the message does not over-assert "Temporal unavailable".
    await surfaceDegraded(
      deps,
      workflowId,
      `sourceIngestion dispatch failed (trigger:${input.run.trigger})`,
    );
    return err({
      code: "dispatch_failed",
      message: "sourceIngestion dispatch failed; fail-closed",
      cause,
    });
  }
}

/** Surface the degraded §16 health item — swallow a sink fault so the dispatch never throws. */
async function surfaceDegraded(
  deps: DispatchSourceIngestionDeps,
  workflowId: string,
  message: string,
): Promise<void> {
  try {
    await deps.surfaceHealth({
      failureClass: DISPATCH_DEGRADED_CLASS,
      subjectRef: `source-dispatch:${workflowId}`,
      message,
      auditRef: deps.auditRef,
    });
  } catch {
    // Even a health-sink fault must NOT crash boot (§16 — nothing throws across the boundary).
  }
}

/**
 * Wrap a @temporalio/client {@link Client} into a {@link StartWorkflowRun} — the PRODUCTION
 * adapter (boot binds this over a loopback Client; the gated test binds it over the
 * TestWorkflowEnvironment's client, so this exact adapter is tested, not dormant). Uses
 * workflowId-reuse `REJECT_DUPLICATE`, so a re-dispatch of the same source key throws
 * {@link WorkflowExecutionAlreadyStartedError} → folded to `already_started` (an idempotent
 * no-op). A transport/connect fault propagates (→ the dispatch's degraded fail-closed).
 */
export function createTemporalClientStartRun(client: Client): StartWorkflowRun {
  return async ({ workflowType, workflowId, taskQueue, args }): Promise<StartRunOutcome> => {
    try {
      const handle = await client.workflow.start(workflowType, {
        workflowId,
        taskQueue,
        args: [...args],
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
      return {
        kind: "started",
        handle: {
          workflowId: handle.workflowId,
          firstExecutionRunId: handle.firstExecutionRunId,
          result: <R>(): Promise<R> => handle.result() as Promise<R>,
        },
      };
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) {
        // The same source key is already dispatched (running or closed) — dedupe, not fail.
        return { kind: "already_started", workflowId };
      }
      throw e;
    }
  };
}
