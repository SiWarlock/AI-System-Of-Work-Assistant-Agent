// C5.4b Slice 2 — the two REAL boot-side readers that feed the built `createServingContextLoader`:
//   • createCommittedVaultReader — enumerates a workspace's committed `.md` vault (via an injected VaultFs
//     resolver) into a CanonicalVaultSnapshot @ head; fail-closed / never-throws / WS-8-scoped.
//   • createServingCoverageReader — derives the raw serving-coverage legs: pinValid REAL (checkVersionPin),
//     parity honest-interim `undefined` (no serve-time ParityReport store), oracleBuildOk false; never-throws.
// The integration pin proves the real vault reader → loader → admitForServing path: a KW-stamped note is
// admitted (trusted); an unstamped note is withheld. Boot wiring is Slice 3 (reachability WAIVED here).
import { describe, it, expect, afterAll } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  RevisionId,
  FactIdentity,
  MdContentSha,
  GbrainPin,
  ParityReport,
} from "@sow/contracts";
import {
  createCommittedVaultReader,
  createServingCoverageReader,
  type ServingCoverageReaderDeps,
} from "../../../src/api/procedures/servingContextBootReaders";
import {
  createServingContextLoader,
  deriveServingCoverage,
  type ServingContextLoaderDeps,
  type ServingCoverageReader,
} from "../../../src/api/procedures/servingContextLoader";
import type { ParityReportStore } from "../../../src/composition/parityReportStore";
import { createServingGateOracle } from "../../../src/api/procedures/copilotProvenanceStamp";
import type { RetrievedContext, RetrievedSource } from "../../../src/api/procedures/copilot";
import { createFsVault } from "../../../src/composition/backends";
import {
  computePageProvenance,
  admitForServing,
  stampProvenance,
  serializeStampFieldValue,
  readVaultHeadRevision,
  isDegradedCoverage,
  type VaultFs,
  type SecretsPort,
  type SecretUnresolved,
  type StamperDeps,
  type RunningGbrainVersion,
} from "@sow/knowledge";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const WS = "ws-personal";
const WS_BRAND = WS as unknown as WorkspaceId;
const REV = "rev-1" as unknown as RevisionId;
const KEY = new Uint8Array(32).fill(9);
const REF = "kw-key";
const DUMMY_REV = "rev-x" as unknown as RevisionId;

// ── fakes ─────────────────────────────────────────────────────────────────────

/** A fake VaultFs over an in-memory file map. `list` returns ALL keys (incl. non-.md and any `unreadable`
 *  paths) so the reader's own `.md` filter + read-fault handling are exercised. `read` returns `undefined` for
 *  a missing/unreadable path (the race/deleted case). Optional whole-op fault injectors. */
function fakeVault(
  files: Record<string, string>,
  opts: { listRejects?: boolean; readRejects?: boolean; unreadable?: readonly string[] } = {},
): VaultFs {
  const listing = [...Object.keys(files), ...(opts.unreadable ?? [])];
  return {
    read: (path: string): Promise<string | undefined> =>
      opts.readRejects ? Promise.reject(new Error("read fault")) : Promise.resolve(files[path]),
    list: (): Promise<string[]> =>
      opts.listRejects ? Promise.reject(new Error("list fault")) : Promise.resolve(listing),
    write: (): Promise<void> => Promise.resolve(),
    rename: (): Promise<void> => Promise.resolve(),
    remove: (): Promise<void> => Promise.resolve(),
  };
}

class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const signing = (): StamperDeps => ({ secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF });

