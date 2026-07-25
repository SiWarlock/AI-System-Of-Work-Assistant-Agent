// spec(§6) — 13.17 retrieval re-ranker LOGIC. A deterministic / local re-ranker that
// re-scores retrieved passages by query-passage relevance and reorders them BEFORE the
// cap — replacing raw gbrain embedding order with true-relevance order. Reuses 13.3a's
// RRF fusion primitive: it fuses the INCOMING embedding ORDER (a rank) with a local
// lexical-relevance rank (no cosine re-compute — post-retrieval there are no vectors).
// Zero-egress / no-spend / no-model BY CONSTRUCTION (no I/O seam); content-preserving
// (same objects reordered — the block↔source pairing survives at the worker binding);
// TOTAL never-throws (fail-safe to input order). The model-based re-ranker leg is OUT
// (owner-gated egress). The worker binding into copilotGbrainRetrieval.ts is a SEPARATE
// worker task (+ the SEC-MED real-egressVeto pin, which rides that binding, not here).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { rerank } from "../src/gbrain/rerank";
import { fuseRrf, lexicalRelevanceRank, type Passage } from "../src/gbrain/local-embed";

const P = (id: string, text: string): Passage => ({ id, text });
const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ── 1. re-ranks by relevance, beating raw embedding order ─────────────────────────

describe("rerank — re-scores by query-passage relevance and reorders before the cap", () => {
  it("reranker_reorders_by_relevance — a lexically-relevant passage is promoted above raw embedding order", () => {
    // embedding order: [pA(lex0), pB(lex2), pC(lex1)]; lexical rank: [pB, pC].
    // RRF(K=60): pB=1/61+1/60 > pC=1/62+1/61 > pA=1/60 → [pB, pC, pA].
    const passages = [P("pA", "zzz"), P("pB", "alpha beta gamma"), P("pC", "alpha")];
    const out = rerank("alpha beta", passages);
    expect(out.map((p) => p.id)).toEqual(["pB", "pC", "pA"]);
    // beats raw embedding order (the relevant passage rose to the top)
    expect(out.map((p) => p.id)).not.toEqual(passages.map((p) => p.id));
  });
});

// ── 2. reuses 13.3a's fusion primitive; no egress (structural) ────────────────────

describe("rerank — reuses the local fusion primitive, no egress", () => {
  it("reranker_reuses_local_fusion_no_egress — output == fuseRrf ∘ lexicalRelevanceRank composition, synchronously", () => {
    const query = "alpha beta";
    const passages = [P("pA", "zzz"), P("pB", "alpha beta gamma"), P("pC", "alpha")];
    // the re-ranker IS the fusion of the embedding order ⊕ the local lexical rank
    const expectedIds = fuseRrf(passages.map((p) => p.id), lexicalRelevanceRank(query, passages)).map((r) => r.id);
    const byIdMap = new Map(passages.map((p) => [p.id, p]));
    const expected = expectedIds.map((id) => byIdMap.get(id));
    const result = rerank(query, passages);
    expect(result).toEqual(expected);
    expect(result).not.toBeInstanceOf(Promise); // synchronous — no await/network
  });

  it("model_leg_absent — the module has NO cloud/model/egress path (imports only the sibling primitive)", () => {
    const src = readFileSync(new URL("../src/gbrain/rerank.ts", import.meta.url), "utf8");
    expect(src.length).toBeGreaterThan(0);
    for (const forbidden of ["fetch", "http", "ModelProvider", "EmbeddingBackend", "egressGate"]) {
      expect(src).not.toContain(forbidden);
    }
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["./local-embed"]);
  });
});

// ── 3. content-preserving (reorders, never fabricates/mutates) ────────────────────

describe("rerank — candidate-data posture: reorders, never fabricates or mutates", () => {
  it("reranking_preserves_passage_content — same objects reordered, extra fields intact", () => {
    type Rich = { id: string; text: string; title: string };
    const passages: Rich[] = [
      { id: "pA", text: "zzz", title: "A" },
      { id: "pB", text: "alpha beta", title: "B" },
      { id: "pC", text: "alpha", title: "C" },
    ];
    const out = rerank("alpha beta", passages);
    expect(out).toHaveLength(passages.length);
    // multiset-equal (no fabrication / drop) incl. the extra `title` field
    expect([...out].sort(byId)).toEqual([...passages].sort(byId));
    // reference-equality: every output IS an input object (nothing rebuilt/mutated)
    for (const p of out) expect(passages).toContain(p);
    expect(out.find((p) => p.id === "pB")).toEqual({ id: "pB", text: "alpha beta", title: "B" });
  });
});

// ── 4. TOTAL never-throws over a malformed / empty set (Lesson 11) ────────────────

describe("rerank — TOTAL never-throws (fail-safe to input order)", () => {
  it("malformed_or_empty_never_throws — empty ⇒ [], a type-lied passage ⇒ input order, never throws", () => {
    expect(rerank("q", [])).toEqual([]);

    const bad = [{ id: "p1", text: null as unknown as string }, { id: "p2", text: "alpha" }];
    let out: readonly { id: string }[] = [];
    expect(() => {
      out = rerank("alpha", bad);
    }).not.toThrow();
    expect(out.map((p) => p.id)).toEqual(["p1", "p2"]); // fail-safe: original order preserved

    const one = [P("only", "x")];
    expect(rerank("q", one).map((p) => p.id)).toEqual(["only"]);
  });

  it("duplicate passage ids fail safe to the untouched input order (no silent collapse)", () => {
    // ids collapse in the map-back ⇒ reordered.length < input ⇒ fail-safe to input order.
    const dupes = [P("dup", "alpha"), P("dup", "beta"), P("pC", "alpha")];
    const out = rerank("alpha", dupes);
    expect(out).toBe(dupes); // same array reference — nothing dropped or reordered
    expect(out.map((p) => p.id)).toEqual(["dup", "dup", "pC"]);
  });

  it("a query with no lexical hits degrades to the embedding (identity) order", () => {
    const passages = [P("p1", "zzz"), P("p2", "yyy"), P("p3", "www")];
    const out = rerank("alpha beta", passages); // no token overlap ⇒ lexical leg empty
    expect(out.map((p) => p.id)).toEqual(["p1", "p2", "p3"]); // fuseRrf(embeddingOrder, []) = embedding order
  });
});
