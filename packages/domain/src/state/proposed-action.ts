// Proposed External Action state machine (task 1.13, DOMAIN_MODEL.md
// §Proposed External Action). The §8 Tool-Gateway external-write lifecycle:
//
//   proposed -> approval_required | auto_allowed
//            -> precondition_checked -> dispatched
//            -> receipt_recorded | retry_queued | rejected | expired
//   retry_queued -> dispatched   (re-dispatch)
//
// Terminal (frozen): receipt_recorded (terminal-success), rejected, expired.
// PURE + TOTAL: built on the foundation `defineMachine` primitive — no clock, no
// randomness, no I/O; identical input ⇒ identical output (replay-safe). Never
// throws: an illegal edge, a move out of a terminal state, or an off-alphabet
// state all return a typed err(...) (§16 error convention).
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";

/** The lifecycle states, in topological-ish order. Const tuple = source of truth. */
export const PROPOSED_ACTION_STATES = [
  "proposed",
  "approval_required",
  "auto_allowed",
  "precondition_checked",
  "dispatched",
  "retry_queued",
  "receipt_recorded",
  "rejected",
  "expired",
] as const;

export type ProposedActionState = (typeof PROPOSED_ACTION_STATES)[number];

// Adjacency table. A zero-length edge list marks a terminal (frozen) state.
const transitions: Readonly<
  Record<ProposedActionState, readonly ProposedActionState[]>
> = {
  proposed: ["approval_required", "auto_allowed"],
  approval_required: ["precondition_checked"],
  auto_allowed: ["precondition_checked"],
  // arch_gap: precondition_checked -> ONLY dispatched. The spec models no
  // precondition-FAILURE exit (the state name implies the check already passed);
  // a failed precondition is not representable as an edge out of this state.
  precondition_checked: ["dispatched"],
  dispatched: ["receipt_recorded", "retry_queued", "rejected", "expired"],
  // arch_gap: the spec states ONLY retry_queued -> dispatched (re-dispatch). No
  // terminal-exhaustion edge (retry_queued -> expired|rejected) is given, so a
  // retry that gives up must re-dispatch and then expire/reject from dispatched.
  retry_queued: ["dispatched"],
  // Terminals (frozen): no outgoing edges. arch_gap: the spec routes `rejected`
  // only from `dispatched` — there is no approval_required -> rejected edge, so a
  // declined approval BEFORE dispatch is not representable on this machine
  // (decline/edit/defer live on the separate Approval machine).
  receipt_recorded: [],
  rejected: [],
  expired: [],
};

// Default opts: terminals are hard-frozen (no idempotent terminal reentry — that
// REQ-F-012 behavior is opt-in on the primitive and not requested for this
// machine). Explicit type annotation per the strict-export posture.
export const proposedActionMachine: StateMachine<ProposedActionState> =
  defineMachine<ProposedActionState>(transitions);
