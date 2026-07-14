// Gate 4 (G1e-2) — the worker-side production ServingContextLoader: it assembles the real per-workspace
// WorkspaceServingContext the real createServingGateOracle runs over (allow-set + rehydrate + quarantine +
// FAIL-CLOSED coverage + signing-key deps + an injective citation resolver), or resolves `degraded` (a NORMAL
// state, never a fault) when the workspace cannot be gated-served. Provenance / serving-trust surface: no
// false-stamp path may survive; §16 no-throw + fail-closed default hold on every axis.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  RevisionId,
  FactIdentity,
  MdContentSha,
  ParityReport,
} from "@sow/contracts";
import {
  createServingContextLoader,
  buildCitationResolver,
  deriveServingCoverage,
  selectServingOracleFactory,
  type ServingContextLoaderDeps,
  type ServingCoverageReader,
  type ServingCoverageSources,
} from "../../../src/api/procedures/servingContextLoader";
import {
  createServingGateOracle,
  createInterimDegradedServingOracle,
} from "../../../src/api/procedures/copilotProvenanceStamp";
import type { RetrievedContext, RetrievedSource } from "../../../src/api/procedures/copilot";
import {
  computePageProvenance,
  deriveCanonicalFacts,
  admitForServing,
  stampProvenance,
  serializeStampFieldValue,
  isDegradedCoverage,
  type CanonicalVaultSnapshot,
  type CanonicalFactSet,
  type DerivedFact,
  type SecretsPort,
  type SecretUnresolved,
  type StamperDeps,
} from "@sow/knowledge";

const WS = "ws-personal";
const WS_BRAND = WS as unknown as WorkspaceId;
const REV = "rev-1" as unknown as RevisionId;
const KEY = new Uint8Array(32).fill(9);
const REF = "kw-key";

class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const signing = (port: SecretsPort = new FakeSecretsPort({ [REF]: KEY })): StamperDeps => ({
  secrets: port,
  signingKeyRef: REF,
});

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

const snapOf = (files: Record<string, string>): CanonicalVaultSnapshot => ({
  workspaceId: WS_BRAND,
  revisionId: REV,
  files: new Map(Object.entries(files)),
});

/** A ParityReport carrying only the two serving-coverage booleans the loader reads (other fields stubbed). */
const parityReport = (o: {
  cleanForServing: boolean;
  coverageComplete: boolean;
  reconciledAtRevision?: string;
}): ParityReport =>
  ({
    reportId: "rep-1",
    workspaceId: WS_BRAND,
    reconciledAtRevision: o.reconciledAtRevision ?? REV,
    gbrainSchemaVersion: 1,
    canonicalFactCount: 1,
    dbFactCount: 1,
    divergences: [],
    cleanForServing: o.cleanForServing,
    coverageComplete: o.coverageComplete,
  }) as unknown as ParityReport;

const GREEN_SOURCES: ServingCoverageSources = {
  parity: parityReport({ cleanForServing: true, coverageComplete: true }),
  pinValid: true,
  oracleBuildOk: true,
};
const greenCoverage: ServingCoverageReader = () => GREEN_SOURCES;

/** Build a loader over a fixed snapshot + all-green coverage + a resolvable key (override any leg per test). */
async function readyDeps(over: Partial<ServingContextLoaderDeps> = {}): Promise<ServingContextLoaderDeps> {
  const path = "notes/acme.md";
  const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
  const snapshot = snapOf({ [path]: stamped });
  return {
    readCommittedVault: () => snapshot,
    readServingCoverage: greenCoverage,
    secrets: new FakeSecretsPort({ [REF]: KEY }),
    signingKeyRef: REF,
    ...over,
  };
}

// ── minimal hand-built allow-set for the pure resolver (bypasses the deriver) ─────
const pageFact = (id: string): DerivedFact =>
  ({ fact: { factIdentity: id, factKind: "page" } }) as unknown as DerivedFact;
