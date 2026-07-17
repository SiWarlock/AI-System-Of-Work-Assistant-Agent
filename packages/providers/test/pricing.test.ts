// spec(§7)/spec(§19.5) — CP-5 (18.15a): the pure conservative provider-axis pricing
// PROJECTION that activates the dead COST-1 dollar cap. The breach machinery (18.2) already
// exists (detectBudgetBreach meters usage×pricing, denies when costUsd > maxCostUsd); the gap
// was that `pricingFor` keys by PROVIDER while real pricing is PER-MODEL. This slice owns the
// projection LOGIC (per-model table → one conservative provider rate) — fixture-tested. The
// pricing DATA + config wiring + the maxCostUsd default live in the owner config (18.15b),
// per OQ-003 ("pricing is injected from config, never hardcoded"). Single source of truth in
// config is what stops the two from drifting stale (the failure that hid a 2× opus under-count).
import { describe, it, expect } from "vitest";
import { meterUsageCost } from "../src/broker/cost-meter";
import type { TokenPricing } from "../src/broker/cost-meter";
import { detectBudgetBreach } from "../src/broker/budget-enforcer";
import { conservativeProviderPricing } from "../src/broker/pricing";
import type { AgentUsage } from "../src/ports/agent-result";

// A fixture per-model table whose max INPUT and max OUTPUT live in DIFFERENT rows — so an
// element-wise projection ({in:10, out:25}) is distinguishable from a row-wise one.
const FIXTURE: Readonly<Record<string, TokenPricing>> = {
  cheap: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
  midOut: { inputUsdPerMillion: 3, outputUsdPerMillion: 25 }, // max OUTPUT
  pricyIn: { inputUsdPerMillion: 10, outputUsdPerMillion: 15 }, // max INPUT
};

describe("conservativeProviderPricing — per-model → conservative provider rate (CP-5 / 18.15a)", () => {
  it("projects the ELEMENT-WISE max (input, output) — not a row-wise pick", () => {
    // spec(§7) — pricingFor keys by provider not model, so the single rate must dominate EACH
    // axis independently: input from `pricyIn` ($10), output from `midOut` ($25) — different rows.
    expect(conservativeProviderPricing(FIXTURE)).toEqual({ inputUsdPerMillion: 10, outputUsdPerMillion: 25 });
  });

  it("FAILS CLOSED (throws) on an empty per-model table — an empty set would defeat the cost cap", () => {
    // spec(§7) — Math.max() over nothing is -Infinity (a never-breaching rate); reject it loudly.
    expect(() => conservativeProviderPricing({})).toThrow(/empty/i);
  });

  it("FAILS CLOSED on a NON-FINITE or NEGATIVE rate — never a fail-OPEN cost-cap defeat", () => {
    // spec(§7) — a NaN rate makes every `costUsd > cap` compare false (silent fail-OPEN); a negative
    // rate under-counts. A safety helper must reject both rather than pass them through to a rate.
    expect(() => conservativeProviderPricing({ x: { inputUsdPerMillion: NaN, outputUsdPerMillion: 5 } })).toThrow();
    expect(() =>
      conservativeProviderPricing({ x: { inputUsdPerMillion: Infinity, outputUsdPerMillion: 5 } }),
    ).toThrow();
    expect(() => conservativeProviderPricing({ x: { inputUsdPerMillion: 5, outputUsdPerMillion: -1 } })).toThrow();
    // $0 IS valid (local/free models) — must NOT throw.
    expect(() => conservativeProviderPricing({ x: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } })).not.toThrow();
  });

  it("the projected rate DOMINATES every model — fail-SAFE, never UNDER-counts (rule: over-deny not overspend)", () => {
    // spec(§7) — a deny-only cap that only reduces spend; the conservative rate must be ≥ every
    // in-table model on both axes, else a pricier model's real spend could slip the cap undetected.
    const rate = conservativeProviderPricing(FIXTURE);
    for (const p of Object.values(FIXTURE)) {
      expect(rate.inputUsdPerMillion).toBeGreaterThanOrEqual(p.inputUsdPerMillion);
      expect(rate.outputUsdPerMillion).toBeGreaterThanOrEqual(p.outputUsdPerMillion);
    }
  });

  it("the projected rate ACTIVATES the COST-1 cap: meterUsageCost measures + the cost breach FIRES", () => {
    // spec(§19.5) — the crux: the previously-dead cost limb now fires. 1M in + 1M out @ {10,25} = $35.
    const rate = conservativeProviderPricing(FIXTURE);
    const usage: AgentUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, runtimeSeconds: 1 };
    const s = meterUsageCost(usage, rate);
    expect(s.measured).toBe(true);
    expect(s.costUsd).toBeCloseTo(35, 6);
    const over = detectBudgetBreach(usage, { maxRuntimeSeconds: 1000, maxCostUsd: 20 }, rate);
    expect(over?.cost).toEqual({ observed: 35, limit: 20 });
    expect(over?.runtime).toBeUndefined(); // runtime under its cap — only the cost limb fired
    const under = detectBudgetBreach(usage, { maxRuntimeSeconds: 1000, maxCostUsd: 50 }, rate);
    expect(under).toBeUndefined();
  });

  it("absent pricing still degrades to measured:false (no false-cheap) — the runtime cap is the backstop", () => {
    // spec(§7) — Claude-first: a non-priced provider (openai/openrouter deferred) yields undefined
    // pricing ⇒ meterUsageCost measured:false (contributes 0) ⇒ the cost limb short-circuits; NEVER
    // a false-cheap $0 measured:true that lets spend slip the cap.
    const usage: AgentUsage = { inputTokens: 1_000_000, outputTokens: 0, runtimeSeconds: 1 };
    const s = meterUsageCost(usage, undefined);
    expect(s.measured).toBe(false);
    expect(s.costUsd).toBe(0);
    const b = detectBudgetBreach(usage, { maxRuntimeSeconds: 1000, maxCostUsd: 0.01 }, undefined);
    expect(b).toBeUndefined();
  });
});
