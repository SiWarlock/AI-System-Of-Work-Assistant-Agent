// @sow/workflows — task 7.9 SEAM: the APPROVAL-FLOW activity ports.
//
// This is the port surface every downstream 7.9 slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) and the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts) it is PURE + workflow-safe: it imports NOTHING
// from @temporalio, NOTHING from node:crypto, and calls NO
// Date.now()/Math.random(). It declares ONLY types + interfaces (erasable under
// verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE approval-flow DRIVER
// (src/workflows/approvalFlow.ts) calls these ports so it stays unit-testable
// with the in-memory fakes; the ACTIVITIES that implement the ports
// (src/activities/approvalTransition.ts) MAY import the real adapters
// (@sow/db ApprovalRepository, @sow/integrations Tool Gateway dispatchExternalWrite,
// @sow/policy requiresApproval) and node:crypto — and FOLD each adapter's typed
// rejection onto the CLOSED, enumerable error each port here declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the approval-flow vocabulary the driver reasons in (mapped to
// the @sow/domain approvalMachine states — pending / approved | edited | rejected
// | deferred | expired), so the driver never depends on a downstream package's
// error enum.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  Approval,
  ApprovalStatus,
  ProposedAction,
  ExternalWriteEnvelope,
  Channel,
  AuditId,
  FailureClass,
} from "@sow/contracts";

// ---------------------------------------------------------------------------
// (1) The decision that drives a transition + the pipeline context
// ---------------------------------------------------------------------------

/**
 * A human/agent DECISION arriving on one channel (Mac or Telegram) — the raw
 * intent the driver folds onto an {@link ApprovalStatus} target via the domain
 * approvalMachine. `channel` is which surface the decision came from; the driver
 * applies it EXACTLY ONCE across BOTH channels (a second approve/reject from
 * either channel is a no-op, never a double-apply — CAS by expectedFromStatus).
 * `actor` names who decided (for the audit). `edited` optionally carries the
 * edited payload when `decision === "edited"`.
 */
export interface ApprovalDecision {
  /** The target status the actor chose. `deferred` snoozes; the four others move it. */
  readonly decision: Extract<
    ApprovalStatus,
    "approved" | "edited" | "rejected" | "deferred"
  >;
  readonly channel: Channel;
  readonly actor: string;
}

/**
 * The pipeline context threaded between approval-flow activities. A PLAIN,
 * immutable data record (no methods, no clock, no I/O). The `workspaceId` is the
 * BOUND/AUTHORIZED workspace the pending action belongs to (WS-2) — every durable
 * write in this flow targets it, never a caller-controlled value. `action` is the
 * §8 ProposedAction the approval gates; `envelope` its ExternalWriteEnvelope
 * (carrying the canonical key + payload hash + idempotencyKey the Tool Gateway
 * dispatches under on approval, and the receipt once written).
 */
export interface ApprovalFlowContext {
  /** WS-2: the bound workspace the pending action + approval belong to. */
  readonly workspaceId: WorkspaceId;
  /** The §8 external action this approval gates. */
  readonly action: ProposedAction;
  /** The derived envelope the Tool Gateway dispatches under (idempotencyKey drives replay reuse). */
  readonly envelope: ExternalWriteEnvelope;
  /** The approval record once recorded (present after the record stage). */
  readonly approval?: Approval;
}

// ---------------------------------------------------------------------------
// (2a) RecordPendingPort — the Tool Gateway records the pending action + card
// ---------------------------------------------------------------------------

/**
 * The result of recording a pending approval. `approval` is the persisted record
 * (status `pending`, carrying the payload hash + expiry). `created` is false when
 * the record already existed (idempotent replay — the same action was already
 * recorded), true on a fresh record. Recording is IDEMPOTENT so a re-drive does
 * not spawn a second card / second audit.
 */
export interface RecordPendingResult {
  readonly approval: Approval;
  readonly created: boolean;
}

