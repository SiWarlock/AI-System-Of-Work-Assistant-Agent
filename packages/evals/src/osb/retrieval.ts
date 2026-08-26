// spec(§6 · §8 · §13 · §5.4) — task 13.1 gate (c): the OSB anti-corruption-layer
// retrieval eval.
//
// Scores retrieval quality over `packages/evals/corpora/retrieval` (task 12.3's
// project-owned corpus — 35 labeled queries with gold doc ids + citations,
// previously consumed ONLY by the floor check in `test/corpora/corpora-floors.test.ts`;
// this gate is its first real consumer). Reuses the REAL, already-wired metric
// primitives verbatim: `recallAtK` (`../retrieval/recall`) and `usefulnessAtK`
// (`../retrieval/relevance`) — the SAME functions the general §20.1
// retrieval-recall / retrieval-relevance suites gate on.
//
// ⚠ HONEST BOUND — this is a STAND-IN, not the live retrieval oracle. Brief
// 017's original deferral of gate (c) was "needs real ModelProviderPort / osb
// retrieval_eval.py port → real I/O" — the GBrain passage-serving read-model that
// real I/O needs does not exist yet (Phase 20, unbuilt). `corpora/retrieval`'s
// entries carry no document TEXT (only ids/citations), so there is nothing to
// embed even locally. `rankByLexicalOverlap` below is a deterministic, PURE,
// REAL token-overlap ranker over the corpus's own doc-id vocabulary — a genuine
// algorithm (not a fixed/fabricated ranking), used ONLY so this gate has a
// non-trivial subject to score and so `corpora/retrieval` finally has a scored
// consumer. It is explicitly NOT a DoD-valid measurement of the eventual
// GBrain-backed retrieval surface — see the suite's `dod_honesty` test. Once the
// Phase-20 serving oracle lands, `scoreOsbRetrieval` re-runs unchanged against a
// REAL ranked-id producer in place of `rankByLexicalOverlap`.
//
// PURE: no clock/network/randomness/I-O of its own — the caller supplies entries.

import { recallAtK } from "../retrieval/recall";
import { usefulnessAtK } from "../retrieval/relevance";
import type { RetrievalCorpusEntry } from "../harness/corpus-schemas";

/** The recall cutoff rank (mirrors the general retrieval gate's `RECALL_K`). */
export const OSB_RECALL_K = 10 as const;
/** The usefulness (precision@K) cutoff rank (mirrors `USEFULNESS_K`). */
export const OSB_USEFULNESS_K = 4 as const;

// Empirically measured over the real `corpora/retrieval` corpus (38 pooled doc
// ids, 35 queries): mean recall@10 ≈ 0.757, mean usefulness@4 ≈ 0.214. Bars are
// set comfortably BELOW the measured value (so the gate has headroom) but well
// ABOVE a random-ranking baseline (~0.26 recall@10 for a 38-item pool, ~0.05
// usefulness@4) — a real, non-vacuous floor for a lexical stand-in, not the 0.91
// bar the real hybrid-embedding gate clears (`RECALL_AT_10_BAR`, `src/retrieval/corpus.ts`).
export const OSB_RETRIEVAL_RECALL_BAR = 0.65 as const;
export const OSB_RETRIEVAL_USEFULNESS_BAR = 0.15 as const;

/** Tokenize into lowercase alphanumeric runs — shared by query + doc-id tokenization. */
function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** The doc-id prefix of a citation string, e.g. `"doc-emp-auth-adr#context"` → `"doc-emp-auth-adr"`. */
export function citationDocId(citation: string): string {
  const i = citation.indexOf("#");
  return i === -1 ? citation : citation.slice(0, i);
}

/**
 * Deterministic LEXICAL (token-overlap) ranker over a POOLED candidate id set: a
 * REAL, pure algorithm — ranks `candidateIds` by the count of tokens shared with
 * `query` (desc), tie-broken id ASC for determinism (mirrors the dense-cosine
 * baseline's tie-break convention in `../retrieval/recall.ts`). See the module
 * header for why this stands in for a live retrieval oracle.
 */
export function rankByLexicalOverlap(query: string, candidateIds: readonly string[]): readonly string[] {
  const qTokens = new Set(tokenize(query));
  return [...candidateIds]
    .map((id) => ({ id, score: tokenize(id).filter((t) => qTokens.has(t)).length }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}

export interface OsbRetrievalReport {
  readonly cases: number;
  readonly recallAt10: number;
  readonly usefulnessAt4: number;
}

/**
 * Scores the OSB retrieval gate over `entries` (task 13.1 gate (c)). The
 * candidate universe is the POOLED set of every entry's `goldDocIds` (never just
 * the entry's own gold set — scoring against only the gold set would trivially
 * recall 1.0 for ANY ranking, the same vacuity `workspace-leakage.test.ts`'s #28
 * lesson warns against). For each entry, ranks the pool via
 * `rankByLexicalOverlap` and scores recall@K / usefulness@K against THIS entry's
 * own gold set.
 */
export function scoreOsbRetrieval(entries: readonly RetrievalCorpusEntry[]): OsbRetrievalReport {
  const candidateIds = [...new Set(entries.flatMap((e) => e.goldDocIds))];
  let recallSum = 0;
  let usefulSum = 0;
  for (const e of entries) {
    const ranked = rankByLexicalOverlap(e.query, candidateIds);
    recallSum += recallAtK(ranked, e.goldDocIds, OSB_RECALL_K);
    usefulSum += usefulnessAtK(ranked, e.goldDocIds, OSB_USEFULNESS_K);
  }
  const n = entries.length;
  return {
    cases: n,
    recallAt10: n === 0 ? 0 : recallSum / n,
    usefulnessAt4: n === 0 ? 0 : usefulSum / n,
  };
}
