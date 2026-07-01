// @sow/providers — budget-cap enforcement (§7 task 5.4, COST-1/2).
//
// Builds the broker's injected `BudgetGate` (see ./broker): a PRE gate that
// derives the enforced per-job budget applying the configurable DEFAULT cap
// (COST-2 — an LLM-calling job is NEVER left silently unbounded), and a POST
// gate that detects a runtime/cost breach after the run and DENIES →
// `cancelled_budget`.
//
// STRICT SIDE-EFFECT RULE (safety, REQ-S-007): this gate only DECIDES. It emits
// no output, calls no write adapter, and never advances the job past the
// broker's control — a breached run's output is discarded by the broker BEFORE
// the schema gate, so a cancelled_budget job leaves NO partial uncommitted side
// effect. The breach is RECORDED via a redaction-safe AuditSignal (§16.3) and a
// distinct System Health item (OBS-2) is available via `budgetBreachHealthItem`.
//
// PURE + deterministic (idempotent on re-drive — identical input ⇒ identical
// decision, and no side effect to duplicate). Default cap VALUES come from
// config (config/providers.defaults.json, OQ-003/OQ-004); this module READS
// them and never hardcodes them (bullet 6). Never throws across a boundary (§16).
import { ok, err } from "@sow/contracts";
import type { AgentJob } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import type { AuditSignal } from "@sow/policy";
import type { AgentUsage } from "../ports/agent-result";
import type {
  BudgetGate,
  EnforcedBudget,
  GateResult,
  GateDeny,
  BrokerHealthItem,
} from "./broker";
import { meterUsageCost, type TokenPricing } from "./cost-meter";

/** Distinct System Health class for a budget-cancelled job (OBS-2). */
export const BUDGET_BREACH_HEALTH_CLASS = "budget_breach" as const;

const ENFORCER_ACTOR = "broker:budget-enforcer" as const;
const BUDGET_MARKER = "broker:budget-decision" as const;
// A budget breach is NOT auto-retryable: re-running under the same caps re-breaches;
// raising a cap is a fresh operator decision, not a transparent retry.
const BUDGET_BREACH_RETRYABLE = false;

/** A resolved cap pair. Both bounds present (COST-2 guarantees a cost cap too). */
export interface BudgetCap {
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd: number;
}

/**
 * Default-cap configuration (COST-2). VALUES are sourced from
 * `config/providers.defaults.json` (OQ-003/OQ-004) — never hardcoded here.
 */
export interface BudgetDefaults {
  /** Global fallback cap applied to any LLM-calling job lacking one. */
  readonly global: BudgetCap;
  /** Optional per-capability overrides (OQ-004, e.g. `meeting.close`). Merged over `global`. */
  readonly perCapability?: Readonly<Record<string, Partial<BudgetCap>>>;
  /**
   * Optional local-runtime allowance multiplier (OQ-004: local ×3). Applied ONLY
   * to a DEFAULT-derived runtime cap on a `local`-egress route — an operator's
   * EXPLICIT job cap is honored verbatim (explicit intent is sacred).
   */
  readonly localRuntimeMultiplier?: number;
}

export interface BudgetEnforcerConfig {
  readonly defaults: BudgetDefaults;
  /** Token pricing per ProviderId for cost estimation when a provider reports none (OQ-003). */
  readonly pricing?: Readonly<Record<string, TokenPricing>>;
}

/** One breached dimension: what was observed vs the enforced limit (numbers only — redaction-safe). */
export interface BreachDetail {
  readonly observed: number;
  readonly limit: number;
}

