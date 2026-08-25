// spec(§20.1 · §5.4 · KN-10) — task 12.1/13.1c: retrieval RELEVANCE (usefulness).
//
// recall.ts asks "was the gold doc retrieved AT ALL" (|gold ∩ top-K| / |gold|).
// This module asks the OPPOSITE question: "are the RETRIEVED ones the right ones"
// — precision@K (|gold ∩ top-K| / K). A system that retrieves everything scores
// recall 1.0 with terrible relevance; usefulness catches exactly that failure mode
// (see retrieval-relevance.test.ts `retrieve_everything_scores_recall_1_but_fails_usefulness`).
//
// Ranks each corpus case through knowledge's REAL exported `retrieveLocalEmbed`
// (13.3a dense ⊕ sparse RRF, unlimited/full fused list — this metric slices to K
// itself, since `retrieveLocalEmbed` returns everything unless `deps.limit` caps
// it) and scores usefulness@K. Deterministic; zero-egress by construction via the
// shared `recordedBackend` (corpus.ts).
import { isOk } from "@sow/contracts";
import { retrieveLocalEmbed, type Passage, type EmbeddingBackend } from "@sow/knowledge";
import { recordedBackend, type RetrievalCorpus } from "./corpus";

/** The usefulness (precision@K) cutoff rank. */
export const USEFULNESS_K = 4 as const;

/** The KN-10/§20.1 recorded bar: fused usefulness@K ≥ 0.9 (criteria-registry.ts RETRIEVAL_RELEVANCE). */
export const RETRIEVAL_USEFULNESS_BAR = 0.9 as const;

/**
 * usefulness@K (precision@K) for one ranked id list vs a gold set:
 * |gold ∩ top-K| / min(K, ranked.length). Vacuously 1 for an empty gold set —
 * mirrors recall.ts:24's convention (a case with no gold cannot be wrong).
 * The denominator is the ACTUAL number of retrieved items considered (never K
 * itself when the ranked list is shorter than K), so a short list isn't punished
 * for items that were never offered.
 */
export function usefulnessAtK(rankedIds: readonly string[], goldIds: readonly string[], k: number): number {
  if (goldIds.length === 0) return 1; // vacuous — a case with no gold cannot be wrong
  const denom = Math.min(k, rankedIds.length);
  if (denom === 0) return 0; // nothing was retrieved and gold was expected
  const gold = new Set(goldIds);
  const top = rankedIds.slice(0, k);
  const hits = top.filter((id) => gold.has(id)).length;
  return hits / denom;
}

export interface UsefulnessReport {
  /** usefulness@K of the fused hybrid order (retrieveLocalEmbed, 13.3a). */
  readonly fused: number;
  /** usefulness@K of the embedding-only (dense cosine) order, for reference. */
  readonly raw: number;
  /** number of cases scored. */
  readonly cases: number;
}

export interface MeasureUsefulnessDeps {
  /** Override the embedding backend (the deferred live-Ollama mode). */
  readonly backend?: EmbeddingBackend;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function byScoreDescThenIdAsc(a: { id: string; score: number }, b: { id: string; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function denseOrder(
  queryEmbedding: readonly number[],
  docs: RetrievalCorpus["docs"],
): readonly string[] {
  return docs
    .map((d) => ({ id: d.id, score: cosine(queryEmbedding, d.embedding) }))
    .sort(byScoreDescThenIdAsc)
    .map((r) => r.id);
}

/**
 * Score usefulness@K for the fused (and raw baseline) orders over the whole
 * corpus (mean over cases). Uses the REAL exported `retrieveLocalEmbed`; the
 * FULL fused list is returned (no `deps.limit` passed), so the K-slice happens
 * here in `usefulnessAtK`, not at the retrieval call. A retrieval fault (e.g.
 * egress denial) scores that case's fused order 0 (fail-closed, never throws).
 */
export async function measureUsefulnessAtK(
  corpus: RetrievalCorpus,
  deps?: MeasureUsefulnessDeps,
): Promise<UsefulnessReport> {
  const backend = deps?.backend ?? recordedBackend(corpus);
  const passages: readonly Passage[] = corpus.docs.map((d) => ({ id: d.id, text: d.text }));

  let raw = 0;
  let fused = 0;
  for (const c of corpus.cases) {
    const rawIds = denseOrder(c.queryEmbedding, corpus.docs);
    raw += usefulnessAtK(rawIds, c.goldDocIds, USEFULNESS_K);

    const f = await retrieveLocalEmbed({ query: c.query, passages, workspace: c.workspace }, { backend });
    const fusedIds = isOk(f) ? f.value.map((r) => r.id) : [];
    fused += usefulnessAtK(fusedIds, c.goldDocIds, USEFULNESS_K);
  }

  const n = corpus.cases.length;
  return {
    raw: n === 0 ? 0 : raw / n,
    fused: n === 0 ? 0 : fused / n,
    cases: n,
  };
}