/** Stamp a note EXACTLY as the KnowledgeWriter does (G1d-2): hash the base, mint over it, embed kwStamp. */
async function stampNote(path: string, base: string): Promise<string> {
  const page = computePageProvenance(path, base);
  if (page === null) throw new Error("no slug");
  const minted = await stampProvenance(
    {
      workspaceId: WS_BRAND,
      factIdentity: page.pageIdentity as FactIdentity,
      originPath: path,
      mdContentSha: page.pageSha as MdContentSha,
      kwRevision: REV,
      sourceEventRef: "src-1",
      committedAt: "2026-07-09T00:00:00.000Z",
    },
    signing(),
  );
  if (!minted.ok) throw new Error("mint failed");
  const value = serializeStampFieldValue(minted.value);
  const close = base.indexOf("\n---\n", 4);
  return `${base.slice(0, close)}\nkwStamp: ${value}${base.slice(close)}`;
}

// ── createCommittedVaultReader ──────────────────────────────────────────────────

describe("createCommittedVaultReader — committed .md → snapshot @ head", () => {
  it("vault_reader_builds_snapshot_from_committed_md", async () => {
    const vault = fakeVault({ "notes/a.md": "AAA", "notes/b.md": "BBB", "notes/c.txt": "CCC" });
    const snap = await createCommittedVaultReader({ resolveVault: () => vault })(WS);
    expect(snap).toBeDefined();
    if (snap === undefined) return;
    expect(String(snap.workspaceId)).toBe(WS);
    expect([...snap.files.keys()].sort()).toEqual(["notes/a.md", "notes/b.md"]); // .txt excluded
    expect(snap.files.get("notes/a.md")).toBe("AAA");
    expect(snap.files.get("notes/b.md")).toBe("BBB");
    // revisionId is the canonical head from readVaultHeadRevision (same fn the executor uses)
    expect(String(snap.revisionId)).toBe(String(await readVaultHeadRevision(vault)));
  });

  it("vault_reader_returns_undefined_when_unmapped_or_empty", async () => {
    // (a) unresolvable workspace / no vault → undefined
    expect(await createCommittedVaultReader({ resolveVault: () => undefined })(WS)).toBeUndefined();
    // (b) vault with zero .md → undefined
    expect(
      await createCommittedVaultReader({ resolveVault: () => fakeVault({ "notes/only.txt": "x" }) })(WS),
    ).toBeUndefined();
    // (c) truly empty vault → undefined
    expect(await createCommittedVaultReader({ resolveVault: () => fakeVault({}) })(WS)).toBeUndefined();
  });

  it("vault_reader_never_throws_on_read_fault", async () => {
    const listFault = createCommittedVaultReader({
      resolveVault: () => fakeVault({ "a.md": "x" }, { listRejects: true }),
    });
    await expect(listFault(WS)).resolves.toBeUndefined();
    const readFault = createCommittedVaultReader({
      resolveVault: () => fakeVault({ "a.md": "x" }, { readRejects: true }),
    });
    await expect(readFault(WS)).resolves.toBeUndefined();
    // a resolver that itself throws → undefined (no throw crosses the boundary)
    const resolverThrows = createCommittedVaultReader({
      resolveVault: () => {
        throw new Error("resolve boom");
      },
    });
    await expect(resolverThrows(WS)).resolves.toBeUndefined();
  });

  it("vault_reader_skips_a_listed_but_unreadable_md_keeps_the_readable_subset", async () => {
    // a .md listed but unreadable at read-time (race/deleted → read returns undefined) is SKIPPED; the
    // readable subset still loads (fail-SAFE: an absent page just isn't in the allow-set ⇒ withholds).
    const mixed = fakeVault({ "notes/a.md": "AAA" }, { unreadable: ["notes/gone.md"] });
    const snap = await createCommittedVaultReader({ resolveVault: () => mixed })(WS);
    expect(snap).toBeDefined();
    if (snap === undefined) return;
    expect([...snap.files.keys()]).toEqual(["notes/a.md"]);
    expect(snap.files.has("notes/gone.md")).toBe(false);
    // ALL listed .md unreadable ⇒ zero readable ⇒ undefined (loader degrades)
    const allGone = fakeVault({}, { unreadable: ["notes/x.md", "notes/y.md"] });
    expect(await createCommittedVaultReader({ resolveVault: () => allGone })(WS)).toBeUndefined();
  });

  it("vault_reader_keeps_empty_content_and_excludes_case-variant_extensions", async () => {
    // an empty-STRING `.md` is a real (empty) note and is KEPT (only an unreadable `read → undefined` is skipped);
    // a `.MD` (case-variant) is EXCLUDED — the filter mirrors the writer's case-sensitive stamp filter.
    const vault = fakeVault({ "notes/empty.md": "", "notes/UPPER.MD": "X", "notes/ok.md": "OK" });
    const snap = await createCommittedVaultReader({ resolveVault: () => vault })(WS);
    expect(snap).toBeDefined();
    if (snap === undefined) return;
    expect([...snap.files.keys()].sort()).toEqual(["notes/empty.md", "notes/ok.md"]); // .MD excluded
    expect(snap.files.get("notes/empty.md")).toBe(""); // empty note kept, not skipped
  });

  it("vault_reader_is_workspace_scoped", async () => {
    const vault = fakeVault({ "notes/a.md": "AAA" });
    // the resolver is the WS-8 authority: it maps ONLY WS; a foreign/unmapped id → undefined.
    const reader = createCommittedVaultReader({ resolveVault: (ws) => (ws === WS ? vault : undefined) });
    const mine = await reader(WS);
    expect(mine === undefined ? undefined : String(mine.workspaceId)).toBe(WS); // stamped with the REQUESTED id
    expect(await reader("ws-foreign")).toBeUndefined(); // unmapped → refused
  });
});