/** A budget breach: runtime and/or cost. At least one field is present. */
export interface BudgetBreach {
  readonly runtime?: BreachDetail;
  readonly cost?: BreachDetail;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function jobRefs(job: AgentJob): readonly string[] {
  return [
    `ref:job:${job.id}`,
    `ref:workspace:${job.workspaceId}`,
    `ref:capability:${String(job.capability)}`,
  ];
}

/**
 * Derive the enforced budget for a job (COST-2). Explicit positive job caps are
 * honored verbatim; otherwise the per-capability-then-global default fills in.
 * The local-runtime multiplier scales ONLY a default-derived runtime cap on a
 * local route. Pure — always returns a fully-populated budget (both bounds set).
 */
export function resolveEnforcedBudget(job: AgentJob, defaults: BudgetDefaults): EnforcedBudget {
  const override = defaults.perCapability?.[String(job.capability)] ?? {};
  const defaultRuntime = override.maxRuntimeSeconds ?? defaults.global.maxRuntimeSeconds;
  const defaultCost = override.maxCostUsd ?? defaults.global.maxCostUsd;

  const runtimeIsExplicit = isPositiveFinite(job.maxRuntimeSeconds);
  let maxRuntimeSeconds = runtimeIsExplicit ? job.maxRuntimeSeconds : defaultRuntime;

  // Local-runtime allowance: default cap only, local route only, positive multiplier only.
  const mult = defaults.localRuntimeMultiplier;
  if (
    !runtimeIsExplicit &&
    job.providerRoute.egressClass === "local" &&
    isPositiveFinite(mult)
  ) {
    maxRuntimeSeconds = defaultRuntime * mult;
  }

  const maxCostUsd = isPositiveFinite(job.maxCostUsd) ? job.maxCostUsd : defaultCost;
  return { maxRuntimeSeconds, maxCostUsd };
}

function pricingFor(config: BudgetEnforcerConfig, job: AgentJob): TokenPricing | undefined {
  if (config.pricing === undefined) return undefined;
  if ("provider" in job.providerRoute) return config.pricing[job.providerRoute.provider];
  return undefined;
}

/**
 * Detect a budget breach after a run. A runtime breach fires when observed
 * runtime exceeds the cap. A cost breach fires only when cost is MEASURABLE
 * (reported or estimable from `pricing`) and exceeds the cap — an unmeasurable
 * cost never breaches (the always-present runtime cap is the safety net). Pure.
 */
export function detectBudgetBreach(
  usage: AgentUsage,
  budget: EnforcedBudget,
  pricing?: TokenPricing,
): BudgetBreach | undefined {
  let runtime: BreachDetail | undefined;
  let cost: BreachDetail | undefined;

  if (
    typeof usage.runtimeSeconds === "number" &&
    Number.isFinite(usage.runtimeSeconds) &&
    usage.runtimeSeconds > budget.maxRuntimeSeconds
  ) {
    runtime = { observed: usage.runtimeSeconds, limit: budget.maxRuntimeSeconds };
  }

  if (budget.maxCostUsd !== undefined) {
    const sample = meterUsageCost(usage, pricing);
    if (sample.measured && sample.costUsd > budget.maxCostUsd) {
      cost = { observed: sample.costUsd, limit: budget.maxCostUsd };
    }
  }

  if (runtime === undefined && cost === undefined) return undefined;
  return {
    ...(runtime !== undefined ? { runtime } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function breachSummary(breach: BudgetBreach): string {
  const parts: string[] = [];
  if (breach.runtime !== undefined) {
    parts.push(`runtime ${breach.runtime.observed}s > cap ${breach.runtime.limit}s`);
  }
  if (breach.cost !== undefined) {
    parts.push(`cost $${breach.cost.observed} > cap $${breach.cost.limit}`);
  }
  return parts.join("; ");
}

/**
 * Build the distinct System Health item (OBS-2) for a budget-cancelled job.
 * Pure; carries refs + numeric bounds only (no raw content). The §16 surfacing
 * layer materializes this into a HealthItem.
 */
export function budgetBreachHealthItem(job: AgentJob, breach: BudgetBreach): BrokerHealthItem {
  return {
    healthClass: BUDGET_BREACH_HEALTH_CLASS,
    message: `agent job cancelled on budget breach: ${breachSummary(breach)}`,
    refs: jobRefs(job),
  };
}

function breachAudit(job: AgentJob, breach: BudgetBreach): AuditSignal {
  return buildAuditSignal({
    actor: ENFORCER_ACTOR,
    event: "broker.budget.breach",
    refs: jobRefs(job),
    payloadHash: BUDGET_MARKER,
    beforeSummary: "running",
    afterSummary: `cancelled_budget: ${breachSummary(breach)}`,
    healthSignalClass: BUDGET_BREACH_HEALTH_CLASS,
  });
}

/**
 * Build the broker's `BudgetGate` over injected config. `pre` applies the COST-2
 * default cap (fail-closed if no bounded runtime cap can be derived); `post`
 * detects a breach and DENIES → `cancelled_budget`. Pure factory — no I/O.
 */
export function createBudgetGate(config: BudgetEnforcerConfig): BudgetGate {
  return {
    pre(job: AgentJob): GateResult<EnforcedBudget> {
      const budget = resolveEnforcedBudget(job, config.defaults);

      // COST-2 hard floor: a runtime cap MUST be bounded and positive, else the
      // job could run unbounded — refuse it (fail closed) rather than proceed.
      if (!isPositiveFinite(budget.maxRuntimeSeconds)) {
        const audit = buildAuditSignal({
          actor: ENFORCER_ACTOR,
          event: "broker.budget.unbounded_rejected",
          refs: jobRefs(job),
          payloadHash: BUDGET_MARKER,
          beforeSummary: "provider_selected",
          afterSummary: "rejected: no bounded runtime cap derivable (COST-2)",
          healthSignalClass: BUDGET_BREACH_HEALTH_CLASS,
        });
        const deny: GateDeny = {
          reason: "budget_exceeded",
          message:
            "no bounded runtime cap could be derived from job or config; refusing to run unbounded (COST-2)",
          audit,
          branch: "failed_terminal",
          retryable: false,
        };
        return err(deny);
      }

      const defaulted =
        !isPositiveFinite(job.maxRuntimeSeconds) || !isPositiveFinite(job.maxCostUsd);
      const audit = buildAuditSignal({
        actor: ENFORCER_ACTOR,
        event: "broker.budget.enforced",
        refs: jobRefs(job),
        payloadHash: BUDGET_MARKER,
        beforeSummary: "provider_selected",
        afterSummary: `caps runtime=${budget.maxRuntimeSeconds}s cost=$${budget.maxCostUsd}${defaulted ? " (default applied)" : ""}`,
      });
      return ok({ value: budget, audit });
    },

    post(job: AgentJob, usage: AgentUsage, budget: EnforcedBudget): GateResult<void> {
      const breach = detectBudgetBreach(usage, budget, pricingFor(config, job));
      if (breach !== undefined) {
        const deny: GateDeny = {
          reason: "budget_exceeded",
          message: `budget cap breached — ${breachSummary(breach)}; job cancelled with no partial side effect`,
          audit: breachAudit(job, breach),
          branch: "cancelled_budget",
          retryable: BUDGET_BREACH_RETRYABLE,
        };
        return err(deny);
      }
      const audit = buildAuditSignal({
        actor: ENFORCER_ACTOR,
        event: "broker.budget.within",
        refs: jobRefs(job),
        payloadHash: BUDGET_MARKER,
        beforeSummary: "running",
        afterSummary: `within caps (runtime=${usage.runtimeSeconds}s)`,
      });
      return ok({ value: undefined, audit });
    },
  };
}
