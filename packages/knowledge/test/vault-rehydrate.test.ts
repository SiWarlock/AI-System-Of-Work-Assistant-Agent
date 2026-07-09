// Gate 4 (G1e-1) — the production RehydrateFn + the writer→serving END-TO-END proof: a note stamped the way the
// KnowledgeWriter stamps it (G1d-2) is re-hydrated + admitted as TRUSTED by the serving gate; an unstamped note
// is withheld. This is the load-bearing integration that the whole gate-4 arc exists to make true.
import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  RevisionId,
  FactIdentity,
  MdContentSha,
} from "@sow/contracts";
import {
  stampProvenance,
  verifyProvenanceStamp,
  serializeStampFieldValue,
  type SecretsPort,
  type StamperDeps,
  type SecretUnresolved,
} from "../src/knowledge-writer/provenance-stamp";
import {
  computePageProvenance,
  deriveCanonicalFacts,
  type CanonicalVaultSnapshot,
} from "../src/gbrain/derive/canonical-fact-deriver";
import { createVaultRehydrate } from "../src/gbrain/serving/vault-rehydrate";
import {
  admitForServing,
  isDegradedCoverage,
  type ServingCoverage,
} from "../src/gbrain/serving/rehydration-gate";
import { createQuarantineLedger } from "../src/gbrain/serving/quarantine-ledger";

const WS = "ws-personal" as WorkspaceId;
const REV = "rev-1" as RevisionId;
const KEY = new Uint8Array(32).fill(9);
const REF = "kw-key";
const GREEN: ServingCoverage = { cleanForServing: true, coverageComplete: true, pinValid: true, oracleBuildOk: true };

class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  resolveSigningKey(ref: string): Promise<Result<Uint8Array, SecretUnresolved>> {
    const k = this.keys[ref];
    return Promise.resolve(k !== undefined ? ok(k) : err({ code: "secret_unresolved", ref }));
  }
}
const signing = (): StamperDeps => ({ secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF });

/** Stamp a note EXACTLY as the KnowledgeWriter does (G1d-2): hash the base bytes, mint over them, embed kwStamp. */
async function stampNote(path: string, base: string): Promise<string> {
  const page = computePageProvenance(path, base);
  if (page === null) throw new Error("no slug");
  const minted = await stampProvenance(
    {
      workspaceId: WS,
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
  // Insert kwStamp as the last frontmatter key (base has a `---`…`---` block).
  const value = serializeStampFieldValue(minted.value);
  const close = base.indexOf("\n---\n", 4);
  return `${base.slice(0, close)}\nkwStamp: ${value}${base.slice(close)}`;
}

const snapOf = (files: Record<string, string>): CanonicalVaultSnapshot => ({
  workspaceId: WS,
  revisionId: REV,
  files: new Map(Object.entries(files)),
});

describe("createVaultRehydrate — the production RehydrateFn (gate 4 G1e-1)", () => {
  it("re-hydrates a stamped page fact: content + hash + verifiable stamp", async () => {
    const path = "notes/acme.md";
    const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
    const snapshot = snapOf({ [path]: stamped });
    const allow = deriveCanonicalFacts(snapshot);
    expect(isOk(allow)).toBe(true);
    if (!isOk(allow)) return;
    const rehydrate = createVaultRehydrate((p) => snapshot.files.get(p), allow.value);
    const r = rehydrate("page:acme");
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.content).toBe(stamped);
    // the rehydrated hash matches the allow-set's page hash (leg A holds)
    const pageFact = allow.value.facts.find((f) => String(f.fact.factIdentity) === "page:acme");
    expect(r.value.mdContentSha).toBe(pageFact?.fact.mdContentSha);
    // and the recovered stamp verifies over the re-derived tuple (leg B holds)
    const verified = await verifyProvenanceStamp(
      { workspaceId: WS, factIdentity: "page:acme" as FactIdentity, originPath: path, mdContentSha: r.value.mdContentSha, stamp: r.value.stamp },
      signing(),
    );
    expect(isOk(verified) && verified.value).toBe(true);
  });

  it("fails closed on an unknown fact, a stamp-less note, and a missing note", async () => {
    const path = "notes/acme.md";
    const unstamped = "---\ntitle: Acme\n---\nprose"; // no kwStamp
    const snapshot = snapOf({ [path]: unstamped });
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) return;
    const rehydrate = createVaultRehydrate((p) => snapshot.files.get(p), allow.value);
    expect(isOk(rehydrate("page:acme"))).toBe(false); // present but UNSTAMPED → no_stamp
    expect(isOk(rehydrate("page:ghost"))).toBe(false); // not in the allow-set
    // a note the allow-set references but the reader can't find → note_unreadable
    const rehydrateBlind = createVaultRehydrate(() => undefined, allow.value);
    expect(isOk(rehydrateBlind("page:acme"))).toBe(false);
  });
});

