// spec(§12/§18) — dashboard warm-load benchmark (task 8.8, REQ-NF-002). The SOLE
// timing gate for the dashboard-serve hot path: Global Today Dashboard warm-load
// served THROUGH the real §10 query path (8.3 `buildQueryRouter` dashboard
// procedure) over a representative fake read-model, asserting warm-load < 2s.
//
// Deterministic core over INJECTED samples + an INJECTED clock — no real
// wall-clock in the RED/GREEN loop (evals forbidden-pattern #2: no flaky timing
// assertions per-slice). The serve probe drives the ACTUAL 8.3 query router via
// tRPC `createCallerFactory` (no socket); the read-model is a fake port. Never
// throws (§16) — every boundary returns a typed Result.
import { describe, expect, it } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  DASHBOARD_WARM_LOAD_BUDGET_MS,
  DEFAULT_DASHBOARD_WARM_LOAD_BUDGET,
  assessDashboardWarmLoad,
  makeRepresentativeReadModel,
  makeDashboardServeProbe,
  runDashboardWarmLoadBenchmark,
  runDashboardWarmLoadBenchmarkIfKeyed,
  DASHBOARD_WARMLOAD_BENCH_ENV_KEY,
  type DashboardWarmLoadBudget,
  type DashboardServeProbe,
} from "../../src/benchmarks/dashboard-warmload.bench";

// ── Recorded threshold ────────────────────────────────────────────────────────

describe("recorded threshold — spec(§18 hard gate, REQ-NF-002)", () => {
  it("pins the dashboard warm-load budget at < 2s (2000ms)", () => {
    expect(DASHBOARD_WARM_LOAD_BUDGET_MS).toBe(2_000);
    expect(DEFAULT_DASHBOARD_WARM_LOAD_BUDGET).toEqual({ warmLoadMs: 2_000 });
  });
});

// ── Pure assessment core (deterministic, injected samples) ────────────────────

describe("assessDashboardWarmLoad — spec(§12)", () => {
  // 20 within-budget serve durations: p95 (nearest-rank) = 19th value.
  const withinBudget: readonly number[] = Array.from({ length: 20 }, (_, i) => 100 + i * 20);

  it("reports within budget for a compliant sample set", () => {
    const r = assessDashboardWarmLoad(withinBudget);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.trials).toBe(20);
    expect(r.value.budgetMs).toBe(2_000);
    expect(r.value.status).toBe("within_budget");
    // nearest-rank p95 over 100..480 step 20 → 19th value (index 18) = 460.
    expect(r.value.p95Ms).toBe(460);
  });

  it("computes p95 by nearest-rank (deterministic, NOT the max outlier)", () => {
    // 19 fast serves + 1 slow outlier: the outlier sits ABOVE p95, so p95 passes.
    const samples = [...Array.from({ length: 19 }, () => 300), 9_999];
    const r = assessDashboardWarmLoad(samples);
    if (!isOk(r)) throw new Error("expected ok");
    expect(r.value.p95Ms).toBe(300);
    expect(r.value.status).toBe("within_budget");
  });

  it("flags OVER budget when p95 breaches 2s", () => {
    // All 20 serves at 2100ms → p95 = 2100 > 2000.
    const samples = Array.from({ length: 20 }, () => 2_100);
    const r = assessDashboardWarmLoad(samples);
    if (!isOk(r)) throw new Error("expected ok");
    expect(r.value.status).toBe("over_budget");
    expect(r.value.p95Ms).toBe(2_100);
  });

  it("honors a caller-supplied stricter budget", () => {
    const strict: DashboardWarmLoadBudget = { warmLoadMs: 400 };
    const r = assessDashboardWarmLoad(withinBudget, strict);
    if (!isOk(r)) throw new Error("expected ok");
    // p95 = 460 > 400 → over the stricter budget.
    expect(r.value.status).toBe("over_budget");
  });

  it("returns a typed Err (never a throw) on empty samples", () => {
    const r = assessDashboardWarmLoad([]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("empty_samples");
  });

  it("returns a typed Err on a non-finite / negative sample", () => {
    expect(isErr(assessDashboardWarmLoad([-1]))).toBe(true);
    const nan = assessDashboardWarmLoad([Number.NaN]);
    expect(isErr(nan)).toBe(true);
    if (!isErr(nan)) return;
    expect(nan.error.code).toBe("invalid_sample");
  });
});

