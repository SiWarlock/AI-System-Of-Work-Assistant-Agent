// §5 Provider-matrix route resolution (REQ-S-005). DETERMINISTIC, allowlist-bound
// resolution SOLELY from `capabilityDefaults[capability]`. There is NO health /
// availability / budget check here — those are the §7 broker, applied AFTER
// resolution + the §5 egress veto (3.4); this module answers only "which route
// does policy PERMIT for this capability", and does so as a pure function of
// (matrix, capability).
//
// PURE — no clock, network, or randomness. Every outcome is a typed
// `PolicyDecision`, never a thrown error (§16). FAIL-CLOSED: a missing capability
// mapping, a route naming a non-allowlisted provider, or a local route on an
// unconfigured endpoint each resolve to a DENY — never an implicit/global
// fallback route (absence = deny). REDACTION-SAFE: audit signals carry
// refs / codes only (workspace id, capability id, endpoint, egressClass) — never
// raw content, prompts, credentials, or tokens.
import type {
  Capability,
  ProviderId,
  ProviderMatrix,
  ProviderRoute,
} from "@sow/contracts";
import {
  allowDecision,
  denyDecision,
  type PolicyDecision,
} from "./decision";
import { buildAuditSignal, type AuditSignal } from "./audit-signal";
import { endpointHostRef } from "./processors";

const ROUTE_ACTOR = "policy:provider-matrix" as const;

// A payloadHash-shaped decision-kind marker (policy is pure — no hasher outside
// session-auth). Redaction-safe: a fixed constant; the routing identity rides the
// refs. Mirrors the `visibility.ts` VISIBILITY_PAYLOAD_MARKER convention.
const ROUTE_PAYLOAD_MARKER = "policy:provider-route-decision" as const;

/**
 * Explicit local-provider configuration: the set of endpoints an operator has
 * declared as legitimate LOCAL (zero-egress) provider targets. A route with
 * `egressClass === 'local'` is only honored when — if this config is supplied —
 * its endpoint appears here. Pins the §5 rule "local endpoints only through
 * explicit local-provider config". Exported so 3.4 (the egress veto) reuses the
 * exact shape.
 */
export interface LocalProviderConfig {
  readonly allowedLocalEndpoints: readonly string[];
}

/**
 * Provider-branch → its closed-enum ProviderId; runtime-branch → null. The
 * ProviderRoute union is discriminated by which port-key is present
 * (`provider` xor `runtime`); a runtime route carries no provider. Pure.
 */
export function routeProvider(route: ProviderRoute): ProviderId | null {
  return "provider" in route ? route.provider : null;
}

/**
 * Resolve the permitted `ProviderRoute` for a capability from a ProviderMatrix.
 *
 * Resolution is SOLELY `capabilityDefaults[capability]` — deterministic (same
 * (matrix, capability) → same route) and with NO implicit/global fallback.
 * Denials (all fail-closed, never fail-open):
 *  - malformed matrix (null / missing capabilityDefaults) ⇒ MALFORMED_POLICY_INPUT.
 *  - capability absent from capabilityDefaults ⇒ NO_ROUTE_FOR_CAPABILITY.
 *  - a PROVIDER-branch route whose provider ∉ allowedProviders ⇒
 *    PROVIDER_NOT_ALLOWED (defense-in-depth; the ProviderMatrix `.refine` also pins this).
 *  - a route with egressClass==='local' whose endpoint is NOT listed in a
 *    supplied `localConfig` ⇒ LOCAL_ENDPOINT_NOT_CONFIGURED.
 *
 * On ALLOW the resolved route's `egressClass` + `endpoint` are surfaced (both on
 * the returned route value and in the audit refs) for the downstream egress veto
 * (3.4). Pure; never throws.
 */
