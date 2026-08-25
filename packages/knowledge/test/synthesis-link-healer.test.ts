// spec(§6 KN-11) — 13.8b LinkHealer, the 2nd ARC-4 living-vault synthesis keystone. The
// governed port of osb's heal_links.py: given a note's Title→slug references + the workspace's
// existing note candidates, emit a corrective LinkMutation{op:'add', srcPath, dstSlug} ONLY on a
// faithful/unambiguous slug match; a lossy / fuzzy / 2+-candidate reference is WITHHELD to a
// proposed clarification (never auto-healed, never a fabricated link). Backlinks are NEVER authored
// (derived read-only via GBrain, KN-11). Every heal is a LinkMutation for the KMP → KnowledgeWriter
// (safety rule 1: the sole writer — never a direct Markdown write). PURE, deterministic, never-throws;
// reuses the 13.8a faithful-match discipline (fold em/en dashes; spaces≠hyphens).
import { describe, it, expect } from "vitest";
import { LinkMutationSchema, workspaceId } from "@sow/contracts";
import type { EntityCandidate } from "../src/synthesis/entity-resolver";
import { healLinks, type LinkHeal } from "../src/synthesis/link-healer";

// 24.92: real branded constructors, not anonymous casts.
const WS_A = workspaceId("ws-a");
const WS_B = workspaceId("ws-b");
const SRC = "notes/2026-07-25-standup.md";

const cand = (o: Partial<EntityCandidate> & Pick<EntityCandidate, "path" | "slug">): EntityCandidate => ({
  workspaceId: WS_A,
  ...o,
});
const ref = (title: string): { title: string } => ({ title });

const heals = (rs: readonly LinkHeal[]): readonly Extract<LinkHeal, { kind: "healed" }>[] =>
  rs.filter((r): r is Extract<LinkHeal, { kind: "healed" }> => r.kind === "healed");

// ── 1. faithful/unambiguous match ⇒ a corrective LinkMutation{op:'add'} (KN-11) ───

