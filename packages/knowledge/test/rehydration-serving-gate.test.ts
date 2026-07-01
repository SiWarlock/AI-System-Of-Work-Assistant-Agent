// spec(§6) — MarkdownRehydrationServingGate (task 4.17): bytes-from-Markdown,
// DEFAULT-DENY. A fact SERVES only if (A) its bytes re-hydrated from committed
// Markdown hash-match the CanonicalFactDeriver.mdContentSha @ current revision AND
// (B) its SignedProvenanceStamp.sig verifies (serve-time content rebinding, 4.15)
// AND (C) factIdentity ∈ current-revision allow-set AND (D) not quarantined — else
// withheld. The GBrain DB is a retrieval/ranking POINTER only, NEVER a byte source.
// Degraded coverage (dirty/failed ParityReport, pin mismatch, oracle-build fail) →
// direct committed-Markdown only. Design doc invariants (i)/(v). Deterministic → TDD.
import { describe, it, expect } from "vitest";
import type {
  WorkspaceId,
  RevisionId,
  MdContentSha,
  FactIdentity,
  SemanticFact,
  FactProvenance,
  QuarantineRecord,
  AuditId,
} from "@sow/contracts";
import type {
  CanonicalFactSet,
  DerivedFact,
} from "../src/gbrain/derive/canonical-fact-deriver";
import {
  stampProvenance,
  type SecretsPort,
  type SecretRef,
  type StampInputs,
} from "../src/knowledge-writer/provenance-stamp";
import { createQuarantineLedger } from "../src/gbrain/serving/quarantine-ledger";
import {
  admitForServing,
  synthesisContext,
  isDegradedCoverage,
  type DbPointer,
  type RehydratedFact,
  type RehydrateFn,
  type ServingCoverage,
  type ServingDeps,
  type ServingRequest,
} from "../src/gbrain/serving/rehydration-gate";

// ── injected SecretsPort fake (a real key-vault double, not a behavior mock) ──
const SECRET_MARKER = "SUPER-SECRET-HMAC-KEY-DO-NOT-LEAK";
class FakeSecretsPort implements SecretsPort {
  constructor(private readonly keys: Record<string, Uint8Array>) {}
  async resolveSigningKey(ref: SecretRef) {
    const { ok, err } = await import("@sow/contracts");
    const key = this.keys[ref];
    return key === undefined
      ? err({ code: "secret_unresolved" as const, ref })
      : ok(key);
  }
}
const KEY = new TextEncoder().encode(SECRET_MARKER);
const REF: SecretRef = "keychain:sow.kw.provenance-signing-key";

// ── fixture vocabulary ────────────────────────────────────────────────────────
const WS = "ws-emp" as WorkspaceId;
const REV = "rev-001" as RevisionId;
const SHA_AUTH = "a".repeat(64) as MdContentSha;
const SHA_OTHER = "b".repeat(64) as MdContentSha;
const SHA_TAMPERED = "c".repeat(64) as MdContentSha;
const ID_AUTH = "page:acme/auth" as FactIdentity;
const ID_OTHER = "page:acme/other" as FactIdentity;
const ID_DBONLY = "page:acme/phantom" as FactIdentity; // present in DB, NOT in Markdown
const PATH_AUTH = "acme/auth.md";
const BODY_AUTH = "# Auth\n\nThe real, committed-Markdown body.";
const DB_ROW_BYTES = "EVIL fabricated DB-row bytes that must never be served.";

function derivedFact(
  over: { factIdentity?: FactIdentity; mdContentSha?: MdContentSha; originPath?: string } = {},
): DerivedFact {
  const fact: SemanticFact = {
    factIdentity: over.factIdentity ?? ID_AUTH,
    factKind: "page",
    workspaceId: WS,
    mdContentSha: over.mdContentSha ?? SHA_AUTH,
    revisionId: REV,
  };
  const provenance: FactProvenance = {
    origin: "markdown",
    kwRevision: REV,
    originPath: over.originPath ?? PATH_AUTH,
    mdContentSha: over.mdContentSha ?? SHA_AUTH,
  };
  return { fact, provenance };
}

