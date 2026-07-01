// spec(§6) — GBrain parity check + DB-only quarantine (task 4.9). The gbrain DB
// is diffed against the gbrain-INDEPENDENT CanonicalFactDeriver set (4.14): any
// fact PRESENT in the DB projection but NOT derivable from committed Markdown is a
// DB-only parity DEFECT (hidden GBrain semantic truth, safety rule 1). Each defect
// → a HARD `db_only` Divergence, a QuarantineRecord keyed on the content-INDEPENDENT
// factIdentity (so a one-byte DB edit can't resurrect it), a distinct `parity_defect`
// System-Health item, and a remediation queued through the NORMAL KnowledgeWriter
// write path (never a DB-first fix). Fail-closed: a partial projection read degrades
// coverageComplete; a HARD defect forces cleanForServing=false. PURE + total.
import { describe, it, expect } from "vitest";
import {
  QuarantineRecordSchema,
  DivergenceSchema,
  ParityReportSchema,
  HealthItemSchema,
  factIdentity,
} from "@sow/contracts";
import type { WorkspaceId, RevisionId } from "@sow/contracts";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import {
  deriveCanonicalFacts,
  type CanonicalVaultSnapshot,
  type CanonicalFactSet,
} from "../src/gbrain/derive/canonical-fact-deriver";
import {
  checkGbrainParity,
  type DbProjection,
  type DbProjectionFact,
  type ParityDeps,
} from "../src/gbrain/parity";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = "2026-07-01T00:00:00.000Z";
const WS = "ws-1" as WorkspaceId;

function idMinter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function deps(overrides: Partial<ParityDeps> = {}): ParityDeps {
  return {
    gbrainSchemaVersion: 35,
    now: () => NOW,
    newReportId: () => "parity-report-1",
    newHealthItemId: idMinter("health"),
    auditRef: "audit-parity-1",
    ...overrides,
  };
}

// A small deterministic vault → the canonical "what SHOULD exist" reference set.
function vault(): CanonicalVaultSnapshot {
  const files = new Map<string, string>([
    ["alpha.md", "# Alpha\n\nLinks to [[beta]].\n"],
    ["beta.md", "---\ntags: topic, work\n---\n# Beta\n\nBody prose.\n"],
  ]);
  return { workspaceId: WS, revisionId: computeRevisionId(files) as RevisionId, files };
}

function canonicalSet(): CanonicalFactSet {
  const derived = deriveCanonicalFacts(vault());
  if (!derived.ok) throw new Error(`fixture derive failed: ${derived.error.code}`);
  return derived.value;
}

// A DB projection that mirrors the canonical set exactly (a clean, converged index).
function convergedProjection(set: CanonicalFactSet, complete = true): DbProjection {
  const facts: DbProjectionFact[] = set.facts.map((d) => ({
    factIdentity: d.fact.factIdentity,
    dbContentHash: d.fact.mdContentSha,
  }));
  return { workspaceId: set.workspaceId, revisionId: set.revisionId, facts, complete };
}

// ── clean parity ───────────────────────────────────────────────────────────

describe("checkGbrainParity — converged index", () => {
  it("reports clean when every DB fact is derivable from Markdown", () => {
    const set = canonicalSet();
    const out = checkGbrainParity(set, convergedProjection(set), deps());

    expect(out.kind).toBe("clean");
    expect(out.divergences).toHaveLength(0);
    expect(out.quarantineRecords).toHaveLength(0);
    expect(out.healthItems).toHaveLength(0);
    expect(out.remediationRequests).toHaveLength(0);
    expect(out.report.cleanForServing).toBe(true);
    expect(out.report.coverageComplete).toBe(true);
    expect(out.report.canonicalFactCount).toBe(set.facts.length);
    expect(out.report.dbFactCount).toBe(set.facts.length);
    // The report is a valid, frozen-contract ParityReport.
    expect(ParityReportSchema.safeParse(out.report).success).toBe(true);
  });

  it("does NOT flag a canonical fact that is missing from the DB (md_only is not a rule-1 defect)", () => {
    const set = canonicalSet();
    // Drop one canonical fact from the DB — the index is merely behind, not hiding.
    const partial = convergedProjection(set);
    const facts = partial.facts.slice(1);
    const out = checkGbrainParity(set, { ...partial, facts }, deps());
    expect(out.kind).toBe("clean");
    expect(out.divergences).toHaveLength(0);
    expect(out.report.cleanForServing).toBe(true);
  });
});

// ── DB-only defect → quarantine + health + queued remediation ────────────────

