// spec(§7) — budget-cap enforcement (COST-1/2): pre-gate derives the enforced
// budget applying the configurable DEFAULT cap (never silently unbounded);
// post-gate cancels on a runtime/cost breach → cancelled_budget with NO partial
// side effect (the gate only DECIDES; it emits no output). Pure + deterministic.
import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { AgentJob } from "@sow/contracts";
import { isRedactionSafe } from "@sow/policy";
import { validAgentJob } from "@sow/contracts";
import type { AgentUsage } from "../src/ports/agent-result";
import type { BudgetGate, EnforcedBudget } from "../src/broker/broker";
import {
  createBudgetGate,
  resolveEnforcedBudget,
  detectBudgetBreach,
  budgetBreachHealthItem,
  BUDGET_BREACH_HEALTH_CLASS,
  type BudgetEnforcerConfig,
  type BudgetDefaults,
} from "../src/broker/budget-enforcer";

// Config VALUES here are TEST fixtures standing in for config/providers.defaults.json
// (OQ-003/OQ-004) — the enforcer READS them, never hardcodes them (bullet 6).
const DEFAULTS: BudgetDefaults = {
  global: { maxRuntimeSeconds: 60, maxCostUsd: 0.5 },
  perCapability: { "meeting.close": { maxRuntimeSeconds: 120, maxCostUsd: 1.0 } },
  localRuntimeMultiplier: 3,
};
const CONFIG: BudgetEnforcerConfig = {
  defaults: DEFAULTS,
  pricing: { claude: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
};

// A job that carries NO explicit caps (exercises the COST-2 default path). The
// AgentJob contract makes maxRuntimeSeconds required, so we craft the uncapped
// shape a test-only cast to prove the enforcer never leaves such a job unbounded.
function uncappedJob(overrides: Partial<AgentJob> = {}): AgentJob {
  const { maxRuntimeSeconds: _r, maxCostUsd: _c, ...rest } = validAgentJob;
  return { ...rest, ...overrides } as AgentJob;
}

describe("resolveEnforcedBudget (COST-2 default cap)", () => {
  it("honors explicit job caps when present (no default substitution)", () => {
    const b = resolveEnforcedBudget({ ...validAgentJob, maxRuntimeSeconds: 42, maxCostUsd: 7 }, DEFAULTS);
    expect(b).toEqual({ maxRuntimeSeconds: 42, maxCostUsd: 7 });
  });

  it("applies the per-capability default when the job lacks a cost cap (never undefined)", () => {
    const job = uncappedJob({ capability: validAgentJob.capability });
    const b = resolveEnforcedBudget(job, DEFAULTS);
    // meeting.close override: runtime 120, cost 1.0
    expect(b.maxCostUsd).toBe(1.0);
    expect(b.maxRuntimeSeconds).toBe(120);
  });

  it("falls back to the GLOBAL default for a capability without an override", () => {
    const job = uncappedJob({ capability: "briefing.daily" as AgentJob["capability"] });
    const b = resolveEnforcedBudget(job, DEFAULTS);
    expect(b).toEqual({ maxRuntimeSeconds: 60, maxCostUsd: 0.5 });
  });

  it("applies the local-runtime multiplier to a DEFAULT-derived runtime cap on a local route (OQ-004 ×3)", () => {
    const localRoute = { ...validAgentJob.providerRoute, egressClass: "local" as const };
    const job = uncappedJob({ providerRoute: localRoute, capability: "briefing.daily" as AgentJob["capability"] });
    const b = resolveEnforcedBudget(job, DEFAULTS);
    expect(b.maxRuntimeSeconds).toBe(180); // 60 × 3
  });

  it("does NOT multiply an operator's EXPLICIT runtime cap (explicit intent is sacred)", () => {
    const localRoute = { ...validAgentJob.providerRoute, egressClass: "local" as const };
    const b = resolveEnforcedBudget({ ...validAgentJob, providerRoute: localRoute, maxRuntimeSeconds: 30 }, DEFAULTS);
    expect(b.maxRuntimeSeconds).toBe(30);
  });
});

describe("createBudgetGate — pre (COST-2)", () => {
  const gate: BudgetGate = createBudgetGate(CONFIG);

  it("conforms to the broker BudgetGate interface", () => {
    // structural assertion: assignable above; call the surface to be sure.
    expect(typeof gate.pre).toBe("function");
    expect(typeof gate.post).toBe("function");
  });

  it("derives an enforced budget with a cost cap even when the job has none (never unbounded)", () => {
    const r = gate.pre(uncappedJob());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const b: EnforcedBudget = r.value.value;
    expect(b.maxCostUsd).toBeDefined();
    expect(b.maxRuntimeSeconds).toBeGreaterThan(0);
    expect(r.value.audit).toBeDefined();
  });

  it("FAILS CLOSED when no bounded runtime cap can be derived (COST-2: never silently unbounded)", () => {
    const badDefaults: BudgetDefaults = { global: { maxRuntimeSeconds: 0, maxCostUsd: 0.5 } };
    const badGate = createBudgetGate({ defaults: badDefaults });
    const r = badGate.pre(uncappedJob({ maxRuntimeSeconds: 0 } as Partial<AgentJob>));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("budget_exceeded");
    expect(r.error.branch).toBe("failed_terminal");
    expect(r.error.retryable).toBe(false);
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });
});

describe("detectBudgetBreach (pure)", () => {
  const budget: EnforcedBudget = { maxRuntimeSeconds: 60, maxCostUsd: 0.5 };
  const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };

  it("returns undefined when within both caps", () => {
    expect(detectBudgetBreach({ runtimeSeconds: 10, costUsd: 0.1 }, budget)).toBeUndefined();
  });

  it("flags a runtime breach", () => {
    const b = detectBudgetBreach({ runtimeSeconds: 61 }, budget);
    expect(b?.runtime).toEqual({ observed: 61, limit: 60 });
    expect(b?.cost).toBeUndefined();
  });

  it("flags a reported-cost breach", () => {
    const b = detectBudgetBreach({ runtimeSeconds: 5, costUsd: 0.75 }, budget);
    expect(b?.cost).toEqual({ observed: 0.75, limit: 0.5 });
  });

  it("flags an ESTIMATED-cost breach from tokens × pricing when cost is unreported", () => {
    // 1M output × $15/M = $15 > $0.5
    const b = detectBudgetBreach({ runtimeSeconds: 5, outputTokens: 1_000_000 }, budget, pricing);
    expect(b?.cost?.observed).toBeCloseTo(15, 6);
  });

  it("does NOT flag a cost breach it cannot measure (runtime cap remains the safety net)", () => {
    // no costUsd, no pricing → cost unmeasurable; runtime within cap → no breach
    expect(detectBudgetBreach({ runtimeSeconds: 5, outputTokens: 9_999_999 }, budget)).toBeUndefined();
  });

  it("flags BOTH runtime and cost when both breach", () => {
    const b = detectBudgetBreach({ runtimeSeconds: 61, costUsd: 0.9 }, budget);
    expect(b?.runtime).toBeDefined();
    expect(b?.cost).toBeDefined();
  });
});