const rawFactSet = (...facts: DerivedFact[]): CanonicalFactSet =>
  ({ workspaceId: WS_BRAND, revisionId: REV, facts }) as unknown as CanonicalFactSet;

describe("createServingContextLoader — ready-context assembly (gate 4 G1e-2)", () => {
  // spec(§6) — serving-context assembly: a stamped, indexed, covered workspace loads a READY context.
  it("loader_assembles_ready_context_for_stamped_page", async () => {
    const deps = await readyDeps();
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.mode).toBe("ready");
    if (r.value.mode !== "ready") return;
    const ctx = r.value.context;
    expect(String(ctx.revisionId)).toBe(REV);
    // the allow-set carries the page fact
    expect(ctx.allowSet.facts.some((f) => String(f.fact.factIdentity) === "page:acme")).toBe(true);
    // the rehydrator serves the committed page bytes (stamp present ⇒ ok)
    expect(isOk(ctx.rehydrate("page:acme"))).toBe(true);
    // coverage is green (not degraded); servingDeps carry the injected key ref
    expect(isDegradedCoverage(ctx.coverage)).toBe(false);
    expect(ctx.servingDeps.signingKeyRef).toBe(REF);
    // quarantine IS the injected seed ledger — default EMPTY when unseeded (Q4)
    expect(ctx.quarantine.list()).toEqual([]);
    // the citation resolver maps gbrain:<slug> → the page fact identity
    expect(ctx.resolveCitation("gbrain:acme")).toEqual(["page:acme"]);
  });
});

describe("createServingContextLoader — degraded (a NORMAL state, never a throw) (gate 4 G1e-2)", () => {
  // spec(§6) — §6(v) fail-closed default: an empty / never-indexed vault degrades (NOT err, NOT a throw).
  it("loader_degraded_when_no_allowset", async () => {
    // (a) empty vault (indexed but no pages) → degraded
    const empty = await createServingContextLoader(
      await readyDeps({ readCommittedVault: () => snapOf({}) }),
    )(WS);
    expect(isOk(empty)).toBe(true);
    if (isOk(empty)) expect(empty.value.mode).toBe("degraded");
    // (b) never-indexed (reader unbound / returns undefined) → degraded
    const unindexed = await createServingContextLoader(
      await readyDeps({ readCommittedVault: () => undefined }),
    )(WS);
    expect(isOk(unindexed)).toBe(true);
    if (isOk(unindexed)) expect(unindexed.value.mode).toBe("degraded");
  });

  // runbook §1 — "no signing key → no sig can be verified → fail closed": the loader degrades, never serves.
  it("loader_degraded_when_signing_key_unresolved", async () => {
    const deps = await readyDeps({ secrets: new FakeSecretsPort({}) }); // REF unresolvable
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("degraded");
  });

  // runbook §1 — dirty parity / pin mismatch ⇒ untrusted: any non-green coverage leg degrades the loader.
  it("coverage_degraded_on_dirty_or_absent_parity", async () => {
    // deriveServingCoverage is fail-closed on each leg — NEVER hardcoded all-green
    expect(
      isDegradedCoverage(
        deriveServingCoverage({
          parity: parityReport({ cleanForServing: false, coverageComplete: true }),
          pinValid: true,
          oracleBuildOk: true,
        }),
      ),
    ).toBe(true); // dirty parity
    expect(
      isDegradedCoverage(deriveServingCoverage({ parity: undefined, pinValid: true, oracleBuildOk: true })),
    ).toBe(true); // absent parity
    expect(
      isDegradedCoverage({
        ...deriveServingCoverage(GREEN_SOURCES),
        ...deriveServingCoverage({ parity: GREEN_SOURCES.parity, pinValid: false, oracleBuildOk: true }),
      }),
    ).toBe(true); // pin mismatch
    // and green sources are NOT degraded (proves the derivation is real, not a constant)
    expect(isDegradedCoverage(deriveServingCoverage(GREEN_SOURCES))).toBe(false);
    // the loader resolves `degraded` under a degraded coverage leg (dirty parity)
    const deps = await readyDeps({
      readServingCoverage: () => ({
        parity: parityReport({ cleanForServing: false, coverageComplete: true }),
        pinValid: true,
        oracleBuildOk: true,
      }),
    });
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("degraded");
  });

  // safety rule 4 (workspace isolation) — a snapshot for the WRONG workspace fails closed to degraded HERE,
  // not just at the downstream gate's workspace_mismatch backstop.
  it("loader_degraded_when_snapshot_workspace_mismatches", async () => {
    const path = "notes/acme.md";
    const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
    const foreign: CanonicalVaultSnapshot = {
      workspaceId: "ws-OTHER" as unknown as WorkspaceId, // reader returned a DIFFERENT workspace's vault
      revisionId: REV,
      files: new Map([[path, stamped]]),
    };
    const deps = await readyDeps({ readCommittedVault: () => foreign });
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("degraded");
  });

  // runbook §1 — a stale (green but wrong-revision) ParityReport cannot vouch for the head set ⇒ degraded.
  it("loader_degraded_when_parity_revision_is_stale", async () => {
    const deps = await readyDeps({
      readServingCoverage: () => ({
        parity: parityReport({
          cleanForServing: true,
          coverageComplete: true,
          reconciledAtRevision: "rev-STALE", // scoped to a DIFFERENT revision than the head snapshot
        }),
        pinValid: true,
        oracleBuildOk: true,
      }),
    });
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("degraded");
  });

  // §16 — a throwing seam never crosses the boundary: a typed `err`, only on an actual (unexpected) load fault.
  it("loader_returns_typed_err_when_a_seam_throws", async () => {
    const deps = await readyDeps({
      readCommittedVault: () => {
        throw new Error("backend exploded");
      },
    });
    const r = await createServingContextLoader(deps)(WS);
    expect(isErr(r)).toBe(true);
  });
});