/** Closed, enumerable record-pending failure set (§16 — never thrown). */
export type RecordPendingErrorCode =
  | "precondition_failed" // the pending action's precondition no longer holds (stale)
  | "record_failed"; // the Tool Gateway could not record the pending action

export interface RecordPendingError {
  readonly code: RecordPendingErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Record the pending action through the Tool Gateway (safety rule 3 seam): the
 * gateway persists the canonical object key, payload hash, required-approval flag,
 * expiry, and visibility, and mints the Approval (status `pending`) the card is
 * surfaced from. IDEMPOTENT by the envelope's idempotencyKey — a re-drive returns
 * the existing record (`created:false`), never a duplicate. A stale precondition
 * fails closed with `precondition_failed`. Never throws.
 */
export interface RecordPendingPort {
  record(
    ctx: ApprovalFlowContext,
  ): Promise<Result<RecordPendingResult, RecordPendingError>>;
}

// ---------------------------------------------------------------------------
// (2b) SurfaceCardPort — Mac + Telegram card PARITY
// ---------------------------------------------------------------------------

/** Proof the pending approval was surfaced on BOTH channels (parity). */
export interface SurfaceCardResult {
  /** The channels the card was rendered on — MUST include both for parity. */
  readonly channels: readonly Channel[];
}

/** Closed, enumerable card-surfacing failure set (§16 — never thrown). */
export type SurfaceCardErrorCode = "parity_failed" | "surface_failed";

export interface SurfaceCardError {
  readonly code: SurfaceCardErrorCode;
  readonly message: string;
  /** The channels that DID render, when a parity break is partial. */
  readonly rendered?: readonly Channel[];
  readonly cause?: unknown;
}

/**
 * Surface the pending approval as a card on BOTH the Mac and Telegram channels
 * with PARITY (REQ-F-012, §9): the same card content on both surfaces. A partial
 * render (one channel up, one down) fails closed with `parity_failed` — the driver
 * treats a parity break as a typed failure, never a silent single-channel card.
 * Never throws.
 */
export interface SurfaceCardPort {
  surface(
    approval: Approval,
  ): Promise<Result<SurfaceCardResult, SurfaceCardError>>;
}

// ---------------------------------------------------------------------------
// (2c) ApplyTransitionPort — EXACTLY ONCE across BOTH channels (CAS)
// ---------------------------------------------------------------------------

/**
 * The outcome of applying a decision. `approval` is the record AFTER the
 * transition. `applied` is true when THIS call performed the transition; false
 * when the transition was ALREADY applied (a second approve/reject from the other
 * channel) — the idempotent no-op path. `noopReason` names why a false `applied`
 * happened (already in the target state, or a CAS conflict resolved to the same
 * target). The single-transition CAS (ApprovalRepository.applyTransition with
 * expectedFromStatus) guarantees at most ONE durable transition + ONE audit.
 */
export interface ApplyTransitionResult {
  readonly approval: Approval;
  readonly applied: boolean;
  readonly noopReason?: "already_terminal" | "already_in_target";
}

/** Closed, enumerable apply-transition failure set (§16 — never thrown). */
export type ApplyTransitionErrorCode =
  | "illegal_transition" // the domain approvalMachine forbids from → to
  | "expired" // the approval already expired — can NEVER later be approved
  | "conflicting_approval" // a genuine CAS conflict onto a DIFFERENT target (two decisions race)
  | "stale_card" // the card the decision came from is stale (payload/expiry moved)
  | "apply_failed"; // the underlying CAS/persist failed for another reason

export interface ApplyTransitionError {
  readonly code: ApplyTransitionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * A SYSTEM (actor-less) transition the deferred snooze timer drives — NOT a human
 * decision. `resurface` is the deferred → pending move (the snooze window elapsed);
 * `expire` is the deferred → expired move (the expiry window elapsed). Modeled
 * separately from {@link ApprovalDecision} so the driver never has to fake an
 * "actor decision" for a timer-driven move (a fragile placeholder), and so the
 * activity can stamp a system actor + skip the actor-authorization the human path
 * needs.
 */
export type ApprovalSystemTransition = "resurface" | "expire";

/**
 * Apply a decision to the approval EXACTLY ONCE across BOTH channels. Backed by
 * ApprovalRepository.applyTransition (a compare-and-set on `expectedFromStatus`):
 * the transition commits IFF the stored status still equals the expected from —
 * so a second approve/reject arriving from the OTHER channel finds the status
 * already moved and returns `applied:false` (idempotent no-op: no double-apply, no
 * double-audit). A move onto a DIFFERENT terminal than the one already applied is a
 * `conflicting_approval`. An `expired` approval can NEVER transition to approved
 * (fails closed). The domain approvalMachine is consulted first so an illegal edge
 * never reaches the CAS.
 *
 * {@link applySystem} is the actor-less counterpart the snooze timer uses for
 * deferred → pending (`resurface`) / deferred → expired (`expire`). Both are CAS
 * on `expectedFromStatus === "deferred"`, so they are EXACTLY-ONCE too (a
 * concurrent human decision that already moved the deferred approval makes the
 * system move an idempotent no-op / conflict, never a double-apply). Never throws.
 */
export interface ApplyTransitionPort {
  apply(
    approval: Approval,
    decision: ApprovalDecision,
  ): Promise<Result<ApplyTransitionResult, ApplyTransitionError>>;
  applySystem(
    approval: Approval,
    transition: ApprovalSystemTransition,
  ): Promise<Result<ApplyTransitionResult, ApplyTransitionError>>;
}

// ---------------------------------------------------------------------------
// (2d) DispatchApprovedActionPort — the Tool Gateway envelope, replay reuse
// ---------------------------------------------------------------------------

/**
 * The outcome of dispatching an approved action through the Tool Gateway. `status`
 * is `created` on a fresh exactly-once external write, `reused` when the envelope's
 * receipt already existed (replay → zero duplicate external write — safety rule 3 /
 * inv-5). The `envelope` carries the write receipt once committed.
 */
export interface DispatchApprovedResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}

/** Closed, enumerable dispatch failure set (§16 — never thrown). */
export type DispatchApprovedErrorCode =
  | "held" // the gateway failed closed (could not confirm safe dispatch) → outbox re-drive
  | "conflict" // the vendor rejected on a precondition clash (never a blind overwrite)
  | "rejected"; // the vendor/gate refused (validation/auth)

export interface DispatchApprovedError {
  readonly code: DispatchApprovedErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Dispatch an APPROVED action through the §8 Tool Gateway (safety rule 3: the ONLY
 * external-write path). Reserve-then-create with a mandatory pre-write existence
 * check; a REPLAY with the same idempotencyKey REUSES the receipt (`status:'reused'`)
 * → zero duplicate external write (inv-5). Only ever called after an `approved`
 * transition landed — a rejected/deferred/expired approval NEVER dispatches (records
 * without side effect). Never throws.
 */
export interface DispatchApprovedActionPort {
  dispatch(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<DispatchApprovedResult, DispatchApprovedError>>;
}

// ---------------------------------------------------------------------------
// (3) ApprovalHealthSink — inv-5: the failure sink (reuses 7.5 surfacing shape)
// ---------------------------------------------------------------------------

/**
 * An approval-flow failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure class through the sink
 * so nothing fails silently (inv-5 / §16). Kept here as a light shape so a
 * downstream slice can widen to the full 7.5 `WorkflowFailure` without re-declaring.
 */
export interface ApprovalWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface ApprovalSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface ApprovalHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every approval-flow failure class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`
 * (HealthItemStore + outbox); the driver depends only on this narrow port so it
 * stays pure + injected-testable. Never throws.
 */
export interface ApprovalHealthSink {
  surface(
    failure: ApprovalWorkflowFailure,
  ): Promise<Result<ApprovalSurfaceOutcome, ApprovalHealthSinkError>>;
}
