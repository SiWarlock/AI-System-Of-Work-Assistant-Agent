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
import { WorkspaceIdSchema, RevisionIdSchema, ok, isOk, failureClassSchema, type WorkspaceId, type RevisionId, type ParityReport, type AuditId, type HealthItem } from "@sow/contracts";
import { deriveCanonicalFacts } from "@sow/knowledge";
import type { CanonicalVaultSnapshot, CanonicalFactSet, DerivedFact, DbFact, ReconcilerDbProjection, ReconcilerDeps, ReconcileRequest } from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import { runReconcilePass, type RunReconcilePassDeps } from "../../src/composition/parityReconcile";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import { createReconcileScheduler, type LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";
import { runReconcileForWorkspace } from "../../src/composition/reconcileDriver";
import type { CanonicalSnapshotOutcome } from "../../src/composition/canonicalFactSet";
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

// ── Item 7 — reconcile armed-path health semantics (7a propagate + 7b pass_faulted mint), Lesson 18 ──────────────
//
// DORMANT (only the owner-gated armed reconcile path constructs these sinks). 7a: a health-materialization fault
// must be VISIBLE (propagate), not silently dropped on a real parity defect. 7b: a durable-store reconcile fault
// (pass_faulted) is health-worthy, not log-only. Both stay safe (only the redacted/synthesized fields cross —
// safety rule 7) and the LOG sink stays UNCONDITIONALLY never-throwing (piece E's flush relies on it).

/** Fresh reconciler deps with a per-instance counter (mirrors parityReconcile.test.ts). */
function itemSevenReconcilerDeps(): ReconcilerDeps {
  let seq = 0;
  return {
    newReportId: () => `report-${(seq += 1)}`,
    newHealthItemId: () => `health-${(seq += 1)}`,
    newAuditId: () => `audit-${(seq += 1)}`,
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

/** Derive a real CanonicalFactSet for the given committed files. */
function canonicalFactSet(files: Record<string, string>): CanonicalFactSet {
  const r = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) });
  if (!isOk(r)) throw new Error("derive failed in fixture");
  return r.value;
}

/** A DB projection mirroring the canonical set PLUS a ghost db_only fact → one HARD parity_defect divergence. */
function dbProjectionWithGhost(set: CanonicalFactSet): ReconcilerDbProjection {
  const facts: DbFact[] = set.facts.map((df: DerivedFact) => ({
    factIdentity: df.fact.factIdentity as string,
    factKind: df.fact.factKind,
    dbContentHash: df.fact.mdContentSha as string,
    stamped: true,
    revisionId: REV as string,
  }));
  const ghost: DbFact = { factIdentity: "page:ghost", factKind: "page", dbContentHash: "ab".repeat(32), stamped: true, revisionId: REV as string };
  return { workspaceId: WS as string, gbrainSchemaVersion: 3, facts: [...facts, ghost], complete: true };
}

describe("createReconcileHealthSink — 7a: a HealthSurface.record fault PROPAGATES (spec §6, Lesson 18)", () => {
  it("record REJECTS when recordFailure rejects — the fault is never swallowed", async () => {
    const sink = createReconcileHealthSink({ ...HEALTH_DEPS, recordFailure: () => Promise.reject(new Error("HealthSurface.record down")) });
    const item = { failureClass: "parity_defect", parityReportRef: "report-9", factIdentity: "page:ghost", message: "RAW SECRET" } as unknown as HealthItem;
    // Capture the reason + assert UNCONDITIONALLY — a `.catch(cb)` would pass vacuously if record ever RESOLVED
    // (the exact swallow this fix removes), LESSONS.md §15.
    const thrown = await sink.record(item).then(
      () => { throw new Error("expected createReconcileHealthSink.record to REJECT on a recordFailure fault, but it resolved"); },
      (e: unknown) => e,
    );
    expect(String(thrown)).toContain("HealthSurface.record down");
  });
});