describe("createServingContextLoader — async (store-backed) coverage-reader seam (B2)", () => {
  // spec(§6) — the ServingCoverageReader seam is sync-or-async; a store-backed reader returns a Promise. The
  // loader must AWAIT it, not derive coverage from a Promise object (which would make every leg fail closed).
  // Proof: an ASYNC reader returning revision-scoped GREEN sources ⇒ the loader resolves READY (only reachable
  // if the resolved sources reached deriveServingCoverage — a non-awaiting loader would degrade on the Promise).
  it("loader_awaits_async_coverage_reader", async () => {
    const asyncGreen: ServingCoverageReader = () => Promise.resolve(GREEN_SOURCES); // GREEN parity is scoped to REV
    const deps = await readyDeps({ readServingCoverage: asyncGreen });
    const r = await createServingContextLoader(deps)(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("ready");
  });

  // spec(§6) nothing-fails-silently — a rejecting async reader (a store fault propagated) never crosses the
  // boundary: the loader's fail-closed catch folds it to a typed `err` (⇒ the oracle strips ⇒ untrusted). A
  // resolved all-false async reader is a NORMAL degrade (ok/degraded), never an err.
  it("loader_degrades_on_coverage_reader_reject", async () => {
    const rejecting: ServingCoverageReader = () => Promise.reject(new Error("coverage store boom"));
    const rejected = await createServingContextLoader(await readyDeps({ readServingCoverage: rejecting }))(WS);
    expect(isErr(rejected)).toBe(true);

    const allFalse: ServingCoverageReader = () =>
      Promise.resolve({ parity: undefined, pinValid: false, oracleBuildOk: false });
    const degraded = await createServingContextLoader(await readyDeps({ readServingCoverage: allFalse }))(WS);
    expect(isOk(degraded)).toBe(true);
    if (isOk(degraded)) expect(degraded.value.mode).toBe("degraded");
  });

  // spec(§6) global-kill-switch staleness closure — even a store-backed reader returning a GREEN report scoped
  // to a NON-head revision is treated as ABSENT by the loader's `revisionScopedParity` re-check ⇒ degraded (the
  // staleness kill-switch still fires with a real async store; the store query-scoping alone does not replace it).
  it("loader_revision_scope_still_kills_stale_store_report", async () => {
    const staleGreen: ServingCoverageReader = () =>
      Promise.resolve({
        parity: parityReport({ cleanForServing: true, coverageComplete: true, reconciledAtRevision: "rev-STALE" }),
        pinValid: true,
        oracleBuildOk: true,
      });
    const r = await createServingContextLoader(await readyDeps({ readServingCoverage: staleGreen }))(WS);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mode).toBe("degraded");
  });
});

