// task 7.9 — in-memory test doubles + builders for the APPROVAL-FLOW ports.
//
// The fakes SATISFY the real port interfaces (src/ports/approvalFlow.ts) so the
// PURE approval-flow driver is Vitest-unit-testable with NO ApprovalRepository /
// Tool Gateway / Temporal server / real DB. Every fake returns the EXACT typed
// Result the port declares (never throws) and is deterministic (the foundation
// FakeClock injects time). The fakes model the 7.9 safety invariants:
//   • FakeRecordPendingPort — idempotent record (a re-drive reuses; no 2nd card).
//   • FakeSurfaceCardPort   — Mac + Telegram parity; force a parity break.
//   • FakeApplyTransitionPort — EXACTLY-ONCE CAS (a 2nd apply is a no-op); models
//       expired-can-never-approve + conflicting-approval + a shared durable store.
//   • FakeDispatchApprovedPort — envelope reuse by idempotencyKey (one create).
//   • FakeApprovalHealthSink — records every surfaced failure (nothing silent).
import { ok, err, isOk, approvalId, actionId, workspaceId } from "@sow/contracts";
import type {
  Result,
  Approval,
  ApprovalStatus,
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
  Channel,
} from "@sow/contracts";
import { approvalMachine } from "@sow/domain";
import type { ApprovalState } from "@sow/domain";
import { decideApprovalCas } from "@sow/db";
import type {
  RecordPendingPort,
  RecordPendingResult,
  RecordPendingError,
  RecordPendingErrorCode,
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
  DispatchApprovedErrorCode,
  ApprovalHealthSink,
  ApprovalWorkflowFailure,
  ApprovalSurfaceOutcome,
  ApprovalHealthSinkError,
  ApprovalFlowContext,
} from "../../src/ports/approvalFlow";

// --- builders --------------------------------------------------------------

/** Build a valid §8 ProposedAction for tests. */
export function makeProposedAction(
  partial: Partial<ProposedAction> = {},
): ProposedAction {
  return {
    actionId: actionId("act-1"),
    targetSystem: "github",
    canonicalObjectKey: "github:repo/issue#1",
    payload: { title: "close issue" },
    approvalPolicy: "requires_approval",
    idempotencyKey: "idem-act-1",
    ...partial,
  };
}

/** Build a valid ExternalWriteEnvelope for tests (matches makeProposedAction). */
export function makeEnvelope(
  partial: Partial<ExternalWriteEnvelope> = {},
): ExternalWriteEnvelope {
  return {
    actionId: actionId("act-1"),
    targetSystem: "github",
    canonicalObjectKey: "github:repo/issue#1",
    idempotencyKey: "idem-act-1",
    preconditions: ["issue-open"],
    payloadHash: "hash-payload-1",
    ...partial,
  };
}

/** Build a well-formed ApprovalFlowContext (bound workspace + action + envelope). */
export function makeApprovalContext(
  partial: Partial<ApprovalFlowContext> = {},
): ApprovalFlowContext {
  return {
    workspaceId: workspaceId("ws-employer"),
    action: makeProposedAction(),
    envelope: makeEnvelope(),
    ...partial,
  };
}

/** Build a pending Approval record (status pending; expiry set). */
export function makeApproval(partial: Partial<Approval> = {}): Approval {
  return {
    id: approvalId("apr-1"),
    actionRef: actionId("act-1"),
    workspaceId: workspaceId("ws-employer"),
    status: "pending",
    actor: "user:alice",
    channel: "mac",
    payloadHash: "hash-payload-1",
    expiresAt: "2026-07-08T00:00:00.000Z",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// FakeRecordPendingPort — idempotent record (a re-drive reuses; no 2nd card)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeRecordPendingPort}: `failWith` forces a typed
 * {@link RecordPendingError}; `approval` overrides the recorded record. Recording
 * is IDEMPOTENT by the envelope's idempotencyKey — a re-drive with the same key
 * returns `created:false` (no second card / audit), tracked by `recordCount`.
 */
export interface FakeRecordPendingConfig {
  readonly failWith?: RecordPendingErrorCode;
  readonly approval?: Approval;
}

export class FakeRecordPendingPort implements RecordPendingPort {
  /** Number of DISTINCT records made (a replay does NOT bump this). */
  recordCount = 0;
  private readonly byKey = new Map<string, Approval>();

  constructor(private readonly config: FakeRecordPendingConfig = {}) {}

  record(
    ctx: ApprovalFlowContext,
  ): Promise<Result<RecordPendingResult, RecordPendingError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({
          code: this.config.failWith,
          message: `fake record failure: ${this.config.failWith}`,
        }),
      );
    }
    const key = ctx.envelope.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // Idempotent replay: reuse the record, NO second card (inv-A).
      return Promise.resolve(ok({ approval: existing, created: false }));
    }
    this.recordCount += 1;
    const approval =
      this.config.approval ??
      makeApproval({
        actionRef: ctx.action.actionId,
        payloadHash: ctx.envelope.payloadHash,
      });
    this.byKey.set(key, approval);
    return Promise.resolve(ok({ approval, created: true }));
  }
}

