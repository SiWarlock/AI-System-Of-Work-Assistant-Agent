// @sow/workflows — slice 7.9 ACTIVITIES: the APPROVAL-FLOW ports implemented over
// the real adapters (ApprovalRepository CAS + the Tool Gateway envelope + the
// policy approval predicate).
//
// These are ACTIVITIES, NOT workflow code — they run worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey`) and the real @sow/db /
// @sow/integrations / @sow/policy adapters. Each implements ONE port from
// src/ports/approvalFlow.ts and FOLDS the adapter's typed rejection onto that
// port's CLOSED, enumerable error set (the driver never sees a downstream enum).
//
// ★ EXACTLY-ONCE across BOTH channels (inv-C): the apply activity is backed by
// ApprovalRepository.applyTransition — a compare-and-set on `expectedFromStatus`.
// The domain approvalMachine is consulted FIRST (an illegal edge never reaches the
// CAS), then the repo ATOMICALLY decides + surfaces the outcome's `applied` flag:
//   • a GENUINE durable transition (current === expected) → `applied:true` — this
//     caller caused the move and is the ONE that drives dispatch;
//   • an idempotent no-op (a Temporal REPLAY, or a concurrent SECOND-CHANNEL CAS
//     that found the record already in the target) → `ok` with `applied:false` and
//     NO durable write — the activity reports `applied:false` (+ a noopReason) so
//     the driver's exactly-once guard skips a second dispatch.
// There is NO pre-write get()/self-loop heuristic anymore — that read-then-write was
// the TOCTOU; the repo now tells the truth atomically. A different-terminal landing
// stays a `conflict` the activity resolves to `conflicting_approval` (two racing
// decisions). An `expired` approval can NEVER move to approved (the machine rejects
// the edge — `expired` is terminal).
//
// §16: every method returns a typed Result — never throws.
import { ok, err, isOk, approvalId as makeApprovalId } from "@sow/contracts";
import type {
  Result,
  Approval,
  ApprovalStatus,
  ProposedAction,
  ExternalWriteEnvelope,
} from "@sow/contracts";
import type { ApprovalRepository, DbError } from "@sow/db";
import { approvalMachine } from "@sow/domain";
import type { ApprovalState } from "@sow/domain";
import { buildIdempotencyKey } from "@sow/domain";
import type {
  RecordPendingPort,
  RecordPendingResult,
  RecordPendingError,
  SurfaceCardPort,
  SurfaceCardResult,
  SurfaceCardError,
  ApplyTransitionPort,
  ApplyTransitionResult,
  ApplyTransitionError,
  ApplyTransitionErrorCode,
  ApprovalDecision,
  ApprovalSystemTransition,
  DispatchApprovedActionPort,
  DispatchApprovedResult,
  DispatchApprovedError,
  ApprovalFlowContext,
} from "../ports/approvalFlow";

// ---------------------------------------------------------------------------
// (1) RecordPendingActivity — the Tool Gateway records the pending action + card
// ---------------------------------------------------------------------------

/**
 * The seam the record activity dispatches through to persist the pending action's
 * envelope (canonical key, payload hash, required-approval flag, expiry, visibility)
 * — modeled as a narrow function so the activity does not hard-depend on the
 * concrete Tool Gateway shape. Returns the recorded envelope (with any minted keys)
 * or a typed failure the activity folds. IDEMPOTENT by the envelope's idempotencyKey.
 */
export interface RecordPendingGateway {
  reservePending(
    envelope: ExternalWriteEnvelope,
    action: ProposedAction,
  ): Promise<Result<{ envelope: ExternalWriteEnvelope; created: boolean }, RecordPendingError>>;
}

/**
 * Injected deps for the record activity: the {@link RecordPendingGateway}, the
 * ApprovalRepository the pending Approval is created in, and the deferred windows
 * (snooze/expiry) stamped onto the pending record's expiry. `now` supplies the
 * recorded-at wall instant (from the injected Clock at the worker edge — NOT
 * Date.now()). `actor`/`channel` seed the pending card's identity.
 */