describe("checkGbrainParity — DB-only fact (hidden GBrain semantic truth)", () => {
  const ghost = factIdentity({ kind: "page", slug: "ghost" });

  function withGhost(complete = true): {
    set: CanonicalFactSet;
    projection: DbProjection;
  } {
    const set = canonicalSet();
    const base = convergedProjection(set, complete);
    const facts: DbProjectionFact[] = [
      ...base.facts,
      { factIdentity: ghost, dbContentHash: "dbhash-ghost-aaa" },
    ];
    return { set, projection: { ...base, facts } };
  }

  it("classifies a DB-only fact as a HARD db_only parity defect and quarantines it", () => {
    const { set, projection } = withGhost();
    const out = checkGbrainParity(set, projection, deps());

    expect(out.kind).toBe("parity_defect");
    expect(out.divergences).toHaveLength(1);
    const div = out.divergences[0]!;
    expect(div.factIdentity).toBe(ghost);
    expect(div.divergenceClass).toBe("db_only");
    expect(div.severityFloor).toBe("hard");
    expect(DivergenceSchema.safeParse(div).success).toBe(true);

    // Quarantined, keyed on the content-independent identity, remediation pending.
    expect(out.quarantineRecords).toHaveLength(1);
    const q = out.quarantineRecords[0]!;
    expect(q.factIdentity).toBe(ghost);
    expect(q.divergenceClass).toBe("db_only");
    expect(q.remediationState).toBe("pending");
    expect(q.workspaceId).toBe(set.workspaceId);
    expect(QuarantineRecordSchema.safeParse(q).success).toBe(true);
  });

  it("surfaces a distinct parity_defect System-Health item linked to the report + fact", () => {
    const { set, projection } = withGhost();
    const out = checkGbrainParity(set, projection, deps());

    expect(out.healthItems).toHaveLength(1);
    const h = out.healthItems[0]!;
    expect(h.failureClass).toBe("parity_defect");
    expect(h.factIdentity).toBe(ghost);
    expect(h.parityReportRef).toBe(out.report.reportId);
    expect(h.state).toBe("open");
    expect(HealthItemSchema.safeParse(h).success).toBe(true);
    // The quarantine record links back to the same health item.
    expect(out.quarantineRecords[0]!.healthItemId).toBe(h.id);
  });

  it("queues remediation via the normal write path (never a DB-first mutation) and makes the report dirty", () => {
    const { set, projection } = withGhost();
    const out = checkGbrainParity(set, projection, deps());

    expect(out.remediationRequests).toHaveLength(1);
    const req = out.remediationRequests[0]!;
    expect(req.factIdentity).toBe(ghost);
    expect(req.divergenceClass).toBe("db_only");

    // A HARD defect forces cleanForServing=false; the report still validates.
    expect(out.report.cleanForServing).toBe(false);
    expect(out.report.divergences).toHaveLength(1);
    expect(ParityReportSchema.safeParse(out.report).success).toBe(true);
  });

  it("keys the quarantine on the content-INDEPENDENT identity — a one-byte DB edit cannot resurrect it", () => {
    const a = withGhost();
    const b = withGhost();
    // Same ghost fact, different DB bytes (a one-byte edit): same DB digest changed.
    const bFacts = b.projection.facts.map((f) =>
      f.factIdentity === ghost ? { ...f, dbContentHash: "dbhash-ghost-ZZZ" } : f,
    );
    const outA = checkGbrainParity(a.set, a.projection, deps());
    const outB = checkGbrainParity(b.set, { ...b.projection, facts: bFacts }, deps());

    expect(outA.quarantineRecords[0]!.factIdentity).toBe(
      outB.quarantineRecords[0]!.factIdentity,
    );
    // The captured DB digest DOES differ (evidence of the tamper) but identity holds.
    expect(outA.quarantineRecords[0]!.capturedDbDigest).not.toBe(
      outB.quarantineRecords[0]!.capturedDbDigest,
    );
  });
});

// ── fail-closed coverage ─────────────────────────────────────────────────────

describe("checkGbrainParity — fail-closed coverage", () => {
  it("degrades coverageComplete when the projection read was partial, even with no defect", () => {
    const set = canonicalSet();
    const out = checkGbrainParity(set, convergedProjection(set, false), deps());
    expect(out.kind).toBe("clean");
    expect(out.report.cleanForServing).toBe(true);
    expect(out.report.coverageComplete).toBe(false);
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe("checkGbrainParity — pure + deterministic", () => {
  it("yields identical divergence identities + order across repeated runs", () => {
    const set = canonicalSet();
    const base = convergedProjection(set);
    const projection: DbProjection = {
      ...base,
      facts: [
        ...base.facts,
        { factIdentity: factIdentity({ kind: "page", slug: "zeta" }), dbContentHash: "z" },
        { factIdentity: factIdentity({ kind: "page", slug: "acme" }), dbContentHash: "a" },
      ],
    };
    const one = checkGbrainParity(set, projection, deps());
    const two = checkGbrainParity(set, projection, deps());
    expect(one.divergences.map((d) => d.factIdentity)).toEqual(
      two.divergences.map((d) => d.factIdentity),
    );
    expect(one.divergences).toHaveLength(2);
  });
});
