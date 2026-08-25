// spec(§6, §5) — 13.3a local-embed retrieval primitive (RES/GBrain local-zero-egress
// path). A pure retrieval primitive over an INJECTED EmbeddingBackend seam (Ollama /
// LM Studio downstream; ModelProviderPort is completion-only, so embeddings ride a
// knowledge-local seam) with RRF hybrid fusion (dense cosine + sparse lexical),
// ported from osb `semantic_search.py` (K=60, 0-indexed rank). Safety rule 5: raw
// Employer-Work content + a cloud (egress) embed backend FAILS CLOSED — local backend
// or a typed err, NEVER a cloud fallback. The rebuildable embedding index lives
// OUTSIDE the canonical Markdown tree (never a 2nd canonical store, rule 1). TOTAL
// never-throws over a faulting/pathological backend (§16 / knowledge Lesson 11).
import { describe, it, expect, vi } from "vitest";
import { isErr, ok, err } from "@sow/contracts";
import type { Result, ProviderId, EgressClass, WorkspaceType } from "@sow/contracts";
import {
  fuseRrf,
  retrieveLocalEmbed,
  resolveLocalEmbedIndexPath,
  isPathOutsideVaultTree,
  type EmbeddingBackend,
  type EmbedFault,
  type RetrievalEgressGate,
  type RetrievalWorkspaceContext,
  type Passage,
} from "../src/gbrain/local-embed";

// ── test doubles ───────────────────────────────────────────────────────────────

/** A fake embedding backend that returns a fixed vector per input text (by index),
 *  or a typed err, or throws — the three shapes an untrusted backend can produce. */
function fakeBackend(opts: {
  providerId: ProviderId;
  egressClass: EgressClass;
  embed: (texts: readonly string[]) => Promise<Result<readonly number[][], EmbedFault>>;
}): EmbeddingBackend & { embedSpy: ReturnType<typeof vi.fn> } {
  const embedSpy = vi.fn(opts.embed);
  return { providerId: opts.providerId, egressClass: opts.egressClass, embed: embedSpy, embedSpy };
}

/** A backend that maps each text to a caller-supplied vector (query first, then passages). */
function vectorBackend(
  vectors: readonly number[][],
  providerId: ProviderId = "ollama",
  egressClass: EgressClass = "local",
) {
  return fakeBackend({
    providerId,
    egressClass,
    embed: async () => ok(vectors),
  });
}

const personal: RetrievalWorkspaceContext = {
  type: "personal_business" as WorkspaceType,
  carriesRawContent: false,
  employerRawEgressAcknowledged: false,
};
const employerRawUnacked: RetrievalWorkspaceContext = {
  type: "employer_work" as WorkspaceType,
  carriesRawContent: true,
  employerRawEgressAcknowledged: false,
};

/** A gate that always proves the backend genuine (24.9: egressGate is now REQUIRED,
 *  so every call site needs one; this double is neutral for tests not about the gate itself). */
const allowGate: RetrievalEgressGate = { check: () => ok(undefined) };

const P = (id: string, text: string): Passage => ({ id, text });

// ── 1. RRF fusion determinism (the ranking contract 13.17 / 13.8c depend on) ─────

describe("fuseRrf — Reciprocal Rank Fusion (osb semantic_search.py port: K=60, 0-indexed)", () => {
  it("rrf_fusion_orders_deterministically — fuses dense+sparse ranks to a pinned order", () => {
    // dense: d1@0 d2@1 d3@2 ; sparse: d2@0 d3@1 d4@2
    // scores: d2=1/61+1/60=.03306 (top) > d3=1/62+1/61=.032522 > d1=1/60=.016667 > d4=1/62=.016129
    const fused = fuseRrf(["d1", "d2", "d3"], ["d2", "d3", "d4"]);
    expect(fused.map((r) => r.id)).toEqual(["d2", "d3", "d1", "d4"]);
    // scores are strictly descending (no accidental equalities in this fixture)
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1]!.score).toBeGreaterThan(fused[i]!.score);
    }
  });

  it("breaks exact score ties deterministically by id ascending", () => {
    // a: dense@0 (1/60) ; b: sparse@0 (1/60) → exact tie → id asc → [a, b]
    const fused = fuseRrf(["a"], ["b"]);
    expect(fused.map((r) => r.id)).toEqual(["a", "b"]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12);
  });

  it("honors the limit cap and the K parameter", () => {
    const fused = fuseRrf(["x", "y", "z"], ["y", "z"], { limit: 2 });
    expect(fused).toHaveLength(2);
    // custom K changes the absolute scores but the id set stays valid
    const k1 = fuseRrf(["x"], ["x"], { k: 1 });
    expect(k1[0]!.score).toBeCloseTo(2 / 1, 12); // present in both legs at rank0: 1/(1+0)*2
  });
});