describe("healLinks — a faithful/unambiguous ref heals to the canonical kebab slug (§6 KN-11)", () => {
  it("faithful_title_kebab_heals_via_linkmutation — Title match ⇒ LinkMutation{op:'add', dstSlug}", () => {
    const r = healLinks(SRC, [ref("Acme API")], [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" })], WS_A);
    expect(r).toEqual([{ kind: "healed", mutation: { op: "add", srcPath: SRC, dstSlug: "acme-api" } }]);
  });

  it("heals on an alias match too", () => {
    const r = healLinks(SRC, [ref("acme")], [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API", aliases: ["acme"] })], WS_A);
    expect(heals(r).map((h) => h.mutation.dstSlug)).toEqual(["acme-api"]);
  });

  it("a slug-form ref (already kebab) heals against the candidate slug", () => {
    const r = healLinks(SRC, [ref("acme-api")], [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "The Acme API Project" })], WS_A);
    expect(heals(r).map((h) => h.mutation.dstSlug)).toEqual(["acme-api"]);
  });

  it("folds an em/en-dash the same way 13.8a does (faithful, not lossy)", () => {
    // "Q3 — Roadmap" (em-dash) faithfully matches the note titled "Q3 - Roadmap" (hyphen)
    const r = healLinks(SRC, [ref("Q3 — Roadmap")], [cand({ path: "planning/q3-roadmap.md", slug: "q3-roadmap", title: "Q3 - Roadmap" })], WS_A);
    expect(heals(r).map((h) => h.mutation.dstSlug)).toEqual(["q3-roadmap"]);
  });

  it("duplicate candidate ROWS for one note (unioned slug/title/alias hits) heal once — not a false ambiguous", () => {
    const r = healLinks(
      SRC,
      [ref("Jane Doe")],
      [
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe.md", slug: "jane-doe", aliases: ["Jane Doe"] }),
      ],
      WS_A,
    );
    expect(r).toEqual([{ kind: "healed", mutation: { op: "add", srcPath: SRC, dstSlug: "jane-doe" } }]);
  });

  it("two refs that resolve to the SAME slug dedupe to one mutation", () => {
    const r = healLinks(
      SRC,
      [ref("Acme API"), ref("acme")],
      [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API", aliases: ["acme"] })],
      WS_A,
    );
    expect(heals(r).map((h) => h.mutation.dstSlug)).toEqual(["acme-api"]);
  });

  it("two candidate ROWS sharing a slug (different paths) heal once — distinct-slug (dst) counting, NOT distinct-path", () => {
    // divergence from 13.8a (which counts distinct PATH → this would be ambiguous there): the healer's
    // output IS a slug, so the slug is the correct dedupe dimension — one distinct dst ⇒ one unambiguous heal.
    const r = healLinks(
      SRC,
      [ref("Jane Doe")],
      [
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "archive/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
      ],
      WS_A,
    );
    expect(r).toEqual([{ kind: "healed", mutation: { op: "add", srcPath: SRC, dstSlug: "jane-doe" } }]);
  });
});

// ── 2. ambiguous / lossy / fuzzy ⇒ WITHHELD (never auto-heals a fabricated link) ──

describe("healLinks — withholds (proposed clarification), never auto-heals a guess (§6 KN-11)", () => {
  it("ambiguous_withholds_never_heals — 2+ distinct faithful candidates ⇒ withheld(ambiguous), no mutation", () => {
    const r = healLinks(
      SRC,
      [ref("Jane Doe")],
      [
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
        cand({ path: "people/jane-doe-2.md", slug: "jane-doe-2", title: "Jane Doe" }),
      ],
      WS_A,
    );
    expect(r).toEqual([{ kind: "withheld", ref: "Jane Doe", reason: "ambiguous" }]);
    expect(heals(r)).toEqual([]);
  });

  it("lossy_withholds_never_heals — C++ vs an existing 'c' note ⇒ withheld(lossy_match), no mutation", () => {
    const r = healLinks(SRC, [ref("C++")], [cand({ path: "concepts/c.md", slug: "c", title: "C" })], WS_A);
    expect(r).toEqual([{ kind: "withheld", ref: "C++", reason: "lossy_match" }]);
    expect(heals(r)).toEqual([]);
  });

  it("a space↔hyphen-only diff vs a slug-only candidate withholds (Q1 stricter-than-osb ruling)", () => {
    // 'Acme API' would osb-slugify to the existing 'acme-api' but faithfully matches no title/alias
    const r = healLinks(SRC, [ref("Acme API")], [cand({ path: "projects/acme-api.md", slug: "acme-api" })], WS_A);
    expect(r).toEqual([{ kind: "withheld", ref: "Acme API", reason: "lossy_match" }]);
  });

  it("fuzzy_withholds_never_heals — a near-miss (Google Ads vs Google Docs) ⇒ withheld(no_candidate), never a guess", () => {
    const r = healLinks(SRC, [ref("Google Ads")], [cand({ path: "tools/google-docs.md", slug: "google-docs", title: "Google Docs" })], WS_A);
    expect(r).toEqual([{ kind: "withheld", ref: "Google Ads", reason: "no_candidate" }]);
    expect(heals(r)).toEqual([]);
  });
});

// ── 3. backlinks are NEVER authored (KN-11 — derived read-only via GBrain) ────────

describe("healLinks — NEVER authors a backlink (KN-11: backlinks derived read-only via GBrain)", () => {
  it("no_backlink_section_ever_authored — every heal targets the SOURCE note, never the linked-to note", () => {
    const target = "projects/acme-api.md";
    const r = healLinks(SRC, [ref("Acme API")], [cand({ path: target, slug: "acme-api", title: "Acme API" })], WS_A);
    // the only mutation writes the SOURCE note's forward link — never a reciprocal write into the target
    for (const h of heals(r)) {
      expect(h.mutation.srcPath).toBe(SRC);
      expect(h.mutation.srcPath).not.toBe(target);
    }
    // no backlink section / region is ever emitted (structural: only op:'add' LinkMutations, no NotePatch)
    expect(JSON.stringify(r).toLowerCase()).not.toContain("backlink");
  });
});

// ── 4. every emitted mutation is KMP-admissible LinkMutation data — no direct write (rule 1) ─

describe("healLinks — emits KMP-admissible LinkMutation data, never a direct Markdown write (safety rule 1)", () => {
  it("mutation_routes_through_kmp_no_direct_write — every heal validates against LinkMutationSchema, op is always 'add'", () => {
    const r = healLinks(
      SRC,
      [ref("Acme API"), ref("Jane Doe")],
      [
        cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" }),
        cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe" }),
      ],
      WS_A,
    );
    const hs = heals(r);
    expect(hs.length).toBe(2);
    for (const h of hs) {
      expect(LinkMutationSchema.safeParse(h.mutation).success).toBe(true); // candidate-data-gate admissible
      expect(h.mutation.op).toBe("add"); // heals only ever ADD a forward link (never remove)
    }
  });
});

// ── 5. PURE, deterministic, TOTAL never-throws (malformed ⇒ fail-safe) — Lesson 11 ─

describe("healLinks — PURE / deterministic / TOTAL never-throws; fail-safe on malformed input (Lesson 11)", () => {
  it("malformed_never_throws — mixed valid+malformed refs/candidates yield the valid heal, no throw", () => {
    const hostile = new Proxy({ path: "x.md", slug: "x", workspaceId: WS_A } as EntityCandidate, {
      get(target, prop, recv) {
        if (prop === "slug") throw new Error("boom");
        return Reflect.get(target, prop, recv);
      },
    });
    const refs = [ref("Acme API"), null, { title: 42 }, ref("   ")] as unknown as readonly { title: string }[];
    const cands = [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" }), null, hostile, { path: "y.md" }] as unknown as readonly EntityCandidate[];
    let r: readonly LinkHeal[] = [];
    expect(() => {
      r = healLinks(SRC, refs, cands, WS_A);
    }).not.toThrow();
    // the one faithful ref still heals; malformed rows are dropped, never crash
    expect(heals(r).map((h) => h.mutation.dstSlug)).toEqual(["acme-api"]);
  });

  it("a whitespace-only ref title ⇒ withheld(malformed_ref), never a heal", () => {
    const r = healLinks(SRC, [ref("   ")], [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" })], WS_A);
    expect(r).toEqual([{ kind: "withheld", ref: "   ", reason: "malformed_ref" }]);
  });

  it("entirely non-array input fails safe to [] — never throws", () => {
    expect(healLinks(SRC, "nope" as unknown as readonly { title: string }[], [], WS_A)).toEqual([]);
    expect(healLinks(SRC, [ref("Acme API")], "nope" as unknown as readonly EntityCandidate[], WS_A)).toEqual([]);
  });

  it("an empty/malformed srcPath fails safe to [] — never emits a mutation that would fail the KMP schema gate", () => {
    // every heal must be a KMP-admissible LinkMutation (srcPath: z.string().min(1)); a heal built on
    // an empty srcPath would be rejected downstream — so refuse to emit it at the source.
    const cands = [cand({ path: "projects/acme-api.md", slug: "acme-api", title: "Acme API" })];
    expect(healLinks("", [ref("Acme API")], cands, WS_A)).toEqual([]);
    expect(healLinks(undefined as unknown as string, [ref("Acme API")], cands, WS_A)).toEqual([]);
  });

  it("WS-8 defense-in-depth — a foreign-workspace candidate is DROPPED, never healed (rule 4)", () => {
    const r = healLinks(SRC, [ref("Jane Doe")], [cand({ path: "people/jane-doe.md", slug: "jane-doe", title: "Jane Doe", workspaceId: WS_B })], WS_A);
    expect(heals(r)).toEqual([]); // the foreign row is never a heal target
    expect(r).toEqual([{ kind: "withheld", ref: "Jane Doe", reason: "no_candidate" }]);
  });
});
