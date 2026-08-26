// spec(§6 · §8 · §13 · §5.4) — task 13.1 gate (c): the OSB anti-corruption-layer
// retrieval eval.
//
// Loads the CHECKED-IN, hash-verified retrieval corpus (task 12.3 — previously
// consumed only by the floor check in `test/corpora/corpora-floors.test.ts`) and
// scores it through `scoreOsbRetrieval` (real `recallAtK`/`usefulnessAtK` metric
// functions over a deterministic lexical-overlap ranking). See
// `src/osb/retrieval.ts`'s header for the honest bound: this is a STAND-IN for
// the Phase-20 GBrain serving oracle, not a live-integration measurement — the
// `dod_honesty` test below states that explicitly, mirroring
// `retrieval-relevance.test.ts`'s own DoD-honesty convention.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk } from "@sow/contracts";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import { CORPUS_FLOORS, type RetrievalCorpusEntry } from "../../src/harness/corpus-schemas";
import {
  scoreOsbRetrieval,
  rankByLexicalOverlap,
  citationDocId,
  OSB_RETRIEVAL_RECALL_BAR,
  OSB_RETRIEVAL_USEFULNESS_BAR,
} from "../../src/osb/retrieval";

const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");
function loadRetrievalCorpus(): readonly RetrievalCorpusEntry[] {
  const dir = resolve(CORPORA, "retrieval");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as RetrievalCorpusEntry[];
  const r = loadCorpus<RetrievalCorpusEntry>(manifest, entries, { expectedFloor: CORPUS_FLOORS.retrieval });
  if (!isOk(r)) {
    throw new Error(`retrieval corpus failed to load: ${JSON.stringify((r as { error: unknown }).error)}`);
  }
  return r.value.entries;
}
const RETRIEVAL = loadRetrievalCorpus();

describe("rankByLexicalOverlap — the ranker itself", () => {
  it("ranks a candidate sharing a token with the query above one that shares none", () => {
    const ranked = rankByLexicalOverlap("auth token refresh policy", ["doc-emp-token-lifetimes", "doc-life-japan-trip-itinerary"]);
    expect(ranked[0]).toBe("doc-emp-token-lifetimes");
  });

  it("ties break id ASC (deterministic)", () => {
    const ranked = rankByLexicalOverlap("nothing matches here", ["doc-b", "doc-a"]);
    expect(ranked).toEqual(["doc-a", "doc-b"]);
  });

  it("is a real function of the query — a different query can change the order", () => {
    const candidates = ["doc-emp-auth-adr", "doc-life-passport-details"];
    const forAuth = rankByLexicalOverlap("auth session design", candidates);
    const forPassport = rankByLexicalOverlap("passport renewal details", candidates);
    expect(forAuth[0]).toBe("doc-emp-auth-adr");
    expect(forPassport[0]).toBe("doc-life-passport-details");
  });
});

describe("citationDocId", () => {
  it("strips the anchor from a citation string", () => {
    expect(citationDocId("doc-emp-auth-adr#context")).toBe("doc-emp-auth-adr");
  });

  it("returns the string unchanged when there is no anchor", () => {
    expect(citationDocId("doc-emp-auth-adr")).toBe("doc-emp-auth-adr");
  });
});

describe("task 13.1 gate (c) — OSB retrieval eval", () => {
  it("loads >=30 labeled queries from the hash-verified corpus", () => {
    expect(RETRIEVAL.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.retrieval);
  });

  it("every entry's goldCitations doc-id prefix is one of its own goldDocIds (corpus self-consistency)", () => {
    for (const e of RETRIEVAL) {
      for (const citation of e.goldCitations) {
        expect(e.goldDocIds).toContain(citationDocId(citation));
      }
    }
  });

  it("scores recall@10 and usefulness@4 clearing their bars over the real corpus", () => {
    const report = scoreOsbRetrieval(RETRIEVAL);
    expect(report.cases).toBe(RETRIEVAL.length);
    expect(report.recallAt10).toBeGreaterThanOrEqual(OSB_RETRIEVAL_RECALL_BAR);
    expect(report.usefulnessAt4).toBeGreaterThanOrEqual(OSB_RETRIEVAL_USEFULNESS_BAR);
  });

  it("the bar is a REAL gate (non-vacuous): a degraded (query-scrambled) corpus drops below it", () => {
    // Replace every query with unrelated, non-overlapping text so the ranker has
    // no signal to work with — ties fall back to id-ASC order, uncorrelated with
    // any entry's gold set.
    const degraded: readonly RetrievalCorpusEntry[] = RETRIEVAL.map((e) => ({
      ...e,
      query: "zzz completely unrelated filler text zzz",
    }));
    const report = scoreOsbRetrieval(degraded);
    expect(report.cases).toBeGreaterThan(0);
    expect(report.recallAt10).toBeLessThan(OSB_RETRIEVAL_RECALL_BAR);
  });

  it("dod_honesty: this is a lexical stand-in, not a live-integration measurement — never claim DoD validity here", () => {
    // Mirrors retrieval-relevance.test.ts's `dod_honesty` convention: a passing
    // functional score over a non-live subject must not be read as a Phase-20
    // GBrain-serving-oracle certification. No `scoreById`/criteria-registry entry
    // exists for this OSB-scoped internal gate (deliberately — it is not one of
    // the PRD §20.1 acceptance tests); this test exists so a future change that
    // wires one in is forced to confront this bound rather than silently
    // certifying DoD-passing off a lexical ranker.
    const report = scoreOsbRetrieval(RETRIEVAL);
    expect(report.recallAt10).toBeGreaterThan(0); // functionally meaningful
    expect(report.recallAt10).toBeLessThan(1); // and NOT a perfect/live oracle
  });
});
