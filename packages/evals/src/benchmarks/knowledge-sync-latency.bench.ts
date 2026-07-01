// spec(§12) — Knowledge-sync latency benchmark (task 4.13, REQ-NF-003).
//
// Instruments the budgeted hot path
//   KnowledgeWriter-commit → GBrain-search-visibility → dashboard-read-model
// and asserts p95 ≤ 60s (search visible) and p95 ≤ 10s (read-model). Per the
// IMPLEMENTATION_PLAN, this is the SOLE timing-assertion path in Phase 4 — no
// per-task latency assertions live in 4.1–4.12 (the dashboard <2s warm-load is a
// separate desktop/read-model budget on another track).
//
// This module is a benchmark HARNESS: a deterministic, pure assessment core over
// INJECTED latency samples, plus a key-gated probe runner for a real-gbrain run.
// The core has no clock, no network, no randomness — the caller supplies the
// samples (unit tests inject synthetic fixtures; a real run injects a probe that
// times an actual KnowledgeWriter commit against a live brain). Every
// cross-boundary function returns a typed Result — never throws (§16).
import type { Result } from "@sow/contracts";
import { ok, err } from "@sow/contracts";

// ── Recorded budgets (REQ-NF-003 / §12) ─────────────────────────────────────

/** KnowledgeWriter commit → GBrain search visibility p95 budget: ≤ 60 seconds. */
export const GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS = 60_000 as const;

/** KnowledgeWriter commit → dashboard read-model p95 budget: ≤ 10 seconds. */
export const READ_MODEL_P95_BUDGET_MS = 10_000 as const;

/** The two per-stage p95 budgets the benchmark asserts against. */
export interface SyncLatencyBudget {
  readonly gbrainSearchVisibilityP95Ms: number;
  readonly readModelP95Ms: number;
}

/** The recorded default budget (the EVALUATION_CRITERIA acceptance-matrix rows). */
export const DEFAULT_SYNC_LATENCY_BUDGET: SyncLatencyBudget = {
  gbrainSearchVisibilityP95Ms: GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS,
  readModelP95Ms: READ_MODEL_P95_BUDGET_MS,
};

// ── Samples & report shapes ─────────────────────────────────────────────────

/** The named stages of the budgeted hot path. */
export type SyncLatencyStage = "gbrain_search_visibility" | "read_model";

/**
 * One trial: from a single KnowledgeWriter commit, the elapsed time until the
 * fact is (a) visible via GBrain search and (b) reflected in the dashboard
 * read-model. Both are measured from the SAME commit, so they share a trial.
 */
export interface SyncTrialSample {
  readonly commitToSearchVisibleMs: number;
  readonly commitToReadModelMs: number;
}

/** Per-stage assessment against its budget. */
export interface StageBudgetResult {
  readonly stage: SyncLatencyStage;
  readonly p95Ms: number;
  readonly budgetMs: number;
  readonly status: "within_budget" | "over_budget";
  readonly trials: number;
}

/** The benchmark report: per-stage p95 vs budget + an overall pass flag. */
export interface SyncLatencyReport {
  readonly trials: number;
  readonly stages: readonly StageBudgetResult[];
  readonly allWithinBudget: boolean;
}

/** Typed failure variants — no throw crosses the boundary (§16). */
export type SyncLatencyError =
  | { readonly code: "empty_samples" }
  | { readonly code: "invalid_sample"; readonly detail: string }
  | { readonly code: "probe_failed"; readonly detail: string };

// ── Pure statistics ─────────────────────────────────────────────────────────

/**
 * p95 by the nearest-rank method over an ASCENDING-sorted, non-empty array.
 * rank = ceil(p/100 · n); returns the value at 1-based `rank` (index rank-1),
 * clamped into range. Deterministic — a fixed sample set yields a fixed p95, and
 * it is NOT the max outlier (the top ~5% may exceed p95 without breaching it).
 */
export function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[idx] as number;
}

function isValidMs(x: number): boolean {
  return Number.isFinite(x) && x >= 0;
}