// ── createServingCoverageReader ─────────────────────────────────────────────────

const RUNNING: RunningGbrainVersion = { sha: "abc1234def5678", indexSchemaVersion: 1 };
const pinOf = (over: Partial<GbrainPin> = {}): GbrainPin =>
  ({
    gbrainSha: "abc1234def5678",
    indexSchemaVersion: 1,
    validatedOn: "2026-01-01T00:00:00.000Z", // a real ISO date — NOT a PENDING_ sentinel
    writeThroughEnabled: false,
    ...over,
  }) as unknown as GbrainPin;
const covDeps = (over: Partial<ServingCoverageReaderDeps> = {}): ServingCoverageReaderDeps => ({
  pin: pinOf(),
  resolveRunning: () => RUNNING,
  now: () => "2026-07-13T00:00:00.000Z",
  ...over,
});

/**
 * A fake {@link ParityReportStore} for the reader unit tests: resolves a report, a true absence
 * (`undefined`), or REJECTS (a fault, as the real adapter does on any DbError) — and optionally spies the
 * `(workspaceId, revisionId)` it was queried with. `record` is not on the narrow read-port, so it is absent.
 */
function fakeStore(
  behavior: { report?: ParityReport; reject?: boolean },
  spy?: (workspaceId: string, revisionId: string) => void,
): ParityReportStore {
  return {
    getLatestForRevision: (workspaceId: string, revisionId: string): Promise<ParityReport | undefined> => {
      spy?.(workspaceId, revisionId);
      return behavior.reject
        ? Promise.reject(new Error("operational-store parityReport.getLatestForRevision failed (unavailable): boom"))
        : Promise.resolve(behavior.report);
    },
  };
}

