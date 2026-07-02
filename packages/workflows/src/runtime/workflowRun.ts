// @sow/workflows — slice 7.4: WorkflowRun registry + state taxonomy (§9).
//
// PURE + deterministic + workflow-safe: imports NOTHING from @temporalio, NOTHING
// from node:crypto, and calls NO Date.now()/Math.random(). Time comes from the
// INJECTED Clock; persistence from the INJECTED WorkflowRunRefRepository. That
// makes this logic (a) Vitest-unit-testable with no Temporal server, and (b) safe
// to import into deterministic workflow code later.
//
// This module owns:
//   • The LOCAL §9 WorkflowRunState value taxonomy (WorkflowRunRef.state is an
//     OPEN string in @sow/contracts; §9 pins the closed set here) + its TERMINAL
//     subset + the reused defineMachine state guard.
//   • createWorkflowRun — admission of a new run. WORKSPACE IS BOUND BEFORE ANY
//     DURABLE PROCESSING (REQ-F-002 / WS-2): an unscoped run is rejected at
//     admission (fail-closed) — a durable step cannot execute on an unscoped run.
//   • transitionWorkflowRun — state moves routed through the guard, with the extra
//     invariant that a run cannot reach a TERMINAL state without an audit trail
//     (auditRefs non-empty).
//
// §16 error convention: never throws across the boundary — returns a typed
// Result<T, WorkflowRunError> whose `code` is an ENUMERABLE closed set. Fail-closed.
import { ok, err, isOk } from "@sow/contracts";
import type { Result, WorkflowRunRef, WorkflowId } from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { WorkflowRunRefRepository, Clock, WorkflowTrigger } from "../ports/operational";

// --- The LOCAL §9 WorkflowRunState taxonomy -------------------------------

/**
 * The closed §9 WorkflowRun lifecycle states. WorkflowRunRef.state is an OPEN
 * string upstream (Phase 1 froze the FIELD-NAME set but deferred the value
 * taxonomy to §9); this @sow/workflows-LOCAL constant pins the closed set. Order
 * is frozen by the spec(§9) snapshot test — do not reorder.
 */
