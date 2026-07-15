// Task 13.10 — rebuild-oracle producer arc, piece A: probeRebuildOracle (the STATUS producer). spec(§6) spec(§12) spec(§16)
//
// The pure worker-side rebuild-oracle STATUS producer composes an INJECTED committed-vault reader (LOCAL — the
// same seam the serving loader uses) + an INJECTED owner-gated IndexRebuildClient (real gbrain scratch-import;
// UNBOUND in production) through the already-built rebuildIndexFromMarkdown → a fail-closed `oracleBuildOk`
// boolean carried on a typed RebuildOracleStatus. The ONLY green path is a WHOLESALE-replace rebuild that
// recovers every Markdown-derivable node (corroborated); every other path degrades (never a false green):
//   • absent / empty / unmapped vault ⇒ absent          (client NOT called — no wasted rebuild I/O)
//   • WS-8 read-back mismatch (snapshot.workspaceId ≠ request) ⇒ absent (Lesson 20; client NOT called)
//   • any rebuildIndexFromMarkdown err (stale / derive-failed / client-fault / non-replacing / incomplete) ⇒
//     diverged, carrying the failure's OWN rebuild_divergence HealthItem (not a synthesized one)
//   • a THROWING/rejecting reader seam ⇒ faulted (defense-in-depth over the reader's never-throw contract)
// The producer is TOTAL — it never throws across its boundary (§16). Tests drive the REAL deriver
// (deriveCanonicalFacts) + a fake IndexRebuildClient, per Lesson 20/21 ("test with the real producer").
import { describe, it, expect } from "vitest";
import { HealthItemSchema } from "@sow/contracts";
import type { WorkspaceId, RevisionId, Result } from "@sow/contracts";
import {
  computeRevisionId,
  deriveCanonicalFacts,
  type CanonicalVaultSnapshot,
  type IndexRebuildClient,
  type IndexRebuildRequest,
  type IndexRebuildReceipt,
  type IndexRebuildError,
} from "@sow/knowledge";
import type { CommittedVaultReader } from "../../src/api/procedures/servingContextLoader";
import {
  probeRebuildOracle,
  type RebuildOracleProbeDeps,
} from "../../src/composition/rebuildOracleStatus";

const NOW = "2026-07-01T00:00:00.000Z";
const WS = "ws-1";

/** A REAL committed-vault snapshot whose revisionId hashes exactly its `.md` files (the go-live reader shape). */
function snapshot(files: Record<string, string>, ws: string = WS): CanonicalVaultSnapshot {
  const map = new Map(Object.entries(files));
  return { workspaceId: ws as WorkspaceId, revisionId: computeRevisionId(map) as RevisionId, files: map };
}

const twoPages = (ws?: string): CanonicalVaultSnapshot =>
  snapshot(
    {
      "alpha.md": "# Alpha\n\nLinks to [[beta]].\n",
      "beta.md": "---\ntags: work\n---\n# Beta\n\nBody.\n",
    },
    ws,
  );

/** A fake full-replace rebuild client that RECORDS the requests it received (for 0-invocation pins). */
class FakeRebuildClient implements IndexRebuildClient {
  readonly received: IndexRebuildRequest[] = [];
  constructor(
    private readonly outcome: (req: IndexRebuildRequest) => Result<IndexRebuildReceipt, IndexRebuildError>,
    private readonly throwOn = false,
  ) {}
  async rebuildFromMarkdown(
    req: IndexRebuildRequest,
  ): Promise<Result<IndexRebuildReceipt, IndexRebuildError>> {
    this.received.push(req);
    if (this.throwOn) throw new Error("rebuild client blew up");
    return this.outcome(req);
  }
  get calls(): number {
    return this.received.length;
  }
}

function okReceipt(req: IndexRebuildRequest, overrides: Partial<IndexRebuildReceipt> = {}): IndexRebuildReceipt {
  return {
    workspaceId: req.workspaceId,
    revisionId: req.revisionId,
    nodeCount: req.facts.length,
    replaced: true,
    ...overrides,
  };
}

function deps(reader: CommittedVaultReader, client: IndexRebuildClient): RebuildOracleProbeDeps {
  return {
    readCommittedVault: reader,
    rebuildClient: client,
    now: () => NOW,
    newHealthItemId: () => "health-oracle-1",
    auditRef: "audit-oracle-1",
  };
}

// ── the crown-jewel green path ─────────────────────────────────────────────────

describe("probeRebuildOracle — corroborated (the only path that yields oracleBuildOk=true)", () => {
  it("probe_wholesale_replace_corroborates: real snapshot + wholesale-replace-with-complete-recovery ⇒ oracleBuildOk true + full oracleSet", async () => {
    const snap = twoPages();
    const derived = deriveCanonicalFacts(snap);
    if (!derived.ok) throw new Error("fixture derive failed");
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

    const status = await probeRebuildOracle(WS, deps(async () => snap, client));

    expect(status.oracleBuildOk).toBe(true);
    if (!status.oracleBuildOk) return;
    expect(status.outcome).toBe("corroborated");
    expect(status.oracleSet.complete).toBe(true);
    // factIdentities == the gbrain-INDEPENDENT derived set's identities, in deriver order (decision #3).
    expect(status.oracleSet.factIdentities).toEqual(derived.value.facts.map((f) => f.fact.factIdentity));
    // NON-VACUITY: the crown-jewel green path must corroborate a NON-EMPTY set — else a 0-fact fixture would
    // pass green trivially ([] === []) on the one path that mints oracleBuildOk=true.
    expect(status.oracleSet.factIdentities.length).toBeGreaterThan(0);
    // the client WAS handed the gbrain-independent derived fact set for THIS workspace (a real rebuild happened).
    expect(client.calls).toBe(1);
    expect(client.received[0]?.workspaceId).toBe(WS);
    expect(client.received[0]?.facts.length).toBe(derived.value.facts.length);
  });
});

