// @sow/workflows — task 7.9: APPROVAL FLOW (incl. deferred snooze/expiry) — the
// PURE orchestration DRIVER.
//
// This is a sibling of the 7.6 meeting-closeout driver: the deterministic control
// driver that progresses an approval run THROUGH the @sow/domain `approvalMachine`
// (APPROVAL_STATES: pending → approved | edited | rejected | deferred | expired;
// deferred is NON-TERMINAL: deferred → pending | expired) over the INJECTED
// activity ports (src/ports/approvalFlow.ts), the injected Clock, the 7.5 health
// sink, the 7.4 idempotency seam (resolveRun), and the PURE 7.9 snooze timer
// (src/runtime/snoozeTimer.ts).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through the injected ports + Clock, so it is Vitest-unit-testable with no
// Temporal server and safe to wrap in a thin @temporalio workflow later. Per-step
// idempotency KEYS live in the ACTIVITIES (node:crypto there).
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct approvalMachine failure/park STATE and routes
// it through the health sink (inv-5: nothing fails silently).
//
// 7.9 safety invariants this driver makes true:
//   inv-A  the Tool Gateway RECORDS the pending action (canonical key, payload
//          hash, required approval, expiry, visibility) BEFORE any card is shown;
//          the record is IDEMPOTENT (a re-drive reuses it, no second card/audit).
//   inv-B  the card shows on Mac + Telegram with PARITY; a partial render is a
//          typed `parity_failed` (never a silent single-channel card).
//   inv-C  apply/record is IDEMPOTENT + EXACTLY ONCE across BOTH channels — a
//          second approve/reject from either channel does NOT double-apply or
//          double-audit (single CAS transition by expectedFromStatus).
//   inv-D  DEFERRED re-surfaces after a configurable snooze (default 24h) and
//          auto-expires after a configurable window (default 7d) via the PURE,
//          clock-injected snooze timer; an EXPIRED approval can NEVER later be
//          approved (expiry wins over re-surface; `expired` is terminal).
//   inv-E  an APPROVED action dispatches through the Tool Gateway envelope
//          (dispatchExternalWrite — NO duplicate external write on replay);
//          rejection/deferral records WITHOUT side effect.
//   inv-F  precondition failure / stale card / conflicting approvals are typed
//          failure states → a distinct 7.5 System Health item (inv-5). The
//          workspace is bound before any durable write (REQ-F-002 / WS-2).
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  Approval,
  ExternalWriteEnvelope,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import type { ApprovalState } from "@sow/domain";
import { approvalMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { evaluateDeferred, DEFAULT_SNOOZE_CONFIG } from "../runtime/snoozeTimer";
import type { SnoozeConfig } from "../runtime/snoozeTimer";
import type {
  ApprovalFlowContext,
  ApprovalDecision,
  RecordPendingPort,
  SurfaceCardPort,
  ApplyTransitionPort,
  DispatchApprovedActionPort,
  ApprovalHealthSink,
  ApprovalWorkflowFailure,
} from "../ports/approvalFlow";

// --- driver input ----------------------------------------------------------

/**
 * A driver "action" — either
 *   • `decide` — a human/agent DECISION arriving on a channel (the initial-record
 *     + surface + apply path; a deferral snoozes, the others move the approval), or
 *   • `snooze_tick` — a deferred-approval timer firing (evaluate the snooze/expiry
 *     windows via the PURE timer → re-surface to pending OR auto-expire).
 */
export type ApprovalFlowAction =
  | { readonly kind: "decide"; readonly decision: ApprovalDecision }
  | {
      readonly kind: "snooze_tick";
      /** The durable wall instant the deferral happened at (the timer's window reference). */
      readonly deferredAt: string;
    };

/**
 * The complete input to {@link runApprovalFlow}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam (resolveRun); `context` carries the
 * BOUND workspace + the §8 action/envelope the approval gates; `action` is the
 * driver action to process. The Approval record + its status are NEVER
 * caller-supplied as authoritative — the driver reads/writes them through the
 * ports (the Tool Gateway records the pending action; the CAS port applies moves).
 */
export interface ApprovalFlowInput {
  readonly run: ResolveRunInput;
  readonly context: ApprovalFlowContext;
  readonly action: ApprovalFlowAction;
  /** Optional per-approval deferred windows (defaults to the domain 24h/7d). */
  readonly snoozeConfig?: SnoozeConfig;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the four approval-flow activity ports, the 7.5
 * health sink, the 7.4 WorkflowRun repository (resolveRun's seam), and the
 * injected Clock. Every dependency is a narrow port so the driver stays pure +
 * fully injected-testable (no ApprovalRepository / Tool Gateway / Temporal).
 */
export interface ApprovalFlowDeps {
  readonly record: RecordPendingPort;
  readonly surface: SurfaceCardPort;
  readonly applyTransition: ApplyTransitionPort;
  readonly dispatch: DispatchApprovedActionPort;
  readonly health: ApprovalHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of an approval-flow drive. `state` is the approvalMachine state the
 * flow rested in. `approval` is the final record (present once recorded).
 * `dispatched` is the applied external-write envelope (present ONLY on an approved
 * dispatch). `run`/`runReused` mirror resolveRun. `surfaced` names the routed
 * health failure on a failure/park branch (undefined on a clean path). Never throws.
 */
export interface ApprovalFlowOutcome {
  readonly state: ApprovalState;
  readonly approval?: Approval;
  readonly dispatched?: ExternalWriteEnvelope;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: ApprovalWorkflowFailure;
}

// --- machine-edge helper ---------------------------------------------------

/**
 * Assert a single approvalMachine edge is legal, returning the target state. The
 * domain machine is pure + total (never throws); an illegal edge returns a typed
 * error. Since the driver only walks DOMAIN_MODEL-pinned edges, a rejection here is
 * a programming error — we return the source state (no teleport) rather than crash,
 * keeping the driver total (§16).
 */
function step(from: ApprovalState, to: ApprovalState): ApprovalState {
  const moved = approvalMachine.transition(from, to);
  return isOk(moved) ? moved.value : from;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) -

/** Map an approval-flow failure to a §16 FailureClass for the health sink. */
function failureClassFor(
  code:
    | "precondition_failed"
    | "parity_failed"
    | "illegal_transition"
    | "expired"
    | "conflicting_approval"
    | "stale_card"
    | "apply_failed"
    | "record_failed"
    | "surface_failed"
    | "dispatch_held"
    | "dispatch_conflict"
    | "dispatch_rejected",
): FailureClass {
  switch (code) {
    case "conflicting_approval":
    case "stale_card":
    case "illegal_transition":
    case "expired":
    case "dispatch_conflict":
      return "conflict_review";
    case "dispatch_held":
      return "write_through_failed";
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the approval flow as a pure, replay-safe driver.
 *
 * `decide` path (each durable step keyed for idempotent replay — inv-C/inv-E):
 *   1. resolveRun (7.4) — a seen idempotencyKey reuses the run.
 *   2. RECORD the pending action through the Tool Gateway (inv-A) — idempotent;
 *      a stale precondition fails closed → pending park + health.
 *   3. SURFACE the card on Mac + Telegram with PARITY (inv-B) — a parity break is
 *      a typed failure → pending park + health (no single-channel card stands).
 *   4. APPLY the decision EXACTLY ONCE via CAS (inv-C) — a second approve/reject
 *      from the other channel is an idempotent no-op (applied:false); an `expired`
 *      approval can never move to approved; a conflicting/stale decision → health.
 *   5. On `approved`: DISPATCH through the Tool Gateway envelope (inv-E) — replay
 *      reuses the receipt (no duplicate external write). On rejected/edited: record
 *      only, NO external side effect. On deferred: park (the snooze timer drives it).
 *
 * `snooze_tick` path (inv-D): evaluate the PURE snooze timer against the injected
 * clock. `expire` → apply deferred → expired (fail-closed; can never be approved).
 * `resurface` → apply deferred → pending + re-surface the card. `sleep` → no-op.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runApprovalFlow(
  input: ApprovalFlowInput,
  deps: ApprovalFlowDeps,
): Promise<ApprovalFlowOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run —
  //    the whole flow is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  const surface = async (
    failState: ApprovalState,
    code: Parameters<typeof failureClassFor>[0],
    message: string,
    approval: Approval | undefined,
  ): Promise<ApprovalFlowOutcome> => {
    const failure: ApprovalWorkflowFailure = {
      failureClass: failureClassFor(code),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed).
    await deps.health.surface(failure);
    return {
      state: failState,
      ...(approval !== undefined ? { approval } : {}),
      run: runResult,
      runReused,
      surfaced: failure,
    };
  };

  // ------------------------------------------------------------------ snooze_tick
  if (input.action.kind === "snooze_tick") {
    const approval = input.context.approval;
    // Defensive: a tick with no recorded approval has nothing to advance — the
    // record was never made / not threaded. Park in pending (no durable move).
    if (approval === undefined) {
      return surface(
        "pending",
        "apply_failed",
        "snooze tick with no recorded approval",
        undefined,
      );
    }
    // A tick only makes sense for a DEFERRED approval; anything else is a no-op
    // (the timer fired against an already-decided approval — idempotent).
    if (approval.status !== "deferred") {
      return { state: approval.status, approval, run: runResult, runReused };
    }

    const decision = evaluateDeferred(
      approval,
      input.action.deferredAt,
      deps.clock,
      input.snoozeConfig ?? DEFAULT_SNOOZE_CONFIG,
    );

    if (decision === "sleep") {
      // Still within the snooze window — stay parked, NO durable move.
      return { state: "deferred", approval, run: runResult, runReused };
    }

    if (decision === "expire") {
      // Auto-expiry (inv-D): deferred → expired via the actor-less system CAS.
      // Fail-closed — an expired approval can NEVER later be approved (`expired`
      // is terminal). EXACTLY-ONCE: CAS on expectedFromStatus === "deferred", so a
      // concurrent human move already off deferred makes this a no-op/conflict.
      const target: ApprovalState = step("deferred", "expired");
      const applied = await deps.applyTransition.applySystem(approval, "expire");
      if (!isOk(applied)) {
        return surface(
          "deferred",
          applied.error.code === "conflicting_approval"
            ? "conflicting_approval"
            : "apply_failed",
          `deferred auto-expiry failed: ${applied.error.code}`,
          approval,
        );
      }
      // NO external side effect on expiry (inv-E). Surface it so nothing is silent.
      await deps.health.surface({
        failureClass: "conflict_review",
        subjectRef: input.run.workflowId,
        message: "deferred approval auto-expired (snooze/expiry window elapsed)",
        auditRef: input.run.workflowId as unknown as AuditId,
      });
      return {
        state: target,
        approval: applied.value.approval,
        run: runResult,
        runReused,
      };
    }

    // resurface (inv-D): deferred → pending via the actor-less system CAS, then
    // show the card again with parity. EXACTLY-ONCE: CAS on expectedFromStatus.
    const target: ApprovalState = step("deferred", "pending");
    const applied = await deps.applyTransition.applySystem(approval, "resurface");
    if (!isOk(applied)) {
      return surface(
        "deferred",
        "apply_failed",
        `deferred re-surface failed: ${applied.error.code}`,
        approval,
      );
    }
    const resurfaced = applied.value.approval;
    const shown = await deps.surface.surface(resurfaced);
    if (!isOk(shown)) {
      return surface(
        "pending",
        shown.error.code === "parity_failed" ? "parity_failed" : "surface_failed",
        `re-surface card failed: ${shown.error.code}`,
        resurfaced,
      );
    }
    return { state: target, approval: resurfaced, run: runResult, runReused };
  }

  // ------------------------------------------------------------------ decide path
  // 2. RECORD the pending action through the Tool Gateway (inv-A). Idempotent by
  //    the envelope's idempotencyKey — a re-drive reuses the record (created:false),
  //    no second card / no second audit. A stale precondition fails closed.
  const recorded = await deps.record.record(input.context);
  if (!isOk(recorded)) {
    return surface(
      "pending",
      recorded.error.code === "precondition_failed"
        ? "precondition_failed"
        : "record_failed",
      `record pending failed: ${recorded.error.code}`,
      undefined,
    );
  }
  const pending = recorded.value.approval;

  // 3. SURFACE the card on Mac + Telegram with PARITY (inv-B). A partial render is
  //    a typed failure — no single-channel card stands (fail-closed).
  const shown = await deps.surface.surface(pending);
  if (!isOk(shown)) {
    return surface(
      "pending",
      shown.error.code === "parity_failed" ? "parity_failed" : "surface_failed",
      `surface card failed: ${shown.error.code}`,
      pending,
    );
  }

  // 4. APPLY the decision EXACTLY ONCE across BOTH channels via CAS (inv-C). A
  //    second approve/reject from the OTHER channel is an idempotent no-op
  //    (applied:false — no double-apply, no double-audit). An `expired` approval
  //    can never move to approved. The domain edge is validated inside the port.
  const decision = input.action.decision;
  const applied = await deps.applyTransition.apply(pending, decision);
  if (!isOk(applied)) {
    const code = applied.error.code;
    const failState: ApprovalState =
      code === "expired" ? "expired" : "pending";
    return surface(
      failState,
      code === "expired"
        ? "expired"
        : code === "conflicting_approval"
          ? "conflicting_approval"
          : code === "stale_card"
            ? "stale_card"
            : code === "illegal_transition"
              ? "illegal_transition"
              : "apply_failed",
      `apply decision failed: ${code}`,
      pending,
    );
  }
  const decided = applied.value.approval;
  const decidedState = decided.status as ApprovalState;

  // A no-op (a second decision from the other channel) rests in the ALREADY-applied
  // state with NO further side effect (the first dispatch already ran, once).
  if (!applied.value.applied) {
    return { state: decidedState, approval: decided, run: runResult, runReused };
  }

  // 5. Route on the applied decision.
  //    • deferred → park; the snooze timer (a later `snooze_tick`) drives it.
  //    • rejected/edited → record only, NO external side effect (inv-E).
  //    • approved → DISPATCH through the Tool Gateway envelope (inv-E), replay-safe.
  if (decidedState === "deferred") {
    return { state: "deferred", approval: decided, run: runResult, runReused };
  }
  if (decidedState === "rejected" || decidedState === "edited") {
    // Recorded WITHOUT side effect (inv-E): no external write on reject/edit.
    return { state: decidedState, approval: decided, run: runResult, runReused };
  }

  // decidedState === "approved": dispatch the external write EXACTLY ONCE (inv-E).
  const dispatched = await deps.dispatch.dispatch(
    input.context.action,
    input.context.envelope,
  );
  if (!isOk(dispatched)) {
    const code = dispatched.error.code;
    // The approval STANDS as approved (the human decision landed + is audited); the
    // external write failed downstream. Surface a distinct health item (inv-5): a
    // `held` is retryable (outbox re-drive), a conflict/rejected is a review.
    await deps.health.surface({
      failureClass: failureClassFor(
        code === "held"
          ? "dispatch_held"
          : code === "conflict"
            ? "dispatch_conflict"
            : "dispatch_rejected",
      ),
      subjectRef: input.run.workflowId,
      message: `approved-action dispatch failed: ${code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    });
    return {
      state: "approved",
      approval: decided,
      run: runResult,
      runReused,
      surfaced: {
        failureClass: failureClassFor(
          code === "held" ? "dispatch_held" : "dispatch_conflict",
        ),
        subjectRef: input.run.workflowId,
        message: `approved-action dispatch failed: ${code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      },
    };
  }

  return {
    state: "approved",
    approval: decided,
    dispatched: dispatched.value.envelope,
    run: runResult,
    runReused,
  };
}
