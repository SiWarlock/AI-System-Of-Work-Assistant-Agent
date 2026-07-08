// Task 8.4 (a) — the approval command: a SINGLE idempotent transition over
// pending -> approved|edited|rejected|deferred|expired (REQ-F-012, §9).
//
// EXACTLY-ONCE, ONE-WRITER. This module owns the command-layer logic BUILT OVER
// the exactly-once approval CAS. It does NOT re-implement the compare-and-set:
// the injected `ApprovalCommandPort.applyTransition` is the atomic CAS (the real
// binding wraps `packages/db`'s `ApprovalRepository`, which itself drives
// `decideApprovalCas` → apply | idempotent_noop | stale_conflict). This layer:
//   1. maps a channel-agnostic DECISION (approve/edit/reject/defer) to the target
//      `ApprovalStatus` (Mac + Telegram parity — the SAME transition regardless of
//      channel);
//   2. reads the current record to build the NEXT record + `expectedFromStatus`
//      for the CAS (defer stamps snoozeUntil/expiresAt from the injected clock);
//   3. issues the CAS EXACTLY ONCE; a second-channel contender / a replay resolves
//      to `applied: false` (idempotent no-op) — NEVER a 2nd durable write;
//   4. drives a downstream side effect (dispatch) ONLY on a genuine transition
//      (`applied: true`) and ONLY through the injected dispatch port — the API
//      never writes an external system or Markdown directly (§7/§8, safety 3);
//   5. rejects approve/reject on an already-terminal (e.g. expired) item as a
//      typed err with NO state change (the CAS returns `conflict`).
//
// §16: never throws across the boundary — every path returns `Result<T,
// FailureVariant>`. PURE-ish: no I/O of its own; all effects go through injected
// ports.
import {
  ok,
  err,
  isErr,
  failure,
  type Approval,
  type ApprovalStatus,
  type Channel,
  type Result,
  type FailureVariant,
} from "@sow/contracts";
import type { ApprovalTransitionOutcome, DbError } from "@sow/db";

/**
 * The channel-agnostic decision a human makes on a pending approval card. Mac +
 * Telegram present the SAME four decisions; the command path maps each to its
 * target `ApprovalStatus` identically regardless of channel (REQ-F-012, §11).
 */
export type ApprovalDecision = "approve" | "edit" | "reject" | "defer";

/**
 * The frozen decision set — used at the transport edge to NARROW an untrusted
 * input string to an {@link ApprovalDecision} (the candidate-data gate). Order is
 * not load-bearing; membership is.
 */
export const APPROVAL_DECISIONS = ["approve", "edit", "reject", "defer"] as const;

/** Map a decision to the target `ApprovalStatus` it transitions the card to. */
const DECISION_TO_STATUS: Record<ApprovalDecision, ApprovalStatus> = {
  approve: "approved",
  edit: "edited",
  reject: "rejected",
  defer: "deferred",
};

/**
 * The injected exactly-once approval store — the command layer's ONLY approval
 * I/O. The real binding wraps `packages/db`'s `ApprovalRepository`
 * (`get` + `applyTransition`), so the atomic compare-and-set (and its
 * `decideApprovalCas` verdicts) live once, in the repository, NOT here. A fake
 * implements this interface for unit tests.
 */
export interface ApprovalCommandPort {
  /** Read the current approval record (for `expectedFromStatus` + the NEXT record). */
  get(id: Approval["id"]): Promise<Result<Approval, DbError>>;
  /**
   * Apply a single approval transition EXACTLY ONCE. `expectedFrom` makes it a
   * compare-and-set; the `ok` outcome's `applied` flag distinguishes a genuine
   * durable transition (`true`) from an idempotent no-op (`false`, a replay or a
   * concurrent second-channel contender). A stale/tombstoned CAS is `conflict`.
   */
  applyTransition(
    id: Approval["id"],
    expectedFrom: ApprovalStatus,
    next: Approval,
  ): Promise<Result<ApprovalTransitionOutcome, DbError>>;
}

/** Dispatch the downstream side effect of an APPLIED approval — ONLY via this port. */
export type DispatchApprovalFn = (approval: Approval) => Promise<Result<void, FailureVariant>>;

/** A clock returning an ISO-8601 timestamp — injected so `defer` is testable. */
export type NowFn = () => string;

/** The result surface of a decideApproval command (mirrors the CAS outcome). */
export interface ApprovalDecisionResult {
  /** The record AFTER the CAS resolved (next on apply; current on a no-op). */
  readonly approval: Approval;
  /** True IFF THIS call caused the durable transition (a genuine `apply`). */
  readonly applied: boolean;
}

/** Default deferred-lifecycle windows (mirror the domain APPROVAL_DEFAULTS). */
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Map a `DbError` from the CAS onto the §16 `FailureVariant` boundary taxonomy.
 * A lost/stale/tombstoned CAS is a `write_conflict` (the exactly-once loser — no
 * 2nd apply); an absent record is a `validation_rejected`; anything else degrades.
 * REDACTION-SAFE: only the stable code crosses, never the driver cause.
 */
