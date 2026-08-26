// §5/§7 task 9.32 — the MISSING ProviderMatrix producer. `defaultWorkspace()`
// seeds an EMPTY matrix and no production path ever writes a non-empty one, so
// `isZeroEgressOnlyWorkspace` (processors.ts) is permanently unsatisfiable and
// `resolveRoute` (provider-matrix.ts) has nothing to resolve. This module is the
// missing WRITER those two already-shipped consumers were built to feed.
//
// ⭐⭐ OWNER RULING 2026-07-29 (read before touching this file): an EMPTY
// providerMatrix is a CORRECT state, never a defect to "fix" with a seeded
// default. This producer NEVER fabricates a route — it only ever admits a
// candidate a real conformance check PASSED, and it is fine, expected, and safe
// for it to return the empty matrix when nothing has been certified yet.
//
// ⛔ ARMING BOUNDARY: certifying a candidate for real means calling the actual
// provider/runtime over the network (an AgentRuntimePort/ModelProviderPort
// conformance probe) — that network call is an ARMING crossing (root CLAUDE.md
// "NOTHING ARMS") and does not belong in `packages/policy`, which is pure (no
// clock, no network, no randomness). So certification is an INJECTED port
// (`ProviderConformanceCertifier`); this module never implements one, and no
// real implementation is bound anywhere in this package. Binding a real
// certifier (and deciding which candidates a workspace is even OFFERED — the
// settings-surface / detection-probe / ProvisioningProfile-extension question
// task 9.32 leaves explicitly open) is a separate, later, cross-package task.
import type {
  Capability,
  ConformanceResult,
  ProviderId,
  ProviderMatrix,
  ProviderRoute,
  WorkspaceId,
} from "@sow/contracts";

/**
 * One candidate route this producer may admit into the matrix for a capability.
 * WHICH candidates a workspace is offered is a product decision this task
 * deliberately leaves open (task 9.32's three open shapes) — this module only
 * answers "given candidates + their conformance verdicts, what matrix results".
 */
export interface ProviderMatrixCandidate {
  readonly capability: Capability;
  readonly route: ProviderRoute;
}

/**
 * The injected certifier — the ARMING-GATED seam. A genuine implementation
 * calls the real provider/runtime to certify it; that is impure and network-
 * bearing, so it is injected rather than performed here. Async because a real
 * certifier is necessarily a network call; a fake/synchronous verdict wrapped
 * in `Promise.resolve` is what every test in this package uses.
 */
export type ProviderConformanceCertifier = (
  candidate: ProviderMatrixCandidate,
) => Promise<ConformanceResult>;

export interface BuildProviderMatrixOptions {
  /**
   * Whether raw cloud egress is enabled for this workspace. NEVER defaulted to
   * `true` — a producer inferring consent from "a cloud route happened to
   * certify" would manufacture exactly the false assurance root CLAUDE.md rule
   * 5 and contracts L56 exist to prevent. Absent ⇒ `false` (fail-closed); the
   * real governing value is a workspace-level decision this module does not own.
   */
  readonly rawCloudEgressEnabled?: boolean;
  readonly localProviderPreference?: ProviderId;
}

/**
 * Does `result` actually certify `candidate` — the same subject, capability,
 * model, and egress class the caller asked about? (contracts L55/L119: a
 * per-request verdict must be checked against what was REQUESTED, not merely
 * trusted because a value came back.) An injected certifier that returns a
 * PASSING verdict for the wrong subject/capability/route must not silently
 * certify a DIFFERENT candidate — that would let a buggy or adversarial
 * certifier admit a route it never actually evaluated. Pure; never throws.
 */
function certifiesCandidate(
  result: ConformanceResult,
  candidate: ProviderMatrixCandidate,
): boolean {
  if (result == null || typeof result !== "object") return false;
  if (result.capability !== candidate.capability) return false;
  if (result.model !== candidate.route.model) return false;
  if (result.egressClass !== candidate.route.egressClass) return false;
  if ("provider" in candidate.route) {
    return result.subjectKind === "provider" && result.subjectId === candidate.route.provider;
  }
  return result.subjectKind === "runtime" && result.subjectId === candidate.route.runtime;
}

/**
 * Build a `ProviderMatrix` from a candidate set + an injected certifier.
 *
 * Admission (fail-closed on every branch):
 *  - the certifier is called for EVERY candidate; a throw is caught and folds
 *    to "not certified" for that candidate alone (§16 never-throw — one bad
 *    candidate does not fail the whole build);
 *  - a result that does not `certifiesCandidate` (wrong subject/capability/
 *    model/egressClass) is treated as not certifying — never admitted;
 *  - only `status === "passing"` is admitted (failing/disabled/unknown are
 *    EXCLUDED — mirrors `packages/evals`' `matrixEligibility`; a matrix entry
 *    nothing actually certified is exactly the phantom-allow-list-entry defect
 *    the Copilot tool catalog's gate-(d) cleanup pruned);
 *  - PER CAPABILITY, the FIRST passing candidate (in input order) becomes
 *    `capabilityDefaults[capability]` — a capability with no passing candidate
 *    gets NO entry (absence = deny, matching `resolveRoute`'s no-fallback rule);
 *  - EVERY passing provider-branch candidate's provider joins `allowedProviders`
 *    (deduped), even when a different candidate already won that capability's
 *    default — allow-listing and default-routing are independent; a
 *    runtime-branch candidate never contributes to `allowedProviders` (the
 *    ProviderMatrix allowlist is providers-only, Appendix A).
 *
 * `rawCloudEgressEnabled` and `localProviderPreference` are caller-supplied
 * (never derived from which routes happened to certify) and both default to
 * the fail-closed / absent value.
 *
 * The result always satisfies `ProviderMatrixSchema`, including its
 * every-provider-route-∈-allowedProviders refine: every route this function
 * places into `capabilityDefaults` was certified in the SAME loop iteration
 * that added its provider to `allowedProviders`, so the invariant holds by
 * construction, not by a second pass.
 *
 * Deterministic given a deterministic certifier; never throws; does not
 * mutate `candidates`.
 */
export async function buildProviderMatrix(
  workspaceId: WorkspaceId,
  candidates: readonly ProviderMatrixCandidate[],
  certify: ProviderConformanceCertifier,
  options: BuildProviderMatrixOptions = {},
): Promise<ProviderMatrix> {
  const allowedProviders = new Set<ProviderId>();
  const capabilityDefaults: Partial<Record<Capability, ProviderRoute>> = {};

  for (const candidate of candidates) {
    let result: ConformanceResult | undefined;
    try {
      result = await certify(candidate);
    } catch {
      result = undefined; // fail-closed: a throwing certifier certifies nothing
    }
    if (result === undefined) continue;
    if (!certifiesCandidate(result, candidate)) continue;
    if (result.status !== "passing") continue;

    if ("provider" in candidate.route) {
      allowedProviders.add(candidate.route.provider);
    }
    if (!Object.hasOwn(capabilityDefaults, candidate.capability)) {
      capabilityDefaults[candidate.capability] = candidate.route;
    }
  }

  return {
    workspaceId,
    allowedProviders: [...allowedProviders],
    capabilityDefaults,
    rawCloudEgressEnabled: options.rawCloudEgressEnabled ?? false,
    ...(options.localProviderPreference !== undefined
      ? { localProviderPreference: options.localProviderPreference }
      : {}),
  };
}
