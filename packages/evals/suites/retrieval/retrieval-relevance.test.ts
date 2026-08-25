// spec(§20.1 · §5.4 · KN-10) — task 12.1/13.1c: the retrieval RELEVANCE (usefulness)
// bar. RETRIEVAL_RELEVANCE (criteria-registry.ts, metric "retrieval-usefulness",
// threshold min 0.9) asks a DIFFERENT question than RETRIEVAL_CORPUS/recall.ts:
// recall asks "was the gold doc retrieved at ALL"; usefulness asks "are the
// RETRIEVED ones the right ones" (precision@K). A system that retrieves everything
// scores recall 1.0 with terrible relevance — recall cannot stand in for this
// criterion (coverage-matrix.test.ts:137-144 explicitly refuses that re-point).
//
// Deterministic / CI-able — recorded embeddings, no live model, no network.
import { describe, it, expect, beforeAll } from "vitest";
import { criterionById } from "../../src/harness/criteria-registry";
import { scoreById } from "../../src/harness/runner";
import { recallAtK } from "../../src/retrieval/recall";
import {
  recordedBackend,
  RETRIEVAL_QUERY_FLOOR,
  RELEVANCE_CORPUS,
  DEGRADED_RELEVANCE_CORPUS,
} from "../../src/retrieval/corpus";
import {
  usefulnessAtK,
  measureUsefulnessAtK,
  USEFULNESS_K,
  RETRIEVAL_USEFULNESS_BAR,
  type UsefulnessReport,
} from "../../src/retrieval/relevance";

describe("usefulnessAtK — the metric itself (precision@K, NOT recall)", () => {
  it("usefulness_is_precision_at_k: |gold ∩ top-K| / K", () => {
    expect(usefulnessAtK(["g", "x", "y", "z"], ["g"], 4)).toBe(0.25);
  });

  it("usefulness_is_not_recall: same input scores recall 1 but usefulness 0.25 (anti-alias control)", () => {
    const ranked = ["g", "x", "y", "z"];
    const gold = ["g"];
    expect(recallAtK(ranked, gold, 4)).toBe(1);
    expect(usefulnessAtK(ranked, gold, 4)).toBe(0.25);
  });

  it("usefulness_handles_short_lists: denominator is min(K, ranked.length), not K", () => {
    // 2-item ranked list, 1 gold hit, k=4 — denominator is min(4,2)=2, not 4.
    expect(usefulnessAtK(["g", "x"], ["g"], 4)).toBe(0.5);
  });

  it("usefulness_of_empty_gold_is_vacuously_scored: mirrors recall.ts:24's convention (1)", () => {
    expect(usefulnessAtK(["a", "b", "c"], [], 4)).toBe(1);
  });
});

describe("§20.1/KN-10 — retrieval usefulness (relevance) bar", () => {
  let report: UsefulnessReport;
  beforeAll(async () => {
    report = await measureUsefulnessAtK(RELEVANCE_CORPUS);
  });

  it("corpus_meets_query_floor: RELEVANCE_CORPUS carries ≥30 labeled queries (A7 floor)", () => {
    expect(RELEVANCE_CORPUS.cases.length).toBeGreaterThanOrEqual(RETRIEVAL_QUERY_FLOOR);
  });

  it("usefulness_meets_bar: measured fused usefulness clears the bar (≥ 0.9)", () => {
    expect(report.cases).toBeGreaterThan(0);
    expect(report.fused).toBeGreaterThanOrEqual(RETRIEVAL_USEFULNESS_BAR);
  });

  it("below_bar_fails_suite: a degraded corpus drops fused usefulness BELOW the bar (non-vacuity)", async () => {
    const degraded = await measureUsefulnessAtK(DEGRADED_RELEVANCE_CORPUS);
    expect(degraded.cases).toBeGreaterThan(0);
    expect(degraded.fused).toBeLessThan(RETRIEVAL_USEFULNESS_BAR);
  });

  it("retrieve_everything_scores_recall_1_but_fails_usefulness: recall cannot substitute for relevance", () => {
    // Rank ALL 40 doc ids (id-ascending) for the first case — "retrieve everything".
    const allIds = [...RELEVANCE_CORPUS.docs.map((d) => d.id)].sort();
    let recallSum = 0;
    let usefulnessSum = 0;
    for (const c of RELEVANCE_CORPUS.cases) {
      recallSum += recallAtK(allIds, c.goldDocIds, allIds.length);
      usefulnessSum += usefulnessAtK(allIds, c.goldDocIds, USEFULNESS_K);
    }
    const n = RELEVANCE_CORPUS.cases.length;
    expect(recallSum / n).toBe(1); // retrieves everything ⇒ recall is trivially perfect
    expect(usefulnessSum / n).toBeLessThan(RETRIEVAL_USEFULNESS_BAR); // but useless
  });

  it("eval_is_zero_egress_local_only: the eval backend is a genuine non-egress (local) backend", () => {
    expect(recordedBackend(RELEVANCE_CORPUS).egressClass).toBe("local");
  });

  it("registry_drift_guard: the registry criterion still points at this suite + this bar", () => {
    const criterion = criterionById("RETRIEVAL_RELEVANCE");
    expect(criterion).toBeDefined();
    expect(criterion?.metric).toBe("retrieval-usefulness");
    expect(criterion?.threshold).toEqual({ kind: "min", value: 0.9, unit: "ratio" });
    expect(criterion?.threshold).toEqual({ kind: "min", value: RETRIEVAL_USEFULNESS_BAR, unit: "ratio" });
    expect(criterion?.suite).toBe("suites/retrieval/retrieval-relevance.test.ts");
  });

  it("dod_honesty: a recorded-corpus measurement is functionally passing but DoD-INVALID", () => {
    // RETRIEVAL_RELEVANCE is requiresRealIntegration:true (criteria-registry.ts:189);
    // this suite's measurement is a recorded fixture, not a real integration — the
    // runner must refuse to certify it DoD-passing, never silently flip the flag.
    const outcome = scoreById({
      criterionId: "RETRIEVAL_RELEVANCE",
      value: report.fused,
      fromRealIntegration: false,
    });
    expect(outcome.functionalPass).toBe(true);
    expect(outcome.dodValid).toBe(false);
    expect(outcome.dodPass).toBe(false);
  });
});
