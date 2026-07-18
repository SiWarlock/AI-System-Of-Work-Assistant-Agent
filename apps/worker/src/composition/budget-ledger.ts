// 18.2 — the worker-composition BUDGET LEDGER seam.
//
// The broker's `createBudgetGate` (packages/providers) enforces per-job COST-1/COST-2
// caps (pre: default-cap derivation, fail-closed on no bounded runtime cap; post:
// breach → cancelled_budget). This module adds a PLUGGABLE `BudgetLedgerPort` around
// it: `createLedgeredBudgetGate` composes the real gate with a ledger that ACCOUNTS
// each run's observed spend. The default `createSingleRunBudgetLedger` is single-run /
// in-boot (records this boot's runs, no cross-run enforcement) — the SEAM the §19.11
// durable cross-run ledger plugs into BACKWARD (no forward dependency; unset/default =
// single-run behavior).
//
// The ledger is a WORKER port (not a providers gate) by the layer rules: a
// packages/providers gate must not import a worker-defined port. Mirrors the broker's
// `IdempotencyLedger` seam shape (a port whose impl the worker supplies).
//
// Deny-only policing — no spend, no egress, no external write. Pure + never throws
// across the boundary (the wrapped gate is never-throws; `record` is a pure append).
import { createBudgetGate, conservativeProviderPricing } from "@sow/providers";
import type { AgentJob } from "@sow/contracts";
import type {
  BudgetGate,
  BudgetEnforcerConfig,
  BudgetDefaults,
  EnforcedBudget,
  AgentUsage,
  TokenPricing,
} from "@sow/providers";

/**
 * One run's budget-accounting entry: the job identity + its observed usage + the
 * enforced budget it ran under. Redaction-safe — ids + numeric bounds only, no raw
 * content. The durable §19.11 ledger persists these across runs.
 */
export interface BudgetLedgerEntry {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly usage: AgentUsage;
  readonly budget: EnforcedBudget;
}

/**
 * The pluggable budget-ledger port. `record` accounts one run's spend. The §19.11
 * durable cross-run impl plugs in here (backward — this port is the stable seam); the
 * default single-run impl records in-boot only.
 */
export interface BudgetLedgerPort {
  record(entry: BudgetLedgerEntry): void;
}

/** The single-run/in-boot ledger: records this boot's runs for inspection; no cross-run
 *  enforcement (unset/default behavior). `entries()` exposes the accumulated rows. */
export interface SingleRunBudgetLedger extends BudgetLedgerPort {
  entries(): readonly BudgetLedgerEntry[];
}

/**
 * The COST-2 default caps, mirroring `config/providers.defaults.json` §budgets
 * (defaultMaxCostUsd / defaultMaxRuntimeSeconds / perCapability). Single-sourced HERE
 * as a typed constant so composition needs no file I/O at boot; a config-JSON loader
 * (true single-source, no transcription drift) is a follow-up. `assembleBackends`
 * accepts an override so a deployment/test can inject its own.
 */
export const DEFAULT_BUDGET_DEFAULTS: BudgetDefaults = {
  global: { maxRuntimeSeconds: 120, maxCostUsd: 0.5 },
  perCapability: {
    // 18.23 step 2 — meeting.close + source.process (the two subscription-EXTRACTION legs) carry the
    // $1.50 extraction cap. Deny-only/fail-safe (only ever REDUCES spend, ships ON — L44; a raise never
    // newly-denies a tokenless dormant job — L54). ⚠ BOTH maxCostUsd AND maxRuntimeSeconds are
    // RE-CONFIRM-AT-FINAL-SPEND PLACEHOLDERS — the owner sets the exact values at the step-7 flip.
    // MUST stay byte-identical to config/providers.defaults.json §budgets.perCapability (drift-guard
    // default_budget_defaults_match_config, broker-gates.test.ts).
    "meeting.close": { maxCostUsd: 1.5, maxRuntimeSeconds: 300 },
    "source.process": { maxCostUsd: 1.5, maxRuntimeSeconds: 300 },
    extraction: { maxCostUsd: 0.25, maxRuntimeSeconds: 120 },
    synthesis: { maxCostUsd: 0.25, maxRuntimeSeconds: 180 },
    "cheap.classify": { maxCostUsd: 0.05, maxRuntimeSeconds: 60 },
    "copilot.qa": { maxCostUsd: 0.15, maxRuntimeSeconds: 90 },
  },
};