export function resolveRoute(
  matrix: ProviderMatrix,
  capability: Capability,
  localConfig?: LocalProviderConfig,
): PolicyDecision<ProviderRoute> {
  const capRef = `ref:capability:${typeof capability === "string" ? capability : "MISSING"}`;

  const deny = (
    reason:
      | "MALFORMED_POLICY_INPUT"
      | "NO_ROUTE_FOR_CAPABILITY"
      | "PROVIDER_NOT_ALLOWED"
      | "LOCAL_ENDPOINT_NOT_CONFIGURED",
    message: string,
    refs: readonly string[],
  ): PolicyDecision<ProviderRoute> =>
    denyDecision(
      reason,
      message,
      buildAuditSignal({
        actor: ROUTE_ACTOR,
        event: "provider.route.denied",
        refs,
        payloadHash: ROUTE_PAYLOAD_MARKER,
        beforeSummary: "provider route unresolved",
        afterSummary: message,
        denialCode: reason,
      }),
    );

  // Fail-closed guard: a null/undefined matrix or a missing capabilityDefaults map
  // is malformed input, not an empty route table.
  if (
    matrix == null ||
    typeof matrix !== "object" ||
    matrix.capabilityDefaults == null ||
    typeof matrix.capabilityDefaults !== "object"
  ) {
    return deny(
      "MALFORMED_POLICY_INPUT",
      "provider matrix is missing or has no capabilityDefaults map",
      ["ref:workspace:MISSING", capRef],
    );
  }

  const wsRef = `ref:workspace:${matrix.workspaceId}`;
  const baseRefs: readonly string[] = [wsRef, capRef];

  // Sole resolution source — no implicit/global fallback. Absence ⇒ deny.
  // `Object.hasOwn` (not `[capability] !== undefined`): capabilityDefaults is a
  // plain object, so a prototype-member capability name ('constructor',
  // '__proto__', 'toString', 'valueOf', 'hasOwnProperty') would otherwise read an
  // INHERITED member and fail OPEN with a garbage route. An OWN-property check
  // keeps "absence = deny". Capability is an open string, so these are all
  // schema-valid inputs.
  const hasOwnRoute =
    typeof capability === "string" && Object.hasOwn(matrix.capabilityDefaults, capability);
  const route: ProviderRoute | undefined = hasOwnRoute
    ? matrix.capabilityDefaults[capability]
    : undefined;
  if (route === undefined || typeof route !== "object") {
    return deny(
      "NO_ROUTE_FOR_CAPABILITY",
      "no route configured for this capability (no implicit fallback)",
      baseRefs,
    );
  }

  const routeRefs: readonly string[] = [
    ...baseRefs,
    // Host only — a `user:pass@host` endpoint must not leak its credential here.
    endpointHostRef(route.endpoint),
    `ref:egress-class:${route.egressClass}`,
  ];

  // Defense-in-depth: a provider-branch route must name an allowlisted provider
  // (the ProviderMatrix `.refine` pins this upstream; re-checked here so a
  // hand-built matrix can never route to a denied provider).
  const provider = routeProvider(route);
  if (provider !== null) {
    const allowed = new Set<ProviderId>(
      Array.isArray(matrix.allowedProviders) ? matrix.allowedProviders : [],
    );
    if (!allowed.has(provider)) {
      return deny(
        "PROVIDER_NOT_ALLOWED",
        "resolved route names a provider outside allowedProviders",
        routeRefs,
      );
    }
  }

  // Local endpoints only through explicit local-provider config: when the route
  // is local AND a config is supplied, the endpoint must be listed.
  if (route.egressClass === "local" && localConfig !== undefined) {
    if (!localConfig.allowedLocalEndpoints.includes(route.endpoint)) {
      return deny(
        "LOCAL_ENDPOINT_NOT_CONFIGURED",
        "local route endpoint is not in the explicit local-provider config",
        routeRefs,
      );
    }
  }

  const audit: AuditSignal = buildAuditSignal({
    actor: ROUTE_ACTOR,
    event: "provider.route.resolved",
    refs: routeRefs,
    payloadHash: ROUTE_PAYLOAD_MARKER,
    beforeSummary: "provider route unresolved",
    afterSummary: "route resolved from capabilityDefaults",
  });
  return allowDecision(route, audit);
}