export interface RecordPendingActivityDeps {
  readonly gateway: RecordPendingGateway;
  readonly approvals: ApprovalRepository;
  readonly now: string;
  readonly expiresAt: string;
  readonly actor: string;
  /** The channel that seeded the card (parity is applied downstream at surface). */
  readonly seedChannel: Approval["channel"];
}

/**
 * Build a {@link RecordPendingPort} that reserves the pending action through the
 * Tool Gateway and creates the pending Approval. IDEMPOTENT by the envelope's
 * idempotencyKey (a re-drive reuses the record — `created:false`, no second card /
 * audit). A stale precondition fails closed with `precondition_failed`. Never throws.
 */
export function createRecordPendingActivity(
  deps: RecordPendingActivityDeps,
): RecordPendingPort {
  return {
    async record(
      ctx: ApprovalFlowContext,
    ): Promise<Result<RecordPendingResult, RecordPendingError>> {
      const reserved = await deps.gateway.reservePending(ctx.envelope, ctx.action);
      if (!isOk(reserved)) return err(reserved.error);

      // The pending Approval's stable id is DERIVED from the envelope's
      // idempotencyKey so a re-drive resolves to the SAME approval id (idempotent
      // record — no duplicate card). node:crypto lives in buildIdempotencyKey.
      const idKey = buildIdempotencyKey({
        operation: "approval.pending",
        identity: {
          idempotencyKey: ctx.envelope.idempotencyKey,
          workspace: String(ctx.workspaceId),
        },
      });
      const id = makeApprovalId(idKey);

      // Idempotent create: if the approval already exists (a replay), reuse it.
      const existing = await deps.approvals.get(id);
      if (isOk(existing)) {
        return ok({ approval: existing.value, created: false });
      }

      const pending: Approval = {
        id,
        actionRef: ctx.action.actionId,
        // §13.10a — the approval-flow seeds an external-write card (a §8 ProposedAction): external_action.
        subjectKind: "external_action",
        // WS-4 inbox-scope: the bound/authorized workspace this pending action belongs to (WS-2). Same value
        // folded into the derived `id` above, so the §9.8 inbox filter (listByStatusAndWorkspace) round-trips.
        workspaceId: ctx.workspaceId,
        status: "pending",
        actor: deps.actor,
        channel: deps.seedChannel,
        payloadHash: ctx.envelope.payloadHash,
        expiresAt: deps.expiresAt,
      };
      const created = await deps.approvals.create(pending);
      if (!isOk(created)) {
        // A create conflict on the same id is a concurrent replay — re-read + reuse.
        const reRead = await deps.approvals.get(id);
        if (isOk(reRead)) return ok({ approval: reRead.value, created: false });
        return err({
          code: "record_failed",
          message: `pending approval create failed: ${created.error.code}`,
          cause: created.error,
        });
      }
      return ok({ approval: created.value, created: true });
    },
  };
}

// ---------------------------------------------------------------------------
// (2) SurfaceCardActivity — Mac + Telegram card PARITY
// ---------------------------------------------------------------------------

/**
 * The seam the surface activity renders through, once per channel. Returns ok on a
 * successful render, a typed err otherwise. The activity calls it for BOTH `mac`
 * and `telegram` and treats a partial render as a parity break (fail-closed).
 */
export interface CardRenderer {
  render(
    approval: Approval,
    channel: Approval["channel"],
  ): Promise<Result<void, { message: string }>>;
}

/**
 * Build a {@link SurfaceCardPort} that renders the pending card on BOTH Mac and
 * Telegram with PARITY (inv-B). A single-channel render failure is a typed
 * `parity_failed` carrying the channels that DID render — no single-channel card
 * stands. Never throws.
 */