describe("writer→serving END-TO-END (gate 4): a stamped note is ADMITTED, an unstamped note is WITHHELD", () => {
  it("admitForServing ADMITS a genuinely-stamped page as trusted (gated)", async () => {
    const path = "notes/acme.md";
    const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
    const snapshot = snapOf({ [path]: stamped });
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) return;
    const rehydrate = createVaultRehydrate((p) => snapshot.files.get(p), allow.value);
    const result = await admitForServing(
      {
        workspaceId: WS,
        revisionId: REV,
        pointers: [{ factIdentity: "page:acme", score: 1 }],
        allowSet: allow.value,
        rehydrate,
        quarantine: createQuarantineLedger(),
        coverage: GREEN,
      },
      { secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF },
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.mode).toBe("gated");
    expect(result.value.admitted.map((f) => f.factIdentity)).toEqual(["page:acme"]);
    expect(result.value.withheld).toHaveLength(0);
  });

  it("admitForServing WITHHOLDS an unstamped page (rehydrate has no stamp ⇒ never trusted)", async () => {
    const path = "notes/acme.md";
    const snapshot = snapOf({ [path]: "---\ntitle: Acme\n---\nprose" }); // no kwStamp
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) return;
    const rehydrate = createVaultRehydrate((p) => snapshot.files.get(p), allow.value);
    const result = await admitForServing(
      {
        workspaceId: WS,
        revisionId: REV,
        pointers: [{ factIdentity: "page:acme", score: 1 }],
        allowSet: allow.value,
        rehydrate,
        quarantine: createQuarantineLedger(),
        coverage: GREEN,
      },
      { secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF },
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.admitted).toHaveLength(0);
    expect(result.value.withheld.map((w) => w.reason)).toContain("rehydrate_failed");
  });

  it("admitForServing WITHHOLDS a note whose body was TAMPERED after stamping (signature_invalid)", async () => {
    // The adversarial leg-B path through the CONCRETE rehydrate: stamp a note, then change its body but keep the
    // (now-stale) stamp. The allow-set + rehydrate both see the tampered hash (leg A passes), but the stamp's sig
    // was minted over the ORIGINAL hash ⇒ verify fails ⇒ withheld. Tampering committed bytes cannot be served.
    const path = "notes/acme.md";
    const stamped = await stampNote(path, "---\ntitle: Acme\n---\nprose");
    const tampered = stamped.replace("prose", "EVIL INJECTED CONTENT"); // body changed; kwStamp unchanged
    expect(tampered).not.toBe(stamped);
    const snapshot = snapOf({ [path]: tampered });
    const allow = deriveCanonicalFacts(snapshot);
    if (!isOk(allow)) return;
    const rehydrate = createVaultRehydrate((p) => snapshot.files.get(p), allow.value);
    const result = await admitForServing(
      {
        workspaceId: WS,
        revisionId: REV,
        pointers: [{ factIdentity: "page:acme", score: 1 }],
        allowSet: allow.value,
        rehydrate,
        quarantine: createQuarantineLedger(),
        coverage: GREEN,
      },
      { secrets: new FakeSecretsPort({ [REF]: KEY }), signingKeyRef: REF },
    );
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.admitted).toHaveLength(0);
    expect(result.value.withheld.map((w) => w.reason)).toContain("signature_invalid");
  });

  it("sanity: GREEN coverage is not degraded", () => {
    expect(isDegradedCoverage(GREEN)).toBe(false);
  });
});