describe("buildCitationResolver — injective gbrain:<slug> → [page:<slug>] (gate 4 G1e-2)", () => {
  // preconditions 2/3 — a served page's citation resolves to exactly its page fact identity.
  it("resolve_citation_maps_slug_to_page_factidentity", async () => {
    const snapshot = snapOf({ "notes/acme.md": "---\ntitle: Acme\n---\nprose" });
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) throw new Error("derive failed");
    const resolve = buildCitationResolver(allow.value);
    expect(resolve("gbrain:acme")).toEqual(["page:acme"]);
  });

  // precondition 3 — withhold (null), never guess: unknown slug, malformed citationId, or non-unique slug.
  it("resolve_citation_withholds_unknown_malformed_or_nonunique", () => {
    const resolve = buildCitationResolver(rawFactSet(pageFact("page:acme")));
    expect(resolve("gbrain:ghost")).toBeNull(); // unknown slug
    expect(resolve("not-a-citation")).toBeNull(); // malformed — no gbrain: prefix
    expect(resolve("gbrain:")).toBeNull(); // malformed — empty slug
    // a slug mapping to >1 served page fact → withhold (defense-in-depth even though the deriver dedupes)
    const dupResolve = buildCitationResolver(rawFactSet(pageFact("page:dupe"), pageFact("page:dupe")));
    expect(dupResolve("gbrain:dupe")).toBeNull();
  });

  // precondition 2 all-or-nothing — the page is the sole stamped + rehydratable unit: return ONLY the page fact.
  it("resolve_citation_returns_only_page_fact", () => {
    const snapshot = snapOf({ "notes/acme.md": "---\ntags: alpha\nrel: [[other]]\n---\n[[body-link]]\nprose" });
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) throw new Error("derive failed");
    // the note yields page + link + tag facts…
    expect(allow.value.facts.some((f) => f.fact.factKind === "link")).toBe(true);
    expect(allow.value.facts.some((f) => f.fact.factKind === "tag")).toBe(true);
    // …but the resolver returns EXACTLY the page fact identity (never link/tag identities)
    expect(buildCitationResolver(allow.value)("gbrain:acme")).toEqual(["page:acme"]);
  });

  // precondition 3 — injective: distinct citationIds resolve to DISJOINT factId sets.
  it("resolve_citation_is_injective_across_distinct_citations", () => {
    const resolve = buildCitationResolver(rawFactSet(pageFact("page:a"), pageFact("page:b")));
    const a = resolve("gbrain:a");
    const b = resolve("gbrain:b");
    expect(a).toEqual(["page:a"]);
    expect(b).toEqual(["page:b"]);
    const inter = (a ?? []).filter((x) => (b ?? []).includes(x));
    expect(inter).toEqual([]); // disjoint
  });
});

// ── the SAFETY-CRITICAL serving-trust pin: real oracle over the real loader ───────
const source = (citationId: string): RetrievedSource => ({ citationId, title: "T" });
const retrieval = (sources: readonly RetrievedSource[]): RetrievedContext => ({
  workspaceId: WS,
  blocks: ["blk"],
  sources,
});