function dbErrorToFailure(e: DbError): FailureVariant {
  switch (e.code) {
    case "conflict":
      return failure("write_conflict", "approval transition lost the compare-and-set", {
        cause: { code: "APPROVAL_CAS_CONFLICT" },
      });
    case "not_found":
      return failure("validation_rejected", "approval not found", {
        cause: { code: "APPROVAL_NOT_FOUND" },
      });
    case "constraint_violation":
      return failure("write_conflict", "approval transition rejected", {
        cause: { code: "APPROVAL_CONSTRAINT" },
      });
    case "serialization_failure":
      return failure("degraded_unavailable", "approval store retryable", {
        retryable: true,
        cause: { code: "APPROVAL_SERIALIZATION" },
      });
    case "unavailable":
      return failure("degraded_unavailable", "approval store unavailable", {
        retryable: true,
        cause: { code: "APPROVAL_STORE_UNAVAILABLE" },
      });
    case "unknown":
    default:
      return failure("degraded_unavailable", "approval store error", {
        cause: { code: "APPROVAL_STORE_UNKNOWN" },
      });
  }
}

/**
 * Build the NEXT approval record for a decision. `defer` stamps snoozeUntil (the
 * re-surface instant) + expiresAt (auto-expiry) from the injected clock; the
 * other three are terminal transitions carrying no snooze. The `channel` is
 * recorded as the deciding channel (Mac/Telegram parity — the transition itself
 * is channel-independent). Non-defer transitions DROP any prior snoozeUntil so
 * the frozen `snooze ⇔ deferred` refine holds.
 */
function nextRecord(
  current: Approval,
  decision: ApprovalDecision,
  channel: Channel,
  now: NowFn,
): Approval {
  const status = DECISION_TO_STATUS[decision];
  const base: Approval = {
    id: current.id,
    // §13.10a — a transition PRESERVES the immutable subject (actionRef/planRef/subjectKind) of the
    // current record; only status/actor/channel/snooze change. Carrying both refs + the discriminator
    // forward keeps the frozen subject-invariant refine satisfied for BOTH kinds (external_action +
    // semantic_mutation) across every transition.
    actionRef: current.actionRef,
    planRef: current.planRef,
    subjectKind: current.subjectKind,
    // WS-4: a transition PRESERVES the stored workspace (immutable — carried forward from the current record).
    workspaceId: current.workspaceId,
    status,
    actor: current.actor,
    channel,
    payloadHash: current.payloadHash,
  };
  if (decision === "defer") {
    const nowMs = new Date(now()).getTime();
    return {
      ...base,
      snoozeUntil: new Date(nowMs + SNOOZE_MS).toISOString(),
      expiresAt: new Date(nowMs + EXPIRY_MS).toISOString(),
    };
  }
  return base;
}

/**
 * Execute a single idempotent approval decision (REQ-F-012, §9). Reads the
 * current record, builds the CAS `expectedFrom` + NEXT record, issues the CAS
 * EXACTLY ONCE, and — ONLY on a genuine `applied: true` transition — drives the
 * injected dispatch port. A no-op contender (`applied: false`, a replay or a
 * losing second-channel apply) returns the same transition WITHOUT re-dispatching
 * (exactly-once across Mac + Telegram). approve/reject on an already-terminal
 * item surfaces the CAS `conflict` as a typed err — NO state change, dispatchable
 * downstream as an audited rejection.
 */
export async function decideApprovalCommand(
  deps: {
    approvals: ApprovalCommandPort;
    dispatchApproval: DispatchApprovalFn;
    now: NowFn;
  },
  input: { approvalId: string; decision: ApprovalDecision; channel: Channel },
): Promise<Result<ApprovalDecisionResult, FailureVariant>> {
  const id = input.approvalId as Approval["id"];

  // 1. Read the current record — needed for expectedFrom + the NEXT record.
  const currentR = await deps.approvals.get(id);
  if (isErr(currentR)) {
    return err(dbErrorToFailure(currentR.error));
  }
  const current = currentR.value;
  const expectedFrom = current.status;

  // 2. Build the NEXT record (defer stamps snooze/expiry from the clock).
  const next = nextRecord(current, input.decision, input.channel, deps.now);

  // 3. Issue the exactly-once CAS. The repository's decideApprovalCas decides
  //    apply | idempotent_noop | stale_conflict — a second-channel contender or
  //    a replay resolves to applied:false; a terminal/expired item is conflict.
  const casR = await deps.approvals.applyTransition(id, expectedFrom, next);
  if (isErr(casR)) {
    // Stale/tombstoned (e.g. approve/reject on an already-expired item) — a typed
    // rejection with NO state change (§9). The audit of the rejection is the
    // dispatch layer's job on the real binding; the command itself never writes.
    return err(dbErrorToFailure(casR.error));
  }
  const outcome = casR.value;

  // 4. Drive the side effect ONLY on a genuine durable transition — the one-writer
  //    / Tool-Gateway rule (§7/§8): a no-op contender must NOT dispatch again.
  if (outcome.applied) {
    const dispatchR = await deps.dispatchApproval(outcome.approval);
    if (isErr(dispatchR)) {
      return err(dispatchR.error);
    }
  }

  return ok({ approval: outcome.approval, applied: outcome.applied });
}
