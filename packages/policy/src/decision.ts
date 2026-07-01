// §5 PolicyDecision — the shared decision envelope every §5 evaluator returns.
//
// A discriminated union on `decision`. EVERY variant (allow AND deny) carries an
// AuditSignal, so a decision is always auditable at the point it is made. This
// is the policy-layer analogue of the contracts `Result` — but a DENY is a
// first-class, typed outcome (never a thrown error): §16 forbids throwing across
// a subsystem boundary, and fail-closed denials are the norm here, not
// exceptions. Pure.
import type { AuditSignal } from "./audit-signal";
import type { DenialReason } from "./denials";

/** An allow outcome carrying the produced value + its audit signal. */
export interface PolicyAllow<T> {
  readonly decision: "allow";
  readonly value: T;
  readonly audit: AuditSignal;
}

/** A deny outcome carrying the closed denial reason, a message, + its audit signal. */
export interface PolicyDeny {
  readonly decision: "deny";
  readonly reason: DenialReason;
  readonly message: string;
  readonly audit: AuditSignal;
}

/** Discriminated union: an evaluator either allows a `T` or denies with a reason. */
export type PolicyDecision<T> = PolicyAllow<T> | PolicyDeny;

/** Construct an allow decision. */
export function allowDecision<T>(value: T, audit: AuditSignal): PolicyAllow<T> {
  return { decision: "allow", value, audit };
}

/** Construct a deny decision (the fail-closed path). */
export function denyDecision(
  reason: DenialReason,
  message: string,
  audit: AuditSignal,
): PolicyDeny {
  return { decision: "deny", reason, message, audit };
}

/** Type guard: narrows a decision to its allow variant. */
export function isAllow<T>(d: PolicyDecision<T>): d is PolicyAllow<T> {
  return d.decision === "allow";
}

/** Type guard: narrows a decision to its deny variant. */
export function isDeny<T>(d: PolicyDecision<T>): d is PolicyDeny {
  return d.decision === "deny";
}
