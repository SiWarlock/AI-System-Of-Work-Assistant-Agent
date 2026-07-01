// @sow/providers — broker egress-veto composition (§7 task 5.3).
//
// The broker's egress step. It COMPOSES @sow/policy `egressVeto` (safety rule 5,
// HARD DENIAL #1) into the fixed-order pipeline AFTER route resolution and BEFORE
// health/budget — it is a pure VETO over the matrix's already-selected route, not
// a pre-filter and not a selector: it may only NARROW (deny the cloud option so
// the sole survivor is a genuine loopback-local route) or DENY, never widen or
// substitute the route. It NEVER re-implements the §5 predicate — the employer-raw
// veto, OpenRouter-is-its-own-processor classification, tunneled-local fail-close,
// and allowlist checks all live in @sow/policy and are reused verbatim.
//
// FAIL-CLOSED: for an Employer-Work raw-content job with egress acknowledgment OFF
// and no loopback-local route, the veto denies EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED
// — there is explicitly NO cloud fallback; the broker surfaces the typed denial +
// its redaction-safe AuditSignal (the broker maps it to a fail-closed System
// Health item). PURE; every outcome is a typed PolicyDecision, never a throw (§16).
//
// DEFENSE-IN-DEPTH (the "no later gate can re-open it" guarantee): the broker
// treats the veto strictly as pass-or-deny. If the underlying veto ever returns an
// ALLOW carrying a route that is not the one it was handed — a widened /
// substituted egress target — the composition FAILS CLOSED (MALFORMED_POLICY_INPUT)
// rather than let a downstream gate run against a provider the veto never cleared.
import type {
  AgentJob,
  EgressPolicy,
  ProviderRoute,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import {
  egressVeto,
  isDeny,
  allowDecision,
  denyDecision,
  buildAuditSignal,
  type AuditSignal,
  type PolicyDecision,
} from "@sow/policy";

const EGRESS_VETO_ACTOR = "broker:egress-veto" as const;
const EGRESS_VETO_MARKER = "broker:egress-veto-decision" as const;

/** The §5 egress-veto signature the broker composes (injectable for testing). */
export type EgressVetoFn = (
  job: AgentJob,
  route: ProviderRoute,
  egress: EgressPolicy,
  workspace: { type: WorkspaceType; dataOwner: DataOwner },
) => PolicyDecision<ProviderRoute>;

/**
 * True iff two routes name the SAME egress target: the same port key
 * (provider|runtime identity), endpoint, and egressClass. Used to prove the veto
 * did not widen/substitute the route on an allow. Reads through an untyped view so
 * a malformed value can never be mistaken for "same". Pure.
 */
function sameEgressTarget(a: ProviderRoute, b: ProviderRoute): boolean {
  const va = a as unknown as Record<string, unknown> | null;
  const vb = b as unknown as Record<string, unknown> | null;
  if (va === null || vb === null || typeof va !== "object" || typeof vb !== "object") {
    return false;
  }
  return (
    va["provider"] === vb["provider"] &&
    va["runtime"] === vb["runtime"] &&
    va["endpoint"] === vb["endpoint"] &&
    va["egressClass"] === vb["egressClass"]
  );
}

/**
 * Compose the §5 egress veto over the broker's selected `route`.
 *
 * Behavior:
 *  1. Delegate to @sow/policy `egressVeto(job, route, egress, workspace)` — the sole
 *     employer-raw veto + allowlist + processor-classification authority.
 *  2. DENY ⇒ surface the typed denial + AuditSignal UNCHANGED (fail-closed; no cloud
 *     fallback). The broker maps this to a fail-closed System Health item.
 *  3. ALLOW ⇒ enforce narrow-only: the permitted route MUST be the same egress
 *     target it was handed. A widened/substituted route ⇒ fail closed
 *     (MALFORMED_POLICY_INPUT) rather than trust a route the veto rewrote.
 *
 * `vetoFn` is injectable only for the defense-in-depth test; production always
 * uses the certified @sow/policy `egressVeto`. Pure; never throws.
 */
export function vetoJobEgress(
  job: AgentJob,
  route: ProviderRoute,
  egress: EgressPolicy,
  workspace: { type: WorkspaceType; dataOwner: DataOwner },
  vetoFn: EgressVetoFn = egressVeto,
): PolicyDecision<ProviderRoute> {
  const decision = vetoFn(job, route, egress, workspace);

  // DENY: fail-closed denial (incl. EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED) passes
  // through with its redaction-safe AuditSignal intact — never a cloud fallback.
  if (isDeny(decision)) return decision;

  // ALLOW: the veto is pass-or-deny — it may narrow the eligible set but must return
  // the SAME route object it was handed. A substitution/widening would let a later
  // gate run on a provider the veto never cleared (re-opening the veto) — fail closed.
  if (!sameEgressTarget(decision.value, route)) {
    const audit: AuditSignal = buildAuditSignal({
      actor: EGRESS_VETO_ACTOR,
      event: "egress.veto.route_substituted",
      refs: [`ref:job:${job.id}`, `ref:workspace:${job.workspaceId}`],
      payloadHash: EGRESS_VETO_MARKER,
      beforeSummary: "egress veto in progress",
      afterSummary: "egress veto returned a widened/substituted route; refusing (broker fails closed)",
      denialCode: "MALFORMED_POLICY_INPUT",
    });
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "egress veto returned a route it was not handed (widening/substitution); the broker treats the veto as pass-or-deny only",
      audit,
    );
  }

  // narrow-only satisfied: re-emit the allow on the SAME route (identity preserved).
  return allowDecision(route, decision.audit);
}
