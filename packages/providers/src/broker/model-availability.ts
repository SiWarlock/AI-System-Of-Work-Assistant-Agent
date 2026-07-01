// @sow/providers — pinned-model availability + conformance eligibility (§7 task 5.9).
//
// One half of the broker's health/availability gate (the sibling half is provider
// reachability/secret health in ./provider-health, which composes this). This
// module answers a single question about an already-selected route: is the route's
// PINNED model usable right now? Two ways it is not:
//
//   1. The pinned model is ABSENT at the configured endpoint → route ineligible,
//      a TYPED failure — NEVER a substitute-model fallback (bullet 4). We do not
//      pick a different model; we deny and surface a distinct System Health item.
//   2. The provider × capability × pinned-model pair is NON-CONFORMANT. §7's
//      "conformance is the contract": only a `passing` pair is eligible; `unknown`
//      (not yet certified), `failing`, and `disabled` are all skipped/denied. The
//      conformance status is produced by the 5.10 harness and CONSUMED here — this
//      is the runtime eligibility gate, not the harness.
//
// The status comes from a DEPENDENCY-INJECTED source (a `ModelAvailabilityProbe`);
// this module does NO network I/O. PURE + deterministic: identical probe ⇒
// identical decision. Every outcome is a typed `GateResult` — never a throw (§16).
// AuditSignals + health items are REDACTION-SAFE (ids / classes only, no endpoint
// URL that could carry userinfo, no raw content).
import { ok, err } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ConformanceStatus } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import type { GateDeny, GateResult, BrokerHealthItem } from "./broker";

// arch_gap: the frozen `FailureClass` enum has no model-availability / conformance
// member. Following the broker's `NO_ELIGIBLE_PROVIDER_HEALTH_CLASS` and policy's
// `POLICY_DENIAL_HEALTH_CLASS` convention, we name the OBS-2 health classes as
// module constants (not new enum members on a frozen contract). Flagged in the
// task manifest.
/** OBS-2 System Health class: a route's pinned model is absent at its endpoint. */
export const MODEL_UNAVAILABLE_HEALTH_CLASS = "provider_model_unavailable" as const;
/** OBS-2 System Health class: the provider×capability×model pair is non-conformant. */
export const PROVIDER_NONCONFORMANT_HEALTH_CLASS = "provider_nonconformant" as const;

/**
 * A degraded model/conformance state is RETRYABLE: the operator can pull the model
 * / promote the conformance pair and re-drive — the job is held, never dropped.
 */
export const AVAILABILITY_DEGRADED_RETRYABLE = true;

const AVAIL_ACTOR = "broker:model-availability" as const;
const AVAIL_MARKER = "broker:model-availability-decision" as const;

/**
 * The injected availability signal for a route's pinned model. `modelPresent` is
 * "is `route.model` served at `route.endpoint` right now"; `conformanceStatus` is
 * the 5.10-fed status of this provider×capability×pinned-model pair.
 */
export interface ModelAvailabilityProbe {
  readonly modelPresent: boolean;
  readonly conformanceStatus: ConformanceStatus;
}

/** The injected availability source (real reachability lives behind this in an adapter). */
export type ModelAvailabilitySource = (
  route: ProviderRoute,
  job: AgentJob,
) => ModelAvailabilityProbe;

/** Redaction-safe, id-only refs for a route+job (never the endpoint URL). */
function availabilityRefs(route: ProviderRoute, job: AgentJob): readonly string[] {
  return [
    `ref:job:${job.id}`,
    `ref:workspace:${job.workspaceId}`,
    `ref:capability:${String(job.capability)}`,
    routeTargetRef(route),
    `ref:model:${route.model}`,
  ];
}

/** The port-identity ref for a route: provider-branch or runtime-branch (id only). */
function routeTargetRef(route: ProviderRoute): string {
  return "provider" in route ? `ref:provider:${route.provider}` : `ref:runtime:${route.runtime}`;
}

/** A distinct OBS-2 health item for an absent pinned model. Redaction-safe. */
export function modelUnavailableHealthItem(route: ProviderRoute, job: AgentJob): BrokerHealthItem {
  return {
    healthClass: MODEL_UNAVAILABLE_HEALTH_CLASS,
    message: `pinned model "${route.model}" is not available at the configured endpoint; route held ineligible (no substitute-model fallback)`,
    refs: availabilityRefs(route, job),
  };
}

/** A distinct OBS-2 health item for a non-conformant provider×model pair. Redaction-safe. */
export function nonconformantHealthItem(route: ProviderRoute, job: AgentJob): BrokerHealthItem {
  return {
    healthClass: PROVIDER_NONCONFORMANT_HEALTH_CLASS,
    message: `provider×capability×model pair is non-conformant; only a conformance-passing pair is eligible (§7)`,
    refs: availabilityRefs(route, job),
  };
}

function availabilityDeny(
  route: ProviderRoute,
  job: AgentJob,
  healthClass: string,
  message: string,
): GateDeny {
  const audit = buildAuditSignal({
    actor: AVAIL_ACTOR,
    event: "broker.model_availability.ineligible",
    refs: availabilityRefs(route, job),
    payloadHash: AVAIL_MARKER,
    beforeSummary: "provider_selected pending model availability",
    afterSummary: message,
    healthSignalClass: healthClass,
  });
  return {
    reason: "provider_unavailable",
    message,
    audit,
    branch: "failed_retryable",
    retryable: AVAILABILITY_DEGRADED_RETRYABLE,
  };
}

/**
 * Gate a route on pinned-model availability + conformance eligibility. Order:
 * conformance (matrix-pair enablement) FIRST — a non-conformant pair is skipped
 * regardless of model presence — then pinned-model presence (no substitute).
 * Fails closed on a malformed probe. Pure; never throws.
 */
export function checkModelAvailability(
  route: ProviderRoute,
  job: AgentJob,
  probe: ModelAvailabilityProbe,
): GateResult<void> {
  // Fail closed on a missing / malformed probe — never proceed on unknown input.
  if (
    probe == null ||
    typeof probe !== "object" ||
    typeof probe.modelPresent !== "boolean" ||
    typeof probe.conformanceStatus !== "string"
  ) {
    return err(
      availabilityDeny(
        route,
        job,
        PROVIDER_NONCONFORMANT_HEALTH_CLASS,
        "model-availability probe is missing or malformed; route held ineligible (fail closed)",
      ),
    );
  }

  // 1. Conformance eligibility — only a `passing` pair routes (§7 conformance-is-the-contract).
  if (probe.conformanceStatus !== "passing") {
    return err(
      availabilityDeny(
        route,
        job,
        PROVIDER_NONCONFORMANT_HEALTH_CLASS,
        `provider×capability×model pair is "${probe.conformanceStatus}" (not conformance-passing); route held ineligible and skipped (§7)`,
      ),
    );
  }

  // 2. Pinned-model presence — absent ⇒ ineligible, NEVER a substitute-model fallback.
  if (!probe.modelPresent) {
    return err(
      availabilityDeny(
        route,
        job,
        MODEL_UNAVAILABLE_HEALTH_CLASS,
        `pinned model "${route.model}" is absent at the configured endpoint; route held ineligible (typed failure — no substitute-model fallback)`,
      ),
    );
  }

  const audit = buildAuditSignal({
    actor: AVAIL_ACTOR,
    event: "broker.model_availability.eligible",
    refs: availabilityRefs(route, job),
    payloadHash: AVAIL_MARKER,
    beforeSummary: "provider_selected pending model availability",
    afterSummary: "pinned model present and conformance-passing",
  });
  return ok({ value: undefined, audit });
}
