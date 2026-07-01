// @sow/providers — provider health / model-availability gate + degraded modes (§7 task 5.9).
//
// The broker's fourth gate, applied AFTER the egress veto and BEFORE budget caps
// (fixed order — ./broker). It answers "is the selected route's provider usable
// right now?" and, if so, folds in the pinned-model availability check
// (./model-availability). An unhealthy or secret-unavailable provider is
// INELIGIBLE for the route:
//
//   - unreachable        → degraded; distinct System Health item (OBS-2, bullet 2)
//   - keychain_locked /  → secret unavailable; the SecretsPort/Keychain degraded
//     keychain_denied      mode (LIFE-6, §16 / bullet 3) — re-attempted on unlock
//
// Every degraded outcome is a TYPED deny with branch `failed_retryable`,
// `retryable: true` — dependent jobs are HELD retryable, NEVER silently dropped,
// and NEVER a silent fallback to an off-matrix provider/endpoint. The
// health/availability signals come from DEPENDENCY-INJECTED sources; this module
// does NO network I/O — real reachability/Keychain probing lives behind the source
// in an adapter (5.7/5.8). PURE + deterministic; never throws (§16). AuditSignals
// + health items are REDACTION-SAFE (ids / classes only).
import { ok, err, isErr } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ConformanceStatus } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import type { GateDeny, GateResult, BrokerHealthItem, HealthGate } from "./broker";
import {
  checkModelAvailability,
  modelUnavailableHealthItem,
  nonconformantHealthItem,
  AVAILABILITY_DEGRADED_RETRYABLE,
  type ModelAvailabilitySource,
} from "./model-availability";

// arch_gap: the frozen `FailureClass` enum has no provider-health member. As with
// the broker's `NO_ELIGIBLE_PROVIDER_HEALTH_CLASS` and policy's
// `POLICY_DENIAL_HEALTH_CLASS`, the OBS-2 classes are named module constants (not
// new members on a frozen contract). Flagged in the task manifest.
/** OBS-2 System Health class: the provider endpoint is unreachable. */
export const PROVIDER_UNREACHABLE_HEALTH_CLASS = "provider_unreachable" as const;
/** OBS-2 System Health class: the provider's secret is unavailable (Keychain locked/denied). */
export const PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS = "provider_secret_unavailable" as const;

const HEALTH_ACTOR = "broker:provider-health" as const;
const HEALTH_MARKER = "broker:provider-health-decision" as const;

/**
 * The injected provider-health state. `healthy` proceeds; `unreachable` is a
 * reachability fault; `keychain_locked` / `keychain_denied` are the SecretsPort
 * degraded modes (LIFE-6). A value outside this set is treated as malformed and
 * fails closed.
 */
export const ProviderHealthState = [
  "healthy",
  "unreachable",
  "keychain_locked",
  "keychain_denied",
] as const;
export type ProviderHealthState = (typeof ProviderHealthState)[number];

const HEALTH_STATE_SET: ReadonlySet<string> = new Set<string>(ProviderHealthState);

/** The injected health probe for a route's provider/runtime target. */
export interface ProviderHealthProbe {
  readonly state: ProviderHealthState;
}

/** The injected provider-health source (real reachability/Keychain probing behind it). */
export type ProviderHealthSource = (route: ProviderRoute, job: AgentJob) => ProviderHealthProbe;

/** The two injected sources the composed 5.9 gate reads. */
export interface HealthGateSources {
  readonly health: ProviderHealthSource;
  readonly availability: ModelAvailabilitySource;
}

/** Redaction-safe, id-only refs (never the endpoint URL). */
function healthRefs(route: ProviderRoute, job: AgentJob): readonly string[] {
  return [
    `ref:job:${job.id}`,
    `ref:workspace:${job.workspaceId}`,
    `ref:capability:${String(job.capability)}`,
    "provider" in route ? `ref:provider:${route.provider}` : `ref:runtime:${route.runtime}`,
  ];
}

/** A distinct OBS-2 health item for an unreachable provider. Redaction-safe. */
export function providerUnreachableHealthItem(route: ProviderRoute, job: AgentJob): BrokerHealthItem {
  return {
    healthClass: PROVIDER_UNREACHABLE_HEALTH_CLASS,
    message: `provider endpoint unreachable; route held ineligible and retryable (no off-matrix fallback)`,
    refs: healthRefs(route, job),
  };
}

/** A distinct OBS-2 health item for a Keychain-locked/denied provider (LIFE-6). Redaction-safe. */
export function providerSecretHealthItem(
  route: ProviderRoute,
  job: AgentJob,
  state: "keychain_locked" | "keychain_denied",
): BrokerHealthItem {
  return {
    healthClass: PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS,
    message: `provider authentication material unavailable (${state}); provider degraded, dependent jobs held retryable, re-attempted on unlock (LIFE-6)`,
    refs: healthRefs(route, job),
  };
}

