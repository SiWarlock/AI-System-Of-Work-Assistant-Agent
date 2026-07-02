// spec(§12/§18) — Dashboard warm-load benchmark (task 8.8, REQ-NF-002).
//
// THE SOLE timing gate for the dashboard-serve hot path. It instruments the Global
// Today Dashboard warm-load served THROUGH the real §10 query path — the 8.3
// `buildQueryRouter` `dashboard` procedure — over a representative fake read-model,
// and asserts warm-load < 2s (REQ-NF-002; §18 HARD GATE). Per the IMPLEMENTATION_PLAN
// this is the ONLY per-serve timing assertion on the dashboard hot path: no
// per-procedure latency assertions live elsewhere (the KW→GBrain / KW→dashboard
// p95 budgets are the knowledge/worker pipeline's `knowledge-sync-latency.bench.ts`,
// not here).
//
// SHAPE (mirrors `knowledge-sync-latency.bench.ts`): a deterministic, PURE assessment
// core over INJECTED serve-duration samples (no clock, no network, no randomness),
// plus a serve PROBE that drives the ACTUAL 8.3 query router in-process via tRPC
// `createCallerFactory` (no socket) with an INJECTED clock, plus a key-gated runner
// for a real timed run. Keeping wall-clock timing off the per-slice RED/GREEN loop is
// the evals forbidden-pattern (#2: no flaky timing assertions per slice) — the unit
// tests inject synthetic samples + a monotone fake clock; a real run injects
// `performance.now`. Every cross-boundary function returns a typed Result — never
// throws (§16).
import type { Result, FailureVariant } from "@sow/contracts";
import { ok, err, isOk, failure } from "@sow/contracts";
// The REAL §10 query path (8.3) — served in-process, no HTTP round-trip. This is
// what makes the benchmark measure the actual dashboard-serve hot path rather than a
// stand-in: the same `buildQueryRouter` the desktop app calls, the same UI-safe
// projection, the same `authedResolver` boundary.
import { buildQueryRouter, type ReadModelQueryPort } from "@sow/worker/api/procedures/queries";
import { router } from "@sow/worker/api/router";
import { createCallerFactory, type ApiContext } from "@sow/worker/api/trpc";
import type { AuthedContext } from "@sow/worker/api/auth/sessionAuth";
import type { DashboardCardSource } from "@sow/worker/api/projections/uiSafe";

// ── Recorded budget (REQ-NF-002 / §18 hard gate) ─────────────────────────────

/** Global Today Dashboard warm-load budget: < 2 seconds (the EVALUATION_CRITERIA row). */
export const DASHBOARD_WARM_LOAD_BUDGET_MS = 2_000 as const;

/** The single warm-load budget the benchmark asserts against. */
export interface DashboardWarmLoadBudget {
  readonly warmLoadMs: number;
}

/** The recorded default budget (the EVALUATION_CRITERIA acceptance-matrix row). */
export const DEFAULT_DASHBOARD_WARM_LOAD_BUDGET: DashboardWarmLoadBudget = {
  warmLoadMs: DASHBOARD_WARM_LOAD_BUDGET_MS,
};

// ── Report + failure shapes ──────────────────────────────────────────────────

/** The benchmark report: p95 warm-load vs the budget + a pass/fail status. */
export interface DashboardWarmLoadReport {
  readonly trials: number;
  readonly p95Ms: number;
  readonly budgetMs: number;
  readonly status: "within_budget" | "over_budget";
}

/** Typed failure variants — no throw crosses the boundary (§16). */
export type DashboardWarmLoadError =
  | { readonly code: "empty_samples" }
  | { readonly code: "invalid_sample"; readonly detail: string }
  | { readonly code: "probe_failed"; readonly detail: string };

// ── Pure statistics ──────────────────────────────────────────────────────────

/**
 * p95 by the nearest-rank method over an ASCENDING-sorted, non-empty array.
 * rank = ceil(p/100 · n); value at 1-based `rank` (index rank-1), clamped into
 * range. Deterministic — a fixed sample set yields a fixed p95, and it is NOT the
 * max outlier (the top ~5% may exceed p95 without breaching it).
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

// ── Deterministic assessment core ────────────────────────────────────────────

/**
 * Assess a set of collected warm-load serve durations against the budget. Pure +
 * deterministic: no clock, no network. Returns a typed Result — `empty_samples`
 * when there is nothing to measure, `invalid_sample` on a non-finite/negative
 * duration. `status` is `within_budget` iff the nearest-rank p95 is STRICTLY under
 * the budget (< 2s, not ≤).
 */
