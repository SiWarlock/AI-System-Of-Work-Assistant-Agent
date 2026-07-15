// Task 13.10 — rebuild-oracle producer arc, piece B: gateRebuildOracle — the default-OFF rebuild-oracle boot gate. spec(§6) spec(§12)
//
// A pure gate helper (mirror gateReconcile F1 / Lesson 8/11/23/27): OFF (the owner-gated real IndexRebuildClient
// factory absent/not-a-function — the default — OR no served workspaces) ⇒ undefined + ZERO dep-thunk invocations
// (byte-equivalent — THE factory-spy safety pin); ON (owner-provisioned real client) ⇒ assemble a RebuildOracleWiring
// whose bound async `compute` runs piece A's probeRebuildOracle over every served workspace, FOLDS fail-closed
// (true IFF the served set is non-empty AND every workspace corroborates) to a boot-global boolean, and exposes a
// SYNC `resolveOracleBuild` accessor over the cached fold (false until compute runs). The real client stays UNBOUND
// by default ⇒ shipped default byte-equivalent; binding it is the owner's arming crossing. B1 = the gate helper +
// this direct test (fake reader + fake client); piece C = the bootWorker call site + boot-await/cache + the
// createServingCoverageReader binding (deferred).
import { describe, it, expect, vi } from "vitest";
import type { WorkspaceId, RevisionId, Result } from "@sow/contracts";
import {
  computeRevisionId,
  type CanonicalVaultSnapshot,
  type IndexRebuildClient,
  type IndexRebuildRequest,
  type IndexRebuildReceipt,
  type IndexRebuildError,
} from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import { gateRebuildOracle, type RebuildOracleGateDeps } from "../../src/boot";

const NOW = "2026-07-01T00:00:00.000Z";

/** A REAL committed-vault snapshot stamped with the REQUESTED workspaceId (mirrors createCommittedVaultReader). */
function snapshotFor(ws: string): CanonicalVaultSnapshot {
  const map = new Map([
    ["alpha.md", "# Alpha\n\nLinks to [[beta]].\n"],
    ["beta.md", "---\ntags: work\n---\n# Beta\n\nBody.\n"],
  ]);
  return { workspaceId: ws as WorkspaceId, revisionId: computeRevisionId(map) as RevisionId, files: map };
}

/** A fake full-replace rebuild client whose per-request outcome is caller-controlled (keys off req.workspaceId). */
class FakeRebuildClient implements IndexRebuildClient {
  readonly received: IndexRebuildRequest[] = [];
  constructor(private readonly outcome: (req: IndexRebuildRequest) => Result<IndexRebuildReceipt, IndexRebuildError>) {}
  async rebuildFromMarkdown(
    req: IndexRebuildRequest,
  ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
    this.received.push(req);
    return this.outcome(req);
  }
}

function okReceipt(req: IndexRebuildRequest, overrides: Partial<IndexRebuildReceipt> = {}): IndexRebuildReceipt {
  return { workspaceId: req.workspaceId, revisionId: req.revisionId, nodeCount: req.facts.length, replaced: true, ...overrides };
}

const corroborating = (): FakeRebuildClient => new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

/** Build the gate dep-thunks as spies; each is invoked ONLY on the ON path. `omitClient`/`badClient` model OFF. */
function makeGateDeps(
  over: {
    reader?: CommittedVaultReader;
    client?: IndexRebuildClient;
    omitClient?: boolean;
    badClient?: unknown;
  } = {},
) {
  const reader: CommittedVaultReader = over.reader ?? ((ws) => snapshotFor(ws));
  const client: IndexRebuildClient = over.client ?? corroborating();
  const makeReader = vi.fn((): CommittedVaultReader => reader);
  const makeRebuildClient = over.omitClient
    ? undefined
    : over.badClient !== undefined
      ? (over.badClient as () => IndexRebuildClient)
      : vi.fn((): IndexRebuildClient => client);
  const now = vi.fn(() => NOW);
  const newHealthItemId = vi.fn(() => "health-oracle-1");
  const deps: RebuildOracleGateDeps = { makeReader, makeRebuildClient, now, newHealthItemId, auditRef: "audit-oracle-1" };
  return { deps, makeReader, makeRebuildClient, now, newHealthItemId, client };
}