describe("createBudgetGate — post (COST-1: cancel-with-no-partial-side-effect)", () => {
  const gate = createBudgetGate(CONFIG);
  const budget: EnforcedBudget = { maxRuntimeSeconds: 60, maxCostUsd: 0.5 };

  it("PROCEEDS (no side effect emitted) when the run is within budget", () => {
    const usage: AgentUsage = { runtimeSeconds: 10, costUsd: 0.1 };
    const r = gate.post(validAgentJob, usage, budget);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.value).toBeUndefined(); // void proceed — emits nothing
  });

  it("DENIES → cancelled_budget on a runtime breach; audit is redaction-safe", () => {
    const usage: AgentUsage = { runtimeSeconds: 120, costUsd: 0.1 };
    const r = gate.post(validAgentJob, usage, budget);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.reason).toBe("budget_exceeded");
    expect(r.error.branch).toBe("cancelled_budget");
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/runtime/i);
    expect(r.error.audit.healthSignalClass).toBe(BUDGET_BREACH_HEALTH_CLASS);
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("DENIES on an ESTIMATED-cost breach when the provider reports no cost", () => {
    // claude pricing: 1M output × $15/M = $15 > $0.5 cap
    const usage: AgentUsage = { runtimeSeconds: 5, outputTokens: 1_000_000 };
    const r = gate.post(validAgentJob, usage, budget);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.branch).toBe("cancelled_budget");
    expect(r.error.message).toMatch(/cost/i);
  });

  it("is DETERMINISTIC / idempotent — re-driving the same breach yields an equal decision and emits nothing", () => {
    const usage: AgentUsage = { runtimeSeconds: 120 };
    const first = gate.post(validAgentJob, usage, budget);
    const second = gate.post(validAgentJob, usage, budget);
    expect(isErr(first) && isErr(second)).toBe(true);
    if (isErr(first) && isErr(second)) {
      expect(second.error.reason).toBe(first.error.reason);
      expect(second.error.branch).toBe(first.error.branch);
      expect(second.error.message).toBe(first.error.message);
    }
  });
});

describe("budgetBreachHealthItem (OBS-2 System Health surfacing)", () => {
  it("builds a distinct budget-breach health item carrying job refs (no raw content)", () => {
    const breach = detectBudgetBreach({ runtimeSeconds: 120 }, { maxRuntimeSeconds: 60, maxCostUsd: 0.5 })!;
    const item = budgetBreachHealthItem(validAgentJob, breach);
    expect(item.healthClass).toBe(BUDGET_BREACH_HEALTH_CLASS);
    expect(item.refs).toContain(`ref:job:${validAgentJob.id}`);
    expect(item.message).toMatch(/budget/i);
  });
});