export function assessDashboardWarmLoad(
  samplesMs: readonly number[],
  budget: DashboardWarmLoadBudget = DEFAULT_DASHBOARD_WARM_LOAD_BUDGET,
): Result<DashboardWarmLoadReport, DashboardWarmLoadError> {
  if (samplesMs.length === 0) {
    return err({ code: "empty_samples" });
  }
  for (let i = 0; i < samplesMs.length; i += 1) {
    const v = samplesMs[i] as number;
    if (!isValidMs(v)) {
      return err({ code: "invalid_sample", detail: `warmLoadMs@${i}` });
    }
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const p95Ms = percentileNearestRank(sorted, 95);
  return ok({
    trials: samplesMs.length,
    p95Ms,
    budgetMs: budget.warmLoadMs,
    status: p95Ms < budget.warmLoadMs ? "within_budget" : "over_budget",
  });
}

// ── Representative fake read-model (served through the real 8.3 path) ─────────

/**
 * A monotone clock the probe reads to bracket ONE served warm-load. Injected so the
 * unit path is deterministic (a fake step clock) and a real run injects
 * `performance.now`. Returns milliseconds.
 */
export type Clock = () => number;

/**
 * Build a representative fake `ReadModelQueryPort` whose `dashboardCards()` serves
 * `cardCount` UI-safe-source dashboard cards — a realistic Global Today card set for
 * the served projection to walk. Only `dashboardCards` is exercised by the 8.8 hot
 * path; the other read-model methods fail-closed (they are out of scope for this
 * benchmark and must never be silently served here).
 *
 * @param cardCount   number of representative dashboard cards to serve.
 * @param onServe     optional side-effect run once per `dashboardCards()` call — the
 *                    test uses it to prove the served path actually reached the port.
 * @param failClosed  when true, `dashboardCards()` returns a typed fail-closed err
 *                    (models a degraded read-model), so the probe surfaces a typed
 *                    probe failure rather than a polluting timing sample.
 */
export function makeRepresentativeReadModel(
  cardCount: number,
  onServe?: () => void,
  failClosed = false,
): ReadModelQueryPort {
  const cards: readonly DashboardCardSource[] = Array.from({ length: cardCount }, (_, i) => ({
    cardId: `card_${i}`,
    kind: "global_today",
    title: `Card ${i}`,
    status: "ok",
    count: i,
    updatedAt: "2026-06-30T00:00:00.000Z",
  }));

  const outOfScope = (): Result<never, FailureVariant> =>
    err(
      failure("degraded_unavailable", "not served by the warm-load benchmark", {
        cause: { code: "BENCH_OUT_OF_SCOPE" },
      }),
    );

  return {
    dashboardCards: (): Result<readonly DashboardCardSource[], FailureVariant> => {
      onServe?.();
      if (failClosed) {
        return err(
          failure("degraded_unavailable", "read-model degraded", {
            cause: { code: "READ_MODEL_DEGRADED" },
          }),
        );
      }
      return ok(cards);
    },
    workspaceCards: outOfScope,
    projectCards: outOfScope,
    ingestionInbox: outOfScope,
    approvalInbox: outOfScope,
    copilotSurface: outOfScope,
    globalSurface: outOfScope,
  };
}

// ── The serve probe: drive the REAL 8.3 dashboard procedure ───────────────────

/** Dependencies for {@link makeDashboardServeProbe}. */
export interface DashboardServeProbeDeps {
  /** The read-model the 8.3 `dashboard` procedure serves (a representative fake). */
  readonly readModel: ReadModelQueryPort;
  /** The clock bracketing one served warm-load (fake step in tests, `performance.now` for a real run). */
  readonly now: Clock;
}

/**
 * A probe that performs ONE warm-load trial: it invokes the REAL 8.3 `dashboard`
 * query in-process (through `buildQueryRouter` + tRPC `createCallerFactory` — the
 * same served path the desktop app hits) and returns the elapsed serve time in ms.
 * Injected into the runner so the harness itself owns no clock. Returns a Result so
 * a degraded serve (the `dashboard` query returned an `err` as data, or the caller
 * threw) surfaces as a typed error — never a throw, never a polluting timing sample.
 */
export type DashboardServeProbe = () => Promise<Result<number, string>>;

/**
 * The authenticated context the served query runs under. The 8.1 interceptor +
 * per-launch token verification is NOT the surface under test here (it has its own
 * suite); the warm-load benchmark measures the post-auth serve cost, so it supplies
 * an already-authenticated context (the auth gate already passed).
 */
const AUTHED_CTX: ApiContext = {
  auth: ok<AuthedContext>({ authenticated: true }),
};

/**
 * Build a {@link DashboardServeProbe} that times ONE `dashboard` warm-load through
 * the real 8.3 query router. The caller is built ONCE per probe invocation over an
 * app router mounting only the query router (matching how 8.3's own suite exercises
 * it), so the measured window brackets exactly the served-query cost.
 */
export function makeDashboardServeProbe(deps: DashboardServeProbeDeps): DashboardServeProbe {
  const { readModel, now } = deps;
  const appRouter = router({ query: buildQueryRouter({ readModel }) });
  const factory = createCallerFactory(appRouter);
  const caller = factory(AUTHED_CTX);

  return async (): Promise<Result<number, string>> => {
    const start = now();
    try {
      // The served DATA is a typed Result — an err means the read-model / boundary
      // failed closed; that is a degraded serve, not a valid timing sample.
      const served = await caller.query.dashboard();
      const elapsed = now() - start;
      if (!isOk(served)) {
        return err(`dashboard_serve_err:${served.error.kind}`);
      }
      return ok(elapsed);
    } catch {
      // Redaction-safe: no raw thrown detail crosses — a fixed code only.
      return err("dashboard_serve_threw");
    }
  };
}

// ── Runner over the injected probe + key-gate ─────────────────────────────────

/**
 * Run `trials` warm-load serves through the injected probe, collect the durations,
 * and assess them against the budget. A single probe failure aborts with a typed
 * `probe_failed` error — a degraded serve makes the p95 meaningless, so fail loud
 * rather than silently shrink the sample set.
 */
export async function runDashboardWarmLoadBenchmark(
  probe: DashboardServeProbe,
  trials: number,
  budget: DashboardWarmLoadBudget = DEFAULT_DASHBOARD_WARM_LOAD_BUDGET,
): Promise<Result<DashboardWarmLoadReport, DashboardWarmLoadError>> {
  const samples: number[] = [];
  for (let i = 0; i < trials; i += 1) {
    const r = await probe();
    if (!r.ok) {
      return err({ code: "probe_failed", detail: `${r.error}@trial${i}` });
    }
    samples.push(r.value);
  }
  return assessDashboardWarmLoad(samples, budget);
}

/** Env key that opts a session into the real timed warm-load run. */
export const DASHBOARD_WARMLOAD_BENCH_ENV_KEY = "SOW_RUN_DASHBOARD_WARMLOAD_BENCH" as const;

/**
 * Key-gated wrapper: like the conformance harness's `*IfKeyed`, this SKIPS the real
 * timed run by default (returns `undefined`) and executes only when the env key is
 * set. Keeps the wall-clock timing assertion off the per-slice CI loop (evals
 * forbidden-pattern #2: no flaky timing in RED/GREEN) while still shipping the
 * harness + the served-path probe.
 */
export async function runDashboardWarmLoadBenchmarkIfKeyed(
  probe: DashboardServeProbe,
  trials: number,
  env: Readonly<Record<string, string | undefined>>,
  budget: DashboardWarmLoadBudget = DEFAULT_DASHBOARD_WARM_LOAD_BUDGET,
): Promise<Result<DashboardWarmLoadReport, DashboardWarmLoadError> | undefined> {
  if (!env[DASHBOARD_WARMLOAD_BENCH_ENV_KEY]) {
    return undefined;
  }
  return runDashboardWarmLoadBenchmark(probe, trials, budget);
}
