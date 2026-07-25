// Retrieval re-ranker (§6, 13.17). A deterministic, local, zero-egress re-scorer that
// reorders retrieved passages by query-passage relevance BEFORE the cap — replacing raw
// gbrain embedding order with a true-relevance order. It reuses 13.3a's RRF fusion
// primitive: it fuses the INCOMING embedding ORDER (a rank) with a local lexical-
// relevance rank (post-retrieval there are no vectors to re-score with cosine).
//
// Zero-egress / no-spend / no-model BY CONSTRUCTION: this module has NO injected I/O
// seam — it takes only (query, passages) and returns them reordered, so nothing can
// reach an external endpoint. The model-based re-ranker leg is OUT (owner-gated egress),
// a separate slice. Content-preserving: generic over the passage type, it returns the
// SAME objects reordered (so the worker's block↔source pairing survives, worker L6).
// TOTAL never-throws (§16 / Lesson 11): the whole re-rank runs under one try and fails
// safe to the input order on any fault. The worker binding into copilotGbrainRetrieval
// (reorder-before-cap) is a separate worker task.
import { fuseRrf, lexicalRelevanceRank, type Passage } from "./local-embed";

/**
 * Re-rank retrieved passages by query-passage relevance, reordering them (before the
 * caller's cap). Fuses the incoming embedding ORDER with the local lexical-relevance
 * rank via 13.3a's RRF. Generic over the passage type so extra fields (title, source
 * pairing) ride through unchanged. Deterministic, pure, TOTAL never-throws — degrades
 * to the input order on any malformed input.
 */
export function rerank<T extends Passage>(query: string, passages: readonly T[]): readonly T[] {
  if (!Array.isArray(passages)) return []; // malformed (non-array) ⇒ safe empty result
  if (passages.length === 0) return passages;
  try {
    const embeddingOrder = passages.map((p) => p.id); // the incoming gbrain order IS a rank
    const lexicalOrder = lexicalRelevanceRank(query, passages);
    const fusedIds = fuseRrf(embeddingOrder, lexicalOrder).map((r) => r.id);
    const byId = new Map<string, T>(passages.map((p) => [p.id, p]));
    const reordered: T[] = [];
    for (const id of fusedIds) {
      const p = byId.get(id);
      if (p !== undefined) reordered.push(p);
    }
    // fusedIds covers exactly the union of both legs = every passage id; a length
    // shortfall means duplicate ids collapsed — fail safe to the untouched input order.
    return reordered.length === passages.length ? reordered : passages;
  } catch {
    return passages; // never-throws: preserve the input order on any fault
  }
}