// ── fail-closed: absence (client never invoked) ────────────────────────────────

describe("probeRebuildOracle — absent (degrade, no wasted rebuild I/O)", () => {
  it("probe_absent_vault_degrades: reader ⇒ undefined ⇒ oracleBuildOk false; client 0 invocations", async () => {
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

    const status = await probeRebuildOracle(WS, deps(async () => undefined, client));

    expect(status.oracleBuildOk).toBe(false);
    expect(status.outcome).toBe("absent");
    expect(client.calls).toBe(0); // short-circuit provably BEFORE the rebuild seam
  });

  it("probe_ws_readback_mismatch_degrades: snapshot.workspaceId ≠ request ⇒ false; client 0 invocations (WS-8, Lesson 20)", async () => {
    const foreign = twoPages("ws-OTHER");
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

    const status = await probeRebuildOracle(WS, deps(async () => foreign, client));

    expect(status.oracleBuildOk).toBe(false);
    expect(status.outcome).toBe("absent");
    expect(client.calls).toBe(0); // never rebuild a foreign-workspace snapshot
  });
});

// ── fail-closed: divergence-defect (health-worthy) ─────────────────────────────

describe("probeRebuildOracle — diverged (surfaces the rebuild's OWN rebuild_divergence health item)", () => {
  it("probe_non_replacing_rebuild_diverges: replaced=false ⇒ false + rebuild_divergence health item (safety rule 1)", async () => {
    const snap = twoPages();
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req, { replaced: false }) }));

    const status = await probeRebuildOracle(WS, deps(async () => snap, client));

    expect(status.oracleBuildOk).toBe(false);
    if (status.oracleBuildOk || status.outcome !== "diverged") throw new Error("expected diverged");
    expect(HealthItemSchema.safeParse(status.healthItem).success).toBe(true);
    expect(status.healthItem.failureClass).toBe("rebuild_divergence");
  });

  it("probe_incomplete_recovery_diverges: nodeCount ≠ derivable count ⇒ false + health item (REQ-D-001)", async () => {
    const snap = twoPages();
    // recover one fewer node than derivable ⇒ incomplete_recovery.
    const client = new FakeRebuildClient((req) => ({
      ok: true,
      value: okReceipt(req, { nodeCount: req.facts.length - 1 }),
    }));

    const status = await probeRebuildOracle(WS, deps(async () => snap, client));

    expect(status.oracleBuildOk).toBe(false);
    if (status.oracleBuildOk || status.outcome !== "diverged") throw new Error("expected diverged");
    expect(status.healthItem.failureClass).toBe("rebuild_divergence");
  });

  it("probe_rebuild_client_fault_diverges: an err-returning client AND a THROWING client both ⇒ false + health item; producer never throws", async () => {
    const snap = twoPages();

    // (a) client returns a typed IndexRebuildError err.
    const errClient = new FakeRebuildClient(() => ({
      ok: false,
      error: { code: "gbrain_unavailable", message: "scratch import down" },
    }));
    const s1 = await probeRebuildOracle(WS, deps(async () => snap, errClient));
    expect(s1.oracleBuildOk).toBe(false);
    if (s1.oracleBuildOk || s1.outcome !== "diverged") throw new Error("expected diverged (err client)");
    expect(s1.healthItem.failureClass).toBe("rebuild_divergence");

    // (b) client THROWS — rebuildIndexFromMarkdown converts it to a typed err; the producer still never throws.
    const throwClient = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }), true);
    const s2 = await probeRebuildOracle(WS, deps(async () => snap, throwClient));
    expect(s2.oracleBuildOk).toBe(false);
    if (s2.oracleBuildOk || s2.outcome !== "diverged") throw new Error("expected diverged (throwing client)");
    expect(s2.healthItem.failureClass).toBe("rebuild_divergence");
  });
});

// ── fail-closed: reader fault (never throws — §16) ─────────────────────────────

describe("probeRebuildOracle — faulted (a throwing/rejecting reader seam degrades, never crosses the boundary)", () => {
  it("probe_reader_throw_faulted: a SYNC-throwing AND an ASYNC-rejecting reader both ⇒ false/faulted, resolved non-vacuously (Lesson 15)", async () => {
    const client = new FakeRebuildClient((req) => ({ ok: true, value: okReceipt(req) }));

    // SYNC throw — assert on the RESOLVED status (the producer resolves, never rejects), not inside a .catch.
    const syncReader: CommittedVaultReader = () => {
      throw new Error("reader boom (sync)");
    };
    const s1 = await probeRebuildOracle(WS, deps(syncReader, client));
    expect(s1.oracleBuildOk).toBe(false);
    expect(s1.outcome).toBe("faulted");

    // ASYNC reject.
    const asyncReader: CommittedVaultReader = async () => {
      throw new Error("reader reject (async)");
    };
    const s2 = await probeRebuildOracle(WS, deps(asyncReader, client));
    expect(s2.oracleBuildOk).toBe(false);
    expect(s2.outcome).toBe("faulted");

    expect(client.calls).toBe(0); // a faulted read never reaches the rebuild seam
  });
});
