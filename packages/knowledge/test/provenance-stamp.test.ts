// spec(§6) — SignedProvenanceStamper: HMAC(workspaceId, factIdentity, originPath,
// mdContentSha, kwRevision) minted via an INJECTED SecretsPort key, with
// serve-time content rebinding (a copied/forged stamp fails verify). Enforces
// safety rule 1 (writerActor const) + safety rule 7 (key unreachable, never
// logged/leaked). Deterministic → strict TDD; typed Results, never throws.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import type {
  WorkspaceId,
  FactIdentity,
  MdContentSha,
  RevisionId,
  SignedProvenanceStamp,
} from "@sow/contracts";
import { SignedProvenanceStampSchema } from "@sow/contracts";
import {
  stampProvenance,
  verifyProvenanceStamp,
  type SecretsPort,
  type SecretRef,
  type StampInputs,
} from "../src/knowledge-writer/provenance-stamp";

// ── injected SecretsPort fake (NOT a behavior mock — a real key vault double) ──

const SECRET_MARKER = "SUPER-SECRET-HMAC-KEY-DO-NOT-LEAK";

class FakeSecretsPort implements SecretsPort {
  resolveCalls: SecretRef[] = [];
  constructor(
    private readonly keys: Record<string, Uint8Array>,
    private readonly opts: { throwOn?: SecretRef } = {},
  ) {}
  async resolveSigningKey(ref: SecretRef) {
    this.resolveCalls.push(ref);
    if (this.opts.throwOn === ref) {
      throw new Error("keychain exploded");
    }
    const key = this.keys[ref];
    if (key === undefined) {
      const { err } = await import("@sow/contracts");
      return err({ code: "secret_unresolved" as const, ref });
    }
    const { ok } = await import("@sow/contracts");
    return ok(key);
  }
}

const KEY_A = new TextEncoder().encode(`${SECRET_MARKER}-A`);
const KEY_B = new TextEncoder().encode(`${SECRET_MARKER}-B`);
const REF_A: SecretRef = "keychain:sow.kw.provenance-signing-key";
const REF_B: SecretRef = "keychain:sow.kw.other-key";

const SHA_1 = "a".repeat(64);
const SHA_2 = "b".repeat(64);
const T0 = "2026-06-30T12:00:00.000Z";

function baseInputs(over: Partial<StampInputs> = {}): StampInputs {
  return {
    workspaceId: "ws-emp" as WorkspaceId,
    factIdentity: "page:acme/auth" as FactIdentity,
    originPath: "acme/auth.md",
    mdContentSha: SHA_1 as MdContentSha,
    kwRevision: "rev-001" as RevisionId,
    sourceEventRef: "meeting:123",
    committedAt: T0,
    ...over,
  };
}

function deps(port: SecretsPort, ref: SecretRef = REF_A) {
  return { secrets: port, signingKeyRef: ref };
}

