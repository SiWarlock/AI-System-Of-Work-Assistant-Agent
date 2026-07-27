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

// ── (7) stub paths are NAMESPACED — asserted against the PLANNER's output, not the corpus's labels ──
//
// 13.8j namespaced entity stub paths so an UNTRUSTED entity name (13.8g-A feeds them from meeting
// attendee strings) cannot mint a writer-owned KN-12 structural surface — `Index`/`Log`/`README`
// minting `index.md`/`log.md` at the vault root. When that landed, THIS corpus still pinned the old
// root paths, so the suite went red and the repair was to re-point the expectations and re-stamp the
// manifest's integrity hash.
//
// That repair is structurally indistinguishable from LAUNDERING a tampered corpus: both edit the
// expectations and then re-stamp the hash that certifies non-tampering. What separates them is an
// assertion a re-point CANNOT satisfy merely by agreeing with whatever the planner currently emits.
// These are that assertion — they pin the security PROPERTY (a create is confined to a namespace,
// therefore it cannot collide with a root structural file) rather than a set of literal paths.
//
// ⚠ WHY THE PRIMARY ASSERTION READS THE PLANNER AND NOT `expected.stubPaths`: a labels-only guard is
// defeatable, and security review demonstrated the bypass. `stubs_present` (`scorer.ts`) is a SUBSET
// check, so an entry's `stubPaths` can be emptied at ZERO cost to the suite; a targeted de-namespace
// of ONE `EntityKind` could then re-point that entry's `createPaths` to the root, empty its
// `stubPaths`, and go fully green — with the corpus-wide non-vacuity count still held above zero by
// the OTHER entry. The oracle has to be the exhaustive, non-emptiable one: the plans the planner
// actually emits. Do not "simplify" the two tests below into the label check alone.
//
// ⚠ The namespace set is declared INDEPENDENTLY here on purpose — do NOT derive it from
// `@sow/knowledge`. `ENTITY_NAMESPACES` is module-private by 13.8j's design, but the exported
// `NAMESPACED_ENTITY_KINDS` sits right next to it and is the symbol a future reader will reach for:
// doing so would both collapse the oracle back into "the corpus agrees with the code" — precisely
// the failure this guard exists to make impossible — and silently omit the `entities/` fallback,
// which is the namespace an UNRECOGNIZED (i.e. hostile) `kind` lands in, the case that matters most.
// If the production namespaces are ever renamed, this list is meant to be updated by a human as a
// deliberate, reviewed act.
const ENTITY_NAMESPACE_SEGMENTS: readonly string[] = ["people", "projects", "concepts", "entities"];

/** A vault path is confined iff it is relative, has a leading directory segment, and never escapes it. */
function expectConfined(label: string, p: string): void {
  expect(p.startsWith("/"), `${label}: ${p} is absolute`).toBe(false);
  expect(p.includes("/"), `${label}: ${p} is at the vault ROOT — it can collide with a KN-12 surface`).toBe(true);
  expect(p.split("/").includes(".."), `${label}: ${p} traverses out of its namespace`).toBe(false);
}

describe("§6 KN-12 — an entity stub is namespaced, never a vault-root file", () => {
  // PRIMARY oracle: asserts the planner's REAL emitted paths. A corpus edit cannot satisfy this, so
  // it holds whatever the expectations claim — this is the assertion that makes the re-point above
  // auditable rather than self-certifying.
  it("no_root_creates_from_planner: no entry's emitted plan creates a file at the vault root", async () => {
    let created = 0;
    for (const entry of CORPUS) {
      for (const p of (await runEntry(entry)).flatMap((pl) => pl.creates).map((c) => c.path)) {
        expectConfined(entry.id, p);
        created += 1;
      }
    }
    // Positive anchor (cf. section 5): a corpus that created nothing would pass vacuously.
    expect(created, "no entry emitted any create — the guard would be vacuous").toBeGreaterThan(0);
  });

  // SECONDARY oracle: the corpus LABELS. Weaker on its own — `stubs_present` (scorer.ts) is a subset
  // check, so emptying `stubPaths` costs nothing and would slip past this loop — which is exactly why
  // the planner-output assertion above is the primary and must never be reduced to this one. Kept
  // because it names the offending expectation directly when a stale corpus is the actual fault.
  it("stub_paths_namespaced: every expected stub path names a known entity namespace", () => {
    const allStubPaths = CORPUS.flatMap((e) => e.expected.stubPaths);
    // Positive anchor: an empty set would make the loop below trivially true.
    expect(allStubPaths.length, "no entry mints a stub — the guard would be vacuous").toBeGreaterThan(0);
    for (const entry of CORPUS) {
      for (const p of entry.expected.createPaths) expectConfined(entry.id, p);
      for (const p of entry.expected.stubPaths) {
        expectConfined(entry.id, p);
        const segment = p.slice(0, p.indexOf("/"));
        expect(
          ENTITY_NAMESPACE_SEGMENTS.includes(segment),
          `${entry.id}: ${p} is under unknown namespace '${segment}/' (expected one of ${ENTITY_NAMESPACE_SEGMENTS.join(", ")})`,
        ).toBe(true);
      }
    }
  });
});

// ── (8) corpus floor ───────────────────────────────────────────────────────────
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