function assessStage(
  stage: SyncLatencyStage,
  valuesMs: readonly number[],
  budgetMs: number,
): StageBudgetResult {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const p95Ms = percentileNearestRank(sorted, 95);
  return {
    stage,
    p95Ms,
    budgetMs,
    status: p95Ms <= budgetMs ? "within_budget" : "over_budget",
    trials: valuesMs.length,
  };
}

// ── Deterministic assessment core ───────────────────────────────────────────

/**
 * Assess a collected set of trials against the p95 budgets. Pure + deterministic:
 * no clock, no network. Returns a typed Result — `empty_samples` when there is
 * nothing to measure, `invalid_sample` on a non-finite/negative duration.
 */
export function assessSyncLatency(
  samples: readonly SyncTrialSample[],
  budget: SyncLatencyBudget = DEFAULT_SYNC_LATENCY_BUDGET,
): Result<SyncLatencyReport, SyncLatencyError> {
  if (samples.length === 0) {
    return err({ code: "empty_samples" });
  }
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] as SyncTrialSample;
    if (!isValidMs(s.commitToSearchVisibleMs)) {
      return err({ code: "invalid_sample", detail: `commitToSearchVisibleMs@${i}` });
    }
    if (!isValidMs(s.commitToReadModelMs)) {
      return err({ code: "invalid_sample", detail: `commitToReadModelMs@${i}` });
    }
  }

  const searchStage = assessStage(
    "gbrain_search_visibility",
    samples.map((s) => s.commitToSearchVisibleMs),
    budget.gbrainSearchVisibilityP95Ms,
  );
  const readStage = assessStage(
    "read_model",
    samples.map((s) => s.commitToReadModelMs),
    budget.readModelP95Ms,
  );

  const stages: readonly StageBudgetResult[] = [searchStage, readStage];
  return ok({
    trials: samples.length,
    stages,
    allWithinBudget: stages.every((s) => s.status === "within_budget"),
  });
}

// ── Probe runner (real-gbrain path, key-gated) ──────────────────────────────

/**
 * A probe that performs ONE real trial: commit a fixture via KnowledgeWriter, poll
 * until it is search-visible + read-model-reflected, and return the two elapsed
 * durations. Injected — the harness never talks to gbrain directly. Returns a
 * Result so a probe failure surfaces as a typed error, never a throw.
 */
export type SyncLatencyProbe = () => Promise<Result<SyncTrialSample, string>>;

/**
 * Run `trials` probe iterations, collect the samples, and assess them against the
 * budget. A single probe failure aborts with a typed `probe_failed` error (a
 * degraded trial makes the p95 meaningless — better to fail loud than silently
 * shrink the sample set).
 */
export async function runSyncLatencyBenchmark(
  probe: SyncLatencyProbe,
  trials: number,
  budget: SyncLatencyBudget = DEFAULT_SYNC_LATENCY_BUDGET,
): Promise<Result<SyncLatencyReport, SyncLatencyError>> {
  const samples: SyncTrialSample[] = [];
  for (let i = 0; i < trials; i += 1) {
    const r = await probe();
    if (!r.ok) {
      return err({ code: "probe_failed", detail: `${r.error}@trial${i}` });
    }
    samples.push(r.value);
  }
  return assessSyncLatency(samples, budget);
}

/** Env key that opts a session into the real-gbrain benchmark run. */
export const SYNC_LATENCY_BENCH_ENV_KEY = "SOW_RUN_SYNC_LATENCY_BENCH" as const;

/**
 * Key-gated wrapper: like the conformance harness's `*IfKeyed`, this SKIPS the
 * real run by default (returns `undefined`) and executes only when the env key is
 * set. Keeps the perf/latency assertion off the per-slice CI loop (LESSONS/forbidden
 * pattern: no flaky timing in RED/GREEN) while still shipping the harness + fixtures.
 */
export async function runSyncLatencyBenchmarkIfKeyed(
  probe: SyncLatencyProbe,
  trials: number,
  env: Readonly<Record<string, string | undefined>>,
  budget: SyncLatencyBudget = DEFAULT_SYNC_LATENCY_BUDGET,
): Promise<Result<SyncLatencyReport, SyncLatencyError> | undefined> {
  if (!env[SYNC_LATENCY_BENCH_ENV_KEY]) {
    return undefined;
  }
  return runSyncLatencyBenchmark(probe, trials, budget);
}