function allowSet(facts: DerivedFact[]): CanonicalFactSet {
  return { workspaceId: WS, revisionId: REV, facts };
}

function coverage(over: Partial<ServingCoverage> = {}): ServingCoverage {
  return {
    cleanForServing: true,
    coverageComplete: true,
    pinValid: true,
    oracleBuildOk: true,
    ...over,
  };
}

function deps(port: SecretsPort = new FakeSecretsPort({ [REF]: KEY })): ServingDeps {
  return { secrets: port, signingKeyRef: REF };
}

// Mint a GENUINE stamp bound to the given fact's content-binding tuple.
async function mintStamp(
  over: Partial<StampInputs> = {},
  port: SecretsPort = new FakeSecretsPort({ [REF]: KEY }),
) {
  const inputs: StampInputs = {
    workspaceId: WS,
    factIdentity: ID_AUTH,
    originPath: PATH_AUTH,
    mdContentSha: SHA_AUTH,
    kwRevision: REV,
    sourceEventRef: "meeting:123",
    committedAt: "2026-06-30T12:00:00.000Z",
    ...over,
  };
  const r = await stampProvenance(inputs, { secrets: port, signingKeyRef: REF });
  if (!r.ok) throw new Error(`fixture stamp mint failed: ${r.error.code}`);
  return r.value;
}

// A rehydrator that serves the AUTH page bytes from committed Markdown.
function rehydrateAuth(stampFor: RehydratedFact["stamp"]): RehydrateFn {
  return (id) =>
    id === (ID_AUTH as string)
      ? { ok: true, value: { factIdentity: id, content: BODY_AUTH, mdContentSha: SHA_AUTH, stamp: stampFor } }
      : { ok: false, error: { code: "rehydrate_failed", factIdentity: id, reason: "not_committed" } };
}

function pointer(over: Partial<DbPointer> = {}): DbPointer {
  return { factIdentity: ID_AUTH as string, score: 0.9, ...over };
}

function request(over: Partial<ServingRequest>): ServingRequest {
  return {
    workspaceId: WS,
    revisionId: REV,
    pointers: [pointer()],
    allowSet: allowSet([derivedFact()]),
    rehydrate: () => ({ ok: false, error: { code: "rehydrate_failed", factIdentity: "x", reason: "unset" } }),
    quarantine: createQuarantineLedger(),
    coverage: coverage(),
    ...over,
  };
}

describe("admitForServing — happy path (all four conditions hold)", () => {
  it("ADMITS a fact that is in the allow-set, hash-matches, is signature-valid, and is not quarantined", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      request({ rehydrate: rehydrateAuth(stamp) }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("gated");
    expect(res.value.withheld).toEqual([]);
    expect(res.value.admitted).toHaveLength(1);
    const a = res.value.admitted[0]!;
    expect(a.factIdentity).toBe(ID_AUTH);
    expect(a.mdContentSha).toBe(SHA_AUTH);
    expect(a.score).toBe(0.9); // ranking preserved from the DB pointer
  });

  it("serves the MARKDOWN-rehydrated bytes, NEVER the DB-row bytes (bytes-from-Markdown, invariant (i))", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      // The DB pointer carries a tempting fabricated body — it must be ignored.
      request({ pointers: [pointer({ dbBody: DB_ROW_BYTES })], rehydrate: rehydrateAuth(stamp) }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const a = res.value.admitted[0]!;
    expect(a.content).toBe(BODY_AUTH);
    expect(a.content).not.toBe(DB_ROW_BYTES);
    expect(JSON.stringify(res.value)).not.toContain(DB_ROW_BYTES);
  });

  it("exposes the admitted set as the ONLY synthesis context (think/synthesis runs over gated context only)", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(stamp) }), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(synthesisContext(res.value)).toEqual(res.value.admitted);
  });
});

