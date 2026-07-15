// Task 13.10 — rebuild-oracle producer arc, piece C (CLOSES the arc): the bootWorker binding's extractable pieces. spec(§6) spec(§12) spec(§16)
//
// Piece C wires piece B's gateRebuildOracle into the live serving path. Per Lesson 16, the extractable pieces are
// unit-tested here over fakes; the bootWorker CALL SITE itself is proven via typecheck + `/wired` (booting the full
// worker in a unit test is out-of-scope heavy — mirror reconcile F2). The two extracted helpers:
//   • createRebuildOracleHealthSink — reproject a `diverged` status's rebuild_divergence HealthItem → a HealthFailure
//     using ONLY safe fields (frozen failureClass + a SYNTHESIZED safe message + a subjectRef from ids/workspaceId),
//     never the item's free-form `message` (safety rule 7); a recordFailure fault PROPAGATES (Lesson 18).
//   • computeAndRouteRebuildOracle — await the one-shot compute once, route ONLY `diverged` statuses to the sink, and
//     CONTAIN any fault so it never escapes boot as an unhandled rejection (§16).
// The DEFAULT binding (owner-gated client absent) yields no wiring ⇒ resolveOracleBuild unbound ⇒ oracleBuildOk
// false ⇒ byte-equivalent + no false green (Lesson 16). Tests drive the REAL gateRebuildOracle/probe (Lesson 20/21).
import { describe, it, expect, vi } from "vitest";
import { auditId, validParityReport } from "@sow/contracts";
import type {
  HealthItem,
  AuditId,
  WorkspaceId,
  RevisionId,
  GbrainPin,
  ParityReport,
  Result,
} from "@sow/contracts";
import {
  computeRevisionId,
  type CanonicalVaultSnapshot,
  type IndexRebuildClient,
  type IndexRebuildRequest,
  type IndexRebuildReceipt,
  type IndexRebuildError,
  type RunningGbrainVersion,
} from "@sow/knowledge";
import type { HealthFailure } from "../../src/health/surface";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import { createServingCoverageReader } from "../../src/api/procedures/servingContextBootReaders";
import type { ParityReportStore } from "../../src/composition/parityReportStore";
import {
  gateRebuildOracle,
  createRebuildOracleHealthSink,
  computeAndRouteRebuildOracle,
  type RebuildOracleGateDeps,
} from "../../src/boot";

const NOW = "2026-07-01T00:00:00.000Z";

// ── health-item + health-sink fixtures ─────────────────────────────────────────

/** A rebuild_divergence HealthItem carrying a HOSTILE free-form message (must NEVER be forwarded — safety rule 7). */
function divergenceItem(message: string): HealthItem {
  return {
    id: "rebuild-oracle-health:1",
    failureClass: "rebuild_divergence",
    severity: "error",
    message,
    auditRef: auditId("rebuild-oracle-audit:1"),
    openedAt: NOW,
    state: "open",
  };
}

function healthDeps(recordFailure: (f: HealthFailure) => Promise<unknown>) {
  return { recordFailure, now: () => NOW, newAuditId: () => "rebuild-oracle-audit:sink" };
}

// ── real gateRebuildOracle wiring fixtures (drive the real probe) ───────────────

function snapshotFor(ws: string): CanonicalVaultSnapshot {
  const map = new Map([
    ["alpha.md", "# Alpha\n\nLinks to [[beta]].\n"],
    ["beta.md", "---\ntags: work\n---\n# Beta\n\nBody.\n"],
  ]);
  return { workspaceId: ws as WorkspaceId, revisionId: computeRevisionId(map) as RevisionId, files: map };
}

class FakeRebuildClient implements IndexRebuildClient {
  constructor(private readonly outcome: (req: IndexRebuildRequest) => Result<IndexRebuildReceipt, IndexRebuildError>) {}
  async rebuildFromMarkdown(
    req: IndexRebuildRequest,
  ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
    return this.outcome(req);
  }
}

function okReceipt(req: IndexRebuildRequest, over: Partial<IndexRebuildReceipt> = {}): IndexRebuildReceipt {
  return { workspaceId: req.workspaceId, revisionId: req.revisionId, nodeCount: req.facts.length, replaced: true, ...over };
}

/** Gate deps whose client corroborates all ws EXCEPT `divergeWs` (returns replaced:false ⇒ diverged). */
function gateDeps(over: { reader?: CommittedVaultReader; divergeWs?: string; omitClient?: boolean } = {}): RebuildOracleGateDeps {
  const reader: CommittedVaultReader = over.reader ?? ((ws) => snapshotFor(ws));
  const client = new FakeRebuildClient((req) =>
    req.workspaceId === over.divergeWs
      ? { ok: true, value: okReceipt(req, { replaced: false }) }
      : { ok: true, value: okReceipt(req) },
  );
  let seq = 0;
  return {
    ...(over.omitClient ? {} : { makeRebuildClient: (): IndexRebuildClient => client }),
    makeReader: (): CommittedVaultReader => reader,
    now: () => NOW,
    newHealthItemId: (): string => `rebuild-oracle-health:${(seq += 1)}`,
    auditRef: "rebuild-oracle-audit:probe",
  };
}

// ── coverage-reader fixtures (test 4) ──────────────────────────────────────────

const RUNNING: RunningGbrainVersion = { sha: "abc1234def5678", indexSchemaVersion: 1 };
const PIN = {
  gbrainSha: "abc1234def5678",
  indexSchemaVersion: 1,
  validatedOn: "2026-01-01T00:00:00.000Z",
  writeThroughEnabled: false,
} as unknown as GbrainPin;
const cleanStore: ParityReportStore = {
  getLatestForRevision: (): Promise<ParityReport | undefined> => Promise.resolve(validParityReport),
};