function healthDeny(
  route: ProviderRoute,
  job: AgentJob,
  healthClass: string,
  event: string,
  message: string,
): GateDeny {
  const audit = buildAuditSignal({
    actor: HEALTH_ACTOR,
    event,
    refs: healthRefs(route, job),
    payloadHash: HEALTH_MARKER,
    beforeSummary: "provider_selected pending health check",
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
 * Gate the route on provider health alone. `healthy` proceeds; `unreachable`,
 * `keychain_locked`, `keychain_denied`, and any unrecognized state deny (fail
 * closed) with a typed, retryable, health-classed outcome. Pure; never throws.
 */
export function checkProviderHealth(
  route: ProviderRoute,
  job: AgentJob,
  probe: ProviderHealthProbe,
): GateResult<void> {
  const state: unknown = probe == null ? undefined : probe.state;

  if (state === "healthy") {
    const audit = buildAuditSignal({
      actor: HEALTH_ACTOR,
      event: "broker.provider_health.healthy",
      refs: healthRefs(route, job),
      payloadHash: HEALTH_MARKER,
      beforeSummary: "provider_selected pending health check",
      afterSummary: "provider healthy",
    });
    return ok({ value: undefined, audit });
  }

  if (state === "unreachable") {
    return err(
      healthDeny(
        route,
        job,
        PROVIDER_UNREACHABLE_HEALTH_CLASS,
        "broker.provider_health.unreachable",
        "provider endpoint unreachable; route held ineligible and retryable (never a silent off-matrix fallback)",
      ),
    );
  }

  if (state === "keychain_locked" || state === "keychain_denied") {
    return err(
      healthDeny(
        route,
        job,
        PROVIDER_SECRET_UNAVAILABLE_HEALTH_CLASS,
        "broker.provider_health.secret_unavailable",
        `provider authentication material unavailable (${state}); provider degraded, job held retryable, re-attempted on unlock (LIFE-6)`,
      ),
    );
  }

  // Unrecognized / malformed state — fail closed.
  return err(
    healthDeny(
      route,
      job,
      PROVIDER_UNREACHABLE_HEALTH_CLASS,
      "broker.provider_health.malformed",
      "provider health state is unrecognized or malformed; route held ineligible (fail closed)",
    ),
  );
}

/**
 * Build the broker's injected 5.9 `HealthGate` over the two sources. Order:
 * provider health FIRST (a dead/secret-locked provider short-circuits before the
 * availability source is even consulted) → then pinned-model availability +
 * conformance eligibility. Any deny is returned verbatim (the broker maps it to a
 * fail-closed no-eligible-provider outcome; never a fallback). Pure factory.
 */
export function createHealthGate(sources: HealthGateSources): HealthGate {
  return (route: ProviderRoute, job: AgentJob): GateResult<void> => {
    const health = checkProviderHealth(route, job, sources.health(route, job));
    if (isErr(health)) return health;

    const availability = checkModelAvailability(route, job, sources.availability(route, job));
    if (isErr(availability)) return availability;

    const audit = buildAuditSignal({
      actor: HEALTH_ACTOR,
      event: "broker.provider_health.eligible",
      refs: healthRefs(route, job),
      payloadHash: HEALTH_MARKER,
      beforeSummary: "provider_selected pending health + availability",
      afterSummary: "provider healthy, pinned model present and conformance-passing",
    });
    return ok({ value: undefined, audit });
  };
}

/**
 * A non-Result eligibility VIEW for the conformance/eligibility layer (5.10) and
 * the System Health read models (bullet 5). Same decision as `createHealthGate`,
 * but exposed as a structured status (with the distinct health item on the first
 * ineligible dimension) rather than a gate outcome. Pure.
 */
export interface ProviderEligibilityStatus {
  readonly eligible: boolean;
  readonly healthState: ProviderHealthState | "unknown";
  readonly modelAvailable: boolean;
  readonly conformanceStatus: ConformanceStatus | "unknown";
  /** Present iff ineligible — the distinct OBS-2 item for the failing dimension. */
  readonly healthItem?: BrokerHealthItem;
}

export function evaluateEligibility(
  route: ProviderRoute,
  job: AgentJob,
  sources: HealthGateSources,
): ProviderEligibilityStatus {
  const healthProbe = sources.health(route, job);
  const healthState: ProviderHealthState | "unknown" = HEALTH_STATE_SET.has(
    healthProbe?.state as string,
  )
    ? healthProbe.state
    : "unknown";

  // Provider-health dimension first.
  if (healthState !== "healthy") {
    const healthItem =
      healthState === "keychain_locked" || healthState === "keychain_denied"
        ? providerSecretHealthItem(route, job, healthState)
        : providerUnreachableHealthItem(route, job);
    return {
      eligible: false,
      healthState,
      modelAvailable: false,
      conformanceStatus: "unknown",
      healthItem,
    };
  }

  const availProbe = sources.availability(route, job);
  const conformanceStatus: ConformanceStatus | "unknown" =
    availProbe == null || typeof availProbe.conformanceStatus !== "string"
      ? "unknown"
      : availProbe.conformanceStatus;
  const modelAvailable = availProbe?.modelPresent === true;

  if (conformanceStatus !== "passing") {
    return {
      eligible: false,
      healthState,
      modelAvailable,
      conformanceStatus,
      healthItem: nonconformantHealthItem(route, job),
    };
  }
  if (!modelAvailable) {
    return {
      eligible: false,
      healthState,
      modelAvailable,
      conformanceStatus,
      healthItem: modelUnavailableHealthItem(route, job),
    };
  }

  return { eligible: true, healthState, modelAvailable, conformanceStatus };
}