describe("admitForServing — DEFAULT-DENY (each condition withholds independently)", () => {
  it("(C) withholds a DB-only fact absent from the allow-set — a DB-only fact has no bytes to serve", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      request({
        pointers: [pointer({ factIdentity: ID_DBONLY as string })],
        rehydrate: rehydrateAuth(stamp),
      }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([
      { factIdentity: ID_DBONLY, reason: "not_in_allow_set" },
    ]);
  });

  it("(D) withholds a quarantined fact even when hash + signature + allow-set all pass", async () => {
    const stamp = await mintStamp();
    const q: QuarantineRecord = {
      factIdentity: ID_AUTH,
      workspaceId: WS,
      divergenceRef: "div-1",
      divergenceClass: "db_only",
      capturedDbDigest: "d",
      remediationState: "pending",
      healthItemId: "h-1",
      auditRef: "aud-1" as AuditId,
    };
    const res = await admitForServing(
      request({ rehydrate: rehydrateAuth(stamp), quarantine: createQuarantineLedger([q]) }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "quarantined" }]);
  });

  it("(A) withholds when the rehydrated hash != the canonical mdContentSha (tampered/stale bytes)", async () => {
    const stamp = await mintStamp();
    const rehydrate: RehydrateFn = () => ({
      ok: true,
      value: { factIdentity: ID_AUTH as string, content: "tampered", mdContentSha: SHA_TAMPERED, stamp },
    });
    const res = await admitForServing(request({ rehydrate }), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "content_hash_mismatch" }]);
  });

  it("(B) withholds a BORROWED stamp — a genuine stamp for another fact copied onto these hash-matching bytes fails serve-time rebinding", async () => {
    // A key-valid stamp minted for page:acme/other (its own tuple), pasted onto the
    // auth page. Hash matches (A passes), but the sig was signed over the OTHER
    // tuple, so verify over the auth tuple fails (design doc GO #3 (c)).
    const borrowed = await mintStamp({
      factIdentity: ID_OTHER,
      originPath: "acme/other.md",
      mdContentSha: SHA_OTHER,
    });
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(borrowed) }), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signature_invalid" }]);
  });

  it("(B) withholds a FORGED sig (an attacker without the signing key cannot mint a valid stamp)", async () => {
    const forged: RehydratedFact["stamp"] = {
      kwRevision: REV,
      originPath: PATH_AUTH,
      mdContentSha: SHA_AUTH,
      writerActor: "KnowledgeWriter",
      sourceEventRef: "meeting:123",
      committedAt: "2026-06-30T12:00:00.000Z",
      sig: "deadbeef".repeat(8),
    };
    const res = await admitForServing(request({ rehydrate: rehydrateAuth(forged) }), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signature_invalid" }]);
  });

  it("withholds when re-hydration from committed Markdown fails (no bytes to serve)", async () => {
    const rehydrate: RehydrateFn = () => ({
      ok: false,
      error: { code: "rehydrate_failed", factIdentity: ID_AUTH as string, reason: "page_missing" },
    });
    const res = await admitForServing(request({ rehydrate }), deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "rehydrate_failed" }]);
  });

  it("withholds when the allow-set fact carries no originPath (cannot build the trusted verify tuple)", async () => {
    const stamp = await mintStamp();
    const noPath = derivedFact();
    const df: DerivedFact = { fact: noPath.fact, provenance: { origin: "markdown", kwRevision: REV, mdContentSha: SHA_AUTH } };
    const res = await admitForServing(
      request({ allowSet: allowSet([df]), rehydrate: rehydrateAuth(stamp) }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "origin_path_missing" }]);
  });
});