// ── tests ──────────────────────────────────────────────────────────────────────

describe("createRebuildOracleHealthSink — rule-7 safe-fields-only reprojection (spec §16)", () => {
  it("health_sink_reprojects_safe_fields_only", async () => {
    const recorded: HealthFailure[] = [];
    const sink = createRebuildOracleHealthSink(healthDeps((f) => (recorded.push(f), Promise.resolve())));
    const item = divergenceItem("HOSTILE raw body MARKER_SECRET_zz — never forward this");

    await sink.record(item, "ws-employer");

    expect(recorded).toHaveLength(1);
    const f = recorded[0]!;
    expect(f.failureClass).toBe("rebuild_divergence"); // frozen class preserved
    expect(f.message).not.toContain("MARKER_SECRET_zz"); // the item's free-form message is NEVER forwarded
    expect(f.subjectRef).toContain("ws-employer"); // subjectRef from workspaceId (item lacks factIdentity/parityReportRef)
    expect(typeof f.auditRef).toBe("string");
    expect(f.now).toBe(NOW);
  });

  it("health_sink_record_fault_propagates", async () => {
    // a rejecting recordFailure ⇒ the sink REJECTS (Lesson 18) — a trust-defect signal is never silently dropped.
    const sink = createRebuildOracleHealthSink(
      healthDeps(() => Promise.reject(new Error("surface.record down: MARKER_zz"))),
    );
    await expect(sink.record(divergenceItem("x"), "ws-1")).rejects.toThrow(/surface\.record down/);
  });
});

describe("computeAndRouteRebuildOracle — compute once + route only diverged, contain faults (spec §6/§16)", () => {
  it("compute_routes_only_diverged", async () => {
    // 3 served ws over the REAL probe: ws-1 corroborates, ws-2 absent (reader undefined), ws-3 diverged.
    const reader: CommittedVaultReader = (ws) => (ws === "ws-2" ? undefined : snapshotFor(ws));
    const wiring = gateRebuildOracle({ servedWorkspaceIds: ["ws-1", "ws-2", "ws-3"] }, gateDeps({ reader, divergeWs: "ws-3" }));
    expect(wiring).toBeDefined();
    const routed: Array<{ item: HealthItem; ws: string }> = [];
    const sink = { record: (item: HealthItem, ws: string) => (routed.push({ item, ws }), Promise.resolve()) };

    await computeAndRouteRebuildOracle(wiring!, sink);

    // ONLY the diverged ws routed a health item; the fold is false (not all corroborated).
    expect(routed).toHaveLength(1);
    expect(routed[0]!.ws).toBe("ws-3");
    expect(routed[0]!.item.failureClass).toBe("rebuild_divergence");
    expect(wiring!.resolveOracleBuild()).toBe(false);
  });

  it("compute_never_throws_contains_fault", async () => {
    // a diverged status routed to a REJECTING sink ⇒ the fault is CONTAINED (never an unhandled rejection out of boot).
    // Non-vacuous: assert the flow RESOLVES and the rejecting sink WAS invoked (the fault path ran).
    const wiring = gateRebuildOracle({ servedWorkspaceIds: ["ws-3"] }, gateDeps({ divergeWs: "ws-3" }));
    const record = vi.fn(() => Promise.reject(new Error("surface down MARKER_zz")));
    const onContainedFault = vi.fn();
    await expect(computeAndRouteRebuildOracle(wiring!, { record }, onContainedFault)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
    // the contained fault is SIGNALLED (not fully silent) — the callback takes no args, so no raw content can leak.
    expect(onContainedFault).toHaveBeenCalledTimes(1);

    // §16 — even a THROWING onContainedFault (a broken logger) must NOT defeat containment / crash boot; the
    // fault SIGNAL is itself best-effort (mirror createReconcileLogSink's guarded log call).
    const throwingSignal = vi.fn(() => {
      throw new Error("logger blew up MARKER_zz");
    });
    await expect(computeAndRouteRebuildOracle(wiring!, { record }, throwingSignal)).resolves.toBeUndefined();
    expect(throwingSignal).toHaveBeenCalledTimes(1);
  });
});

describe("rebuild-oracle boot binding — byte-equivalent DEFAULT (owner client unbound, Lesson 16)", () => {
  it("default_off_wiring_absent_byte_equivalent", async () => {
    // makeRebuildClient ABSENT ⇒ gateRebuildOracle undefined ⇒ the binding passes resolveOracleBuild: undefined ⇒
    // createServingCoverageReader yields oracleBuildOk:false EVEN with pinValid true + a clean parity — no false green.
    // (The brief's `() => undefined` mis-mapped piece B's client-PRESENCE gate; the correct dormant binding is an
    //  ABSENT factory — flagged at Step 2.5. `() => undefined` also wouldn't typecheck as `() => IndexRebuildClient`.)
    const wiring = gateRebuildOracle({ servedWorkspaceIds: ["ws-1"] }, gateDeps({ omitClient: true }));
    expect(wiring).toBeUndefined();

    const sources = await createServingCoverageReader({
      pin: PIN,
      resolveRunning: () => RUNNING,
      now: () => NOW,
      store: cleanStore,
      resolveOracleBuild: wiring?.resolveOracleBuild, // the DEFAULT binding expression ⇒ undefined
    })("ws-1", "rev:abc" as RevisionId);

    expect(sources.pinValid).toBe(true); // other legs green
    expect(sources.parity).toBeDefined();
    expect(sources.oracleBuildOk).toBe(false); // NO false green — the oracle leg degrades by default
  });
});
