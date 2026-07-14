// Task 13.10 — reconcile-TRIGGER arc, piece A: runReconcilePass composition. spec(§6) spec(§12)
//
// runReconcilePass(req, deps) is the pure worker-side reconcile-pass composition seam every later arc
// piece wires into: reconcileParity(req) → recordReconcileOutcome (B3, record-only-on-ok) → route
// outcome.healthItems through the injected ReconcileHealthSink IN ORDER → return the ParityRecordDisposition.
// Fail-closed BOTH directions (§12): a store `record` fault REJECTS BEFORE any health routing (the pass
// did not durably land ⇒ nothing routed); a reconcile err is a typed skip (records nothing, routes nothing,
// never coerced into a clean pass); a health-sink fault PROPAGATES (a trust-defect signal is never silently
// dropped). Owns COMPOSITION only — never input construction or trigger scheduling. DORMANT + fakes only.
//
// Fixtures mirror packages/knowledge/test/parity-reconciler.test.ts (real reconcileParity inputs via the
// barrel-exported deriveCanonicalFacts) so the pass exercises the REAL producer + REAL B3 record gate.
import { describe, it, expect, vi } from "vitest";
import {
  isOk,
  WorkspaceIdSchema,
  RevisionIdSchema,
  type WorkspaceId,
  type RevisionId,
  type HealthItem,
  type ParityReport,
} from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalFactSet,
  type DerivedFact,
  type DbFact,
  type ReconcilerDbProjection,
  type ReconcilerDeps,
  type ReconcileRequest,
} from "@sow/knowledge";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import { runReconcilePass, type ReconcileHealthSink } from "../../src/composition/parityReconcile";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function canonical(files: Record<string, string>): CanonicalFactSet {
  const r = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) });
  if (!isOk(r)) throw new Error("derive failed in fixture");
  return r.value;
}

/** A DB projection that FAITHFULLY mirrors a canonical set (stamped, current, hash-equal) → clean. */
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

/** Fresh reconciler deps with deterministic id minters (a distinct counter per instance). */
function makeReconcilerDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps {
  let seq = 0;
  return {
    newReportId: () => `report-${(seq += 1)}`,
    newHealthItemId: () => `health-${(seq += 1)}`,
    newAuditId: () => `audit-${(seq += 1)}`,
    now: () => "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

/** A faithful (clean) request → clean report, zero health items. */
function cleanReq(): ReconcileRequest {
  const set = canonical({ "p.md": "hi", "q.md": "[[p]]" });
  return { origin: "post_commit", canonicalSet: set, dbProjection: mirrorDb(set) };
}

/** A ghost (db_only HARD) fact → dirty report + a single parity_defect health item. */
function dirtyReq(): ReconcileRequest {
  const set = canonical({ "p.md": "hi" });
  const db = mirrorDb(set);
  const ghost: DbFact = {
    factIdentity: "page:ghost",
    factKind: "page",
    dbContentHash: "ab".repeat(32),
    stamped: true,
    revisionId: REV as string,
  };
  return { origin: "post_commit", canonicalSet: set, dbProjection: { ...db, facts: [...db.facts, ghost] } };
}

/** BOTH a parity_defect (ghost db_only) AND a rebuild_divergence (oracle identity set disagrees). */
function twoHealthReq(): ReconcileRequest {
  return { ...dirtyReq(), rebuildOracle: { factIdentities: ["page:phantom"], complete: true } };
}

/** A workspace mismatch between the canonical set and the DB projection → reconcileParity typed err. */
function errReq(): ReconcileRequest {
  const set = canonical({ "p.md": "hi" });
  return { origin: "post_commit", canonicalSet: set, dbProjection: { ...mirrorDb(set), workspaceId: "ws-personal" } };
}

/** A fake ParityReportRecorder: records the report it was handed (spied), or REJECTS (a store fault). */
function fakeRecorder(
  behavior: { reject?: boolean } = {},
  spy?: (report: ParityReport) => void,
): ParityReportRecorder {
  return {
    record: (report): Promise<void> => {
      spy?.(report);
      return behavior.reject
        ? Promise.reject(new Error("operational-store parityReport.record failed (unavailable): boom"))
        : Promise.resolve();
    },
  };
}

/** A fake ReconcileHealthSink: routes the item it was handed (spied), or REJECTS (a sink fault). */
function fakeSink(
  behavior: { reject?: boolean } = {},
  spy?: (item: HealthItem) => void,
): ReconcileHealthSink {
  return {
    record: (item): Promise<void> => {
      spy?.(item);
      return behavior.reject
        ? Promise.reject(new Error("health sink unavailable: boom"))
        : Promise.resolve();
    },
  };
}

describe("runReconcilePass — records then routes the reconciler's health items (spec §6)", () => {
  it("routes every outcome.healthItems element through the sink IN ORDER, records once", async () => {
    const recorded: ParityReport[] = [];
    const routed: HealthItem[] = [];
    const disposition = await runReconcilePass(twoHealthReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink({}, (i) => routed.push(i)),
    });
    expect(disposition.kind).toBe("recorded");
    expect(recorded).toHaveLength(1); // the report is persisted exactly once
    // both items, exactly once each, in the reconciler's emitted order (parity_defect THEN rebuild_divergence)
    expect(routed.map((h) => h.failureClass)).toEqual(["parity_defect", "rebuild_divergence"]);
    if (disposition.kind !== "recorded") return;
    expect(routed.every((h) => h.parityReportRef === disposition.report.reportId)).toBe(true);
  });

  it("a clean pass records the report and routes ZERO health items — the sink is not called", async () => {
    const recorded: ParityReport[] = [];
    const routed: HealthItem[] = [];
    const disposition = await runReconcilePass(cleanReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink({}, (i) => routed.push(i)),
    });
    expect(disposition.kind).toBe("recorded");
    expect(recorded).toHaveLength(1);
    expect(routed).toHaveLength(0);
  });

  it("a dirty (HARD-divergence) pass records the DIRTY report and routes its parity_defect", async () => {
    const recorded: ParityReport[] = [];
    const routed: HealthItem[] = [];
    const disposition = await runReconcilePass(dirtyReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink({}, (i) => routed.push(i)),
    });
    expect(disposition.kind).toBe("recorded");
    if (disposition.kind !== "recorded") return;
    expect(disposition.report.cleanForServing).toBe(false); // dirty report recorded (operational truth)
    expect(routed).toHaveLength(1);
    expect(routed[0]?.failureClass).toBe("parity_defect");
  });
});