// ── The serve probe drives the REAL 8.3 query path ────────────────────────────

describe("makeDashboardServeProbe — serves THROUGH buildQueryRouter (§10 query path)", () => {
  it("times ONE dashboard warm-load through the real 8.3 dashboard procedure, injected clock", async () => {
    // Injected monotone clock: each `now()` call advances by a fixed step, so the
    // measured serve duration is deterministic (step ms) — no real wall-clock.
    let t = 0;
    const step = 37;
    const clock = (): number => {
      const v = t;
      t += step;
      return v;
    };
    const probe = makeDashboardServeProbe({
      readModel: makeRepresentativeReadModel(12),
      now: clock,
    });
    const r = await probe();
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    // Exactly one clock delta straddles the served call → the step.
    expect(r.value).toBe(step);
  });

  it("actually EXERCISES the served dashboard cards (representative read-model reaches the projection)", async () => {
    // If the probe short-circuited the 8.3 procedure it would not observe the
    // served cards. We prove the served result carried the representative cards by
    // spying the read-model's card-serve count via a probe over a counting port.
    let served = 0;
    const counting = makeRepresentativeReadModel(5, () => {
      served += 1;
    });
    const probe = makeDashboardServeProbe({ readModel: counting, now: () => 0 });
    const r = await probe();
    expect(isOk(r)).toBe(true);
    // The 8.3 `dashboard` procedure called `readModel.dashboardCards()` exactly once.
    expect(served).toBe(1);
  });

  it("propagates a serve failure as a typed probe error (never throws)", async () => {
    // A read-model that fails-closed → the served `dashboard` query returns an err
    // as DATA; the probe surfaces that as a typed probe failure, not a thrown clock
    // sample that would pollute the p95.
    const probe = makeDashboardServeProbe({
      readModel: makeRepresentativeReadModel(0, undefined, /* failClosed */ true),
      now: () => 0,
    });
    const r = await probe();
    expect(isErr(r)).toBe(true);
  });
});

// ── Runner over the injected probe + key-gate ─────────────────────────────────

describe("runDashboardWarmLoadBenchmark — spec(§12)", () => {
  it("collects N timed serves and asserts them within budget", async () => {
    let n = 0;
    const probe: DashboardServeProbe = () => {
      n += 1;
      return Promise.resolve({ ok: true, value: 100 * n });
    };
    const r = await runDashboardWarmLoadBenchmark(probe, 5);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.trials).toBe(5);
    expect(r.value.status).toBe("within_budget");
  });

  it("propagates a probe failure as a typed Err (never throws)", async () => {
    const probe: DashboardServeProbe = () => Promise.resolve({ ok: false, error: "serve_degraded" });
    const r = await runDashboardWarmLoadBenchmark(probe, 3);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("probe_failed");
  });
});

describe("runDashboardWarmLoadBenchmarkIfKeyed — spec(§12)", () => {
  const probe: DashboardServeProbe = () => Promise.resolve({ ok: true, value: 250 });

  it("SKIPS the real timed run by default (no env key — off the per-slice loop)", async () => {
    const skipped = await runDashboardWarmLoadBenchmarkIfKeyed(probe, 3, {});
    expect(skipped).toBeUndefined();
  });

  it("runs when the env key is set", async () => {
    const r = await runDashboardWarmLoadBenchmarkIfKeyed(probe, 3, {
      [DASHBOARD_WARMLOAD_BENCH_ENV_KEY]: "1",
    });
    expect(r).toBeDefined();
    expect(r && isOk(r)).toBe(true);
  });
});