// ── 2. index path is OUTSIDE the canonical Markdown tree (rule 1 posture) ─────────

describe("resolveLocalEmbedIndexPath / isPathOutsideVaultTree — rebuildable sidecar, never a 2nd store", () => {
  it("index_path_outside_markdown_tree — the resolved index location is NOT under the vault root", () => {
    const vault = "/Users/x/vault";
    const idx = resolveLocalEmbedIndexPath(vault);
    expect(isPathOutsideVaultTree(vault, idx)).toBe(true);
  });

  it("isPathOutsideVaultTree is non-vacuous — a path UNDER the vault is not 'outside'", () => {
    const vault = "/Users/x/vault";
    expect(isPathOutsideVaultTree(vault, "/Users/x/vault/embeddings.json")).toBe(false);
    expect(isPathOutsideVaultTree(vault, vault)).toBe(false); // the root itself is not "outside"
    expect(isPathOutsideVaultTree(vault, "/Users/x/other")).toBe(true);
  });
});

// ── 3. Employer-Work + cloud embed FAILS CLOSED (safety rule 5, no fallback) ──────

describe("retrieveLocalEmbed — Employer-Work raw content egress veto (rule 5)", () => {
  it("employer_work_cloud_embed_fails_closed — cloud backend ⇒ typed err, backend NEVER called, no fallback", async () => {
    const backend = fakeBackend({
      providerId: "openai",
      egressClass: "cloud",
      embed: async () => ok([[1], [1]]),
    });
    const res = await retrieveLocalEmbed(
      { query: "auth", passages: [P("p1", "auth flow")], workspace: employerRawUnacked },
      { backend, egressGate: allowGate }, // floor denies even though the gate would allow
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("egress_denied");
    // the fail-closed guarantee: no cloud embed was ever attempted (no fallback)
    expect(backend.embedSpy).not.toHaveBeenCalled();
  });

  it("local_backend_employer_work_ok — Employer-Work + a local backend succeeds (the allowed zero-egress path)", async () => {
    // query≈p2 (both [1,0]); p1 orthogonal ([0,1]) → dense ranks p2 over p1.
    const backend = vectorBackend([
      [1, 0], // query
      [0, 1], // p1
      [1, 0], // p2
    ], "ollama", "local");
    const res = await retrieveLocalEmbed(
      {
        query: "alpha",
        passages: [P("p1", "beta gamma"), P("p2", "alpha")],
        workspace: employerRawUnacked,
      },
      { backend, egressGate: allowGate },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((r) => r.id).sort()).toEqual(["p1", "p2"]);
    expect(backend.embedSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 3b. End-to-end hybrid fusion ordering (dense + sparse legs disagree) ──────────

describe("retrieveLocalEmbed — end-to-end hybrid fusion ordering", () => {
  it("fuses cosine-dense + lexical-sparse into a pinned order when the legs disagree", async () => {
    // query≈[1,0]; p1 orthogonal (cos 0) but top lexical (2); p2 aligned (cos 1) zero
    // lexical; p3 [1,1] (cos .707) lexical 1.  dense=[p2,p3,p1]; sparse(filtered)=[p1,p3];
    // RRF(K=60): p1=1/62+1/60=.032796 > p3=1/61+1/61=.032787 > p2=1/60=.016667.
    const backend = vectorBackend(
      [
        [1, 0], // query
        [0, 1], // p1
        [1, 0], // p2
        [1, 1], // p3
      ],
      "ollama",
      "local",
    );
    const res = await retrieveLocalEmbed(
      {
        query: "alpha beta",
        passages: [P("p1", "alpha beta"), P("p2", "zzz"), P("p3", "alpha")],
        workspace: personal,
      },
      { backend, egressGate: allowGate },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((r) => r.id)).toEqual(["p1", "p3", "p2"]);
  });

  it("a zero-lexical query ranks by the dense leg alone (sparse leg empty); limit:0 ⇒ []", async () => {
    const backend = vectorBackend([[1, 0], [1, 0], [0, 1]], "ollama", "local");
    const ranked = await retrieveLocalEmbed(
      { query: "alpha", passages: [P("p1", "zzz"), P("p2", "yyy")], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) return;
    expect(ranked.value.map((r) => r.id)).toEqual(["p1", "p2"]); // p1 cos 1 > p2 cos 0

    const capped = await retrieveLocalEmbed(
      { query: "alpha", passages: [P("p1", "zzz"), P("p2", "yyy")], workspace: personal },
      { backend, egressGate: allowGate, limit: 0 },
    );
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.value).toEqual([]);
  });
});

// ── 4. Injected egress gate (reuse of the real egressVeto downstream) ─────────────

describe("retrieveLocalEmbed — injected egress gate is consulted and fail-closed", () => {
  const denyGate: RetrievalEgressGate = {
    check: () => err({ code: "egress_denied", reason: "processor_not_allowed" }),
  };

  it("egressGate is a REQUIRED dependency (24.9) — omitting it must not compile", () => {
    // A self-declared `egressClass` alone is not proof (the finding this task fixes).
    // The endpoint-check authority can only be exercised through a BOUND gate, so the
    // seam must make the unbound (unproven) path unrepresentable, not merely "MUST
    // bind" in a comment. If `egressGate` is ever made optional again, this line stops
    // producing a type error and `@ts-expect-error` itself becomes a typecheck failure
    // ("Unused '@ts-expect-error' directive") — the pin fires on the regression.
    const backend = vectorBackend([[1, 0], [1, 0]], "ollama", "local");
    // @ts-expect-error — egressGate is required; a deps object without it must be rejected.
    void retrieveLocalEmbed({ query: "q", passages: [P("p1", "x")], workspace: personal }, { backend });
  });

  it("self_declared_local_does_not_bypass_the_gate — a backend that CLAIMS local still answers to the mandatory endpoint-check gate", async () => {
    // The backend self-declares "local" — exactly the value the rule-5 floor alone
    // would trust — but the bound gate (standing in for the real endpoint-proof
    // egressVeto) determines it is not genuinely local and denies. The self-declared
    // class must never be the sole authority once a gate is bound.
    const backend = vectorBackend([[1, 0], [1, 0]], "ollama", "local");
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: denyGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("egress_denied");
    expect(backend.embedSpy).not.toHaveBeenCalled();
  });

  it("injected_egress_gate_deny_fails_closed — a gate deny ⇒ err, backend never called", async () => {
    const backend = vectorBackend([[1], [1]], "openai", "cloud");
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: denyGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("egress_denied");
    expect(backend.embedSpy).not.toHaveBeenCalled();
  });

  it("injected_egress_gate_throw_fails_closed — a throwing gate ⇒ err, never a thrown escape", async () => {
    const throwGate: RetrievalEgressGate = {
      check: () => {
        throw new Error("gate boom");
      },
    };
    const backend = vectorBackend([[1], [1]], "openai", "cloud");
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: throwGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("egress_denied");
    expect(backend.embedSpy).not.toHaveBeenCalled();
  });

  it("an allow gate lets a local retrieval proceed", async () => {
    const backend = vectorBackend([[1, 0], [1, 0]], "ollama", "local");
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(res.ok).toBe(true);
  });
});

// ── 5. TOTAL never-throws over a faulting / pathological backend (Lesson 11) ──────

describe("retrieveLocalEmbed — TOTAL never-throws (§16 / Lesson 11)", () => {
  it("provider_fault_never_throws — a backend THROW becomes a typed err, not an escape", async () => {
    const boom = new Error("ollama socket hang up");
    const backend = fakeBackend({
      providerId: "ollama",
      egressClass: "local",
      embed: async () => {
        throw boom;
      },
    });
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("embed_backend_fault");
    if (res.error.code !== "embed_backend_fault") return;
    expect(res.error.cause).toBe(boom);
  });

  it("a typed embed err is propagated (never coerced to a false result)", async () => {
    const backend = fakeBackend({
      providerId: "ollama",
      egressClass: "local",
      embed: async () => err({ code: "embed_backend_fault", cause: "model_unavailable" }),
    });
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "x")], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("embed_backend_fault");
  });

  it("a pathological embedding shape (wrong length) fails closed, never throws", async () => {
    // backend resolves ok but returns FEWER vectors than 1 (query) + passages
    const backend = fakeBackend({
      providerId: "ollama",
      egressClass: "local",
      embed: async () => ok([[1, 0]]), // only 1 vector for query + 2 passages
    });
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [P("p1", "a"), P("p2", "b")], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("embed_backend_fault");
  });

  it("an empty passage set returns ok([]) without touching the backend", async () => {
    const backend = vectorBackend([], "ollama", "local");
    const res = await retrieveLocalEmbed(
      { query: "q", passages: [], workspace: personal },
      { backend, egressGate: allowGate },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
    expect(backend.embedSpy).not.toHaveBeenCalled();
  });
});