describe("createServingCoverageReader — real pin leg + persisted parity leg (B2), honest-interim oracle", () => {
  it("coverage_reader_pinValid_true_and_false", async () => {
    // running SHA matches the pin → pinValid true
    expect((await createServingCoverageReader(covDeps())(WS, DUMMY_REV)).pinValid).toBe(true);
    // SHA mismatch → pinValid false
    expect(
      (
        await createServingCoverageReader(
          covDeps({ resolveRunning: () => ({ sha: "deadbeef00000", indexSchemaVersion: 1 }) }),
        )(WS, DUMMY_REV)
      ).pinValid,
    ).toBe(false);
    // gbrain unavailable (running undefined) → pinValid false
    expect(
      (await createServingCoverageReader(covDeps({ resolveRunning: () => undefined }))(WS, DUMMY_REV)).pinValid,
    ).toBe(false);
    // a PENDING_ pin (owed live validation) → pinValid false even on a SHA match
    expect(
      (
        await createServingCoverageReader(covDeps({ pin: pinOf({ validatedOn: "PENDING_LIVE_VALIDATION" }) }))(
          WS,
          DUMMY_REV,
        )
      ).pinValid,
    ).toBe(false);
  });

  it("coverage_reader_parity_undefined_and_oracle_false", async () => {
    // UNBOUND store (the dormant default — boot binds a real store in B4) ⇒ parity undefined ⇒ degrade
    const s = await createServingCoverageReader(covDeps())(WS, DUMMY_REV);
    expect(s.parity).toBeUndefined();
    expect(s.oracleBuildOk).toBe(false); // no serve-time rebuild oracle (B2 wires the parity leg only)
    expect(s.pinValid).toBe(true); // pin is a real coverage signal
    // ⇒ even with a valid pin, absent parity means the loader still degrades in production (sound + inert).
  });

  it("coverage_reader_never_throws", async () => {
    const ALL_FALSE = { parity: undefined, pinValid: false, oracleBuildOk: false };
    // a throwing running-probe → all-fail-closed, no throw
    const probeThrows = createServingCoverageReader(
      covDeps({
        resolveRunning: () => {
          throw new Error("probe boom");
        },
      }),
    );
    expect(await probeThrows(WS, DUMMY_REV)).toEqual(ALL_FALSE);
    // a throwing clock (checkVersionPin invokes now() on its degrade path) → all-fail-closed, no throw
    const clockThrows = createServingCoverageReader(
      covDeps({
        resolveRunning: () => undefined, // forces the degrade path that calls now()
        now: () => {
          throw new Error("clock boom");
        },
      }),
    );
    expect(await clockThrows(WS, DUMMY_REV)).toEqual(ALL_FALSE);
  });

  // ── B2: the persisted parity leg ─────────────────────────────────────────────────
  it("serving_coverage_reader_binds_store_parity", async () => {
    // a bound store returning a report for (ws, rev) ⇒ the reader's `parity` IS that report (§6 parity leg)
    const report = parityReport(String(DUMMY_REV));
    const s = await createServingCoverageReader(covDeps({ store: fakeStore({ report }) }))(WS, DUMMY_REV);
    expect(s.parity).toEqual(report);
    expect(s.pinValid).toBe(true); // pin stays a real signal
    expect(s.oracleBuildOk).toBe(false);
  });

  it("serving_coverage_reader_store_absence_degrades", async () => {
    // a bound store with NO report (never reconciled) ⇒ parity undefined (a true absence ⇒ degrade)
    const s = await createServingCoverageReader(covDeps({ store: fakeStore({ report: undefined }) }))(WS, DUMMY_REV);
    expect(s.parity).toBeUndefined();
    expect(s.pinValid).toBe(true);
  });

  it("serving_coverage_reader_store_reject_fail_closed", async () => {
    // a store REJECT (DbError) ⇒ the reader DEGRADES ALL legs and does NOT reject/throw (§6 fail-closed —
    // the load-bearing direction: a store fault never crosses the boundary and never becomes a false green).
    const reader = createServingCoverageReader(covDeps({ store: fakeStore({ reject: true }) }));
    await expect(reader(WS, DUMMY_REV)).resolves.toEqual({
      parity: undefined,
      pinValid: false,
      oracleBuildOk: false,
    });
  });

  it("serving_coverage_reader_unbound_store_byte_equivalent", async () => {
    // no store dep ⇒ today's dormant default: parity undefined + real pinValid + oracleBuildOk false
    const s = await createServingCoverageReader(covDeps())(WS, DUMMY_REV);
    expect(s).toEqual({ parity: undefined, pinValid: true, oracleBuildOk: false });
  });

  it("serving_coverage_reader_queries_head_revision", async () => {
    // the store is queried with the HEAD (workspaceId, String(revisionId)) passed in — not a stale one
    const calls: Array<[string, string]> = [];
    const store = fakeStore({ report: parityReport(String(DUMMY_REV)) }, (ws, rev) => calls.push([ws, rev]));
    await createServingCoverageReader(covDeps({ store }))(WS, DUMMY_REV);
    expect(calls).toEqual([[WS, String(DUMMY_REV)]]);
  });

  it("serving_coverage_reader_oracle_build_ok_stays_false", async () => {
    // even a green report (clean+complete, by construction) + a valid pin ⇒ oracleBuildOk STILL false when
    // `resolveOracleBuild` is UNBOUND (the dormant default) ⇒ coverage stays AND-degraded. (B5 makes the leg
    // bindable via `resolveOracleBuild?`; boot leaves it unbound — see the B5 describe below.)
    const green = parityReport(String(DUMMY_REV));
    const s = await createServingCoverageReader(covDeps({ store: fakeStore({ report: green }) }))(WS, DUMMY_REV);
    expect(s.parity).toEqual(green);
    expect(s.pinValid).toBe(true);
    expect(s.oracleBuildOk).toBe(false);
  });
});

