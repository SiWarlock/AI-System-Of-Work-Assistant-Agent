// Approval state machine (DOMAIN_MODEL.md §Approval; REQ-F-012). PURE + TOTAL —
// no clock, no randomness, no I/O; identical input ⇒ identical output
// (replay-safe). Models the human decision on a sensitive action, surfaced with
// Mac+Telegram parity: a card may be approved/edited/rejected/deferred/expired
// exactly once across BOTH channels. The idempotentTerminalReentry option makes a
// re-applied terminal transition (e.g. a second "approve" from the other channel)
// a no-op SUCCESS rather than an error — that is the exactly-once seam.
//
// DOMAIN_MODEL.md §Approval states only `pending -> approved | edited | rejected
// | deferred | expired` and does not enumerate `deferred`'s outgoing edges. The
// task brief supplies them: `deferred` is NON-TERMINAL and re-surfaces to
// `pending` (after the snooze window) or `expired` (auto-expiry). See arch_gap on
// the table below.
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";
import type { ApprovalStatus } from "@sow/contracts";

/**
 * Declared state alphabet. Mirrors `@sow/contracts` `ApprovalStatus` (the frozen
 * seam enum) — the static assertion below pins them in lockstep so neither can
 * drift from the other.
 */
export const APPROVAL_STATES = [
  "pending",
  "approved",
  "edited",
  "rejected",
  "deferred",
  "expired",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

// Compile-time drift guard: ApprovalState ≡ the frozen contract enum (both ways).
// If either set changes, one of these assignments stops type-checking.
type _AssertStateMatchesContract = ApprovalState extends ApprovalStatus
  ? ApprovalStatus extends ApprovalState
    ? true
    : never
  : never;
const _stateContractParity: _AssertStateMatchesContract = true;
void _stateContractParity;

/**
 * Configurable timing windows for the deferred lifecycle. PURE constants only —
 * the machine itself is clockless; whatever drives `deferred -> pending`
 * (snooze elapsed) or `* -> expired` (TTL elapsed) reads these and supplies the
 * clock outside this module. Defaults: snooze 24h, expiry 7d.
 */
export const APPROVAL_DEFAULTS = {
  snoozeMs: 24 * 60 * 60 * 1000,
  expiryMs: 7 * 24 * 60 * 60 * 1000,
} as const;

// arch_gap: `deferred`'s outgoing edges (pending|expired) are NOT in
// DOMAIN_MODEL.md §Approval — that line only lists pending's targets. The brief
// supplies the deferred re-surface semantics; encoded here. The four terminal
// states (approved/edited/rejected/expired) are frozen — empty edge lists.
const APPROVAL_TRANSITIONS: Readonly<
  Record<ApprovalState, readonly ApprovalState[]>
> = {
  pending: ["approved", "edited", "rejected", "deferred", "expired"],
  deferred: ["pending", "expired"],
  approved: [],
  edited: [],
  rejected: [],
  expired: [],
};

/**
 * The Approval machine. Total + pure; illegal edges and moves out of a frozen
 * terminal return a typed `err(...)` (never throw). `idempotentTerminalReentry`
 * makes terminal -> same-state an ok no-op (REQ-F-012 exactly-once parity);
 * terminal -> a *different* state still errs `terminal_state`.
 *
 * Annotated with the explicit `StateMachine<ApprovalState>` type per the
 * strict-TS / TS4023 guidance (no reliance on bare inference at the export).
 */
export const approvalMachine: StateMachine<ApprovalState> = defineMachine(
  APPROVAL_TRANSITIONS,
  { idempotentTerminalReentry: true },
);