describe("stampProvenance — minting", () => {
  it("mints a schema-valid stamp with the one-writer actor + a 64-hex HMAC sig", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const res = await stampProvenance(baseInputs(), deps(port));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stamp: SignedProvenanceStamp = res.value;
    expect(stamp.writerActor).toBe("KnowledgeWriter");
    expect(stamp.kwRevision).toBe("rev-001");
    expect(stamp.originPath).toBe("acme/auth.md");
    expect(stamp.mdContentSha).toBe(SHA_1);
    expect(stamp.sourceEventRef).toBe("meeting:123");
    expect(stamp.committedAt).toBe(T0);
    expect(stamp.sig).toMatch(/^[0-9a-f]{64}$/);
    // Output survives the frozen contract gate.
    expect(SignedProvenanceStampSchema.safeParse(stamp).success).toBe(true);
    expect(port.resolveCalls).toEqual([REF_A]);
  });

  it("is deterministic — identical inputs + key yield an identical sig", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const a = await stampProvenance(baseInputs(), deps(port));
    const b = await stampProvenance(baseInputs(), deps(port));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.sig).toBe(b.value.sig);
  });

  it("binds sig to EACH signed field — a change in any of the 4 content-binding fields changes sig", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const base = await stampProvenance(baseInputs(), deps(port));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const sig0 = base.value.sig;
    const variants: Partial<StampInputs>[] = [
      { workspaceId: "ws-personal" as WorkspaceId },
      { factIdentity: "page:acme/other" as FactIdentity },
      { originPath: "acme/other.md" },
      { mdContentSha: SHA_2 as MdContentSha },
    ];
    for (const v of variants) {
      const r = await stampProvenance(baseInputs(v), deps(port));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.sig).not.toBe(sig0);
    }
  });

  it("does NOT fold kwRevision / sourceEventRef / committedAt into sig (all outside the signed preimage)", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const a = await stampProvenance(baseInputs(), deps(port));
    const b = await stampProvenance(
      // kwRevision is UNSIGNED (v2) — the volatile whole-vault revision must not change the sig, else a stamp
      // self-invalidates on the next unrelated commit.
      baseInputs({ kwRevision: "rev-777" as RevisionId, sourceEventRef: "meeting:999", committedAt: "2027-01-01T00:00:00.000Z" }),
      deps(port),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.sig).toBe(b.value.sig);
  });

  it("uses a distinct sig per signing key (key material is load-bearing)", async () => {
    const portA = new FakeSecretsPort({ [REF_A]: KEY_A });
    const portB = new FakeSecretsPort({ [REF_B]: KEY_B });
    const a = await stampProvenance(baseInputs(), deps(portA, REF_A));
    const b = await stampProvenance(baseInputs(), deps(portB, REF_B));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.sig).not.toBe(b.value.sig);
  });
});

describe("stampProvenance — key isolation + fail-closed (safety rule 7 / §16)", () => {
  it("never leaks the resolved key into the stamp", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const res = await stampProvenance(baseInputs(), deps(port));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.value)).not.toContain(SECRET_MARKER);
  });

  it("returns a typed secret_unresolved error (never throws) when the ref is absent", async () => {
    const port = new FakeSecretsPort({ [REF_B]: KEY_B }); // REF_A missing
    const res = await stampProvenance(baseInputs(), deps(port, REF_A));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("secret_unresolved");
    if (res.error.code === "secret_unresolved") {
      expect(res.error.ref).toBe(REF_A);
      expect(JSON.stringify(res.error)).not.toContain(SECRET_MARKER);
    }
  });

  it("converts a thrown SecretsPort into a typed error — never throws across the boundary", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A }, { throwOn: REF_A });
    const res = await stampProvenance(baseInputs(), deps(port, REF_A));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("secret_unresolved");
  });
});

