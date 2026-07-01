// spec(§12) — knowledge-sync latency benchmark: KnowledgeWriter-commit →
// GBrain-search-visibility (≤60s p95) → dashboard-read-model (≤10s p95). This is
// the SOLE timing-assertion path (REQ-NF-003). Deterministic core over INJECTED
// samples/probe — no real gbrain, no clock, no network. Never throws (§16).
import { describe, expect, it } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS,
  READ_MODEL_P95_BUDGET_MS,
  DEFAULT_SYNC_LATENCY_BUDGET,
  assessSyncLatency,
  runSyncLatencyBenchmark,
  runSyncLatencyBenchmarkIfKeyed,
  type SyncTrialSample,
  type SyncLatencyProbe,
} from "../../src/benchmarks/knowledge-sync-latency.bench";

/** A within-budget trial: search visible well under 60s, read-model under 10s. */
function trial(searchMs: number, readMs: number): SyncTrialSample {
  return { commitToSearchVisibleMs: searchMs, commitToReadModelMs: readMs };
}

/** 20 deterministic within-budget trials (p95 comfortably under both budgets). */
const withinBudgetSamples: readonly SyncTrialSample[] = Array.from({ length: 20 }, (_, i) =>
  trial(1_000 + i * 500, 200 + i * 100),
);

describe("recorded budget thresholds — spec(§12)", () => {
  it("pins the REQ-NF-003 p95 budgets (60s search-visible, 10s read-model)", () => {
    expect(GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS).toBe(60_000);
    expect(READ_MODEL_P95_BUDGET_MS).toBe(10_000);
    expect(DEFAULT_SYNC_LATENCY_BUDGET).toEqual({
      gbrainSearchVisibilityP95Ms: 60_000,
      readModelP95Ms: 10_000,
    });
  });
});

describe("assessSyncLatency — spec(§12)", () => {
  it("reports BOTH stages within budget for compliant samples", () => {
    const r = assessSyncLatency(withinBudgetSamples);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const report = r.value;
    expect(report.trials).toBe(20);
    expect(report.allWithinBudget).toBe(true);
    const search = report.stages.find((s) => s.stage === "gbrain_search_visibility");
    const read = report.stages.find((s) => s.stage === "read_model");
    expect(search?.status).toBe("within_budget");
    expect(search?.budgetMs).toBe(60_000);
    expect(read?.status).toBe("within_budget");
    expect(read?.budgetMs).toBe(10_000);
  });

  it("computes p95 by nearest-rank (deterministic, not the max outlier)", () => {
    // 20 sorted search values 1000..10500 step 500 → nearest-rank p95 = 19th value = 10000.
    const r = assessSyncLatency(withinBudgetSamples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.p95Ms).toBe(10_000);
  });

  it("flags the GBrain-search stage OVER budget when p95 exceeds 60s", () => {
    // 19 fast + 1 slow would still pass p95; make the top 5% breach: 20 all at 61s search.
    const samples = Array.from({ length: 20 }, () => trial(61_000, 500));
    const r = assessSyncLatency(samples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.status).toBe("over_budget");
    expect(r.value.allWithinBudget).toBe(false);
  });

  it("flags the read-model stage OVER budget independently of the search stage", () => {
    const samples = Array.from({ length: 20 }, () => trial(2_000, 11_000));
    const r = assessSyncLatency(samples);
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    const read = r.value.stages.find((s) => s.stage === "read_model");
    expect(search?.status).toBe("within_budget");
    expect(read?.status).toBe("over_budget");
    expect(r.value.allWithinBudget).toBe(false);
  });

  it("honors a caller-supplied stricter budget", () => {
    const r = assessSyncLatency(withinBudgetSamples, {
      gbrainSearchVisibilityP95Ms: 5_000,
      readModelP95Ms: 10_000,
    });
    if (!isOk(r)) throw new Error("expected ok");
    const search = r.value.stages.find((s) => s.stage === "gbrain_search_visibility");
    expect(search?.status).toBe("over_budget");
  });

  it("returns a typed Err (not a throw) on empty samples", () => {
    const r = assessSyncLatency([]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("empty_samples");
  });

  it("returns a typed Err on a non-finite / negative sample", () => {
    const r = assessSyncLatency([trial(-1, 200)]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("invalid_sample");
  });
});

describe("runSyncLatencyBenchmark (injected probe) — spec(§12)", () => {
  it("collects N trials from the probe and assesses them", async () => {
    let n = 0;
    const probe: SyncLatencyProbe = () => {
      n += 1;
      return Promise.resolve({ ok: true, value: trial(1_000 * n, 100 * n) });
    };
    const r = await runSyncLatencyBenchmark(probe, 5);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.trials).toBe(5);
    expect(r.value.allWithinBudget).toBe(true);
  });

  it("propagates a probe failure as a typed Err (never throws)", async () => {
    const probe: SyncLatencyProbe = () => Promise.resolve({ ok: false, error: "gbrain_unreachable" });
    const r = await runSyncLatencyBenchmark(probe, 3);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("probe_failed");
  });
});

describe("runSyncLatencyBenchmarkIfKeyed — spec(§12)", () => {
  const probe: SyncLatencyProbe = () => Promise.resolve({ ok: true, value: trial(1_000, 200) });

  it("SKIPS the real-gbrain run by default (no env key)", async () => {
    const skipped = await runSyncLatencyBenchmarkIfKeyed(probe, 3, {});
    expect(skipped).toBeUndefined();
  });

  it("runs when the env key is set", async () => {
    const r = await runSyncLatencyBenchmarkIfKeyed(probe, 3, { SOW_RUN_SYNC_LATENCY_BENCH: "1" });
    expect(r).toBeDefined();
    expect(r && isOk(r)).toBe(true);
  });
});
