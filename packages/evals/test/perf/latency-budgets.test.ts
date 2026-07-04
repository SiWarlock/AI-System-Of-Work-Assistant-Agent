// spec(§12/§5.4 · task 12.21) — performance & latency budgets, wired to EVAL-1.
//
// The three budgeted hot paths (dashboard warm-load < 2s, KW→GBrain search
// visibility ≤ 60s p95, KW→dashboard read-model ≤ 10s p95, REQ-NF-002/003) are
// measured by the deterministic benchmark cores (`assessSyncLatency`,
// `assessDashboardWarmLoad`) and SCORED through the 12.1 runner's metric criteria.
//
// This test is DETERMINISTIC over INJECTED samples — it is NOT the real-timing
// benchmark (the `*.bench.ts` cadence owns that, forbidden-pattern #2). It proves:
//   • the registered EVALUATION_CRITERIA thresholds MIRROR the bench budgets (drift guard),
//   • a within-budget p95 scores functionalPass, a regression past budget FAILS,
//   • the runner value is DERIVED from the real bench p95 (not hardcoded), and
//   • DoD honesty: these are requiresRealIntegration=true, so a synthetic-sample run
//     is functionally-passing but NOT DoD-certified (real warmed-integration run pending).
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import {
  GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS,
  READ_MODEL_P95_BUDGET_MS,
  assessSyncLatency,
  type SyncTrialSample,
} from "../../src/benchmarks/knowledge-sync-latency.bench";
import {
  DASHBOARD_WARM_LOAD_BUDGET_MS,
  assessDashboardWarmLoad,
} from "../../src/benchmarks/dashboard-warmload.bench";
import { criterionById, type Threshold } from "../../src/harness/criteria-registry";
import { scoreById } from "../../src/harness/runner";

const p95OfStage = (samples: readonly SyncTrialSample[], stage: string): number => {
  const r = assessSyncLatency(samples);
  if (!isOk(r)) throw new Error(`assessSyncLatency failed`);
  const s = r.value.stages.find((x) => x.stage === stage);
  if (s === undefined) throw new Error(`no stage ${stage}`);
  return s.p95Ms;
};
const warmP95 = (samplesMs: readonly number[]): number => {
  const r = assessDashboardWarmLoad(samplesMs);
  if (!isOk(r)) throw new Error("assessDashboardWarmLoad failed");
  return r.value.p95Ms;
};

// within-budget sample sets
const okSync: readonly SyncTrialSample[] = Array.from({ length: 20 }, (_, i) => ({
  commitToSearchVisibleMs: 3_000 + i * 500, // p95 well under 60s
  commitToReadModelMs: 500 + i * 100, // p95 well under 10s
}));
const okWarm: readonly number[] = Array.from({ length: 20 }, (_, i) => 200 + i * 60); // p95 < 2s

// regression sample sets (p95 breaches the budget)
const slowSync: readonly SyncTrialSample[] = Array.from({ length: 20 }, () => ({
  commitToSearchVisibleMs: 70_000, // p95 > 60s
  commitToReadModelMs: 12_000, // p95 > 10s
}));
const slowWarm: readonly number[] = Array.from({ length: 20 }, () => 3_000); // p95 > 2s

const maxValue = (t: Threshold): number => {
  if (t.kind !== "max") throw new Error("expected a max threshold");
  return t.value;
};

describe("12.21 — recorded thresholds mirror EVALUATION_CRITERIA (drift guard)", () => {
  it("registers the three latency budgets as `max`-ms metric criteria matching the bench budgets", () => {
    const gbrain = criterionById("SYNC_LATENCY_GBRAIN_P95");
    const dash = criterionById("SYNC_LATENCY_DASHBOARD_P95");
    const warm = criterionById("DASHBOARD_WARMLOAD_P95");
    for (const c of [gbrain, dash, warm]) {
      expect(c).toBeDefined();
      expect(c!.threshold.kind).toBe("max");
      expect((c!.threshold as { unit: string }).unit).toBe("ms");
      expect(c!.requiresRealIntegration).toBe(true); // §20.2: real warmed integration
    }
    expect(maxValue(gbrain!.threshold)).toBe(GBRAIN_SEARCH_VISIBILITY_P95_BUDGET_MS);
    expect(maxValue(dash!.threshold)).toBe(READ_MODEL_P95_BUDGET_MS);
    expect(maxValue(warm!.threshold)).toBe(DASHBOARD_WARM_LOAD_BUDGET_MS);
  });
});

describe("12.21 — a within-budget p95 scores functionally-passing (value derived from the bench)", () => {
  it("KW→GBrain search visibility p95 within 60s", () => {
    const out = scoreById({
      criterionId: "SYNC_LATENCY_GBRAIN_P95",
      value: p95OfStage(okSync, "gbrain_search_visibility"),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
  });
  it("KW→dashboard read-model p95 within 10s", () => {
    const out = scoreById({
      criterionId: "SYNC_LATENCY_DASHBOARD_P95",
      value: p95OfStage(okSync, "read_model"),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
  });
  it("dashboard warm-load p95 within 2s", () => {
    const out = scoreById({
      criterionId: "DASHBOARD_WARMLOAD_P95",
      value: warmP95(okWarm),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
  });
});

describe("12.21 — a regression past budget FAILS the benchmark", () => {
  it("search-visibility p95 over 60s ⇒ functionalPass false", () => {
    const out = scoreById({
      criterionId: "SYNC_LATENCY_GBRAIN_P95",
      value: p95OfStage(slowSync, "gbrain_search_visibility"),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(false);
  });
  it("read-model p95 over 10s ⇒ functionalPass false", () => {
    const out = scoreById({
      criterionId: "SYNC_LATENCY_DASHBOARD_P95",
      value: p95OfStage(slowSync, "read_model"),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(false);
  });
  it("warm-load p95 over 2s ⇒ functionalPass false", () => {
    const out = scoreById({
      criterionId: "DASHBOARD_WARMLOAD_P95",
      value: warmP95(slowWarm),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(false);
  });
});

describe("12.21 — DoD honesty: latency budgets need a real warmed-integration run", () => {
  it("a synthetic-sample run is functionally-passing but NOT DoD-certified", () => {
    const out = scoreById({
      criterionId: "DASHBOARD_WARMLOAD_P95",
      value: warmP95(okWarm),
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
    expect(out.reason).toContain("DoD-INVALID");
  });
  it("would be DoD-certified from a real warmed-integration measurement", () => {
    const out = scoreById({
      criterionId: "DASHBOARD_WARMLOAD_P95",
      value: warmP95(okWarm),
      fromRealIntegration: true,
    });
    expect(out.dodPass).toBe(true);
  });
});