export function createSurfaceCardActivity(renderer: CardRenderer): SurfaceCardPort {
  const CHANNELS: readonly Approval["channel"][] = ["mac", "telegram"];
  return {
    async surface(
      approval: Approval,
    ): Promise<Result<SurfaceCardResult, SurfaceCardError>> {
      const rendered: Approval["channel"][] = [];
      for (const channel of CHANNELS) {
        const r = await renderer.render(approval, channel);
        if (isOk(r)) {
          rendered.push(channel);
        }
      }
      if (rendered.length !== CHANNELS.length) {
        return err({
          code: "parity_failed",
          message: `card parity break: rendered on [${rendered.join(", ")}] only`,
          rendered,
        });
      }
      return ok({ channels: rendered });
    },
  };
}

// ---------------------------------------------------------------------------
// (3) ApplyTransitionActivity — EXACTLY ONCE across BOTH channels (CAS)
// ---------------------------------------------------------------------------

/** Map an ApprovalDecision's target to the domain machine's ApprovalState. */
function decisionTarget(decision: ApprovalDecision): ApprovalState {
  return decision.decision as ApprovalState;
}

/** Fold an ApprovalRepository DbError onto the closed apply-transition error set. */
function foldApplyDbError(e: DbError): ApplyTransitionErrorCode {
  switch (e.code) {
    case "conflict":
      return "conflicting_approval";
    case "not_found":
      return "stale_card";
    default:
      return "apply_failed";
  }
}

/**
 * Injected deps for the apply activity: the ApprovalRepository (CAS) + the wall
 * `now` (from the injected Clock; NOT Date.now()) used to stamp snooze windows on a
 * defer, and the `snoozeUntil` a defer records.
 */
export interface ApplyTransitionActivityDeps {
  readonly approvals: ApprovalRepository;
  readonly now: string;
  readonly snoozeUntil: string;
  readonly expiresAt: string;
}

/**
 * Build an {@link ApplyTransitionPort} backed by ApprovalRepository.applyTransition
 * (CAS on `expectedFromStatus`). EXACTLY-ONCE across BOTH channels (inv-C): the
 * domain approvalMachine validates the edge first (an illegal move / an expired
 * approval never reaches the CAS), then the CAS commits IFF the stored status still
 * equals the from — a second decision from the other channel is a `conflict` the
 * activity resolves to `applied:false` (already in target) or `conflicting_approval`
 * (a different terminal). Never throws.
 */