/**
 * CONSERVATIVE FAIL-SAFE PLACEHOLDER per-model Claude token pricing (USD per 1,000,000 tokens),
 * transcribed from `config/providers.defaults.json` §costEstimation.pricing.claude.
 *
 * ⚠ NOT CURRENT AUTHORITY — a fail-safe ESTIMATE pending flip. Vendor pricing drifts; the exact
 * per-model numbers are RE-VERIFIED via a fresh Context7 fetch at the crossing — a HARD, lead-owned
 * flip precondition (#13). Basis: the claude-api Current Models table (cached 2026-06-24) + the config
 * table; transcribed 2026-07-17. Grounding note (Finding-E correction): opus-4-8 / -4-7 = $5/$25 — the
 * "$10/$50 opus" Finding-E asserted is actually FABLE 5's rate (a conflation). The conservative margin
 * comes correctly from fable-5 DOMINATING the element-wise MAX below, NOT from over-stating any per-model
 * rate (falsifying a cited table would be worse than the non-existent staleness).
 *
 * FINDING F (#13): pricing is keyed by ProviderId (`pricingFor` reads `config.pricing[providerRoute.provider]`).
 * The flagship `meeting.close.cloudPreferred` route is `{runtime:"claude-agent-sdk"}` — it carries NO
 * `providerRoute.provider`, so it can't be keyed here and is NOT dollar-capped by this wiring. HARD arming
 * precondition (#13): arm the dollar-capped raw-model PROVIDER routes first; runtime-route cost metering
 * is a deferred Future-TODO.
 *
 * FUTURE-TODO (#13; ARCHITECTURE §5.4 "must not hardcode" end state): replace BOTH this and
 * DEFAULT_BUDGET_DEFAULTS with ONE real config loader — but one that fails CLOSED at arming. A boot loader
 * that fails OPEN on a packaged-path miss would silently drop the cap (the exact silent-safety-loss class
 * this round hardens — CP-4 always-green, 17.3 silent-hold), so a compiled-in constant is the safe interim.
 */
export const DEFAULT_CLAUDE_PRICING: Readonly<Record<string, TokenPricing>> = {
  "claude-fable-5": { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
  "claude-opus-4-8": { inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
  "claude-opus-4-7": { inputUsdPerMillion: 5, outputUsdPerMillion: 25 },
  "claude-sonnet-4-6": { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  "claude-haiku-4-5": { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
};

/**
 * The conservative PROVIDER-axis pricing threaded into `BudgetEnforcerConfig.pricing` (keyed by
 * ProviderId — the axis `pricingFor` consumes). `conservativeProviderPricing` (CP-5a) takes the
 * ELEMENT-WISE MAX over the per-model table (fable-5's $10/$50 dominates) — fail-SAFE: it OVER-counts,
 * so a deny-only dollar cap can never be exceeded undetected (over-denying a cheaper model is the safe
 * direction). Deny-only ⇒ ships ON (worker L44); the shipped default carries this and `assembleBackends`
 * threads it unless a deployment overrides `budgetPricing`. The helper throws (fail-CLOSED) on an empty
 * or non-finite/negative table — a composition misconfiguration surfaces at boot, never a silent gap.
 */
export const DEFAULT_PROVIDER_PRICING: Readonly<Record<string, TokenPricing>> = {
  claude: conservativeProviderPricing(DEFAULT_CLAUDE_PRICING),
};

/** Build the single-run/in-boot budget ledger. */
export function createSingleRunBudgetLedger(): SingleRunBudgetLedger {
  const rows: BudgetLedgerEntry[] = [];
  return {
    record(entry: BudgetLedgerEntry): void {
      rows.push(entry);
    },
    entries(): readonly BudgetLedgerEntry[] {
      return [...rows];
    },
  };
}

/**
 * Compose the real broker `BudgetGate` (`createBudgetGate`) with a {@link BudgetLedgerPort}.
 * `pre` delegates unchanged (default-cap derivation + COST-2 fail-closed). `post` runs
 * the real breach detection, then RECORDS the run's observed spend into the ledger
 * (regardless of the within/breach decision — the ledger tracks actual consumption; a
 * breach is still a real spend). The gate's decision is returned unchanged — the ledger
 * is accounting-only, it never widens or narrows the budget verdict here (single-run).
 */
export function createLedgeredBudgetGate(
  config: BudgetEnforcerConfig,
  ledger: BudgetLedgerPort,
): BudgetGate {
  const inner = createBudgetGate(config);
  return {
    pre: (job: AgentJob) => inner.pre(job),
    post: (job, usage, budget) => {
      const decision = inner.post(job, usage, budget);
      // §16 — accounting is best-effort and must NEVER affect the gate's control flow: the
      // broker awaits `post()` WITHOUT a guard, so a throwing ledger (e.g. a future durable
      // §19.11 ledger on a DB fault) is swallowed here — the budget verdict always returns.
      try {
        ledger.record({
          jobId: String(job.id),
          workspaceId: String(job.workspaceId),
          usage,
          budget,
        });
      } catch {
        /* never crash the broker's budget gate on an accounting fault */
      }
      return decision;
    },
  };
}
