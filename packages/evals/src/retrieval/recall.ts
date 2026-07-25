// spec(§6 · §13.1c · §12) — task 13.3b retrieval eval harness: recall@10 scoring.
//
// Ranks each corpus case's docs three ways over the SAME recorded embeddings and
// scores recall@10:
//   · raw     — embedding-only (dense cosine) order: the eval's baseline reference.
//   · fused   — knowledge's REAL `retrieveLocalEmbed` (13.3a: dense ⊕ sparse RRF).
//   · reranked— knowledge's REAL `rerank` (13.17) applied to the raw (dense) order.
// The gate: fused (hybrid) recall@10 ≥ the §13.1c bar, AND reranked ≥ raw (the
// re-ranker helps or does not hurt). Deterministic; the only "cosine" here is the
// baseline reference metric (the SUT is retrieveLocalEmbed + rerank) — it mirrors
// knowledge's own cosine + tie-break EXACTLY so `raw` is precisely the dense leg
// `fused` fuses over (fused then adds the sparse lexical leg, so fused ≥ raw).
import { isOk } from "@sow/contracts";
import {
  retrieveLocalEmbed,
  rerank,
  type Passage,
  type EmbeddingBackend,
} from "@sow/knowledge";
import { RECALL_K, recordedBackend, type RetrievalCorpus } from "./corpus";

/** recall@K for one ranked id list vs a gold set: |gold ∩ top-K| / |gold|. */
export function recallAtK(rankedIds: readonly string[], goldIds: readonly string[], k: number): number {
  if (goldIds.length === 0) return 1; // vacuous — a case with no gold cannot miss
  const top = new Set(rankedIds.slice(0, k));
  const hits = goldIds.filter((g) => top.has(g)).length;
  return hits / goldIds.length;
}

// ── dense-cosine baseline (mirrors knowledge/local-embed EXACTLY) ──────────────────
// Cosine in [-1,1]; 0 on empty / dimension-mismatch / zero-norm.
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

// score DESC then id ASC — the same deterministic order knowledge's dense leg uses.
function byScoreDescThenIdAsc(a: { id: string; score: number }, b: { id: string; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The embedding-only (dense cosine) ranked ids — the `raw` baseline. */
function denseOrder(
  queryEmbedding: readonly number[],
  docs: RetrievalCorpus["docs"],
): readonly string[] {
  return docs
    .map((d) => ({ id: d.id, score: cosine(queryEmbedding, d.embedding) }))
    .sort(byScoreDescThenIdAsc)
    .map((r) => r.id);
}

export interface RecallReport {
  /** recall@10 of the embedding-only (dense cosine) baseline order. */
  readonly raw: number;
  /** recall@10 of the fused hybrid order (retrieveLocalEmbed, 13.3a). */
  readonly fused: number;
  /** recall@10 of the re-ranked order (rerank, 13.17). */
  readonly reranked: number;
  /** number of cases scored. */
  readonly cases: number;
}

export interface MeasureDeps {
  /**
   * Override the embedding backend (the deferred live-Ollama mode). NOTE: an override
   * currently re-routes only the FUSED leg's embeddings; the `raw` baseline + the
   * `rerank` input still read the corpus's recorded vectors — so the "raw is the dense
   * leg fused fuses over" invariant (and the fused≥raw relation) holds precisely only
   * for the default recorded backend. The gate runs on the recorded default; wiring a
   * live backend through all three legs is the live-mode leg (Future TODO).
   */
  readonly backend?: EmbeddingBackend;
}

/**
 * Score recall@10 for the raw / fused / reranked orders over the whole corpus
 * (mean over cases). Uses the REAL exported retrieval + re-ranker; the raw baseline
 * is the harness's own embedding-only reference. A retrieval fault (e.g. egress
 * denial) scores that order 0 for the case (fail-closed, never throws the harness).
 */
export async function measureRecallAt10(corpus: RetrievalCorpus, deps?: MeasureDeps): Promise<RecallReport> {
  const backend = deps?.backend ?? recordedBackend(corpus);
  const passages: readonly Passage[] = corpus.docs.map((d) => ({ id: d.id, text: d.text }));
  const byId = new Map<string, Passage>(passages.map((p) => [p.id, p]));

  let raw = 0;
  let fused = 0;
  let reranked = 0;
  for (const c of corpus.cases) {
    // raw — embedding-only (dense cosine) baseline.
    const rawIds = denseOrder(c.queryEmbedding, corpus.docs);
    raw += recallAtK(rawIds, c.goldDocIds, RECALL_K);

    // fused — the REAL 13.3a hybrid (dense ⊕ sparse RRF).
    const f = await retrieveLocalEmbed({ query: c.query, passages, workspace: c.workspace }, { backend });
    const fusedIds = isOk(f) ? f.value.map((r) => r.id) : [];
    fused += recallAtK(fusedIds, c.goldDocIds, RECALL_K);

    // reranked — the REAL 13.17 re-ranker over the raw (embedding) order.
    const docsInRawOrder = rawIds.map((id) => byId.get(id)).filter((p): p is Passage => p !== undefined);
    const rerankedIds = rerank(c.query, docsInRawOrder).map((p) => p.id);
    reranked += recallAtK(rerankedIds, c.goldDocIds, RECALL_K);
  }

  const n = corpus.cases.length;
  return {
    raw: n === 0 ? 0 : raw / n,
    fused: n === 0 ? 0 : fused / n,
    reranked: n === 0 ? 0 : reranked / n,
    cases: n,
  };
}
