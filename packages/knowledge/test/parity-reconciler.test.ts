// spec(§6) — ParityReconciler (task 4.16): continuous bidirectional parity pass.
// Diffs the SoW gbrain-INDEPENDENT CanonicalFactSet (4.14, the trusted reference)
// against a read-only DB projection (HTTP GbrainReadGrant), keyed by factIdentity,
// with the gbrain import-rebuild oracle as a SECOND corroborating cross-check only
// (disagreement is a defect, NEVER a calibration target). Emits a revision-scoped,
// contract-valid ParityReport (cleanForServing + coverageComplete) + Divergence[]
// + a parity_defect HealthItem on any HARD-floor (db_only/unstamped) divergence.
// Pure/deterministic, typed Result — never throws across the boundary.
import { describe, it, expect } from "vitest";
import {
  isOk,
  isErr,
  ParityReportSchema,
  HealthItemSchema,
  WorkspaceIdSchema,
  RevisionIdSchema,
} from "@sow/contracts";
import type { WorkspaceId, RevisionId } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalFactSet,
  type DerivedFact,
} from "../src/gbrain/derive/canonical-fact-deriver";
import type { DbFact } from "../src/gbrain/parity/divergence-classifier";
import {
  reconcileParity,
  collapseToMaxRevision,
  type ReconcilerDbProjection,
  type ReconcilerDeps,
  type ReconcileRequest,
  type PendingTrigger,
} from "../src/gbrain/parity/reconciler";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function canonical(files: Record<string, string>): CanonicalFactSet {
  const r = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) });
  if (!isOk(r)) throw new Error("derive failed in fixture");
  return r.value;
}

/** A DB projection that FAITHFULLY mirrors a canonical set (stamped, current, hash-equal). */
function mirrorDb(set: CanonicalFactSet, complete = true): ReconcilerDbProjection {
  const facts: DbFact[] = set.facts.map((df: DerivedFact) => ({
    factIdentity: df.fact.factIdentity as string,
    factKind: df.fact.factKind,
    dbContentHash: df.fact.mdContentSha as string,
    stamped: true,
    revisionId: REV as string,
  }));
  return { workspaceId: WS as string, gbrainSchemaVersion: 3, facts, complete };
}

let seq = 0;
const deps: ReconcilerDeps = {
  newReportId: () => `report-${(seq += 1)}`,
  newHealthItemId: () => `health-${(seq += 1)}`,
  newAuditId: () => `audit-${(seq += 1)}`,
  now: () => "2026-07-01T00:00:00.000Z",
};

function req(over: Partial<ReconcileRequest>): ReconcileRequest {
  const set = over.canonicalSet ?? canonical({ "p.md": "hi", "q.md": "[[p]]" });
  return {
    origin: "post_commit",
    canonicalSet: set,
    dbProjection: over.dbProjection ?? mirrorDb(set),
    ...(over.rebuildOracle ? { rebuildOracle: over.rebuildOracle } : {}),
  };
}

describe("reconcileParity — clean reconcile", () => {
  it("a DB that faithfully mirrors the canonical set → clean, complete, zero divergences, no health items", () => {
    const r = reconcileParity(req({}), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.divergences).toHaveLength(0);
    expect(r.value.report.cleanForServing).toBe(true);
    expect(r.value.report.coverageComplete).toBe(true);
    expect(r.value.healthItems).toHaveLength(0);
    // the report is a contract-valid ParityReport
    expect(ParityReportSchema.safeParse(r.value.report).success).toBe(true);
    expect(r.value.report.reconciledAtRevision).toBe(REV);
    expect(r.value.report.canonicalFactCount).toBe(r.value.report.dbFactCount);
  });
});

describe("reconcileParity — HARD-floor db_only defect (safety rule 1)", () => {
  it("a DB-only fact with no Markdown backing → db_only HARD, dirty report, parity_defect HealthItem", () => {
    const set = canonical({ "p.md": "hi" });
    const db = mirrorDb(set);
    const injected: DbFact = {
      factIdentity: "page:ghost",
      factKind: "page",
      dbContentHash: "ab".repeat(32),
      stamped: true,
      revisionId: REV as string,
    };
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: { ...db, facts: [...db.facts, injected] } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const ghost = r.value.report.divergences.find((d) => (d.factIdentity as string) === "page:ghost");
    expect(ghost?.divergenceClass).toBe("db_only");
    expect(ghost?.severityFloor).toBe("hard");
    expect(r.value.report.cleanForServing).toBe(false);
    // exactly one parity_defect health item, pinned to the report + the offending fact
    const pd = r.value.healthItems.find((h) => h.failureClass === "parity_defect");
    expect(pd).toBeDefined();
    expect(pd?.state).toBe("open");
    expect(pd?.parityReportRef).toBe(r.value.report.reportId);
    expect(pd?.factIdentity).toBe("page:ghost");
    expect(HealthItemSchema.safeParse(pd).success).toBe(true);
  });

  it("an unstamped DB fact → unstamped HARD, dirty report, parity_defect", () => {
    const set = canonical({ "p.md": "hi" });
    const db = mirrorDb(set);
    const facts = db.facts.map((f) => ({ ...f, stamped: false }));
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: { ...db, facts } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.divergences.some((d) => d.divergenceClass === "unstamped")).toBe(true);
    expect(r.value.report.cleanForServing).toBe(false);
    expect(r.value.healthItems.some((h) => h.failureClass === "parity_defect")).toBe(true);
  });
});

