// spec(§6) — CanonicalFactDeriver: SoW-owned, gbrain-INDEPENDENT Markdown→SemanticFact[]
// parser (task 4.14). The sole trusted "what SHOULD exist" reference set for parity:
// deterministic, revision-keyed, content-INDEPENDENT factIdentity + SoW-computed
// mdContentSha. NEVER consults gbrain. Typed Result — never throws across the boundary.
import { describe, it, expect } from "vitest";
import {
  isOk,
  isErr,
  SemanticFactSchema,
  FactProvenanceSchema,
  WorkspaceIdSchema,
  RevisionIdSchema,
} from "@sow/contracts";
import type { WorkspaceId, RevisionId } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalVaultSnapshot,
  type DerivedFact,
} from "../src/gbrain/derive/canonical-fact-deriver";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function snap(files: Record<string, string>, rev: RevisionId = REV): CanonicalVaultSnapshot {
  return { workspaceId: WS, revisionId: rev, files: new Map(Object.entries(files)) };
}

function identities(facts: readonly DerivedFact[]): string[] {
  return facts.map((f) => f.fact.factIdentity as string);
}
function byId(facts: readonly DerivedFact[], id: string): DerivedFact | undefined {
  return facts.find((f) => (f.fact.factIdentity as string) === id);
}