describe("verifyProvenanceStamp — serve-time content rebinding", () => {
  it("verifies a genuine stamp against its own signed inputs", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const minted = await stampProvenance(baseInputs(), deps(port));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const res = await verifyProvenanceStamp(
      { stamp: minted.value, ...baseInputs() },
      deps(port),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(true);
  });

  it("VERIFIES a stamp whose serve-time kwRevision DIFFERS from mint time (revision is NOT bound)", async () => {
    // Architectural property (the fix): a stamp binds CONTENT+LOCATION, not the volatile whole-vault revision.
    // The serving gate re-derives kwRevision = the CURRENT whole-vault revision, which advances on every
    // unrelated commit. Binding it would self-invalidate every stamp on the next commit. It must NOT be bound:
    // a note whose content+location is unchanged verifies at ANY later revision.
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const minted = await stampProvenance(baseInputs({ kwRevision: "rev-001" as RevisionId }), deps(port));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const res = await verifyProvenanceStamp(
      // Same content (mdContentSha) + location (workspaceId/factIdentity/originPath), LATER whole-vault revision.
      { stamp: minted.value, ...baseInputs({ kwRevision: "rev-999" as RevisionId }) },
      deps(port),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(true);
  });

  it("REJECTS a copied stamp bound to different re-derived content (forged bytes → mdContentSha mismatch)", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    // Attacker copies a genuine, key-valid stamp onto a fabricated page whose
    // serve-time re-derived mdContentSha differs.
    const genuine = await stampProvenance(baseInputs(), deps(port));
    expect(genuine.ok).toBe(true);
    if (!genuine.ok) return;
    const res = await verifyProvenanceStamp(
      { stamp: genuine.value, ...baseInputs({ mdContentSha: SHA_2 as MdContentSha }) },
      deps(port),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(false);
  });

  it("REJECTS a copied stamp re-pointed to a different factIdentity / originPath", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const genuine = await stampProvenance(baseInputs(), deps(port));
    expect(genuine.ok).toBe(true);
    if (!genuine.ok) return;
    for (const over of [
      { factIdentity: "page:acme/evil" as FactIdentity },
      { originPath: "acme/evil.md" },
      { workspaceId: "ws-personal" as WorkspaceId },
      // NOTE: kwRevision is NOT in this list — it is UNSIGNED (v2), so re-deriving it differently does NOT
      // fail verify (pinned by the "VERIFIES ... kwRevision DIFFERS" test above). Only content+location bind.
    ]) {
      const res = await verifyProvenanceStamp(
        { stamp: genuine.value, ...baseInputs(over) },
        deps(port),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value).toBe(false);
    }
  });

  it("REJECTS a forged sig (attacker without the key cannot mint a valid stamp)", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const forged: SignedProvenanceStamp = {
      kwRevision: "rev-001" as RevisionId,
      originPath: "acme/auth.md",
      mdContentSha: SHA_1 as MdContentSha,
      writerActor: "KnowledgeWriter",
      sourceEventRef: "meeting:123",
      committedAt: T0,
      sig: "deadbeef".repeat(8), // 64-hex but not a real HMAC
    };
    const res = await verifyProvenanceStamp(
      { stamp: forged, ...baseInputs() },
      deps(port),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(false);
  });

  it("REJECTS a genuine stamp verified under a DIFFERENT key (key rotation / wrong key ref)", async () => {
    const portA = new FakeSecretsPort({ [REF_A]: KEY_A });
    const minted = await stampProvenance(baseInputs(), deps(portA, REF_A));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const portB = new FakeSecretsPort({ [REF_A]: KEY_B }); // same ref, different key
    const res = await verifyProvenanceStamp(
      { stamp: minted.value, ...baseInputs() },
      deps(portB, REF_A),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(false);
  });

  it("does NOT throw on a malformed-length sig — returns false", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const genuine = await stampProvenance(baseInputs(), deps(port));
    expect(genuine.ok).toBe(true);
    if (!genuine.ok) return;
    const shortSig = { ...genuine.value, sig: "abcd" } as SignedProvenanceStamp;
    const res = await verifyProvenanceStamp(
      { stamp: shortSig, ...baseInputs() },
      deps(port),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(false);
  });

  it("surfaces a typed secret_unresolved error when the verify key cannot be resolved", async () => {
    const port = new FakeSecretsPort({}); // REF_A absent
    const genuine: SignedProvenanceStamp = {
      kwRevision: "rev-001" as RevisionId,
      originPath: "acme/auth.md",
      mdContentSha: SHA_1 as MdContentSha,
      writerActor: "KnowledgeWriter",
      sourceEventRef: "meeting:123",
      committedAt: T0,
      sig: "0".repeat(64),
    };
    const res = await verifyProvenanceStamp(
      { stamp: genuine, ...baseInputs() },
      deps(port, REF_A),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("secret_unresolved");
  });
});

// Cross-check: an independent HMAC recompute over the documented 4-field preimage
// agrees with the stamper — pins the signed preimage as a stable contract that
// the 4.17 serving gate can re-derive. v2: the volatile kwRevision is NOT in the preimage.
describe("preimage stability (independent oracle)", () => {
  it("matches an independent HMAC-SHA256 over the length-prefixed 4-field preimage", async () => {
    const port = new FakeSecretsPort({ [REF_A]: KEY_A });
    const minted = await stampProvenance(baseInputs(), deps(port));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const fields = ["sow:provenance-stamp:v2", "ws-emp", "page:acme/auth", "acme/auth.md", SHA_1];
    const preimage = fields.map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`).join(" ");
    const expected = createHmac("sha256", KEY_A).update(preimage, "utf8").digest("hex");
    expect(minted.value.sig).toBe(expected);
  });
});
