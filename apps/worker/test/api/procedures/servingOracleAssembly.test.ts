// C5.4b Slice 3 — the go-live-seam boot assembly. Two small PURE helpers boot uses to construct the real
// admitForServing-backed serving oracle DORMANT behind three independent OFF-locks:
//   (1) the arming flag `copilotServingOracleGoLive` (default unset ⇒ goLiveArmed false),
//   (2) `loaderBacked === undefined` unless a signing key is provisioned (SecretsPort/Keychain = HITL/11.4),
//   (3) real serving coverage degrades by reality (no serve-time parity store) — arming ≠ trust.
// Each lock is INDEPENDENTLY sufficient to keep propose OFF. The crown-jewel e2e proves the whole assembled
// reader → loader → gate → stamp path from the boot helper. DO NOT arm the flag (owner hard-line).
import { describe, it, expect, afterAll } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Result, WorkspaceId, FactIdentity, MdContentSha } from "@sow/contracts";
import {
  buildLoaderBackedServingOracle,
  buildServedVaultResolver,
} from "../../../src/api/procedures/servingOracleAssembly";
import {
  selectServingOracleFactory,
  type ServingCoverageReader,
} from "../../../src/api/procedures/servingContextLoader";
import { createInterimDegradedServingOracle } from "../../../src/api/procedures/copilotProvenanceStamp";
import { createServingCoverageReader } from "../../../src/api/procedures/servingContextBootReaders";
import type { RetrievedContext, RetrievedSource } from "../../../src/api/procedures/copilot";
import { createFsVault } from "../../../src/composition/backends";
import {
  computePageProvenance,
  stampProvenance,
  serializeStampFieldValue,
  type VaultFs,
  type SecretsPort,
  type SecretUnresolved,
  type StamperDeps,
} from "@sow/knowledge";
import type { GbrainPin } from "@sow/contracts";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const WS = "ws-personal";
const WS_BRAND = WS as unknown as WorkspaceId;
const REV = "rev-1" as unknown as import("@sow/contracts").RevisionId;
const KEY = new Uint8Array(32).fill(9);
const REF = "kw-key";

class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const testSecrets = (): SecretsPort => new FakeSecretsPort({ [REF]: KEY });

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
    { secrets: testSecrets(), signingKeyRef: REF } as StamperDeps,
  );
  if (!minted.ok) throw new Error("mint failed");
  const value = serializeStampFieldValue(minted.value);
  const close = base.indexOf("\n---\n", 4);
  return `${base.slice(0, close)}\nkwStamp: ${value}${base.slice(close)}`;
}

const source = (citationId: string): RetrievedSource => ({ citationId, title: "T" });
const retrieval = (sources: readonly RetrievedSource[]): RetrievedContext => ({
  workspaceId: WS,
  blocks: ["blk"],
  sources,
});

// A green coverage reader that ECHOES the loader-passed head revision (so the revision-scoped parity check
// passes regardless of the reader-computed head) — the honest test injection (the REAL reader degrades).
const greenEcho: ServingCoverageReader = (_ws, revisionId) => ({
  parity: {
    reportId: "rep-1",
    workspaceId: WS_BRAND,
    reconciledAtRevision: String(revisionId),
    gbrainSchemaVersion: 1,
    canonicalFactCount: 1,
    dbFactCount: 1,
    divergences: [],
    cleanForServing: true,
    coverageComplete: true,
  } as unknown as import("@sow/contracts").ParityReport,
  pinValid: true,
  oracleBuildOk: true,
});

const STAMP_ENABLED = { provenanceStampingEnabled: true } as const;

// ── OFF-lock 1: the arming flag (dormancy pin — shipped default) ─────────────────

