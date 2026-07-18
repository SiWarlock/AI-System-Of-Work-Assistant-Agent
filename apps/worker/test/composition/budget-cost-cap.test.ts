// CP-5b / 18.15b — the COST-1 dollar cap made LIVE: real per-model Claude pricing
// projected to a conservative provider rate, threaded into the composed budget gate so an
// over-cost route DENIES on `maxCostUsd` (not just runtime-seconds). The breach machinery
// (detectBudgetBreach cost limb, resolveEnforcedBudget maxCostUsd) already exists (18.2); the
// gap was `config.pricing` being unpopulated ⇒ pricingFor undefined ⇒ meterUsageCost measured:false
// ⇒ the cost limb never fired. This wires DEFAULT_PROVIDER_PRICING through the REAL
// createLedgeredBudgetGate (the exact composition assembleBackends uses).
//
// PRICING GROUNDING (Finding-E correction, orch2-ratified): the claude table is grounded on the
// authoritative claude-api Current Models table (cached 2026-06-24). Opus 4.8 = $5/$25 (NOT stale —
// the "live $10/$50 opus" that Finding-E asserted is actually FABLE 5's rate, a conflation). The
// conservative element-wise MAX (conservativeProviderPricing) is fable-5's $10/$50 — fail-SAFE
// (over-counts, never under-caps), so the dollar cap can't be exceeded undetected regardless.
//
// FINDING F (documented, routed to #13): pricing is keyed by ProviderId; the flagship
// `meeting.close.cloudPreferred` route is `{runtime:"claude-agent-sdk"}` (no providerRoute.provider),
// so pricingFor can't key it ⇒ that route is NOT dollar-capped by this wiring. Arm the dollar-capped
// raw-model PROVIDER routes first; runtime-route cost metering is a #13 Future-TODO.
//
// SAFE-BUILD: deny-only cost cap (only ever REDUCES spend) — ships ON, no dormancy knob (worker L44).
// The full-broker e2e cost breach is arming-gated (the dormant stub run leg emits {runtimeSeconds:1}
// with NO tokens ⇒ measured:false), so the cost DENY is pinned at the composed gate over the REAL
// shipped constants (L50 real-config, not a fabricated pricing table).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { isOk, isErr, validAgentJob, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID } from "@sow/contracts";
import type { AgentJob, ProviderRoute } from "@sow/contracts";
import { budgetBreachHealthItem } from "@sow/providers";
import type { EnforcedBudget, AgentUsage, BudgetBreach } from "@sow/providers";
import {
  createSingleRunBudgetLedger,
  createLedgeredBudgetGate,
  DEFAULT_BUDGET_DEFAULTS,
  DEFAULT_CLAUDE_PRICING,
  DEFAULT_PROVIDER_PRICING,
} from "../../src/composition/budget-ledger";

// A raw-model CLAUDE PROVIDER route (has `providerRoute.provider` ⇒ pricingFor keys config.pricing.claude).
const claudeRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4-8",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
} as unknown as ProviderRoute;

const claudeJob = (over: Record<string, unknown> = {}): AgentJob => ({
  ...validAgentJob,
  providerRoute: claudeRoute,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  idempotencyKey: "idem-cost",
  ...over,
});

// The EXACT composition assembleBackends builds for its DEFAULT branch (real constants, real fn).
const shippedGate = () =>
  createLedgeredBudgetGate(
    { defaults: DEFAULT_BUDGET_DEFAULTS, pricing: DEFAULT_PROVIDER_PRICING },
    createSingleRunBudgetLedger(),
  );

// runtime UNDER cap, cost OVER cap: at the $10/$50 conservative claude rate, 60k input tokens =
// 60000*10/1e6 = $0.60 > the $0.50 default cost cap. Isolates a COST-only breach.
const OVER_COST_USAGE: AgentUsage = { runtimeSeconds: 2, inputTokens: 60_000 } as AgentUsage;
const CAP: EnforcedBudget = { maxRuntimeSeconds: 300, maxCostUsd: 0.5 };