export function createApplyTransitionActivity(
  deps: ApplyTransitionActivityDeps,
): ApplyTransitionPort {
  const cas = async (
    approval: Approval,
    from: ApprovalStatus,
    to: ApprovalState,
    next: Approval,
  ): Promise<Result<ApplyTransitionResult, ApplyTransitionError>> => {
    // 1. The domain machine gates the edge FIRST (no illegal move reaches the CAS).
    const edge = approvalMachine.transition(from as ApprovalState, to);
    if (!isOk(edge)) {
      // An `expired` from-state is terminal — a move to approved can never happen.
      const code: ApplyTransitionErrorCode =
        from === "expired" && to === "approved" ? "expired" : "illegal_transition";
      return err({
        code,
        message: `illegal approval edge ${from} → ${to}`,
        cause: edge.error,
      });
    }

    // 2. CAS on expectedFromStatus — EXACTLY-ONCE, decided ATOMICALLY by the repo.
    //    The repo's `ApprovalTransitionOutcome` now SURFACES `applied` (the fix that
    //    closed the TOCTOU): a GENUINE durable transition returns `applied:true`
    //    with the next record; an idempotent no-op — a Temporal REPLAY or a
    //    concurrent SECOND-CHANNEL CAS that found the record already in the target —
    //    returns `ok` with `applied:false` and the current record, WITHOUT a durable
    //    write. Both look identical at the CAS (expected=pending, current=approved,
    //    next=approved) and BOTH are correctly no-ops (REQ-F-012 replay idempotency).
    //    We report the activity's `applied` straight from the repo's atomic verdict —
    //    NO pre-write get()/self-loop heuristic (that read-then-write was the race).
    //    Only the genuine transitioner (`applied:true`) drives the downstream
    //    dispatch; a no-op contender rests with `applied:false` so dispatch runs once.
    const res = await deps.approvals.applyTransition(approval.id, from, next);
    if (isOk(res)) {
      if (res.value.applied) {
        return ok({ approval: res.value.approval, applied: true });
      }
      // Idempotent no-op: the record already sits in the requested target (a replay
      // or the SAME decision on the other channel) — no double-apply/audit/dispatch.
      return ok({
        approval: res.value.approval,
        applied: false,
        noopReason: approvalMachine.isTerminal(to)
          ? "already_terminal"
          : "already_in_target",
      });
    }
    // A stale/lost CAS: the record moved to a DIFFERENT non-target state. Re-read to
    // classify — a different terminal already landed (two racing decisions conflict).
    if (res.error.code === "conflict") {
      const current = await deps.approvals.get(approval.id);
      if (isOk(current)) {
        // Defensive: if a further move parked it back on the target between the CAS
        // and this re-read, treat it as the idempotent no-op (never a 2nd apply).
        if (current.value.status === to) {
          return ok({
            approval: current.value,
            applied: false,
            noopReason: approvalMachine.isTerminal(to)
              ? "already_terminal"
              : "already_in_target",
          });
        }
        // A DIFFERENT terminal already landed — two racing decisions conflict.
        return err({
          code: "conflicting_approval",
          message: `conflicting approval: already ${current.value.status}, wanted ${to}`,
        });
      }
    }
    return err({
      code: foldApplyDbError(res.error),
      message: `apply transition failed: ${res.error.code}`,
      cause: res.error,
    });
  };

  return {
    apply(approval, decision) {
      const to = decisionTarget(decision);
      const next: Approval = {
        ...approval,
        status: to as ApprovalStatus,
        actor: decision.actor,
        channel: decision.channel,
        // A defer stamps the snooze re-surface instant (snoozeUntil ⇔ deferred).
        ...(to === "deferred" ? { snoozeUntil: deps.snoozeUntil } : {}),
      };
      return cas(approval, approval.status, to, next);
    },
    applySystem(approval, transition: ApprovalSystemTransition) {
      const to: ApprovalState = transition === "expire" ? "expired" : "pending";
      // A system move clears snoozeUntil (it is meaningful only while deferred —
      // the contract refine rejects snoozeUntil on a non-deferred record).
      const { snoozeUntil: _drop, ...rest } = approval;
      void _drop;
      const next: Approval = {
        ...rest,
        status: to as ApprovalStatus,
        actor: "system:snooze-timer",
      };
      return cas(approval, approval.status, to, next);
    },
  };
}

// ---------------------------------------------------------------------------
// (4) DispatchApprovedActivity — the Tool Gateway envelope, replay reuse
// ---------------------------------------------------------------------------

/**
 * The seam the dispatch activity dispatches an approved action through — the §8
 * Tool Gateway envelope pipeline (dispatchExternalWrite). Returns the write outcome
 * (created on a fresh exactly-once write, reused on a replay) or a typed failure.
 * The activity folds the gateway's outcome onto the closed dispatch error set.
 */
export interface ApprovedDispatchGateway {
  dispatch(
    action: ProposedAction,
    envelope: ExternalWriteEnvelope,
  ): Promise<Result<DispatchApprovedResult, DispatchApprovedError>>;
}

/**
 * Build a {@link DispatchApprovedActionPort} over the Tool Gateway envelope
 * (inv-E). Reserve-then-create with a mandatory pre-write existence check; a REPLAY
 * with the same idempotencyKey REUSES the receipt (`status:'reused'`) → zero
 * duplicate external write. Only ever invoked after an `approved` transition landed
 * — a rejected/deferred/expired approval never dispatches. Never throws.
 */
export function createDispatchApprovedActivity(
  gateway: ApprovedDispatchGateway,
): DispatchApprovedActionPort {
  return {
    dispatch(action, env) {
      return gateway.dispatch(action, env);
    },
  };
}