export const WORKFLOW_RUN_STATES = [
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

/** A closed §9 WorkflowRun state (element of {@link WORKFLOW_RUN_STATES}). */
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

/**
 * The TERMINAL subset of {@link WORKFLOW_RUN_STATES}: a run in one of these has no
 * outgoing edge. A run may only enter a terminal state with a non-empty audit
 * trail (enforced by {@link transitionWorkflowRun}). Order frozen by the snapshot.
 */
export const TERMINAL_WORKFLOW_RUN_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const;

/** The initial state every newly-admitted run starts in. */
export const INITIAL_WORKFLOW_RUN_STATE: WorkflowRunState = "running";

// --- The reused state guard (defineMachine) --------------------------------

// Adjacency table for the §9 WorkflowRun lifecycle. A zero-length edge list marks
// a terminal state (completed/failed/cancelled are frozen). The guard is PURE +
// total + never-throwing (returns a typed TransitionError) — reused from
// @sow/domain rather than re-implemented.
const WORKFLOW_RUN_TRANSITIONS: Readonly<Record<WorkflowRunState, readonly WorkflowRunState[]>> = {
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** The §9 WorkflowRun state machine (the small guard every transition routes through). */
export const workflowRunMachine: StateMachine<WorkflowRunState> = defineMachine(
  WORKFLOW_RUN_TRANSITIONS,
);

/** True IFF `s` is a terminal WorkflowRun state (has no outgoing edge). */
export function isTerminalWorkflowRunState(s: WorkflowRunState): boolean {
  return workflowRunMachine.isTerminal(s);
}

// --- The typed, enumerable error surface (§16) -----------------------------

/** Closed, enumerable failure taxonomy for the WorkflowRun registry (never thrown). */
export type WorkflowRunErrorCode =
  | "unscoped_run" // WS-2: a run with no bound workspace is rejected at admission
  | "not_found" // the target run does not exist
  | "illegal_transition" // the state move is not a legal edge
  | "terminal_without_audit" // a terminal move on a run with an empty audit trail
  | "persist_failed"; // the injected repo returned a typed DbError

export interface WorkflowRunError {
  readonly code: WorkflowRunErrorCode;
  readonly message: string;
  /** The from-state, when the failure is a state-guard rejection. */
  readonly from?: string;
  /** The to-state, when the failure is a state-guard rejection. */
  readonly to?: string;
}

const fail = (
  code: WorkflowRunErrorCode,
  message: string,
  extra?: { from?: string; to?: string },
): Result<never, WorkflowRunError> => err({ code, message, ...extra });

// --- createWorkflowRun (admission) -----------------------------------------

/**
 * The admission input for a new WorkflowRun. `workspaceId` is a SEPARATE parameter
 * (not a WorkflowRunRef field — the frozen ref carries no workspace key): WS-2
 * binds the workspace at admission, before any durable step, and this is where it
 * is checked. The new run always starts in {@link INITIAL_WORKFLOW_RUN_STATE}
 * with an empty audit trail.
 */
export interface CreateWorkflowRunInput {
  readonly workflowId: WorkflowId;
  readonly trigger: WorkflowTrigger;
  readonly idempotencyKey: string;
  /** REQ-F-002 / WS-2: the bound workspace. Missing/blank ⇒ rejected. */
  readonly workspaceId?: string;
}

/** True IFF `workspaceId` is present and non-blank (WS-2 admission gate). */
function isScoped(workspaceId: string | undefined): workspaceId is string {
  return typeof workspaceId === "string" && workspaceId.trim().length > 0;
}

/**
 * Admit a new WorkflowRun. WORKSPACE IS BOUND BEFORE ANY DURABLE PROCESSING
 * (REQ-F-002 / WS-2): an unscoped submission (missing/blank workspaceId) is
 * REJECTED here (fail-closed) and nothing is persisted. On success the run is
 * created in the RUNNING state with an empty audit trail through the injected
 * repo. `clock` is accepted for creation-time bookkeeping and to keep the
 * signature uniform with the rest of the pure runtime (no Date.now() anywhere).
 */
export async function createWorkflowRun(
  input: CreateWorkflowRunInput,
  repo: WorkflowRunRefRepository,
  clock: Clock,
): Promise<Result<WorkflowRunRef, WorkflowRunError>> {
  if (!isScoped(input.workspaceId)) {
    return fail(
      "unscoped_run",
      "REQ-F-002/WS-2: a workflow run must be bound to a workspace before any durable step",
    );
  }
  // Read the clock so the injected time source is exercised (bookkeeping edge;
  // the ref itself carries no timestamp field per the frozen contract).
  void clock.now();

  const ref: WorkflowRunRef = {
    workflowId: input.workflowId,
    trigger: input.trigger,
    state: INITIAL_WORKFLOW_RUN_STATE,
    idempotencyKey: input.idempotencyKey,
    auditRefs: [],
  };

  const created = await repo.create(ref);
  if (!isOk(created)) {
    return fail(
      "persist_failed",
      `failed to persist workflow run: ${created.error.message}`,
    );
  }
  return ok(created.value);
}

// --- transitionWorkflowRun (state guard + terminal-needs-audit) ------------

/**
 * Move a run to `to`, routed through the {@link workflowRunMachine} guard PLUS the
 * §9 invariant that a run cannot reach a TERMINAL state without an audit trail
 * (auditRefs non-empty). Order of checks (fail-closed): load → legal-edge guard →
 * terminal-needs-audit → persist. Returns the updated ref on success; a typed
 * WorkflowRunError otherwise (never throws).
 */
export async function transitionWorkflowRun(
  workflowId: WorkflowId,
  to: WorkflowRunState,
  repo: WorkflowRunRefRepository,
): Promise<Result<WorkflowRunRef, WorkflowRunError>> {
  const loaded = await repo.get(workflowId);
  if (!isOk(loaded)) {
    return fail("not_found", `no workflow run: ${workflowId}`);
  }
  const current = loaded.value;
  const from = current.state as WorkflowRunState;

  const guard = workflowRunMachine.transition(from, to);
  if (!isOk(guard)) {
    // The domain guard distinguishes illegal_transition vs terminal_state; both
    // collapse to our illegal_transition code (moving out of a terminal state IS
    // an illegal edge from the registry's point of view).
    return fail("illegal_transition", `illegal state transition ${from} → ${to}`, {
      from,
      to,
    });
  }

  // A run may only ENTER a terminal state with a non-empty audit trail.
  if (isTerminalWorkflowRunState(to) && current.auditRefs.length === 0) {
    return fail(
      "terminal_without_audit",
      `cannot move run ${workflowId} to terminal state '${to}' without an audit trail`,
      { from, to },
    );
  }

  const updated = await repo.updateState(workflowId, to);
  if (!isOk(updated)) {
    return fail(
      "persist_failed",
      `failed to persist state transition: ${updated.error.message}`,
      { from, to },
    );
  }
  return ok(updated.value);
}
