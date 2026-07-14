// Task 13.10 — reconcile-TRIGGER arc, piece F2: the composition-root gateReconcile binding. spec(§6) spec(§12)
//
// F2 supplies the REAL leaf-thunks the F1 gate assembles on the armed path + the bootWorker call site (GREEN-on-
// write + /wired, mirroring the gateAutoIngest boot line). This test covers F2's NEW, directly-testable surface:
//   • createReconcileLogSink — the redacted log sink that ALSO materializes a HealthItem (via an injected
//     recordFailure = HealthSurface.record at boot) from the SAFE `detail` code on a skipped_derive_error
//     (never the raw error); a rejecting recordFailure never throws (piece E relies on log being non-throwing);
//   • createReconcileHealthSink — the passDeps healthSink that reprojects a reconciler HealthItem → HealthFailure
//     → recordFailure, using only SAFE fields (failureClass + a safe message, never the item's raw message);
//   • the ASSEMBLED wiring through gateReconcile: an unbound adapter degrades (coverageComplete=false), a broken
//     vault mints safe health, and the OFF default constructs nothing (byte-equivalent).
import { describe, it, expect, vi } from "vitest";
import { WorkspaceIdSchema, RevisionIdSchema, ok, type WorkspaceId, type RevisionId, type ParityReport, type AuditId, type HealthItem } from "@sow/contracts";
import type { CanonicalVaultSnapshot } from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import type { RunReconcilePassDeps } from "../../src/composition/parityReconcile";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import type { LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";
import type { HealthFailure } from "../../src/health/surface";
import { gateReconcile, createReconcileLogSink, createReconcileHealthSink, type ReconcileGateDeps } from "../../src/boot";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");
const okRecord = () => Promise.resolve(ok(undefined) as unknown);

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  return { workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) };
}
const reconcilerDeps = { newReportId: () => "report-1", newHealthItemId: () => "health-1", newAuditId: () => "audit-1", now: () => "2026-07-14T00:00:00.000Z" };
const HEALTH_DEPS = { now: () => "2026-07-14T00:00:00.000Z", newAuditId: () => "audit-x" };

describe("createReconcileLogSink — redacted + health-materializing sink (constraint b/c, safety rule 7)", () => {
  it("skipped_derive_error mints a HealthItem from the SAFE code, never the raw error", async () => {
    const failures: HealthFailure[] = [];
    const logged: LoggedReconcileOutcome[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: (s) => logged.push(s) });
    sink({ kind: "skipped_derive_error", workspaceId: "ws-employer", revisionId: "rev:1", detail: "invalid_page_path" });
    await Promise.resolve(); // flush the fire-and-forget health record
    expect(logged).toHaveLength(1); // the redacted summary is logged
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("parity_defect");
    expect(failures[0]!.subjectRef).toContain("ws-employer");
    expect(failures[0]!.message).toContain("invalid_page_path"); // the SAFE code, carried into the message
    expect(JSON.stringify(failures[0])).not.toContain("SECRET"); // no raw error object rides along
  });

  it("a non-derive outcome logs but mints NO health", async () => {
    const recordFailure = vi.fn(okRecord);
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: () => {} });
    sink({ kind: "reconciled", workspaceId: "ws-employer", revisionId: "rev:1", detail: "recorded" });
    sink({ kind: "skipped_absent", workspaceId: "ws-employer", revisionId: "rev:1" });
    await Promise.resolve();
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it("never throws when recordFailure rejects OR throws synchronously OR the log throws (fail-safe for piece E)", async () => {
    const de = { kind: "skipped_derive_error", workspaceId: "ws-employer", revisionId: "rev:1", detail: "schema_invalid" } as const;
    const rejectSink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure: () => Promise.reject(new Error("surface down")), log: () => {} });
    expect(() => rejectSink(de)).not.toThrow();
    const syncThrowSink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure: () => { throw new Error("sync surface throw"); }, log: () => {} });
    expect(() => syncThrowSink(de)).not.toThrow(); // a SYNC throw from recordFailure is swallowed too
    const throwLogSink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure: okRecord, log: () => { throw new Error("log throw"); } });
    expect(() => throwLogSink({ kind: "reconciled", workspaceId: "ws-employer", revisionId: "rev:1", detail: "recorded" })).not.toThrow();
    await Promise.resolve();
  });
});

describe("createReconcileHealthSink — reproject a reconciler HealthItem safely", () => {
  it("reprojects failureClass + a SAFE message (never the raw item message)", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileHealthSink({ ...HEALTH_DEPS, recordFailure });
    const item = { failureClass: "parity_defect", parityReportRef: "report-9", factIdentity: "page:ghost", message: "RAW leak SECRET" } as unknown as HealthItem;
    await sink.record(item);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("parity_defect");
    expect(JSON.stringify(failures[0])).not.toContain("SECRET"); // the item's raw message is NOT forwarded
  });
});

describe("gateReconcile assembled with the real F2 sinks (spec §6/§12)", () => {
  function realDeps(over: { reader?: CommittedVaultReader; recorder?: ParityReportRecorder; recordFailure?: (f: HealthFailure) => Promise<unknown>; log?: (s: LoggedReconcileOutcome) => void }) {
    const recordFailure = over.recordFailure ?? okRecord;
    const passDeps = (): RunReconcilePassDeps => ({
      reconcilerDeps,
      recorder: over.recorder ?? { record: () => Promise.resolve() },
      healthSink: createReconcileHealthSink({ ...HEALTH_DEPS, recordFailure }),
    });
    const deps: ReconcileGateDeps = {
      makeReader: vi.fn((): CommittedVaultReader => over.reader ?? (() => undefined)),
      makeDbAdapter: vi.fn(() => undefined),
      makePassDeps: vi.fn(passDeps),
      makeLog: vi.fn(() => createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: over.log ?? (() => {}) })),
    };
    return deps;
  }

  it("off_default_constructs_nothing", () => {
    const deps = realDeps({});
    expect(gateReconcile({ vaultRoot: "/vault" }, deps)).toBeUndefined();
    expect(deps.makeReader).not.toHaveBeenCalled();
    expect(deps.makePassDeps).not.toHaveBeenCalled();
    expect(deps.makeLog).not.toHaveBeenCalled();
  });

  it("armed_path_degrades_not_false_green", async () => {
    const recorded: ParityReport[] = [];
    const deps = realDeps({
      reader: () => snapshot({ "p.md": "hi" }),
      recorder: { record: (r) => { recorded.push(r); return Promise.resolve(); } },
    });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    wiring!.scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await wiring!.scheduler.flush("ws-employer");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.coverageComplete).toBe(false); // unbound transport ⇒ degraded, never a false-green
  });

  it("armed_broken_vault_mints_safe_health", async () => {
    const failures: HealthFailure[] = [];
    const deps = realDeps({
      reader: () => snapshot({ "dir1/dup.md": "one", "dir2/dup.md": "two" }), // → duplicate_fact_identity derive_error
      recordFailure: (f) => { failures.push(f); return okRecord(); },
    });
    const wiring = gateReconcile({ reconcile: true, vaultRoot: "/vault" }, deps);
    wiring!.scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await wiring!.scheduler.flush("ws-employer");
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("parity_defect");
    expect(JSON.stringify(failures[0])).not.toContain("dup.md"); // the raw derive-error path never surfaces
  });
});
