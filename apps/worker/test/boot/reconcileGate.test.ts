// Task 13.10 — reconcile-TRIGGER arc, piece F (F1): gateReconcile — the default-OFF reconcile boot gate. spec(§6) spec(§12)
//
// A pure gate helper (mirror gateAutoIngest / Lesson 2/8/16): OFF (owner opt-in unset — the default, OR a missing
// precondition) ⇒ undefined + ZERO dep-thunk invocations (byte-equivalent — THE safety pin); ON (armed, owner-gated,
// never default) ⇒ assemble createReconcileScheduler bound to runReconcileForWorkspace over the never-reject
// buildCanonicalFactSet/buildReconcilerDbProjection + a redacted log. The owner-gated GbrainReadGrant transport stays
// UNBOUND (makeDbAdapter → undefined) ⇒ even the armed path records DEGRADED (coverageComplete=false, never false-green).
// F1 = the gate helper + this direct test (fakes); F2 = the bootWorker call site + real leaf-thunks (deferred).
import { describe, it, expect, vi } from "vitest";
import { WorkspaceIdSchema, RevisionIdSchema, type WorkspaceId, type RevisionId, type ParityReport } from "@sow/contracts";
import type { CanonicalVaultSnapshot } from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import type { RunReconcilePassDeps, ReconcileHealthSink } from "../../src/composition/parityReconcile";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import type { LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";
import { gateReconcile, type ReconcileGateDeps } from "../../src/boot";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  return { workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) };
}

/** Deterministic reconciler id-minters + clock for the assembled pass. */
const reconcilerDeps = {
  newReportId: () => "report-1",
  newHealthItemId: () => "health-1",
  newAuditId: () => "audit-1",
  now: () => "2026-07-14T00:00:00.000Z",
};

function passDeps(recorder: ParityReportRecorder): RunReconcilePassDeps {
  const healthSink: ReconcileHealthSink = { record: () => Promise.resolve() };
  return { reconcilerDeps, recorder, healthSink };
}

/** Build the 4 gate dep-thunks as spies wrapping inner fakes; each is invoked ONLY on the ON path. */
function makeGateDeps(over: {
  reader?: CommittedVaultReader;
  recorder?: ParityReportRecorder;
  log?: (s: LoggedReconcileOutcome) => void;
} = {}) {
  const reader: CommittedVaultReader = over.reader ?? (() => undefined);
  const recorder: ParityReportRecorder = over.recorder ?? { record: () => Promise.resolve() };
  const log = over.log ?? ((_s: LoggedReconcileOutcome) => {});
  const makeReader = vi.fn((): CommittedVaultReader => reader);
  const makeDbAdapter = vi.fn(() => undefined); // owner-gated GbrainReadGrant transport UNBOUND ⇒ degrade
  const makePassDeps = vi.fn((): RunReconcilePassDeps => passDeps(recorder));
  const makeLog = vi.fn(() => log);
  const deps: ReconcileGateDeps = { makeReader, makeDbAdapter, makePassDeps, makeLog };
  return { deps, makeReader, makeDbAdapter, makePassDeps, makeLog };
}

describe("gateReconcile — default-OFF byte-equivalence (spec §12, Lesson 8/11)", () => {
  it("off_path_returns_undefined_constructs_nothing", async () => {
    // THE safety pin: default opts (reconcile unset) ⇒ undefined AND every dep-thunk has 0 invocations
    for (const opts of [{ vaultRoot: "/vault" }, { reconcile: false, vaultRoot: "/vault" }]) {
      const { deps, makeReader, makeDbAdapter, makePassDeps, makeLog } = makeGateDeps();
      expect(gateReconcile(opts, deps)).toBeUndefined();
      expect(makeReader).not.toHaveBeenCalled();
      expect(makeDbAdapter).not.toHaveBeenCalled();
      expect(makePassDeps).not.toHaveBeenCalled();
      expect(makeLog).not.toHaveBeenCalled();
    }
  });

  it("missing_precondition_returns_undefined", async () => {
    // reconcile:true but no vaultRoot ⇒ undefined (fail-safe AND-composed) + zero construction
    const { deps, makeReader } = makeGateDeps();
    expect(gateReconcile({ reconcile: true }, deps)).toBeUndefined();
    expect(makeReader).not.toHaveBeenCalled();
  });
});

describe("gateReconcile — ON path assembly (spec §6)", () => {
  it("on_path_assembles_wiring", async () => {
    const { deps, makeReader, makeDbAdapter, makePassDeps, makeLog } = makeGateDeps();
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    expect(wiring).toBeDefined();
    expect(wiring?.scheduler).toBeDefined();
    expect(typeof wiring?.scheduler.enqueue).toBe("function");
    expect(typeof wiring?.scheduler.flush).toBe("function");
    // the dep-thunks ran exactly once (on this ON path only)
    expect(makeReader).toHaveBeenCalledTimes(1);
    expect(makeDbAdapter).toHaveBeenCalledTimes(1);
    expect(makePassDeps).toHaveBeenCalledTimes(1);
    expect(makeLog).toHaveBeenCalledTimes(1);
  });

  it("binds_never_reject_builders", async () => {
    // the driver's getCanonicalFactSet is bound to buildCanonicalFactSet (never-reject): an undefined-returning
    // reader ⇒ absent ⇒ skipped_absent (NOT a throw) — proving the never-reject builder is wired, not a raw transport
    const logged: LoggedReconcileOutcome[] = [];
    const { deps } = makeGateDeps({ reader: () => undefined, log: (s) => logged.push(s) });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    wiring!.scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await wiring!.scheduler.flush("ws-employer");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.kind).toBe("skipped_absent");
  });

  it("unbound_transport_degrades_not_admits", async () => {
    // the owner-gated transport is UNBOUND (makeDbAdapter → undefined) ⇒ the db-projection degrades (complete=false)
    // ⇒ the recorded ParityReport carries coverageComplete=false (never a false-green), even on the armed path
    const recorded: ParityReport[] = [];
    const recorder: ParityReportRecorder = { record: (r) => { recorded.push(r); return Promise.resolve(); } };
    const { deps } = makeGateDeps({ reader: () => snapshot({ "p.md": "hi" }), recorder });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    wiring!.scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await wiring!.scheduler.flush("ws-employer");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.coverageComplete).toBe(false); // degraded — the arming precondition (transport) holds
  });

  it("routes_outcome_through_the_redacted_log", async () => {
    // a store record fault ⇒ the driver's pass_faulted ⇒ the scheduler routes a REDACTED summary to the injected
    // log (a marker-secret cause never appears) — proving the gate wired the scheduler's redaction chokepoint
    const logged: LoggedReconcileOutcome[] = [];
    const recorder: ParityReportRecorder = { record: () => Promise.reject(new Error("record failed: MARKER_SECRET_zz")) };
    const { deps } = makeGateDeps({ reader: () => snapshot({ "p.md": "hi" }), recorder, log: (s) => logged.push(s) });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    wiring!.scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await wiring!.scheduler.flush("ws-employer");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.kind).toBe("pass_faulted");
    expect(JSON.stringify(logged[0])).not.toContain("MARKER_SECRET_zz");
  });
});
