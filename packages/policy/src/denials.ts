// §5 denial taxonomy. A DenialReason is a CLOSED string union — every policy
// DENY names exactly one. FAIL-CLOSED: any missing / unrecognized / malformed
// input resolves to `MALFORMED_POLICY_INPUT` (the default-deny code); a policy
// evaluator NEVER fails open.
//
// PURE: no clock, no network, no randomness — a static classification surface.

/**
 * The FOUR §5 HARD denials — the load-bearing safety invariants of the control
 * plane (CLAUDE.md "Key safety rules"). A hard denial is never a soft/advisory
 * signal: it is a fail-closed refusal of a safety-critical operation.
 *
 *  - EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED  — safety rule 5 (Employer-Work egress veto)
 *  - DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL — safety rule 4 (workspace isolation)
 *  - UNTRUSTED_CONTENT_MUTATING_TOOL      — safety rule 6 (ING-7 tool-stripping)
 *  - WRITE_ADAPTER_OUTSIDE_GATEWAY        — safety rule 3 (external-write envelope)
 *
 * Declared `readonly` + `as const` so the membership set is frozen at the type
 * level; `HardDenial` is the narrowed union of exactly these four codes.
 */
export const HARD_DENIALS = [
  "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
  "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
  "UNTRUSTED_CONTENT_MUTATING_TOOL",
  "WRITE_ADAPTER_OUTSIDE_GATEWAY",
] as const;

export type HardDenial = (typeof HARD_DENIALS)[number];

/**
 * Supporting §5 denial codes this phase needs (provider routing, egress
 * classification, visibility, approval, session-auth). NOT hard denials — many
 * are ordinary routing/admission outcomes that are correct fail-closed
 * behavior, not safety-invariant breaches.
 */
export const SUPPORT_DENIALS = [
  "PROVIDER_NOT_ALLOWED",
  "NO_ROUTE_FOR_CAPABILITY",
  "PROCESSOR_NOT_ALLOWED",
  "LOCAL_ENDPOINT_NOT_CONFIGURED",
  "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
  "VISIBILITY_EXCEEDS_SOURCE",
  "APPROVAL_REQUIRED",
  "AUTH_TOKEN_INVALID",
  "ORIGIN_NOT_ALLOWED",
  // FAIL-CLOSED default: missing / unrecognized / malformed policy input.
  "MALFORMED_POLICY_INPUT",
] as const;

export type SupportDenial = (typeof SUPPORT_DENIALS)[number];

/** The closed union of every §5 denial code (hard ∪ support). */
export type DenialReason = HardDenial | SupportDenial;

/**
 * The fail-closed default denial code. Every evaluator that encounters missing,
 * unrecognized, or malformed input returns a DENY carrying this reason rather
 * than throwing or failing open.
 */
export const FAIL_CLOSED_DENIAL: DenialReason = "MALFORMED_POLICY_INPUT";

// Set membership check, allocation-free at call time.
const HARD_DENIAL_SET: ReadonlySet<string> = new Set<string>(HARD_DENIALS);

/** True iff `r` is one of the four §5 hard-safety denials. */
export function isHardDenial(r: DenialReason): boolean {
  return HARD_DENIAL_SET.has(r);
}