// ── B5: the rebuild-oracle (oracleBuildOk) leg — the last hardwired-false coverage leg, now bindable ──────
describe("createServingCoverageReader — rebuild-oracle (oracleBuildOk) leg (B5)", () => {
  it("oracle_build_ok_unbound_stays_false", async () => {
    // no resolveOracleBuild dep (the dormant default) ⇒ oracleBuildOk false (byte-equivalent to the pre-B5 hardwire)
    const s = await createServingCoverageReader(covDeps())(WS, DUMMY_REV);
    expect(s.oracleBuildOk).toBe(false);
    expect(s.pinValid).toBe(true); // the other legs are unchanged
  });

  it("oracle_build_ok_bound_true", async () => {
    // a bound resolver returning true ⇒ oracleBuildOk carries the real signal
    const s = await createServingCoverageReader(covDeps({ resolveOracleBuild: () => true }))(WS, DUMMY_REV);
    expect(s.oracleBuildOk).toBe(true);
  });

  it("oracle_build_ok_bound_false", async () => {
    // an honest false ⇒ oracleBuildOk false ⇒ degrade (the rebuild-oracle build is not OK)
    const s = await createServingCoverageReader(covDeps({ resolveOracleBuild: () => false }))(WS, DUMMY_REV);
    expect(s.oracleBuildOk).toBe(false);
  });

  it("oracle_build_ok_throwing_fail_closed", async () => {
    // a THROWING resolver is caught by the reader's existing try/catch ⇒ ALL legs degrade — a probe fault never
    // crosses the boundary and never becomes a false green (§12 fail-closed; same posture as resolveRunning/store).
    const s = await createServingCoverageReader(
      covDeps({
        resolveOracleBuild: () => {
          throw new Error("rebuild-oracle probe boom");
        },
      }),
    )(WS, DUMMY_REV);
    expect(s).toEqual({ parity: undefined, pinValid: false, oracleBuildOk: false });
  });

  it("full_green_reachable_when_all_four_legs_true", async () => {
    // THE MILESTONE: a clean revision-matched report (bound store) + a valid pin + resolveOracleBuild()=>true ⇒
    // deriveServingCoverage yields ALL 4 legs true ⇒ isDegradedCoverage FALSE — the coverage gate is now
    // green-CAPABLE (the last hardwired-false leg removed). A unit proof with FAKES only. A REAL green admission
    // additionally needs BOTH (1) the RECONCILE-TRIGGER writing real reports into the store (else
    // getLatestForRevision returns undefined ⇒ degrade) AND (2) the owner arming `goLiveArmed` (the HARD LINE —
    // selectServingOracleFactory keeps the interim oracle until then). Production stays DORMANT: boot leaves
    // resolveOracleBuild AND the store UNBOUND. Green-CAPABLE ≠ live.
    const sources = await createServingCoverageReader(
      covDeps({ store: fakeStore({ report: parityReport(String(DUMMY_REV)) }), resolveOracleBuild: () => true }),
    )(WS, DUMMY_REV);
    const coverage = deriveServingCoverage(sources);
    expect(coverage).toEqual({
      cleanForServing: true,
      coverageComplete: true,
      pinValid: true,
      oracleBuildOk: true,
    });
    expect(isDegradedCoverage(coverage)).toBe(false);
  });
});