describe("createReconcileLogSink — 7b: a pass_faulted outcome mints a HealthItem from the SAFE cause code (spec §6)", () => {
  it("mints ONE parity_defect HealthItem carrying the arch_gap token + safe causeCode, never the redacted message blob", async () => {
    const failures: HealthFailure[] = [];
    const logged: LoggedReconcileOutcome[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: (s) => logged.push(s) });
    sink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1", redactedCause: { message: "REDACTED_RAW_BLOB", causeCode: "STORE_FAULT" } });
    await Promise.resolve(); // flush the fire-and-forget health record
    expect(logged).toHaveLength(1); // the redacted summary is still logged (unchanged behavior)
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("parity_defect");
    expect(failures[0]!.subjectRef).toContain("ws-employer");
    expect(failures[0]!.subjectRef).toContain("rev:1");
    expect(failures[0]!.message).toContain("pass_faulted"); // greppable arch_gap token names the store-fault cause
    expect(failures[0]!.message).toContain("STORE_FAULT"); // the SAFE typed causeCode surfaces
    expect(JSON.stringify(failures[0])).not.toContain("REDACTED_RAW_BLOB"); // the redacted message blob is NOT forwarded
  });

  it("minted failureClass is an EXISTING frozen FailureClass member (no new member invented)", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: () => {} });
    sink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1", redactedCause: { message: "x", causeCode: "STORE_FAULT" } });
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failureClassSchema.safeParse(failures[0]!.failureClass).success).toBe(true);
  });

  it("with NO redactedCause, falls back to the fixed safe 'pass_faulted' literal (never reaches for a raw cause)", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: () => {} });
    sink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1" });
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("pass_faulted");
  });

  it("a present-but-empty causeCode folds to the clean 'pass_faulted' literal — no dangling separator in the operator message", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => { failures.push(f); return okRecord(); });
    const sink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure, log: () => {} });
    sink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1", redactedCause: { message: "x", causeCode: "" } });
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toContain("pass_faulted");
    expect(failures[0]!.message).not.toContain("pass_faulted:"); // a falsy causeCode never yields a dangling `pass_faulted:` tag
  });

  it("NEVER throws on pass_faulted even when recordFailure rejects OR throws synchronously (piece E flush relies on it)", () => {
    const rejectSink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure: () => Promise.reject(new Error("boom")), log: () => {} });
    expect(() => rejectSink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1", redactedCause: { message: "x", causeCode: "C" } })).not.toThrow();
    const syncThrowSink = createReconcileLogSink({ ...HEALTH_DEPS, recordFailure: () => { throw new Error("sync boom"); }, log: () => {} });
    expect(() => syncThrowSink({ kind: "pass_faulted", workspaceId: "ws-employer", revisionId: "rev:1", redactedCause: { message: "x", causeCode: "C" } })).not.toThrow();
  });
});

describe("reconcile armed-path propagation end-to-end — a rejecting health sink surfaces as pass_faulted (spec §12, 7a)", () => {
  it("driver catches the propagated sink fault → pass_faulted; the scheduler logs it and flush never throws", async () => {
    const set = canonicalFactSet({ "p.md": "hi" });
    const db = dbProjectionWithGhost(set); // a db_only ghost ⇒ HARD divergence ⇒ one routed parity_defect healthItem
    const logged: LoggedReconcileOutcome[] = [];
    const rejectingHealthSink = createReconcileHealthSink({ ...HEALTH_DEPS, recordFailure: () => Promise.reject(new Error("HealthSurface.record down")) });
    const derived: CanonicalSnapshotOutcome = { kind: "derived", set };
    const scheduler = createReconcileScheduler({
      runReconcile: (ws, origin) =>
        runReconcileForWorkspace(ws, {
          getCanonicalFactSet: () => Promise.resolve(derived),
          getDbProjection: () => Promise.resolve(db),
          origin,
          runPass: (req: ReconcileRequest) =>
            runReconcilePass(req, {
              reconcilerDeps: itemSevenReconcilerDeps(),
              recorder: { record: () => Promise.resolve() },
              healthSink: rejectingHealthSink,
            }),
        }),
      log: (s) => logged.push(s),
    });
    scheduler.enqueue("ws-employer", { origin: "schedule", revisionId: "rev:1", seq: 1 });
    await expect(scheduler.flush("ws-employer")).resolves.toBeUndefined(); // the propagated fault NEVER escapes flush
    expect(logged).toHaveLength(1);
    expect(logged[0]!.kind).toBe("pass_faulted"); // 7a: rejecting sink → runReconcilePass rejects → driver → pass_faulted
  });
});