describe("selectServingOracleFactory composition — the three OFF-locks", () => {
  it("unset_flag_selects_interim_degraded_oracle", () => {
    // a fully-built loaderBacked, but goLiveArmed unset ⇒ interim selected (shipped default behavior)
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([[WS, {} as VaultFs]])),
      readServingCoverage: greenEcho,
      secrets: testSecrets(),
      signingKeyRef: REF,
    });
    expect(loaderBacked).toBeDefined();
    const selected = selectServingOracleFactory({ ...STAMP_ENABLED, loaderBacked });
    expect(selected).toBe(createInterimDegradedServingOracle); // OFF-lock 1: flag unset ⇒ interim
  });

  it("armed_without_signing_key_stays_interim", () => {
    // armed flag, but NO signing key ⇒ loaderBacked undefined ⇒ interim (the flag alone cannot arm)
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([[WS, {} as VaultFs]])),
      readServingCoverage: greenEcho,
      secrets: undefined, // key not provisioned (SecretsPort/Keychain = HITL)
      signingKeyRef: undefined,
    });
    expect(loaderBacked).toBeUndefined(); // OFF-lock 2 is STRUCTURAL
    const selected = selectServingOracleFactory({ ...STAMP_ENABLED, loaderBacked, goLiveArmed: true });
    expect(selected).toBe(createInterimDegradedServingOracle);
  });

  it("armed_with_key_selects_loaderBacked", () => {
    // flag on + a signing key ⇒ the real loaderBacked factory IS selected (the seam is genuinely selectable)
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([[WS, {} as VaultFs]])),
      readServingCoverage: greenEcho,
      secrets: testSecrets(),
      signingKeyRef: REF,
    });
    expect(loaderBacked).toBeDefined();
    const selected = selectServingOracleFactory({ ...STAMP_ENABLED, loaderBacked, goLiveArmed: true });
    expect(selected).toBe(loaderBacked);
    expect(selected).not.toBe(createInterimDegradedServingOracle);
  });

  it("provenance_stamping_off_selects_no_decorator_regardless", () => {
    // decorator off entirely ⇒ undefined even when armed + keyed (no stamping path at all)
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([[WS, {} as VaultFs]])),
      readServingCoverage: greenEcho,
      secrets: testSecrets(),
      signingKeyRef: REF,
    });
    expect(
      selectServingOracleFactory({ provenanceStampingEnabled: false, loaderBacked, goLiveArmed: true }),
    ).toBeUndefined();
  });
});

// ── resolveVault WS-8 (safety rule 4) ────────────────────────────────────────────

describe("buildServedVaultResolver — WS-8 fail-closed workspace→vault mapping", () => {
  it("resolveVault_is_workspace_scoped_and_fail_closed", () => {
    const vaultA = { tag: "A" } as unknown as VaultFs;
    const resolve = buildServedVaultResolver(new Map([[WS, vaultA]]));
    expect(resolve(WS)).toBe(vaultA); // a known served workspace ⇒ its own vault
    expect(resolve("ws-foreign")).toBeUndefined(); // unmapped ⇒ undefined (⇒ loader degrades)
    expect(resolve("")).toBeUndefined();
  });

  it("an empty served-workspace map resolves nothing (unconfigured ⇒ all degrade)", () => {
    const resolve = buildServedVaultResolver(new Map());
    expect(resolve(WS)).toBeUndefined();
  });
});

// ── the crown jewel + OFF-lock 3 (real coverage degrades) ────────────────────────

