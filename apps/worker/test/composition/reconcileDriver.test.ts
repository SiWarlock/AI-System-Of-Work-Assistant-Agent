// Task 13.10 — reconcile-TRIGGER arc, piece D: runReconcileForWorkspace (the driver). spec(§6) spec(§12)
//
// The pure, trigger-agnostic end-to-end driver composes pieces A+B+C over INJECTED async collaborators:
//   getCanonicalFactSet (C) → on `derived`, getDbProjection (B) → assemble the ReconcileRequest (rebuildOracle
//   OMITTED, decision #2) → runPass (A, injected) → a typed 4-way ReconcileDriverOutcome.
// It SHORT-CIRCUITS an absent/broken canonical reference (no wasted gbrain read) and NEVER THROWS (a runPass
// rejection — piece A's DESIGNED record/health-sink fault channel — is caught into a typed pass_faulted, so the
// trigger, piece E, gets a typed result under EITHER model: a Temporal activity or a bare worker pass).
//
// runPass is INJECTED (wiring binds runPass = (req) => runReconcilePass(req, passDeps)), so the test supplies a
// fake runPass to capture the assembled req + control resolve/reject — no module mock.
import { describe, it, expect, vi } from "vitest";
import { validParityReport, WorkspaceIdSchema, RevisionIdSchema, type WorkspaceId, type RevisionId } from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalFactSet,
  type CanonicalVaultSnapshot,
  type ReconcilerDbProjection,
  type ReconcileRequest,
  type ReconcileTriggerOrigin,
  type DeriveError,
} from "@sow/knowledge";
import type { ParityRecordDisposition } from "../../src/composition/parityReportStore";
import type { CanonicalSnapshotOutcome } from "../../src/composition/canonicalFactSet";
import { runReconcileForWorkspace, type ReconcileDriverDeps } from "../../src/composition/reconcileDriver";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function factSet(): CanonicalFactSet {
  const snap: CanonicalVaultSnapshot = { workspaceId: WS, revisionId: REV, files: new Map([["p.md", "hi"]]) };
  const r = deriveCanonicalFacts(snap);
  if (!r.ok) throw new Error("derive failed in fixture");
  return r.value;
}

const SET = factSet();
const DB_PROJECTION: ReconcilerDbProjection = { workspaceId: "ws-employer", gbrainSchemaVersion: 3, facts: [], complete: true };
const DISPOSITION: ParityRecordDisposition = { kind: "recorded", report: validParityReport };

/** Build driver deps with spied collaborators (+ return the spies for assertions). */
function makeDeps(opts: {
  canonical?: CanonicalSnapshotOutcome;
  origin?: ReconcileTriggerOrigin;
  runPass?: (req: ReconcileRequest) => Promise<ParityRecordDisposition>;
} = {}) {
  const getCanonicalFactSet = vi.fn(
    async (): Promise<CanonicalSnapshotOutcome> => opts.canonical ?? { kind: "derived", set: SET },
  );
  const getDbProjection = vi.fn(async (): Promise<ReconcilerDbProjection> => DB_PROJECTION);
  const runPass = vi.fn(opts.runPass ?? (async (_req: ReconcileRequest): Promise<ParityRecordDisposition> => DISPOSITION));
  const deps: ReconcileDriverDeps = {
    getCanonicalFactSet,
    getDbProjection,
    origin: opts.origin ?? "schedule",
    runPass,
  };
  return { deps, getCanonicalFactSet, getDbProjection, runPass };
}

describe("runReconcileForWorkspace — end-to-end reconcile pass (spec §6)", () => {
  it("derived_assembles_req_and_reconciles", async () => {
    const { deps, getCanonicalFactSet, getDbProjection, runPass } = makeDeps();
    const outcome = await runReconcileForWorkspace("ws-employer", deps);
    expect(outcome).toEqual({ kind: "reconciled", disposition: DISPOSITION });
    // the SAME workspaceId is threaded to both reads (no hardcode / cross)
    expect(getCanonicalFactSet).toHaveBeenCalledWith("ws-employer");
    expect(getDbProjection).toHaveBeenCalledWith("ws-employer");
    expect(getDbProjection).toHaveBeenCalledTimes(1);
    expect(runPass).toHaveBeenCalledTimes(1);
    const req = runPass.mock.calls[0]![0];
    expect(req.canonicalSet).toBe(SET); // the derived set forwarded verbatim (no re-derivation)
    expect(req.dbProjection).toBe(DB_PROJECTION);
  });

  it("origin_threaded_from_deps", async () => {
    // the trigger (piece E) owns the origin; the driver stamps it verbatim, never inventing one
    for (const origin of ["post_commit", "fs_watch", "schedule", "on_demand"] as ReconcileTriggerOrigin[]) {
      const { deps, runPass } = makeDeps({ origin });
      await runReconcileForWorkspace("ws-employer", deps);
      expect(runPass.mock.calls[0]![0].origin).toBe(origin);
    }
  });

  it("rebuild_oracle_omitted", async () => {
    // decision #2: no rebuildOracle ⇒ coverageComplete rests on dbProjection.complete, not forced false
    const { deps, runPass } = makeDeps();
    await runReconcileForWorkspace("ws-employer", deps);
    const req = runPass.mock.calls[0]![0];
    expect(req.rebuildOracle).toBeUndefined();
    expect("rebuildOracle" in req).toBe(false);
  });
});

describe("runReconcileForWorkspace — fail-closed outcome routing (spec §12)", () => {
  it("absent_short_circuits", async () => {
    // no canonical reference ⇒ skip WITHOUT the gbrain read — getDbProjection + runPass never called
    const { deps, getDbProjection, runPass } = makeDeps({ canonical: { kind: "absent" } });
    const outcome = await runReconcileForWorkspace("ws-employer", deps);
    expect(outcome).toEqual({ kind: "skipped_absent" });
    expect(getDbProjection).not.toHaveBeenCalled();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("derive_error_short_circuits_typed", async () => {
    // a broken vault is surfaced TYPED for the trigger caller to route to health — the driver stays pure (no
    // HealthItem materialized here, decision #4); downstream not called
    const error: DeriveError = { code: "invalid_page_path", path: "dir/../escape.md" };
    const { deps, getDbProjection, runPass } = makeDeps({ canonical: { kind: "derive_error", error } });
    const outcome = await runReconcileForWorkspace("ws-employer", deps);
    expect(outcome).toEqual({ kind: "skipped_derive_error", error });
    expect(getDbProjection).not.toHaveBeenCalled();
    expect(runPass).not.toHaveBeenCalled();
  });

  it("pass_fault_caught_not_thrown", async () => {
    // runPass REJECTS (piece A's designed record/health-sink fault channel) ⇒ pass_faulted carrying the cause,
    // NEVER a throw. `.resolves` asserts non-throw + value UNCONDITIONALLY (a leaked reject fails loudly — §15).
    const cause = new Error("operational-store parityReport.record failed (unavailable)");
    const { deps } = makeDeps({
      runPass: async () => {
        throw cause;
      },
    });
    // a bare await: if the driver THREW (rejected) this line rejects and the test fails LOUDLY (§15 non-vacuous)
    const outcome = await runReconcileForWorkspace("ws-employer", deps);
    expect(outcome).toEqual({ kind: "pass_faulted", cause });
    if (outcome.kind !== "pass_faulted") throw new Error("unreachable");
    expect(outcome.cause).toBe(cause); // the opaque cause forwarded by EXACT identity (not a re-wrap)
  });
});