describe("runReconcilePass — fail-closed both directions (spec §12)", () => {
  it("a reconcile err records NOTHING and routes NOTHING — a typed skip, never a downgraded clean pass", async () => {
    const recorded: ParityReport[] = [];
    const routed: HealthItem[] = [];
    const disposition = await runReconcilePass(errReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink({}, (i) => routed.push(i)),
    });
    expect(disposition.kind).toBe("skipped_reconcile_error");
    if (disposition.kind !== "skipped_reconcile_error") return;
    expect(disposition.error.code).toBe("workspace_mismatch");
    expect(recorded).toHaveLength(0);
    expect(routed).toHaveLength(0);
  });

  it("a store record fault REJECTS before any health routing — 0 sink calls", async () => {
    const routed: HealthItem[] = [];
    // CAPTURE the rejection reason and assert UNCONDITIONALLY (a `.catch(cb)` would pass vacuously if the
    // helper ever RESOLVED — the exact fail-closed property this test pins — LESSONS.md §15).
    const thrown = await runReconcilePass(dirtyReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({ reject: true }),
      healthSink: fakeSink({}, (i) => routed.push(i)),
    }).then(
      () => {
        throw new Error("expected runReconcilePass to REJECT on a store record fault, but it resolved");
      },
      (e: unknown) => e,
    );
    expect(String(thrown)).toContain("unavailable");
    expect(routed).toHaveLength(0); // the pass never durably landed ⇒ no health routed
  });

  it("a health-sink fault PROPAGATES — a trust-defect signal is never silently dropped", async () => {
    const recorded: ParityReport[] = [];
    const thrown = await runReconcilePass(dirtyReq(), {
      reconcilerDeps: makeReconcilerDeps(),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink({ reject: true }),
    }).then(
      () => {
        throw new Error("expected runReconcilePass to PROPAGATE the health-sink fault, but it resolved");
      },
      (e: unknown) => e,
    );
    expect(String(thrown)).toContain("health sink unavailable");
    expect(recorded).toHaveLength(1); // the report DID record — surfacing failed, and the fault is NOT swallowed
  });
});

describe("runReconcilePass — pure composition seam (spec §6)", () => {
  it("runs reconcileParity ONCE over the injected req — no re-derivation, no mutation", async () => {
    const newReportId = vi.fn(() => "report-once");
    const recorded: ParityReport[] = [];
    const req = cleanReq();
    const disposition = await runReconcilePass(req, {
      reconcilerDeps: makeReconcilerDeps({ newReportId }),
      recorder: fakeRecorder({}, (r) => recorded.push(r)),
      healthSink: fakeSink(),
    });
    // reconcileParity mints exactly one reportId per pass (only on the ok path) ⇒ called once ⇒ one reconcile
    expect(newReportId).toHaveBeenCalledTimes(1);
    expect(disposition.kind).toBe("recorded");
    // the recorded report reflects the INJECTED req (reconciled MY set, not a re-derived/fabricated one)
    expect(String(recorded[0]?.workspaceId)).toBe(String(req.canonicalSet.workspaceId));
    expect(String(recorded[0]?.reconciledAtRevision)).toBe(String(req.canonicalSet.revisionId));
  });
});