describe("COST-1 dollar cap — real Claude pricing threaded into the composed budget gate (CP-5b/18.15b)", () => {
  it("composed_gate_denies_over_cost_claude_route — an over-$maxCostUsd claude route ⇒ DENY cancelled_budget on COST (spec COST-1, L50 real config)", () => {
    const res = shippedGate().post(claudeJob(), OVER_COST_USAGE, CAP);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("budget_exceeded");
    expect(res.error.branch).toBe("cancelled_budget");
    // a COST breach specifically (not the runtime limb) — the dead cost limb is now LIVE.
    expect(res.error.message).toContain("cost $");
  });

  it("default_on_gate_passes_tokenless_dormant_usage — the shipped default gate (DEFAULT_PROVIDER_PRICING wired ON) + a TOKENLESS dormant usage ⇒ PASSES, no cost deny (shipped-behavior safety: turning the cap ON must NOT newly-deny the current dormant app)", () => {
    // The dormant stub run leg emits {runtimeSeconds:1} with NO tokens. With pricing wired ON by
    // default, a tokenless job must meter as UNMEASURED cost (never a nonzero cost) ⇒ no cost breach.
    const dormant: AgentUsage = { runtimeSeconds: 1 } as AgentUsage; // the dormant stub's fixed, tokenless usage
    const res = shippedGate().post(claudeJob(), dormant, CAP);
    expect(isOk(res)).toBe(true); // tokenless ⇒ cost unmeasured ⇒ no false cost deny under the priced-ON default
  });

  it("composed_gate_allows_under_cost_claude_route — a cheap usage metered at the conservative $10/$50 stays < $0.50 ⇒ PASSES (the cap DISCRIMINATES, not deny-all)", () => {
    const under: AgentUsage = { runtimeSeconds: 2, inputTokens: 1_000 } as AgentUsage; // 1000*10/1e6 = $0.01 < $0.50
    const res = shippedGate().post(claudeJob(), under, CAP);
    expect(isOk(res)).toBe(true); // within both caps — a legitimate cheap run is NOT denied
  });

  it("default_provider_pricing_is_conservative_claude_rate — projected claude rate = fable-5's $10/$50 (conservative element-wise MAX, fail-SAFE)", () => {
    // $10/$50 is FABLE 5's rate (the max), NOT opus (opus is $5/$25) — the conservative projection
    // over-counts so a deny-only cap can never be exceeded undetected.
    expect(DEFAULT_PROVIDER_PRICING.claude).toEqual({
      inputUsdPerMillion: 10,
      outputUsdPerMillion: 50,
    });
  });

  it("default_claude_pricing_matches_config — DEFAULT_CLAUDE_PRICING mirrors config §costEstimation.pricing.claude (transcription drift-guard)", () => {
    // The per-model table transcribes the config (no JSON loader yet — Future-TODO). Pin it so a
    // config price edit that isn't mirrored fails loudly rather than silently under-capping.
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../config/providers.defaults.json",
    );
    const claude = (
      JSON.parse(readFileSync(configPath, "utf8")) as {
        costEstimation: { pricing: { claude: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> } };
      }
    ).costEstimation.pricing.claude;
    const expected = Object.fromEntries(
      Object.entries(claude).map(([model, price]) => [
        model,
        { inputUsdPerMillion: price.inUsdPerMTok, outputUsdPerMillion: price.outUsdPerMTok },
      ]),
    );
    // BIDIRECTIONAL (mirrors default_budget_defaults_match_config): an unmirrored config edit OR an
    // extra/ungrounded model in the constant ⇒ RED; not vacuous on an emptied config either (L15).
    expect(DEFAULT_CLAUDE_PRICING).toEqual(expected);
    // opus-4-8 is $5/$25 (Finding-E correction: NOT the $10/$50 conflated with Fable 5).
    expect(DEFAULT_CLAUDE_PRICING["claude-opus-4-8"]).toEqual({ inputUsdPerMillion: 5, outputUsdPerMillion: 25 });
  });

  it("maxCostUsd_default_is_resolved_not_undefined — the composed gate's pre-derived budget carries a finite maxCostUsd (COST-2 default) so the cost limb can fire", () => {
    const pre = shippedGate().pre(claudeJob());
    expect(isOk(pre)).toBe(true);
    if (!isOk(pre)) return;
    // GateProceed wraps the derived budget in `.value` (alongside the audit signal).
    expect(Number.isFinite(pre.value.value.maxCostUsd)).toBe(true);
    expect(pre.value.value.maxCostUsd).toBeGreaterThan(0);
  });

  it("unpriced_route_degrades_runtime_only_byte_equivalent — absent pricing ⇒ cost UNMEASURED (no cost cap, no false cost-cheap); runtime cap still the safety net", () => {
    // The SAME over-cost usage under an EMPTY pricing map ⇒ pricingFor undefined ⇒ measured:false ⇒
    // NO cost breach (the pre-CP-5b behavior). Only the always-present runtime cap enforces.
    const gate = createLedgeredBudgetGate({ defaults: DEFAULT_BUDGET_DEFAULTS, pricing: {} }, createSingleRunBudgetLedger());
    const res = gate.post(claudeJob(), OVER_COST_USAGE, CAP); // runtime 2 < 300, cost unmeasured
    expect(isOk(res)).toBe(true); // within budget — degrades to runtime-only, never a false cost deny
  });

  it("budget_breach_health_item_redacted — the OBS-2 HealthItem carries id-refs + numeric bounds ONLY, no raw content/prompt (rule 7)", () => {
    const breach: BudgetBreach = { cost: { observed: 0.6, limit: 0.5 } };
    const item = budgetBreachHealthItem(claudeJob({ id: "job-redact" }), breach);
    // refs are id-only (job / workspace / capability) — never content.
    for (const ref of item.refs) expect(ref.startsWith("ref:")).toBe(true);
    expect(item.refs).toContain("ref:job:job-redact");
    // message is the numeric breach summary — no raw content, no prompt.
    expect(item.message).toContain("budget breach");
    expect(item.message).not.toContain("claude-opus-4-8"); // no route/model leakage into the health item
  });
});