/** Load a single-note vault through the REAL oracle+loader and return the admitted citationId set. */
async function admittedVia(vaultContent: string): Promise<ReadonlySet<string>> {
  const path = "notes/acme.md";
  const snapshot = snapOf({ [path]: vaultContent });
  const deps: ServingContextLoaderDeps = {
    readCommittedVault: () => snapshot,
    readServingCoverage: greenCoverage,
    secrets: new FakeSecretsPort({ [REF]: KEY }),
    signingKeyRef: REF,
  };
  const oracle = createServingGateOracle({
    admitForServing,
    loadContext: createServingContextLoader(deps),
  });
  const v = await oracle.admit(WS, retrieval([source("gbrain:acme")]));
  if (!isOk(v)) throw new Error("oracle faulted");
  return v.value.mode === "gated" ? new Set(v.value.admitted.keys()) : new Set();
}

describe("serving-trust END-TO-END: real createServingGateOracle over createServingContextLoader (gate 4 G1e-2)", () => {
  // The load-bearing safety pin (mirrors G1e-1 writer→serving, worker side): a genuinely KW-stamped page's
  // citation is ADMITTED; an unstamped OR body-tampered page is NOT — no false-stamp path survives.
  it("serving_trust_end_to_end", async () => {
    // (1) genuinely KW-stamped page ⇒ its citation is ADMITTED (gated, trusted)
    const stamped = await stampNote("notes/acme.md", "---\ntitle: Acme\n---\nprose");
    expect([...(await admittedVia(stamped))]).toEqual(["gbrain:acme"]);

    // (2) UNSTAMPED page ⇒ NOT admitted (no stamp ⇒ rehydrate withholds ⇒ all-or-nothing drops the citation)
    expect([...(await admittedVia("---\ntitle: Acme\n---\nprose"))]).toEqual([]);

    // (3) body TAMPERED after stamping ⇒ NOT admitted (leg-A hash re-derives to the tampered bytes, but the
    //     stamp's sig was minted over the ORIGINAL hash ⇒ signature_invalid ⇒ withheld). Tampered committed
    //     bytes can never be served as trusted.
    const tampered = stamped.replace("prose", "EVIL INJECTED CONTENT");
    expect(tampered).not.toBe(stamped);
    expect([...(await admittedVia(tampered))]).toEqual([]);
  });
});

describe("selectServingOracleFactory — boot dormancy pin (gate 4 G1e-2)", () => {
  // A dormant deps set (always-degrades) is enough to REFERENCE the real loader-backed factory — proving the
  // real path is constructible + selectable (dead-code-safe), while it is NEVER armed today.
  const dormantDeps: ServingContextLoaderDeps = {
    readCommittedVault: () => undefined,
    readServingCoverage: () => ({ parity: undefined, pinValid: false, oracleBuildOk: false }),
    secrets: new FakeSecretsPort({}),
    signingKeyRef: REF,
  };
  const loaderBacked = (): ReturnType<typeof createServingGateOracle> =>
    createServingGateOracle({ admitForServing, loadContext: createServingContextLoader(dormantDeps) });

  it("boot_stays_dormant_interim_default", () => {
    // provenance-stamping OFF ⇒ no decorator at all
    expect(selectServingOracleFactory({ provenanceStampingEnabled: false })).toBeUndefined();
    // ON but UNARMED ⇒ the interim always-degraded oracle is the SELECTED default (boot's live case today)
    expect(selectServingOracleFactory({ provenanceStampingEnabled: true })).toBe(
      createInterimDegradedServingOracle,
    );
    // ON + a real loaderBacked provided but STILL unarmed ⇒ interim (the precondition, not mere presence, gates)
    expect(selectServingOracleFactory({ provenanceStampingEnabled: true, loaderBacked })).toBe(
      createInterimDegradedServingOracle,
    );
    // ON + armed + a real loaderBacked ⇒ the loader-backed factory is selected (the go-live path is reachable)
    expect(
      selectServingOracleFactory({ provenanceStampingEnabled: true, loaderBacked, goLiveArmed: true }),
    ).toBe(loaderBacked);
  });
});
