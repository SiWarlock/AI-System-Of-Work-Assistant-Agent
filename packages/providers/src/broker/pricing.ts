// @sow/providers — conservative provider-axis pricing PROJECTION (CP-5 / 18.15a, §7 COST-1 / §19.5).
//
// Activates the COST-1 dollar cap. `pricingFor` keys by PROVIDER
// (`config.pricing[job.providerRoute.provider]`) while real pricing is PER-MODEL — so a single
// provider entry must cover WHATEVER model a route resolves to. This module owns ONLY the pure
// PROJECTION LOGIC (a per-model table → one conservative provider rate). The pricing DATA lives in
// the owner config (`config/providers.defaults.json costEstimation.pricing`, OQ-003 — "pricing is
// injected by the caller, never hardcoded here"); 18.15b reads that per-model Claude table, projects
// it here, and threads the result into `BudgetEnforcerConfig.pricing`. Keeping the DATA in the single
// config source (not a duplicate TS constant) is what stops the two drifting stale — the failure
// that hid a 2× opus-4-8 under-count in a skill-cache snapshot ($5/$25 vs the live $10/$50).
import type { TokenPricing } from "./cost-meter";

/**
 * Project a PER-MODEL pricing table to the single conservative provider-axis rate `pricingFor`
 * consumes: the ELEMENT-WISE MAX (input, output). Conservative-higher so the cap NEVER
 * UNDER-counts — a deny-only cap that only reduces spend, so over-denying a cheaper model is the
 * SAFE direction; under-counting a pricier one would let real spend exceed the cap undetected.
 *
 * FAILS CLOSED on ANY malformed table rather than emitting an unsafe rate: an EMPTY table
 * (`Math.max()` over nothing is `-Infinity`, a never-breaching rate) throws; a NON-FINITE
 * (`NaN`/`±Infinity`) or NEGATIVE rate throws too — a `NaN` rate makes every `costUsd > cap`
 * compare false (a silent fail-OPEN cap defeat) and a negative rate under-counts. So the helper
 * NEVER produces a rate that could defeat the cost cap. Pure; throws only on a composition
 * misconfiguration. (18.15b decides whether an empty/absent CONFIG table guards to
 * undefined-pricing — the gate then degrades to the runtime-only backstop — or is a fail-fast
 * boot error.)
 */
function isSafeRate(n: number): boolean {
  // finite + non-negative — $0 is valid (local/free models); NaN / ±Infinity / negative are not.
  return Number.isFinite(n) && n >= 0;
}

export function conservativeProviderPricing(
  perModel: Readonly<Record<string, TokenPricing>>,
): TokenPricing {
  const models = Object.values(perModel);
  if (models.length === 0) {
    throw new Error(
      "conservativeProviderPricing: empty per-model pricing table (would defeat the cost cap)",
    );
  }
  for (const p of models) {
    if (!isSafeRate(p.inputUsdPerMillion) || !isSafeRate(p.outputUsdPerMillion)) {
      throw new Error(
        "conservativeProviderPricing: non-finite or negative rate (would fail the cost cap open)",
      );
    }
  }
  return {
    inputUsdPerMillion: Math.max(...models.map((p) => p.inputUsdPerMillion)),
    outputUsdPerMillion: Math.max(...models.map((p) => p.outputUsdPerMillion)),
  };
}