describe("gateRebuildOracle — default-OFF byte-equivalence (spec §12, Lesson 8/11/27)", () => {
  it("gate_off_absent_client_returns_undefined_zero_invocations", () => {
    // THE safety pin: the owner-gated real client factory is ABSENT (default) ⇒ undefined AND every dep-thunk 0 invocations.
    const { deps, makeReader, now, newHealthItemId } = makeGateDeps({ omitClient: true });
    expect(gateRebuildOracle({ servedWorkspaceIds: ["ws-1"] }, deps)).toBeUndefined();
    expect(makeReader).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(newHealthItemId).not.toHaveBeenCalled();
  });

  it("gate_off_malformed_client_degrades", () => {
    // a NON-FUNCTION makeRebuildClient value ⇒ undefined, no throw at gate time (type-robust, Lesson 27).
    const { deps, makeReader } = makeGateDeps({ badClient: 123 });
    expect(() => gateRebuildOracle({ servedWorkspaceIds: ["ws-1"] }, deps)).not.toThrow();
    expect(gateRebuildOracle({ servedWorkspaceIds: ["ws-1"] }, deps)).toBeUndefined();
    expect(makeReader).not.toHaveBeenCalled();
  });

  it("gate_off_no_served_workspaces_returns_undefined", () => {
    // client PRESENT but the served-set precondition fails ⇒ undefined + the present client factory 0 invocations.
    const { deps, makeReader, makeRebuildClient } = makeGateDeps();
    expect(gateRebuildOracle({ servedWorkspaceIds: [] }, deps)).toBeUndefined();
    expect(makeReader).not.toHaveBeenCalled();
    expect(makeRebuildClient).not.toHaveBeenCalled();
  });
});

describe("gateRebuildOracle — ON path: fold to a fail-closed boot-global boolean (spec §6)", () => {
  it("gate_on_all_corroborate_folds_true", async () => {
    // multi-ws green fold: every served ws corroborates ⇒ compute resolves resolveOracleBuild() === true.
    const { deps, makeReader, makeRebuildClient } = makeGateDeps();
    const wiring = gateRebuildOracle({ servedWorkspaceIds: ["ws-1", "ws-2"] }, deps);
    expect(wiring).toBeDefined();
    expect(makeReader).toHaveBeenCalledTimes(1);
    expect(makeRebuildClient).toHaveBeenCalledTimes(1);
    // fail-closed BEFORE compute runs.
    expect(wiring!.resolveOracleBuild()).toBe(false);

    const result = await wiring!.compute();
    expect(result.oracleBuildOk).toBe(true);
    expect(wiring!.resolveOracleBuild()).toBe(true); // cached one-shot boot-global boolean
    expect(result.statuses.map((s) => s.workspaceId)).toEqual(["ws-1", "ws-2"]);
    expect(result.statuses.every((s) => s.status.outcome === "corroborated")).toBe(true);
  });

  it("gate_on_any_non_corroborated_folds_false", async () => {
    // fail-closed AND: a SINGLE non-corroborated served ws ⇒ false. Parametrized over a diverged ws AND an absent ws.
    // (a) ws-2 diverges (client returns replaced:false for it).
    const divergeClient = new FakeRebuildClient((req) =>
      req.workspaceId === "ws-2"
        ? { ok: true, value: okReceipt(req, { replaced: false }) }
        : { ok: true, value: okReceipt(req) },
    );
    const g1 = makeGateDeps({ client: divergeClient });
    const w1 = gateRebuildOracle({ servedWorkspaceIds: ["ws-1", "ws-2"] }, g1.deps);
    const r1 = await w1!.compute();
    expect(r1.oracleBuildOk).toBe(false);
    expect(w1!.resolveOracleBuild()).toBe(false);
    expect(r1.statuses.find((s) => s.workspaceId === "ws-2")?.status.outcome).toBe("diverged");

    // (b) ws-2 absent (reader returns undefined for it).
    const absentReader: CommittedVaultReader = (ws) => (ws === "ws-2" ? undefined : snapshotFor(ws));
    const g2 = makeGateDeps({ reader: absentReader });
    const w2 = gateRebuildOracle({ servedWorkspaceIds: ["ws-1", "ws-2"] }, g2.deps);
    const r2 = await w2!.compute();
    expect(r2.oracleBuildOk).toBe(false);
    expect(w2!.resolveOracleBuild()).toBe(false);
    expect(r2.statuses.find((s) => s.workspaceId === "ws-2")?.status.outcome).toBe("absent");
  });

  it("gate_on_compute_never_throws", async () => {
    // total over dep faults: a THROWING reader ⇒ piece A degrades to faulted ⇒ the fold resolves false, never throws.
    // Asserted NON-VACUOUSLY on the resolved result (not inside a .catch — Lesson 15).
    const throwingReader: CommittedVaultReader = () => {
      throw new Error("reader boom");
    };
    const { deps } = makeGateDeps({ reader: throwingReader });
    const wiring = gateRebuildOracle({ servedWorkspaceIds: ["ws-1"] }, deps);
    const result = await wiring!.compute();
    expect(result.oracleBuildOk).toBe(false);
    expect(wiring!.resolveOracleBuild()).toBe(false);
    expect(result.statuses[0]?.status.outcome).toBe("faulted");
  });
});