describe("deriveCanonicalFacts — structural derivation", () => {
  it("empty vault → ok with zero facts", () => {
    const r = deriveCanonicalFacts(snap({}));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.facts).toHaveLength(0);
    expect(r.value.workspaceId).toBe(WS);
    expect(r.value.revisionId).toBe(REV);
  });

  it("a single page yields exactly one page fact keyed by page:<slug>", () => {
    const r = deriveCanonicalFacts(snap({ "notes/auth.md": "---\ntitle: Auth\n---\nHello prose." }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toEqual(["page:auth"]);
    const page = byId(r.value.facts, "page:auth");
    expect(page?.fact.factKind).toBe("page");
    expect(page?.fact.workspaceId).toBe(WS);
    expect(page?.fact.revisionId).toBe(REV);
    expect(page?.fact.mdContentSha).toMatch(/^[0-9a-f]{64}$/);
    expect(page?.provenance.origin).toBe("markdown");
    expect(page?.provenance.originPath).toBe("notes/auth.md");
    expect(page?.provenance.mdContentSha).toBe(page?.fact.mdContentSha);
    expect(page?.provenance.kwRevision).toBe(REV);
  });

  it("non-.md files are ignored (only Markdown pages derive facts)", () => {
    const r = deriveCanonicalFacts(snap({ "a.md": "body", "img.png": "binary", "readme.txt": "x" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toEqual(["page:a"]);
  });

  it("a body wikilink derives a link fact (source=markdown, field=body)", () => {
    const r = deriveCanonicalFacts(snap({ "src.md": "See [[dst]] for detail." }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const link = byId(r.value.facts, "link:src->dst:body");
    expect(link).toBeDefined();
    expect(link?.fact.factKind).toBe("link");
    expect(link?.provenance.origin).toBe("markdown");
    expect(link?.provenance.gbrainLinkSource).toBe("markdown");
  });

  it("duplicate wikilinks to the same target collapse to one edge fact", () => {
    const r = deriveCanonicalFacts(snap({ "src.md": "[[dst]] and again [[dst]]." }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const links = r.value.facts.filter((f) => f.fact.factKind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]?.fact.factIdentity).toBe("link:src->dst:body");
  });

  it("a frontmatter wikilink value derives a link fact (source=frontmatter, field=<key>)", () => {
    const r = deriveCanonicalFacts(snap({ "src.md": "---\nrelated: [[other]]\n---\nbody" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const link = byId(r.value.facts, "link:src->other:related");
    expect(link).toBeDefined();
    expect(link?.provenance.origin).toBe("frontmatter");
    expect(link?.provenance.gbrainLinkSource).toBe("frontmatter");
  });

  it("frontmatter tags derive one tag fact per tag (source=frontmatter)", () => {
    const r = deriveCanonicalFacts(snap({ "p.md": "---\ntags: alpha, beta\n---\nbody" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const tagIds = identities(r.value.facts).filter((i) => i.startsWith("tag:")).sort();
    expect(tagIds).toEqual(["tag:p:alpha", "tag:p:beta"]);
    const t = byId(r.value.facts, "tag:p:alpha");
    expect(t?.fact.factKind).toBe("tag");
    expect(t?.provenance.origin).toBe("frontmatter");
  });

  it("a Timeline section derives one timeline fact per entry, ordered by seq", () => {
    const md = "body\n\n## Timeline\n- first thing\n- second thing\n";
    const r = deriveCanonicalFacts(snap({ "p.md": md }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const tl = identities(r.value.facts).filter((i) => i.startsWith("timeline:")).sort();
    expect(tl).toEqual(["timeline:p:0", "timeline:p:1"]);
    expect(byId(r.value.facts, "timeline:p:0")?.fact.factKind).toBe("timeline");
    expect(byId(r.value.facts, "timeline:p:0")?.provenance.origin).toBe("markdown");
  });

  it("frontmatter slug overrides the path-derived slug", () => {
    const r = deriveCanonicalFacts(snap({ "notes/x.md": "---\nslug: canonical-name\n---\nbody" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toContain("page:canonical-name");
  });
});

describe("deriveCanonicalFacts — determinism + content independence", () => {
  it("re-deriving the same revision yields an identical fact set (deep-equal, same order)", () => {
    const files = {
      "b.md": "---\ntags: z, a\n---\n[[c]]\n\n## Timeline\n- one\n- two\n",
      "a.md": "just prose",
      "c.md": "---\nrelated: [[a]]\n---\nmore",
    };
    const r1 = deriveCanonicalFacts(snap(files));
    const r2 = deriveCanonicalFacts(snap(files));
    expect(isOk(r1)).toBe(true);
    expect(isOk(r2)).toBe(true);
    if (!isOk(r1) || !isOk(r2)) return;
    expect(r2.value).toEqual(r1.value);
  });

  it("output facts are sorted deterministically by factIdentity", () => {
    const r = deriveCanonicalFacts(snap({ "z.md": "zz", "a.md": "aa", "m.md": "mm" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const ids = identities(r.value.facts);
    expect(ids).toEqual([...ids].sort());
  });

  it("editing body prose changes the page mdContentSha but NOT its factIdentity", () => {
    const a = deriveCanonicalFacts(snap({ "p.md": "version one" }));
    const b = deriveCanonicalFacts(snap({ "p.md": "version two" }));
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    const pa = byId(a.value.facts, "page:p");
    const pb = byId(b.value.facts, "page:p");
    expect(pa?.fact.factIdentity).toBe(pb?.fact.factIdentity);
    expect(pa?.fact.mdContentSha).not.toBe(pb?.fact.mdContentSha);
  });

  it("trailing whitespace / trailing blank lines do NOT change mdContentSha (no false divergence)", () => {
    const a = deriveCanonicalFacts(snap({ "p.md": "line one\nline two" }));
    const b = deriveCanonicalFacts(snap({ "p.md": "line one   \nline two\n\n\n" }));
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    expect(byId(a.value.facts, "page:p")?.fact.mdContentSha).toBe(
      byId(b.value.facts, "page:p")?.fact.mdContentSha,
    );
  });

  it("the revisionId flows into every derived fact + provenance", () => {
    const rev2 = RevisionIdSchema.parse("rev:zzz999");
    const r = deriveCanonicalFacts(snap({ "p.md": "[[q]]" }, rev2));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    for (const df of r.value.facts) {
      expect(df.fact.revisionId).toBe(rev2);
      expect(df.provenance.kwRevision).toBe(rev2);
    }
  });
});

describe("deriveCanonicalFacts — typed failure variants (never throws)", () => {
  it("two files producing the same page slug → err duplicate_fact_identity (does not throw)", () => {
    const r = deriveCanonicalFacts(snap({ "dir1/dup.md": "one", "dir2/dup.md": "two" }));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("duplicate_fact_identity");
    if (r.error.code !== "duplicate_fact_identity") return;
    expect(r.error.factIdentity).toBe("page:dup");
    expect([...r.error.paths].sort()).toEqual(["dir1/dup.md", "dir2/dup.md"]);
  });
});

describe("deriveCanonicalFacts — every emitted fact is contract-valid", () => {
  it("all facts pass SemanticFactSchema and all provenance passes FactProvenanceSchema", () => {
    const files = {
      "p.md": "---\ntags: x\nrelated: [[q]]\n---\n[[r]]\n\n## Timeline\n- t0\n",
      "q.md": "body q",
      "r.md": "body r",
    };
    const r = deriveCanonicalFacts(snap(files));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    for (const df of r.value.facts) {
      expect(SemanticFactSchema.safeParse(df.fact).success).toBe(true);
      expect(FactProvenanceSchema.safeParse(df.provenance).success).toBe(true);
    }
    // sanity: covers all four emitted kinds
    const kinds = new Set(r.value.facts.map((f) => f.fact.factKind));
    expect(kinds).toEqual(new Set(["page", "link", "tag", "timeline"]));
  });
});

describe("deriveCanonicalFacts — kwStamp is provenance-only (hash-invisible; gate 4 G1b)", () => {
  it("a note WITH a kwStamp frontmatter key derives the SAME page mdContentSha as without it", () => {
    // Resolves the stamp-in-frontmatter circularity: the writer computes the hash over the base bytes, mints a
    // stamp over it, then embeds the stamp under `kwStamp`. The deriver must skip `kwStamp` so it recomputes the
    // IDENTICAL hash at serve time (serving-gate leg A: rehydrated sha === allow-set sha).
    const base = "---\ntitle: Auth\n---\nHello prose.";
    const stamped = '---\ntitle: Auth\nkwStamp: {"mdContentSha":"deadbeef","sig":"abc123"}\n---\nHello prose.';
    const a = deriveCanonicalFacts(snap({ "notes/auth.md": base }));
    const b = deriveCanonicalFacts(snap({ "notes/auth.md": stamped }));
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    const pa = byId(a.value.facts, "page:auth");
    const pb = byId(b.value.facts, "page:auth");
    expect(pb?.fact.mdContentSha).toBe(pa?.fact.mdContentSha);
  });

  it("the kwStamp key emits NO stray fact (not scalar-meta, not its own fact)", () => {
    const stamped = '---\ntitle: Auth\nkwStamp: {"sig":"abc"}\n---\nHello prose.';
    const r = deriveCanonicalFacts(snap({ "notes/auth.md": stamped }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toEqual(["page:auth"]);
  });

  it("a kwStamp VALUE containing a wikilink derives NO link fact (carved out before link classification)", () => {
    // Defense: an attacker-forged stamp value must not be able to inject a spurious link fact into the allow-set.
    const stamped = "---\ntitle: Auth\nkwStamp: [[injected]]\n---\nbody";
    const r = deriveCanonicalFacts(snap({ "notes/auth.md": stamped }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toEqual(["page:auth"]);
  });

  it("kwStamp as the ONLY frontmatter key still derives the page fact (no crash, no stray fact)", () => {
    const stamped = '---\nkwStamp: {"sig":"z"}\n---\nbody only';
    const r = deriveCanonicalFacts(snap({ "notes/auth.md": stamped }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(identities(r.value.facts)).toEqual(["page:auth"]);
  });

  it("the carve-out is NOT over-broad — a REAL scalar-meta edit STILL moves the page hash", () => {
    // Guards against a future carve-out accidentally excluding real content: only kwStamp is hash-invisible.
    const a = "---\ntitle: Auth\nkwStamp: {\"sig\":\"z\"}\n---\nbody";
    const b = "---\ntitle: CHANGED\nkwStamp: {\"sig\":\"z\"}\n---\nbody";
    const ra = deriveCanonicalFacts(snap({ "notes/auth.md": a }));
    const rb = deriveCanonicalFacts(snap({ "notes/auth.md": b }));
    expect(isOk(ra) && isOk(rb)).toBe(true);
    if (!isOk(ra) || !isOk(rb)) return;
    expect(byId(rb.value.facts, "page:auth")?.fact.mdContentSha).not.toBe(
      byId(ra.value.facts, "page:auth")?.fact.mdContentSha,
    );
  });
});
