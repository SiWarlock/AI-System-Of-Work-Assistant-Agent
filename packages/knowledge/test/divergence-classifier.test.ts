// spec(§6) — DivergenceClassifier (task 4.16): closed-lattice classification of a
// single factIdentity's disagreement between the SoW gbrain-INDEPENDENT canonical
// set (CanonicalFactDeriver, 4.14 — the reference side) and the read-only DB
// projection. Closed enum: db_only | unstamped (HARD floor → quarantine) |
// content_mismatch (Markdown-wins resync) | md_only (benign re-index) | edge_* |
// stale_revision. Pure, deterministic, never throws; every emitted Divergence is
// contract-valid. db_only/unstamped are the ONLY HARD-floor classes.
import { describe, it, expect } from "vitest";
import {
  isOk,
  DivergenceSchema,
  WorkspaceIdSchema,
  RevisionIdSchema,
} from "@sow/contracts";
import type { WorkspaceId, RevisionId } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type DerivedFact,
} from "../src/gbrain/derive/canonical-fact-deriver";
import {
  classifyDivergence,
  type DbFact,
  type FactComparison,
} from "../src/gbrain/parity/divergence-classifier";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

/** Derive real DerivedFacts from a tiny vault; fetch one by identity. */
function derive(files: Record<string, string>): readonly DerivedFact[] {
  const r = deriveCanonicalFacts({
    workspaceId: WS,
    revisionId: REV,
    files: new Map(Object.entries(files)),
  });
  if (!isOk(r)) throw new Error("derive failed in fixture");
  return r.value.facts;
}
function byId(facts: readonly DerivedFact[], id: string): DerivedFact {
  const f = facts.find((x) => (x.fact.factIdentity as string) === id);
  if (!f) throw new Error(`no derived fact ${id}`);
  return f;
}

const pageFact = (): DerivedFact => byId(derive({ "p.md": "hello prose" }), "page:p");
const linkFact = (): DerivedFact => byId(derive({ "s.md": "[[d]]" }), "link:s->d:body");

function dbFor(canonical: DerivedFact, over: Partial<DbFact> = {}): DbFact {
  return {
    factIdentity: canonical.fact.factIdentity as string,
    factKind: canonical.fact.factKind,
    dbContentHash: canonical.fact.mdContentSha as string,
    stamped: true,
    revisionId: REV as string,
    ...over,
  };
}

describe("classifyDivergence — present in BOTH sides", () => {
  it("stamped, hash match, revision match → clean (no divergence)", () => {
    const c = pageFact();
    const out = classifyDivergence({ present: "both", canonical: c, db: dbFor(c) }, REV);
    expect(out.kind).toBe("clean");
  });

  it("stamped, hash MISMATCH at the current revision → content_mismatch (soft, resync, Markdown-wins)", () => {
    const c = pageFact();
    const db = dbFor(c, { dbContentHash: "deadbeef".repeat(8) });
    const out = classifyDivergence({ present: "both", canonical: c, db }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("content_mismatch");
    expect(out.divergence.severityFloor).toBe("soft");
    expect(out.divergence.remediation).toBe("resync");
    expect(out.divergence.mdContentSha).toBe(c.fact.mdContentSha);
    expect(out.divergence.dbContentHash).toBe("deadbeef".repeat(8));
  });

  it("stamped, hash mismatch but the DB row claims an OLDER revision → stale_revision (soft, resync)", () => {
    const c = pageFact();
    const db = dbFor(c, { dbContentHash: "cafe".repeat(16), revisionId: "rev:old000" });
    const out = classifyDivergence({ present: "both", canonical: c, db }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("stale_revision");
    expect(out.divergence.severityFloor).toBe("soft");
    expect(out.divergence.remediation).toBe("resync");
  });

  it("UNSTAMPED (no signed provenance) is a HARD-floor defect even when the hash matches — no backfill on a gbrain-supplied hash", () => {
    const c = pageFact();
    const db = dbFor(c, { stamped: false }); // hash matches, but unstamped
    const out = classifyDivergence({ present: "both", canonical: c, db }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("unstamped");
    expect(out.divergence.severityFloor).toBe("hard");
    expect(out.divergence.remediation).toBe("review");
  });
});

describe("classifyDivergence — present in the DB ONLY (not derivable from Markdown)", () => {
  it("a non-edge DB-only fact → db_only (HARD floor → quarantine, review)", () => {
    const c = pageFact();
    const db = dbFor(c, { stamped: false }); // stamp irrelevant to db_only
    const out = classifyDivergence({ present: "db_only", db }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("db_only");
    expect(out.divergence.severityFloor).toBe("hard");
    expect(out.divergence.remediation).toBe("review");
    expect(out.divergence.dbContentHash).toBe(c.fact.mdContentSha);
  });

  it("an EDGE DB-only fact → edge_db_only (soft, split out to avoid divergence floods; serving still default-deny)", () => {
    const c = linkFact();
    const out = classifyDivergence({ present: "db_only", db: dbFor(c) }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("edge_db_only");
    expect(out.divergence.severityFloor).toBe("soft");
  });
});

describe("classifyDivergence — present in the canonical set ONLY (not yet in the DB)", () => {
  it("a non-edge Markdown-only fact → md_only (benign, soft, resync/re-index)", () => {
    const c = pageFact();
    const out = classifyDivergence({ present: "canonical_only", canonical: c }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("md_only");
    expect(out.divergence.severityFloor).toBe("soft");
    expect(out.divergence.remediation).toBe("resync");
    expect(out.divergence.mdContentSha).toBe(c.fact.mdContentSha);
  });

  it("an EDGE Markdown-only fact → edge_md_only (soft, resync)", () => {
    const c = linkFact();
    const out = classifyDivergence({ present: "canonical_only", canonical: c }, REV);
    expect(out.kind).toBe("divergent");
    if (out.kind !== "divergent") return;
    expect(out.divergence.divergenceClass).toBe("edge_md_only");
    expect(out.divergence.severityFloor).toBe("soft");
  });
});

describe("classifyDivergence — contract validity + determinism", () => {
  it("every emitted Divergence passes the frozen DivergenceSchema", () => {
    const c = pageFact();
    const comparisons: FactComparison[] = [
      { present: "db_only", db: dbFor(c) },
      { present: "canonical_only", canonical: c },
      { present: "both", canonical: c, db: dbFor(c, { stamped: false }) },
      { present: "both", canonical: c, db: dbFor(c, { dbContentHash: "ab".repeat(32) }) },
    ];
    for (const cmp of comparisons) {
      const out = classifyDivergence(cmp, REV);
      expect(out.kind).toBe("divergent");
      if (out.kind !== "divergent") continue;
      expect(DivergenceSchema.safeParse(out.divergence).success).toBe(true);
    }
  });

  it("is deterministic: identical input yields a deep-equal outcome", () => {
    const c = pageFact();
    const cmp: FactComparison = { present: "db_only", db: dbFor(c) };
    expect(classifyDivergence(cmp, REV)).toEqual(classifyDivergence(cmp, REV));
  });
});