// ---------------------------------------------------------------------------
// FakeSurfaceCardPort — Mac + Telegram parity
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeSurfaceCardPort}: `failWith` forces a typed
 * {@link SurfaceCardError} (default `parity_failed` when set to true). Absent, the
 * card renders on BOTH channels with parity, and every surface is recorded.
 */
export interface FakeSurfaceCardConfig {
  readonly failWith?: SurfaceCardError["code"];
}

export class FakeSurfaceCardPort implements SurfaceCardPort {
  /** Every approval surfaced (proof the card was shown). */
  readonly surfaced: Approval[] = [];

  constructor(private readonly config: FakeSurfaceCardConfig = {}) {}

  surface(approval: Approval): Promise<Result<SurfaceCardResult, SurfaceCardError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({
          code: this.config.failWith,
          message: `fake surface failure: ${this.config.failWith}`,
          rendered: this.config.failWith === "parity_failed" ? ["mac"] : [],
        }),
      );
    }
    this.surfaced.push(approval);
    // PARITY: both channels rendered (inv-B).
    return Promise.resolve(ok({ channels: ["mac", "telegram"] satisfies Channel[] }));
  }
}

// ---------------------------------------------------------------------------
// FakeApplyTransitionPort — EXACTLY-ONCE CAS across BOTH channels
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeApplyTransitionPort}:
 *   • `failWith` forces a typed {@link ApplyTransitionError} on EVERY apply.
 *   • `store` shares a durable Approval store across drives (models the real DB +
 *     the EXACTLY-ONCE CAS: a second apply from the other channel finds the record
 *     already moved and returns `applied:false`). Absent, a private store is used.
 *
 * The fake models the CAS by keying the current status on the approval id: the
 * FIRST apply that finds the record in the expected `from` commits (applied:true,
 * `applyCount` bumped); a SECOND apply that finds it already in the target returns
 * `applied:false` (no double-apply/audit); a move onto a DIFFERENT terminal is a
 * `conflicting_approval`. An `expired` → `approved` move is rejected as `expired`
 * (an expired approval can never later be approved). The domain approvalMachine
 * gates every edge first.
 */
export interface FakeApplyTransitionConfig {
  readonly failWith?: ApplyTransitionErrorCode;
  readonly store?: FakeApprovalStore;
}

/** A shared, durable approval store (models the DB across drives + channels). */
export class FakeApprovalStore {
  readonly byId = new Map<string, Approval>();
  /** Number of DISTINCT durable transitions (a no-op replay does NOT bump this). */
  applyCount = 0;
  seed(approval: Approval): void {
    this.byId.set(approval.id, approval);
  }
  get(id: string): Approval | undefined {
    return this.byId.get(id);
  }
}

export class FakeApplyTransitionPort implements ApplyTransitionPort {
  private readonly store: FakeApprovalStore;

  constructor(private readonly config: FakeApplyTransitionConfig = {}) {
    this.store = config.store ?? new FakeApprovalStore();
  }

  private commit(
    approval: Approval,
    to: ApprovalState,
    patch: Partial<Approval>,
  ): Result<ApplyTransitionResult, ApplyTransitionError> {
    if (this.config.failWith !== undefined) {
      return err({
        code: this.config.failWith,
        message: `fake apply failure: ${this.config.failWith}`,
      });
    }
    // The CURRENT durable status (seeded on first sight of the record).
    const current = this.store.get(approval.id) ?? approval;
    if (!this.store.byId.has(approval.id)) this.store.seed(approval);
    const from = current.status;

    // The domain machine gates the edge (illegal / terminal-guarded).
    const edge = approvalMachine.transition(from as ApprovalState, to);
    if (!isOk(edge)) {
      const code: ApplyTransitionErrorCode =
        from === "expired" && to === "approved" ? "expired" : "illegal_transition";
      return err({ code, message: `illegal edge ${from} → ${to}` });
    }

    // EXACTLY-ONCE CAS decided by the SAME shared 2.5 invariant the shipped adapters
    // use (`decideApprovalCas`), so this port fake surfaces `applied` the same way as
    // production: expectedFrom === the current durable status (a decision always CASes
    // from the status it observed). `idempotent_noop` (a replay / second-channel
    // decision on the SAME target) → applied:false, NO durable write; `apply` → a
    // genuine transition, applied:true.
    const verdict = decideApprovalCas(from as ApprovalStatus, from as ApprovalStatus, to as ApprovalStatus);
    if (verdict.kind === "idempotent_noop") {
      return ok({
        approval: current,
        applied: false,
        noopReason: approvalMachine.isTerminal(to)
          ? "already_terminal"
          : "already_in_target",
      });
    }

    // Commit the transition durably (one distinct apply).
    const next: Approval = {
      ...current,
      ...patch,
      status: to as ApprovalStatus,
    };
    this.store.byId.set(approval.id, next);
    this.store.applyCount += 1;
    return ok({ approval: next, applied: true });
  }