describe("boot-constructed serving oracle — the C5.4b crown-jewel e2e", () => {
  const tmpRoots: string[] = [];
  afterAll(async () => {
    for (const r of tmpRoots) await rm(r, { recursive: true, force: true });
  });

  async function fixtureVault(files: Record<string, string>): Promise<VaultFs> {
    const root = await mkdtemp(join(tmpdir(), "sow-oracle-boot-"));
    tmpRoots.push(root);
    for (const [p, content] of Object.entries(files)) {
      const full = join(root, p);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    }
    return createFsVault(root);
  }

  /** Run an ask through the ARMED, boot-constructed loaderBacked oracle over the given vault + coverage. */
  async function admittedVia(
    vault: VaultFs,
    coverage: ServingCoverageReader,
    citationId = "gbrain:acme",
  ): Promise<ReadonlySet<string>> {
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([[WS, vault]])),
      readServingCoverage: coverage,
      secrets: testSecrets(),
      signingKeyRef: REF,
    });
    const selected = selectServingOracleFactory({ ...STAMP_ENABLED, loaderBacked, goLiveArmed: true });
    if (selected === undefined || selected === createInterimDegradedServingOracle) {
      throw new Error("expected the loaderBacked factory to be selected");
    }
    const v = await selected().admit(WS, retrieval([source(citationId)]));
    if (!isOk(v)) throw new Error("oracle faulted");
    return v.value.mode === "gated" ? new Set(v.value.admitted.keys()) : new Set();
  }

  it("boot_constructed_oracle_admits_stamped_withholds_imported", async () => {
    // armed + test key + fixture vault (KW-STAMPED) + GREEN coverage ⇒ the stamped note is admitted (trusted)
    const stamped = await stampNote("notes/acme.md", "---\ntitle: Acme\n---\nprose");
    const stampedVault = await fixtureVault({ "notes/acme.md": stamped });
    expect([...(await admittedVia(stampedVault, greenEcho))]).toEqual(["gbrain:acme"]);

    // an UNSTAMPED (imported) note ⇒ WITHHELD — no false-stamp survives the assembled path
    const importedVault = await fixtureVault({ "notes/acme.md": "---\ntitle: Acme\n---\nprose" });
    expect([...(await admittedVia(importedVault, greenEcho))]).toEqual([]);
  });

  it("armed_and_keyed_but_vault_unmapped_admits_nothing", async () => {
    // fail-safe corner: fully armed + keyed + GREEN coverage, but the served workspace resolves to NO vault
    // (empty/foreign map — e.g. copilotGbrainWorkspaceId unset in boot) ⇒ the loader degrades ⇒ nothing admitted.
    const stamped = await stampNote("notes/acme.md", "---\ntitle: Acme\n---\nprose");
    const stampedVault = await fixtureVault({ "notes/acme.md": stamped });
    const loaderBacked = buildLoaderBackedServingOracle({
      resolveVault: buildServedVaultResolver(new Map([["ws-OTHER", stampedVault]])), // WS is NOT mapped
      readServingCoverage: greenEcho,
      secrets: testSecrets(),
      signingKeyRef: REF,
    });
    const selected = selectServingOracleFactory({ ...STAMP_ENABLED, loaderBacked, goLiveArmed: true });
    if (selected === undefined || selected === createInterimDegradedServingOracle) throw new Error("expected loaderBacked");
    const v = await selected().admit(WS, retrieval([source("gbrain:acme")]));
    expect(isOk(v)).toBe(true);
    if (isOk(v)) expect(v.value.mode === "gated" ? [...v.value.admitted.keys()] : []).toEqual([]);
  });

  it("armed_with_real_coverage_still_degrades", async () => {
    // OFF-lock 3: armed + a genuinely KW-stamped note, but the REAL coverage reader (parity undefined) ⇒
    // the loader degrades ⇒ NOTHING is admitted trusted. Arming ≠ trust until real coverage is green.
    const stamped = await stampNote("notes/acme.md", "---\ntitle: Acme\n---\nprose");
    const stampedVault = await fixtureVault({ "notes/acme.md": stamped });
    const realCoverage = createServingCoverageReader({
      pin: { gbrainSha: "abc1234def", indexSchemaVersion: 1, validatedOn: "2026-01-01T00:00:00.000Z", writeThroughEnabled: false } as unknown as GbrainPin,
      resolveRunning: () => ({ sha: "abc1234def", indexSchemaVersion: 1 }),
      now: () => "2026-07-13T00:00:00.000Z",
    });
    expect([...(await admittedVia(stampedVault, realCoverage))]).toEqual([]);
  });
});