// ── integration: real vault reader → loader → gate (the value pin) ───────────────

const source = (citationId: string): RetrievedSource => ({ citationId, title: "T" });
const retrieval = (sources: readonly RetrievedSource[]): RetrievedContext => ({
  workspaceId: WS,
  blocks: ["blk"],
  sources,
});

/** A ParityReport carrying only the serving booleans the loader reads, scoped to `reconciledAtRevision`. */
const parityReport = (reconciledAtRevision: string): ParityReport =>
  ({
    reportId: "rep-1",
    workspaceId: WS_BRAND,
    reconciledAtRevision,
    gbrainSchemaVersion: 1,
    canonicalFactCount: 1,
    dbFactCount: 1,
    divergences: [],
    cleanForServing: true,
    coverageComplete: true,
  }) as unknown as ParityReport;

describe("integration — real createCommittedVaultReader → loader → admitForServing (value pin)", () => {
  const tmpRoots: string[] = [];
  afterAll(async () => {
    for (const r of tmpRoots) await rm(r, { recursive: true, force: true });
  });

  async function realVault(files: Record<string, string>): Promise<VaultFs> {
    const root = await mkdtemp(join(tmpdir(), "sow-serving-"));
    tmpRoots.push(root);
    for (const [p, content] of Object.entries(files)) {
      const full = join(root, p);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    return createFsVault(root);
  }

  // Green coverage that ECHOES the loader-passed head revisionId, so the revision-scoped parity check passes
  // regardless of the reader-computed head (this test proves the reader/loader/gate wiring, not coverage policy).
  const greenEcho: ServingCoverageReader = (_ws, revisionId) => ({
    parity: parityReport(String(revisionId)),
    pinValid: true,
    oracleBuildOk: true,
  });

  async function admittedVia(files: Record<string, string>): Promise<ReadonlySet<string>> {
    const vault = await realVault(files);
    const deps: ServingContextLoaderDeps = {
      readCommittedVault: createCommittedVaultReader({ resolveVault: () => vault }),
      readServingCoverage: greenEcho,
      secrets: new FakeSecretsPort({ [REF]: KEY }),
      signingKeyRef: REF,
    };
    const oracle = createServingGateOracle({ admitForServing, loadContext: createServingContextLoader(deps) });
    const v = await oracle.admit(WS, retrieval([source("gbrain:acme")]));
    if (!isOk(v)) throw new Error("oracle faulted");
    return v.value.mode === "gated" ? new Set(v.value.admitted.keys()) : new Set();
  }

  it("integration_real_vault_reader_admits_stamped_note_trusted", async () => {
    // (1) a genuinely KW-stamped note read off a REAL fs vault ⇒ its citation is ADMITTED (trusted)
    const stamped = await stampNote("notes/acme.md", "---\ntitle: Acme\n---\nprose");
    expect([...(await admittedVia({ "notes/acme.md": stamped }))]).toEqual(["gbrain:acme"]);
    // (2) an UNSTAMPED note ⇒ WITHHELD (no false-stamp path survives the real reader → loader → gate)
    expect([...(await admittedVia({ "notes/acme.md": "---\ntitle: Acme\n---\nprose" }))]).toEqual([]);
  });
});
