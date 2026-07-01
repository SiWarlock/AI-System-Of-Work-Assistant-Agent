// spec(§7) — running cost meter over a job's provider calls (COST-1): reported
// cost wins; else estimate from tokens × pricing; else unmeasured. Immutable
// accumulation across calls.
import { describe, it, expect } from "vitest";
import {
  meterUsageCost,
  newCostMeter,
  type TokenPricing,
  type CostSample,
} from "../src/broker/cost-meter";
import type { AgentUsage } from "../src/ports/agent-result";

const PRICING: TokenPricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

describe("meterUsageCost", () => {
  it("prefers a provider-reported costUsd and marks it measured", () => {
    const usage: AgentUsage = { runtimeSeconds: 2, costUsd: 0.42, inputTokens: 100, outputTokens: 50 };
    const s: CostSample = meterUsageCost(usage, PRICING);
    expect(s).toEqual({ costUsd: 0.42, measured: true });
  });

  it("estimates from tokens × pricing when costUsd is absent", () => {
    const usage: AgentUsage = { runtimeSeconds: 2, inputTokens: 1_000_000, outputTokens: 2_000_000 };
    const s = meterUsageCost(usage, PRICING);
    // 1M input × $3/M + 2M output × $15/M = 3 + 30 = 33
    expect(s.measured).toBe(true);
    expect(s.costUsd).toBeCloseTo(33, 6);
  });

  it("treats missing token counts as zero when estimating", () => {
    const usage: AgentUsage = { runtimeSeconds: 1, inputTokens: 500_000 };
    const s = meterUsageCost(usage, PRICING);
    expect(s.costUsd).toBeCloseTo(1.5, 6); // 0.5M × $3/M, output tokens 0
    expect(s.measured).toBe(true);
  });

  it("is UNMEASURED when neither reported cost nor pricing is available", () => {
    const usage: AgentUsage = { runtimeSeconds: 5, inputTokens: 999, outputTokens: 999 };
    expect(meterUsageCost(usage)).toEqual({ costUsd: 0, measured: false });
  });

  it("is UNMEASURED when pricing exists but the provider reported no tokens", () => {
    const usage: AgentUsage = { runtimeSeconds: 5 };
    expect(meterUsageCost(usage, PRICING)).toEqual({ costUsd: 0, measured: false });
  });
});

describe("CostMeter (running accumulation)", () => {
  it("starts zeroed and fully measured", () => {
    expect(newCostMeter().totals).toEqual({ runtimeSeconds: 0, costUsd: 0, costFullyMeasured: true });
  });

  it("accumulates runtime + cost across successive provider calls", () => {
    const m = newCostMeter()
      .accrue({ runtimeSeconds: 2, costUsd: 0.1 })
      .accrue({ runtimeSeconds: 3, costUsd: 0.25 });
    expect(m.totals.runtimeSeconds).toBe(5);
    expect(m.totals.costUsd).toBeCloseTo(0.35, 6);
    expect(m.totals.costFullyMeasured).toBe(true);
  });

  it("estimates per-call cost from pricing during accrual", () => {
    const m = newCostMeter().accrue({ runtimeSeconds: 1, inputTokens: 1_000_000 }, PRICING);
    expect(m.totals.costUsd).toBeCloseTo(3, 6);
  });

  it("is IMMUTABLE — accrue returns a new meter and never mutates the receiver", () => {
    const base = newCostMeter();
    const next = base.accrue({ runtimeSeconds: 4, costUsd: 1 });
    expect(base.totals).toEqual({ runtimeSeconds: 0, costUsd: 0, costFullyMeasured: true });
    expect(next.totals.runtimeSeconds).toBe(4);
  });

  it("flips costFullyMeasured to false once any sample is unmeasurable", () => {
    const m = newCostMeter()
      .accrue({ runtimeSeconds: 1, costUsd: 0.1 })
      .accrue({ runtimeSeconds: 1 }); // no cost, no pricing → unmeasured
    expect(m.totals.runtimeSeconds).toBe(2);
    expect(m.totals.costUsd).toBeCloseTo(0.1, 6);
    expect(m.totals.costFullyMeasured).toBe(false);
  });
});