  apply(
    approval: Approval,
    decision: ApprovalDecision,
  ): Promise<Result<ApplyTransitionResult, ApplyTransitionError>> {
    const to = decision.decision as ApprovalState;
    return Promise.resolve(
      this.commit(approval, to, {
        actor: decision.actor,
        channel: decision.channel,
      }),
    );
  }

  applySystem(
    approval: Approval,
    transition: ApprovalSystemTransition,
  ): Promise<Result<ApplyTransitionResult, ApplyTransitionError>> {
    const to: ApprovalState = transition === "expire" ? "expired" : "pending";
    return Promise.resolve(
      this.commit(approval, to, { actor: "system:snooze-timer" }),
    );
  }
}

// ---------------------------------------------------------------------------
// FakeDispatchApprovedPort — envelope reuse by idempotencyKey (one create)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeDispatchApprovedPort}: `failWith` forces a typed
 * {@link DispatchApprovedError} (fail-closed — NO create). Absent, a first dispatch
 * CREATES (createCount bumped) and a REPLAY with the same idempotencyKey REUSES the
 * receipt → zero duplicate external write (inv-E).
 */
export interface FakeDispatchApprovedConfig {
  readonly failWith?: DispatchApprovedErrorCode;
}

export class FakeDispatchApprovedPort implements DispatchApprovedActionPort {
  /** Number of DISTINCT external creates (a reuse does NOT bump this). */
  createCount = 0;
  private readonly byKey = new Map<string, WriteReceipt>();

  constructor(private readonly config: FakeDispatchApprovedConfig = {}) {}

  dispatch(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<DispatchApprovedResult, DispatchApprovedError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({
          code: this.config.failWith,
          message: `fake dispatch failure: ${this.config.failWith}`,
        }),
      );
    }
    const key = env.idempotencyKey || action.idempotencyKey;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      // Replay: reuse the receipt — zero duplicate external write (inv-E).
      return Promise.resolve(
        ok({ status: "reused", envelope: { ...env, writeReceipt: existing } }),
      );
    }
    this.createCount += 1;
    const receipt: WriteReceipt = {
      externalObjectId: `ext-${this.createCount}`,
      recordedAt: "2026-07-01T00:00:00.000Z",
    };
    this.byKey.set(key, receipt);
    return Promise.resolve(
      ok({ status: "created", envelope: { ...env, writeReceipt: receipt } }),
    );
  }
}

// ---------------------------------------------------------------------------
// FakeApprovalHealthSink — records every surfaced failure (nothing silent)
// ---------------------------------------------------------------------------

/**
 * Config for {@link FakeApprovalHealthSink}: `failWith` forces a typed
 * {@link ApprovalHealthSinkError} (exercises the §16 "sink itself failed" path);
 * absent, every surfaced failure is RECORDED in `surfaced` (inv-5 proof).
 */
export interface FakeApprovalHealthSinkConfig {
  readonly failWith?: ApprovalHealthSinkError["code"];
}

export class FakeApprovalHealthSink implements ApprovalHealthSink {
  readonly surfaced: ApprovalWorkflowFailure[] = [];

  constructor(private readonly config: FakeApprovalHealthSinkConfig = {}) {}

  surface(
    failure: ApprovalWorkflowFailure,
  ): Promise<Result<ApprovalSurfaceOutcome, ApprovalHealthSinkError>> {
    if (this.config.failWith !== undefined) {
      return Promise.resolve(
        err({
          code: this.config.failWith,
          message: `fake health-sink failure: ${this.config.failWith}`,
        }),
      );
    }
    this.surfaced.push(failure);
    return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
  }
}
