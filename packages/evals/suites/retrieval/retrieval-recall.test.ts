// spec(§6 · §13.1c · §12) — task 13.3b: the retrieval recall@10 bar.
//
// The §13.1c quality gate for the local-zero-egress retrieval path: scores recall@10
// over a recorded-embedding fixture corpus through knowledge's REAL exported
// `retrieveLocalEmbed` (13.3a hybrid) + `rerank` (13.17), gating the fused (hybrid)
// recall@10 at ≥ 0.91 with a re-ranker no-regression, and confirming the eval stays
// zero-egress (local backend only; a cloud backend for employer-raw fails closed).
// Deterministic / CI-able — no live model, no network (recorded embeddings).
import { describe, it, expect, beforeAll } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import { retrieveLocalEmbed } from "@sow/knowledge";
import {
  RETRIEVAL_CORPUS,
  DEGRADED_CORPUS,
  RECALL_AT_10_BAR,
  RETRIEVAL_QUERY_FLOOR,
  recordedBackend,
} from "../../src/retrieval/corpus";
import { measureRecallAt10, recallAtK, type RecallReport } from "../../src/retrieval/recall";

describe("§13.1c — retrieval recall@10 bar (local-embed 13.3a + re-ranker 13.17)", () => {
  let report: RecallReport;
  beforeAll(async () => {
    report = await measureRecallAt10(RETRIEVAL_CORPUS);
  });

  it("corpus_meets_query_floor: the recorded corpus carries ≥30 labeled queries (A7 floor)", () => {
    expect(RETRIEVAL_CORPUS.cases.length).toBeGreaterThanOrEqual(RETRIEVAL_QUERY_FLOOR);
  });

  it("recall_at_10_meets_bar: the fused (hybrid) recall@10 clears the §13.1c bar (≥ 0.91)", () => {
    expect(report.cases).toBeGreaterThan(0);
    expect(report.fused).toBeGreaterThanOrEqual(RECALL_AT_10_BAR);
  });

  it("reranker_no_regression: re-ranked recall@10 ≥ the raw embedding-only order (helps or ties)", () => {
    expect(report.reranked).toBeGreaterThanOrEqual(report.raw);
  });

  it("raw_vs_fused_vs_reranked_measured: all three orders are measured; fusion ≥ raw (measured, not by fiat)", () => {
    for (const v of [report.raw, report.fused, report.reranked]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // hybrid fusion helps or ties the embedding-only baseline (the whole point of RRF).
    expect(report.fused).toBeGreaterThanOrEqual(report.raw);
  });

  it("eval_is_zero_egress_local_only: the eval backend is local, and a cloud backend for employer-raw FAILS CLOSED (rule-5)", async () => {
    // (a) the recorded backend used by the eval is a genuine non-egress (local) backend.
    expect(recordedBackend(RETRIEVAL_CORPUS).egressClass).toBe("local");

    // (b) drive the REAL retrieval floor: a CLOUD backend carrying employer-raw
    //     (ack OFF) is refused — the backend is never invoked, no cloud fallback.
    let cloudInvoked = false;
    const cloud = recordedBackend(RETRIEVAL_CORPUS, { egressClass: "cloud" });
    const spyCloud = {
      ...cloud,
      embed: (texts: readonly string[]) => {
        cloudInvoked = true;
        return cloud.embed(texts);
      },
    };
    const denied = await retrieveLocalEmbed(
      {
        query: "any employer-raw query",
        passages: [{ id: "d1", text: "some passage" }],
        workspace: { type: "employer_work", carriesRawContent: true, employerRawEgressAcknowledged: false },
      },
      { backend: spyCloud },
    );
    expect(isErr(denied)).toBe(true);
    if (isErr(denied)) expect(denied.error.code).toBe("egress_denied");
    expect(cloudInvoked).toBe(false); // never called — no cloud egress

    // (c) the same query on a LOCAL backend is admitted (non-vacuity: it's the egress
    //     class, not the query, that gates).
    const local = await retrieveLocalEmbed(
      {
        query: "any employer-raw query",
        passages: [{ id: "d1", text: "some passage" }],
        workspace: { type: "employer_work", carriesRawContent: true, employerRawEgressAcknowledged: false },
      },
      { backend: recordedBackend(RETRIEVAL_CORPUS) },
    );
    expect(isOk(local)).toBe(true);
  });
});

describe("§13.1c — the bar is a REAL gate (non-vacuous)", () => {
  it("below_bar_fails_suite: a degraded corpus drops fused recall@10 BELOW the bar", async () => {
    const degraded = await measureRecallAt10(DEGRADED_CORPUS);
    expect(degraded.cases).toBeGreaterThan(0);
    expect(degraded.fused).toBeLessThan(RECALL_AT_10_BAR);
  });
});

describe("recallAtK — the metric itself", () => {
  it("scores |gold ∩ top-K| / |gold|", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 10)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "z"], 10)).toBe(0.5);
    expect(recallAtK(["x", "y"], ["a"], 10)).toBe(0);
  });

  it("respects the K cutoff (a gold beyond top-K does not count)", () => {
    const ranked = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "gold"];
    expect(recallAtK(ranked, ["gold"], 10)).toBe(0); // gold is at rank 11
    expect(recallAtK(ranked, ["gold"], 11)).toBe(1);
  });
});