describe("admitForServing — degraded coverage → direct committed-Markdown only (invariant (v))", () => {
  it.each([
    ["dirty ParityReport", { cleanForServing: false }],
    ["incomplete coverage", { coverageComplete: false }],
    ["pin mismatch", { pinValid: false }],
    ["oracle-build failure", { oracleBuildOk: false }],
  ])("degrades on %s: no gated admission, mode = degraded_direct_markdown", async (_label, over) => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      request({ rehydrate: rehydrateAuth(stamp), coverage: coverage(over) }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("degraded_direct_markdown");
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "degraded_coverage" }]);
    // synthesis gets NOTHING in degraded mode (no store-wide gated context).
    expect(synthesisContext(res.value)).toEqual([]);
  });

  it("isDegradedCoverage is true iff any leg is not green", () => {
    expect(isDegradedCoverage(coverage())).toBe(false);
    expect(isDegradedCoverage(coverage({ cleanForServing: false }))).toBe(true);
    expect(isDegradedCoverage(coverage({ coverageComplete: false }))).toBe(true);
    expect(isDegradedCoverage(coverage({ pinValid: false }))).toBe(true);
    expect(isDegradedCoverage(coverage({ oracleBuildOk: false }))).toBe(true);
  });
});

describe("admitForServing — fail-closed on key resolution (§16 / safety rule 7)", () => {
  it("degrades the WHOLE request when the signing key cannot be resolved (no sig can be verified)", async () => {
    const stamp = await mintStamp();
    const res = await admitForServing(
      request({ rehydrate: rehydrateAuth(stamp) }),
      deps(new FakeSecretsPort({})), // REF absent → key unresolvable
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.mode).toBe("degraded_direct_markdown");
    expect(res.value.admitted).toEqual([]);
    expect(res.value.withheld).toEqual([{ factIdentity: ID_AUTH, reason: "signing_key_unresolved" }]);
  });
});

describe("admitForServing — hard wiring errors return a typed Result error", () => {
  it("errs on a workspace mismatch between the request and the allow-set (safety rule 4)", async () => {
    const res = await admitForServing(
      request({ allowSet: { workspaceId: "ws-personal" as WorkspaceId, revisionId: REV, facts: [] } }),
      deps(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("workspace_mismatch");
  });

  it("errs on a revision mismatch between the request and the allow-set", async () => {
    const res = await admitForServing(
      request({ allowSet: { workspaceId: WS, revisionId: "rev-999" as RevisionId, facts: [] } }),
      deps(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("revision_mismatch");
  });
});

describe("admitForServing — mixed batch: ranking preserved, dedup, per-candidate reasons", () => {
  it("admits the valid fact, withholds the rest with their own reasons, and dedups by identity keeping the first", async () => {
    const stamp = await mintStamp();
    const df = derivedFact();
    const q: QuarantineRecord = {
      factIdentity: ID_OTHER,
      workspaceId: WS,
      divergenceRef: "div-2",
      divergenceClass: "db_only",
      capturedDbDigest: "d",
      remediationState: "pending",
      healthItemId: "h-2",
      auditRef: "aud-2" as AuditId,
    };
    const otherDf = derivedFact({ factIdentity: ID_OTHER, mdContentSha: SHA_OTHER, originPath: "acme/other.md" });
    const res = await admitForServing(
      request({
        pointers: [
          pointer({ factIdentity: ID_AUTH as string, score: 0.9 }),
          pointer({ factIdentity: ID_AUTH as string, score: 0.1 }), // duplicate → dropped
          pointer({ factIdentity: ID_DBONLY as string, score: 0.8 }), // not in allow-set
          pointer({ factIdentity: ID_OTHER as string, score: 0.7 }), // quarantined
        ],
        allowSet: allowSet([df, otherDf]),
        rehydrate: rehydrateAuth(stamp),
        quarantine: createQuarantineLedger([q]),
      }),
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.admitted.map((a) => a.factIdentity)).toEqual([ID_AUTH]);
    expect(res.value.admitted[0]!.score).toBe(0.9); // first (highest-ranked) kept
    expect(res.value.withheld).toEqual([
      { factIdentity: ID_DBONLY, reason: "not_in_allow_set" },
      { factIdentity: ID_OTHER, reason: "quarantined" },
    ]);
  });
});
