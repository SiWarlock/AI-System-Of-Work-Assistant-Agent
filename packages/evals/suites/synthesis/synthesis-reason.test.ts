// spec(§6 KN-10 · §12 · REQ-F-017) — task 13.8c-eval: the synthesis REASON-leg eval.
//
// The model-REASON-leg DoD eval for the landed confined synthesis planner: runs `planSynthesis` over a labeled
// corpus (≥20 source-contexts) with each entry's RECORDED `SynthesisCandidate` replayed through a fake
// `SynthesisReasonPort`, asserting the planner's SAFETY invariants at a HARD 100% floor (L27, mirror 12.16) +
// synthesis FAITHFULNESS (entity-grounded, hard 0-count on fabrication). Provider-free / deterministic — imports
// `@sow/knowledge`, never edits it (L29). Each guard is proven non-vacuous by fixture inversion (L7).
import { describe, it, expect, beforeAll } from "vitest";
import { TBD } from "@sow/domain";
import { loadSynthesisCorpus } from "../../src/synthesis/corpus";
import { runEntry, checkEntry, scoreSafety, scoreFaithfulness } from "../../src/synthesis/scorer";
import { CORPUS_FLOORS, type SynthesisCorpusEntry, type SynthesisExpected } from "../../src/harness/corpus-schemas";
import { corpusContentHash, loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import { isErr } from "@sow/contracts";

let CORPUS: readonly SynthesisCorpusEntry[] = [];
beforeAll(() => {
  CORPUS = loadSynthesisCorpus();
});

// ── (1) HARD 100% floor over the safety-invariant set (L27) ────────────────────
describe("§6 KN-10 — the synthesis safety invariants hold at a HARD 100% floor", () => {
  it("safety_floor_100pct: every safety invariant passes across the corpus — one leak fails", async () => {
    const s = await scoreSafety(CORPUS);
    expect(s.total).toBeGreaterThan(0);
    expect(s.failures, JSON.stringify(s.failures)).toEqual([]);
    expect(s.score).toBe(1);
  });
});

// ── (2) @user / dropped-region confinement across the corpus ───────────────────
describe("§6 SAFETY — a @user / unsafe / collision region is NEVER patched", () => {
  it("user_region_never_patched_corpus: no emitted patch targets @user or any labelled-dropped id", async () => {
    for (const entry of CORPUS) {
      const patchIds = (await runEntry(entry)).flatMap((p) => p.patches).map((p) => p.regionId);
      expect(patchIds.includes("@user"), `${entry.id}`).toBe(false);
      expect(patchIds.some((id) => entry.expected.droppedRegionIds.includes(id)), `${entry.id}`).toBe(false);
    }
  });
});

// ── (3) KN-10 tiering ──────────────────────────────────────────────────────────
describe("§6 KN-10 — tiering is classified deterministically (AUTO vs PROPOSE)", () => {
  it("tier_classification_correct: each entry's emitted tier matches its expected tier", async () => {
    for (const entry of CORPUS) {
      const tierCheck = (await checkEntry(entry)).find((c) => c.invariant === "tier");
      expect(tierCheck?.passed, `${entry.id}: ${tierCheck?.detail}`).toBe(true);
    }
  });
});

// ── (4) no-inference (REQ-F-017) ───────────────────────────────────────────────
describe("REQ-F-017 — un-evidenced owner/date → TBD; evidenced preserved; other un-evidenced dropped", () => {
  it("no_inference_tbd_corpus: the tbd / kept / dropped-frontmatter invariants hold per entry", async () => {
    for (const entry of CORPUS) {
      const checks = await checkEntry(entry);
      for (const inv of ["tbd_keys", "kept_keys", "dropped_frontmatter_absent"]) {
        expect(checks.find((c) => c.invariant === inv)?.passed, `${entry.id}:${inv}`).toBe(true);
      }
    }
  });
});

// ── (5) faithfulness — hard 0-count on fabrication ─────────────────────────────
describe("§6 WS-8 — entity-grounding faithfulness (no fabrication)", () => {
  it("faithfulness_no_fabrication: a withheld entity fabricates NO path (hard 0-count)", async () => {
    const fabrications = await scoreFaithfulness(CORPUS);
    expect(fabrications, JSON.stringify(fabrications)).toEqual([]);
    // positive anchor: at least one create_stub across the corpus DOES mint a stub (not an always-empty plan)
    const anyStub = CORPUS.some((e) => e.expected.stubPaths.length > 0);
    expect(anyStub).toBe(true);
  });
});

// ── (6) verify-by-inversion — each guard is non-vacuous (L7) ────────────────────
const EXP0: SynthesisExpected = {
  tier: "none",
  patchRegionIds: [],
  createPaths: [],
  frontmatterTBDKeys: [],
  frontmatterKeptKeys: [],
  droppedRegionIds: [],
  droppedFrontmatterKeys: [],
  stubPaths: [],
  noFabricationNames: [],
};
const mkEntry = (over: Partial<SynthesisCorpusEntry>): SynthesisCorpusEntry => ({
  id: "inv",
  sensitivity: "internal",
  provenanceOrigin: "ingestion",
  sourceRefs: [{ sourceId: "src-1", span: "1-2" }],
  sections: {},
  candidate: {},
  expected: EXP0,
  ...over,
});

describe("L7 — each guard is non-vacuous (invert the fixture; the suppressed effect appears)", () => {
  it("@user confinement: a @user region is dropped, but a SAFE fresh region id patches", async () => {
    const suppressed = await runEntry(mkEntry({ candidate: { regions: [{ notePath: "n.md", regionId: "@user", body: "x", effect: "new_region" }] } }));
    expect(suppressed.flatMap((p) => p.patches)).toEqual([]);
    const inverted = await runEntry(mkEntry({ candidate: { regions: [{ notePath: "n.md", regionId: "safe-region", body: "x", effect: "new_region" }] } }));
    expect(inverted.flatMap((p) => p.patches).map((p) => p.regionId)).toEqual(["safe-region"]);
  });

  it("no-inference: an un-evidenced owner coerces to TBD, but an EVIDENCED owner is kept verbatim", async () => {
    const suppressed = await runEntry(mkEntry({ candidate: { frontmatter: [{ notePath: "n.md", key: "owner", value: "Alice" }] } }));
    expect(suppressed.flatMap((p) => p.frontmatterUpdates).find((f) => f.key === "owner")?.value).toBe(TBD);
    const inverted = await runEntry(mkEntry({ candidate: { frontmatter: [{ notePath: "n.md", key: "owner", value: "Alice", evidenceRef: "src-1#s" }] } }));
    expect(inverted.flatMap((p) => p.frontmatterUpdates).find((f) => f.key === "owner")?.value).toBe("Alice");
  });

  it("faithfulness: a withheld entity fabricates nothing, but a create_stub resolution mints a stub", async () => {
    const suppressed = await runEntry(mkEntry({ candidate: { entityRefs: [{ name: "Ghost", kind: "person" }] }, gbrainByName: { Ghost: { outcome: "withheld" } } }));
    expect(suppressed.flatMap((p) => p.creates)).toEqual([]);
    const inverted = await runEntry(mkEntry({ candidate: { entityRefs: [{ name: "Newproj", kind: "project" }] }, gbrainByName: { Newproj: { outcome: "create_stub" } } }));
    expect(inverted.flatMap((p) => p.creates).some((c) => c.path.includes("newproj"))).toBe(true);
  });

  it("collision: a new_region colliding with an owned id drops, but a FRESH id patches", async () => {
    const suppressed = await runEntry(mkEntry({ sections: { "n.md": ["summary"] }, candidate: { regions: [{ notePath: "n.md", regionId: "summary", body: "x", effect: "new_region" }] } }));
    expect(suppressed.flatMap((p) => p.patches)).toEqual([]);
    const inverted = await runEntry(mkEntry({ sections: { "n.md": ["summary"] }, candidate: { regions: [{ notePath: "n.md", regionId: "fresh", body: "x", effect: "new_region" }] } }));
    expect(inverted.flatMap((p) => p.patches).map((p) => p.regionId)).toEqual(["fresh"]);
  });
});

// ── (7) corpus floor ───────────────────────────────────────────────────────────
describe("§12 — the synthesis corpus floor is enforced", () => {
  it("corpus_floor_enforced: a shrunk corpus fails the ≥20 floor", () => {
    const subset = CORPUS.slice(0, 2);
    const manifest: CorpusManifest = {
      corpusId: "synthesis",
      version: "1.0.0",
      contentHash: corpusContentHash("synthesis", "1.0.0", subset),
      entryCount: subset.length,
      floor: CORPUS_FLOORS.synthesis,
    };
    const r = loadCorpus(manifest, subset, { expectedFloor: CORPUS_FLOORS.synthesis });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("below_floor");
  });
});