describe("reconcileParity — SOFT divergences do NOT block serving", () => {
  it("a Markdown-only fact (DB behind) → md_only soft, report stays clean-for-serving, no parity_defect", () => {
    const set = canonical({ "p.md": "hi", "q.md": "bye" });
    const db = mirrorDb(set);
    const facts = db.facts.filter((f) => (f.factIdentity as string) !== "page:q"); // q not indexed yet
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: { ...db, facts } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.divergences.some((d) => d.divergenceClass === "md_only")).toBe(true);
    expect(r.value.report.cleanForServing).toBe(true);
    expect(r.value.healthItems.some((h) => h.failureClass === "parity_defect")).toBe(false);
  });

  it("a content_mismatch → soft, clean-for-serving true", () => {
    const set = canonical({ "p.md": "hi" });
    const db = mirrorDb(set);
    const facts = db.facts.map((f) =>
      (f.factIdentity as string) === "page:p" ? { ...f, dbContentHash: "00".repeat(32) } : f,
    );
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: { ...db, facts } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.divergences.some((d) => d.divergenceClass === "content_mismatch")).toBe(true);
    expect(r.value.report.cleanForServing).toBe(true);
  });
});

describe("reconcileParity — coverage + the rebuild oracle (corroborating cross-check ONLY)", () => {
  it("an incomplete DB projection → coverageComplete false even when clean (degrade → direct-Markdown serving)", () => {
    const set = canonical({ "p.md": "hi" });
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: mirrorDb(set, false) }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.cleanForServing).toBe(true);
    expect(r.value.report.coverageComplete).toBe(false);
  });

  it("oracle CORROBORATES (same identity set) → coverageComplete true, oracleFactCount recorded, no rebuild_divergence", () => {
    const set = canonical({ "p.md": "hi", "q.md": "[[p]]" });
    const ids = set.facts.map((f) => f.fact.factIdentity as string);
    const r = reconcileParity(req({ canonicalSet: set, rebuildOracle: { factIdentities: ids, complete: true } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.coverageComplete).toBe(true);
    expect(r.value.report.oracleFactCount).toBe(ids.length);
    expect(r.value.healthItems.some((h) => h.failureClass === "rebuild_divergence")).toBe(false);
  });

  it("oracle DISAGREES → coverageComplete false + a rebuild_divergence HealthItem (defect, never a calibration target)", () => {
    const set = canonical({ "p.md": "hi" });
    const r = reconcileParity(
      req({ canonicalSet: set, rebuildOracle: { factIdentities: ["page:p", "page:phantom"], complete: true } }),
      deps,
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.report.coverageComplete).toBe(false);
    const rd = r.value.healthItems.find((h) => h.failureClass === "rebuild_divergence");
    expect(rd).toBeDefined();
    expect(HealthItemSchema.safeParse(rd).success).toBe(true);
    // The oracle NEVER reclassifies canonical-vs-db: with a faithful DB there are no divergences.
    expect(r.value.report.divergences).toHaveLength(0);
  });
});

describe("reconcileParity — guards + determinism", () => {
  it("a workspace mismatch between the canonical set and the DB projection → typed err (never throws)", () => {
    const set = canonical({ "p.md": "hi" });
    const db = { ...mirrorDb(set), workspaceId: "ws-personal" };
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: db }), deps);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("workspace_mismatch");
  });

  it("divergences are emitted in deterministic factIdentity order", () => {
    const set = canonical({ "a.md": "x", "b.md": "y", "c.md": "z" });
    const db = mirrorDb(set);
    // drop all DB facts → three md_only divergences
    const r = reconcileParity(req({ canonicalSet: set, dbProjection: { ...db, facts: [] } }), deps);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const ids = r.value.report.divergences.map((d) => d.factIdentity as string);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("collapseToMaxRevision — LIFE-2 burst collapse=MAX", () => {
  it("collapses a burst of triggers to the newest revision (max seq)", () => {
    const triggers: PendingTrigger[] = [
      { origin: "post_commit", revisionId: "rev:1", seq: 1 },
      { origin: "fs_watch", revisionId: "rev:3", seq: 3 },
      { origin: "schedule", revisionId: "rev:2", seq: 2 },
    ];
    expect(collapseToMaxRevision(triggers)?.revisionId).toBe("rev:3");
  });

  it("an empty burst collapses to undefined", () => {
    expect(collapseToMaxRevision([])).toBeUndefined();
  });
});
