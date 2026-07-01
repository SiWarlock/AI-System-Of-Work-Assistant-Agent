// @sow/providers — cost meter for COST-1 budget accounting (§7 task 5.4).
//
// A PURE, deterministic meter over a job's provider calls. It answers ONE
// question the budget enforcer (5.4) asks: how much did this run cost so far?
// A provider-reported `costUsd` is authoritative; otherwise the cost is
// ESTIMATED from token counts × config-sourced token pricing (OQ-003); if
// neither is available the cost is UNMEASURED (contributes 0 and flips the
// running meter's `costFullyMeasured` flag) so the enforcer can fall back on the
// always-present runtime cap rather than enforce a cost it cannot see.
//
// No clock, no I/O, no hardcoded prices — pricing is injected by the caller from
// `config/providers.defaults.json`. Immutable: `accrue` returns a NEW meter.
import type { AgentUsage } from "../ports/agent-result";

/** Token pricing for one provider/model, in USD per 1,000,000 tokens (config-sourced, OQ-003). */
export interface TokenPricing {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

/** The metered cost of one usage sample + whether it was measurable at all. */
export interface CostSample {
  readonly costUsd: number;
  /** False iff neither a reported cost nor an estimable token/pricing pair was present. */
  readonly measured: boolean;
}

const TOKENS_PER_MILLION = 1_000_000;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Meter one usage sample into a cost. Reported `costUsd` wins (authoritative);
 * otherwise estimate from whichever token counts are present × `pricing`; if
 * neither path applies the sample is UNMEASURED (`{ costUsd: 0, measured: false }`).
 * Pure.
 */
export function meterUsageCost(usage: AgentUsage, pricing?: TokenPricing): CostSample {
  if (isFiniteNumber(usage.costUsd)) {
    return { costUsd: usage.costUsd, measured: true };
  }
  const hasTokens = isFiniteNumber(usage.inputTokens) || isFiniteNumber(usage.outputTokens);
  if (pricing !== undefined && hasTokens) {
    const inTok = isFiniteNumber(usage.inputTokens) ? usage.inputTokens : 0;
    const outTok = isFiniteNumber(usage.outputTokens) ? usage.outputTokens : 0;
    const costUsd =
      (inTok / TOKENS_PER_MILLION) * pricing.inputUsdPerMillion +
      (outTok / TOKENS_PER_MILLION) * pricing.outputUsdPerMillion;
    return { costUsd, measured: true };
  }
  return { costUsd: 0, measured: false };
}

/** Running totals accumulated over a job's provider calls. */
export interface CostTotals {
  readonly runtimeSeconds: number;
  readonly costUsd: number;
  /** True iff EVERY accrued sample was measurable (a single unmeasured sample flips it false). */
  readonly costFullyMeasured: boolean;
}

/**
 * An IMMUTABLE running cost meter. `accrue` folds one more provider call's usage
 * in and returns a FRESH meter — the receiver is never mutated, so re-driving
 * from an earlier meter is deterministic (replay-safe).
 */
export interface CostMeter {
  readonly totals: CostTotals;
  accrue(usage: AgentUsage, pricing?: TokenPricing): CostMeter;
}

function meterFrom(totals: CostTotals): CostMeter {
  return {
    totals,
    accrue(usage: AgentUsage, pricing?: TokenPricing): CostMeter {
      const sample = meterUsageCost(usage, pricing);
      const runtime = isFiniteNumber(usage.runtimeSeconds) ? usage.runtimeSeconds : 0;
      return meterFrom({
        runtimeSeconds: totals.runtimeSeconds + runtime,
        costUsd: totals.costUsd + sample.costUsd,
        costFullyMeasured: totals.costFullyMeasured && sample.measured,
      });
    },
  };
}

/** A zeroed, fully-measured meter — the starting point before any provider call. Pure. */
export function newCostMeter(): CostMeter {
  return meterFrom({ runtimeSeconds: 0, costUsd: 0, costFullyMeasured: true });
}
