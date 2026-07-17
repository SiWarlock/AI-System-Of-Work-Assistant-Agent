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
import { createBudgetGate } from "@sow/providers";
import type { AgentJob } from "@sow/contracts";
import type {
  BudgetGate,
  BudgetEnforcerConfig,
  BudgetDefaults,
  EnforcedBudget,
  AgentUsage,
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
    "meeting.close": { maxCostUsd: 0.5, maxRuntimeSeconds: 300 },
    extraction: { maxCostUsd: 0.25, maxRuntimeSeconds: 120 },
    synthesis: { maxCostUsd: 0.25, maxRuntimeSeconds: 180 },
    "cheap.classify": { maxCostUsd: 0.05, maxRuntimeSeconds: 60 },
    "copilot.qa": { maxCostUsd: 0.15, maxRuntimeSeconds: 90 },
  },
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
