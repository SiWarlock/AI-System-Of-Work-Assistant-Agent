// §9.6-real P3-live — the subprocess GBrain retrieval transport (deterministic surface).
//
// The interim TEST transport that connects the P3.1 mapper (parseGbrainSearchResult) to a REAL gbrain
// read via the local `gbrain call query` CLI. This suite pins the DETERMINISTIC halves — the PURE
// `normalizeGbrainHits` (gbrain's {chunk_text,slug,title} → the {content,id,title} shape the P3.1 mapper
// accepts) and the `createGbrainSubprocessRetrieval` composite (only the ONE served workspace reads the
// brain; every other is fixture-fallback, WS-8 by construction) — with an injected fake exec. The real
// `createGbrainCliExec` (child_process) is the imperative seam, integration-tested behind a gate.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure } from "@sow/contracts";
import type { FailureVariant, Result } from "@sow/contracts";
import { createFixtureRetrieval } from "../../../src/api/procedures/copilot";
import type { RetrievedContext } from "../../../src/api/procedures/copilot";
import { parseGbrainSearchResult } from "../../../src/api/procedures/copilotGbrainRetrieval";
import { mapCompletionToCandidate } from "../../../src/api/procedures/copilotClaudeSynthesis";
import {
  normalizeGbrainHits,
  createGbrainSubprocessRetrieval,
  createMultiServedGbrainRetrieval,
  createGbrainCliExec,
  createWorkspaceScopeFilter,
  DEFAULT_GBRAIN_COPILOT_WORKSPACE,
} from "../../../src/api/procedures/copilotGbrainSubprocess";
import type { GbrainQueryExec, GbrainScopeFilter } from "../../../src/api/procedures/copilotGbrainSubprocess";
import { workspaceId, sourceId } from "@sow/contracts";
import type { WorkspaceScopeRegistry, LegacyContentPolicy } from "@sow/policy";

/** A gbrain `call query` hit shaped like the live output (only the mapped fields matter). */
function gbrainHit(
  slug: string,
  chunkText: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    page_id: 42,
    title,
    type: "note",
    chunk_text: chunkText,
    chunk_source: "compiled_truth",
    chunk_id: 7,
    chunk_index: 0,
    score: 0.9,
    stale: false,
    source_id: "default", // the gbrain SOURCE (same for every hit) — must NOT become the citationId
    ...extra,
  };
}

/** A fake exec that records its calls and returns a canned Result. */
function fakeExec(result: Result<unknown, FailureVariant>): {
  readonly exec: GbrainQueryExec;
  readonly calls: { question: string; limit: number }[];
} {
  const calls: { question: string; limit: number }[] = [];
  const exec: GbrainQueryExec = async (question, limit) => {
    calls.push({ question, limit });
    return result;
  };
  return { exec, calls };
}

describe("normalizeGbrainHits — gbrain {chunk_text,slug,title} → the parseGbrainSearchResult {content,id,title} shape", () => {
  it("maps chunk_text→content, slug→id (path-like → colons), title→title", () => {
    const raw = [gbrainHit("sessions/028-real-copilot", "the egress notice text", "Session 028")];
    const norm = normalizeGbrainHits(raw) as Array<Record<string, unknown>>;
    expect(norm).toEqual([
      { content: "the egress notice text", id: "sessions:028-real-copilot", title: "Session 028" },
    ]);
  });

  it("does NOT let source_id become the id (it is 'default' for every hit → would collapse citations)", () => {
    const raw = [gbrainHit("a/b/c", "text", "T")];
    const norm = normalizeGbrainHits(raw) as Array<Record<string, unknown>>;
    expect(norm[0]!["id"]).toBe("a:b:c"); // from slug, not source_id
  });

  it("replaces every '/' in a deeply nested slug so the id stays opaque-gate-safe (no path)", () => {
    const raw = [gbrainHit("x/y/z/deep", "t", "T")];
    const norm = normalizeGbrainHits(raw) as Array<Record<string, unknown>>;
    expect(norm[0]!["id"]).toBe("x:y:z:deep");
    expect(String(norm[0]!["id"])).not.toContain("/");
  });

  it("returns a NON-array input UNCHANGED (so parseGbrainSearchResult fails closed on it)", () => {
    expect(normalizeGbrainHits({ not: "an array" })).toEqual({ not: "an array" });
    expect(normalizeGbrainHits(null)).toBeNull();
    expect(normalizeGbrainHits("nope")).toBe("nope");
  });

  it("a hit missing chunk_text OR slug yields an object lacking content/id (parse then SKIPS it)", () => {
    const raw = [
      { slug: "has/slug", title: "no text" }, // missing chunk_text
      { chunk_text: "has text", title: "no slug" }, // missing slug
    ];
    const norm = normalizeGbrainHits(raw) as Array<Record<string, unknown>>;
    expect(norm[0]).not.toHaveProperty("content");
    expect(norm[1]).not.toHaveProperty("id");
  });

  it("passes a non-object hit through unchanged (parse then skips it)", () => {
    const norm = normalizeGbrainHits([null, 5, "x"]) as unknown[];
    expect(norm).toEqual([null, 5, "x"]);
  });
});

describe("normalizeGbrainHits + parseGbrainSearchResult — end-to-end mapping", () => {
  it("produces a RetrievedContext with gbrain:<slug-colons> citations, titles, and ALIGNED blocks", () => {
    const raw = [
      gbrainHit("sessions/028-real-copilot", "block A", "Session 028"),
      gbrainHit("sessions/030-p2", "block B", "Session 030"),
    ];
    const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(raw));
    expect(isOk(ctx)).toBe(true);
    if (isOk(ctx)) {
      expect(ctx.value.workspaceId).toBe("personal-business");
      expect(ctx.value.blocks).toEqual(["block A", "block B"]);
      expect(ctx.value.sources).toEqual([
        { citationId: "gbrain:sessions:028-real-copilot", title: "Session 028" },
        { citationId: "gbrain:sessions:030-p2", title: "Session 030" },
      ]);
    }
  });

  it("skips a hit that normalized away (missing content or id), keeping block↔source alignment", () => {
    const raw = [
      gbrainHit("keep/me", "good block", "Keep"),
      { slug: "drop/me", title: "no text" }, // missing chunk_text → skipped
    ];
    const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(raw));
    expect(isOk(ctx)).toBe(true);
    if (isOk(ctx)) {
      expect(ctx.value.blocks).toEqual(["good block"]);
      expect(ctx.value.sources).toEqual([{ citationId: "gbrain:keep:me", title: "Keep" }]);
    }
  });

  it("a non-array exec payload fails CLOSED via parseGbrainSearchResult (malformed shape)", () => {
    const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits({ error: "x" }));
    expect(isErr(ctx)).toBe(true);
  });

  it("PER-PAGE citation granularity: multiple CHUNKS of one note share a slug → one deduped page citation", () => {
    // gbrain returns one hit per chunk; two chunks of the SAME note (same slug, differing chunk_index) must
    // both appear as grounded blocks under the SAME gbrain:<slug> cite, deduped to ONE page-level citation.
    const raw = [
      gbrainHit("sessions/028", "chunk zero text", "Session 028", { chunk_index: 0, chunk_id: 1 }),
      gbrainHit("sessions/028", "chunk one text", "Session 028", { chunk_index: 1, chunk_id: 2 }),
    ];
    const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(raw));
    expect(isOk(ctx)).toBe(true);
    if (isOk(ctx)) {
      // Both excerpts are shown to the model (grounding), each tagged with the same page-level cite…
      expect(ctx.value.blocks).toEqual(["chunk zero text", "chunk one text"]);
      expect(ctx.value.sources.map((s) => s.citationId)).toEqual([
        "gbrain:sessions:028",
        "gbrain:sessions:028",
      ]);
      // …and the reconciliation collapses them to ONE citation per page (the model's echoed title discarded).
      const candidate = mapCompletionToCandidate(
        { answer: ["…"], citations: [{ citationId: "gbrain:sessions:028", title: "x" }] },
        ctx.value,
      );
      expect(isOk(candidate)).toBe(true);
      if (isOk(candidate)) {
        expect(candidate.value.citations).toEqual([
          { citationId: "gbrain:sessions:028", title: "Session 028" },
        ]);
      }
    }
  });
});

describe("createGbrainSubprocessRetrieval — served workspace reads gbrain; every other is fixture-fallback (WS-8)", () => {
  const served = "personal-business";
  const goodHits = [gbrainHit("sessions/028", "the seed says X", "Session 028")];
  // The fallback covers the OTHER known workspaces with an empty-but-valid context (honest "nothing wired")
  // and fails closed for an UNKNOWN workspace — exactly the interim fixture behavior.
  const fallback = createFixtureRetrieval({
    "employer-work": { workspaceId: "employer-work", blocks: [], sources: [] },
  });

  it("served workspace: calls exec once with (question, limit) and maps the result", async () => {
    const { exec, calls } = fakeExec(ok(goodHits));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback, limit: 6 });
    const r = await retrieval.retrieve(served, "what did we decide?");
    expect(calls).toEqual([{ question: "what did we decide?", limit: 6 }]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe(served); // the WS-8 self-check anchor
      expect(r.value.blocks).toEqual(["the seed says X"]);
      expect(r.value.sources).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
    }
  });

  it("served workspace: an exec transport fault propagates as the typed err (retryable)", async () => {
    const fault = failure("degraded_unavailable", "gbrain read failed", {
      retryable: true,
      cause: { code: "GBRAIN_CLI_FAULT" },
    });
    const { exec } = fakeExec(err(fault));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback });
    const r = await retrieval.retrieve(served, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.retryable).toBe(true);
      expect(r.error.cause?.code).toBe("GBRAIN_CLI_FAULT");
    }
  });

  it("served workspace: a non-array exec payload fails CLOSED (parse malformed)", async () => {
    const { exec } = fakeExec(ok({ not: "array" }));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback });
    const r = await retrieval.retrieve(served, "q");
    expect(isErr(r)).toBe(true);
  });

  it("NON-served KNOWN workspace: delegates to the fallback (empty context) and NEVER reads gbrain", async () => {
    const { exec, calls } = fakeExec(ok(goodHits));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback });
    const r = await retrieval.retrieve("employer-work", "q");
    expect(calls).toEqual([]); // no cross-workspace brain read
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe("employer-work");
      expect(r.value.blocks).toEqual([]);
    }
  });

  it("UNKNOWN workspace: the fallback fails closed (WORKSPACE_NOT_FOUND) and gbrain is NEVER read", async () => {
    const { exec, calls } = fakeExec(ok(goodHits));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback });
    const r = await retrieval.retrieve("personal-life", "q"); // not in the fallback fixtures
    expect(calls).toEqual([]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("caps the accepted response at the limit (never inflates the synthesis prompt)", async () => {
    const many = Array.from({ length: 20 }, (_v, i) => gbrainHit(`s/${i}`, `block ${i}`, `T${i}`));
    const { exec } = fakeExec(ok(many));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback, limit: 3 });
    const r = await retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toHaveLength(3);
      expect(r.value.sources).toHaveLength(3);
    }
  });

  it("the served-workspace default names personal-business (the workspace the seeded brain holds)", () => {
    expect(DEFAULT_GBRAIN_COPILOT_WORKSPACE).toBe("personal-business");
  });
});

describe("createGbrainCliExec — the real child_process transport (redaction-safe fail-closed)", () => {
  it("a missing/absent gbrain binary fails CLOSED with a stable code, never a throw", async () => {
    // Point at a binary that does not exist — the spawn error must fold to a typed retryable fault, and
    // the child's error message (which could echo the query) must NEVER surface (§16 / safety 7).
    const exec = createGbrainCliExec({ binary: "gbrain-does-not-exist-xyz", timeoutMs: 5_000 });
    const r = await exec("what did we decide about egress?", 6);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.retryable).toBe(true);
      expect(r.error.cause?.code).toBe("GBRAIN_CLI_FAULT");
      // The stable message carries no query fragment.
      expect(r.error.message).not.toContain("egress");
    }
  });

  it("a non-array stdout (no top-level '[') fails closed as a NON-retryable shape fault", async () => {
    // `echo` prints its argv back — `call query {"query":…}` — which has no leading '[', so the exec hits
    // the GBRAIN_CLI_EMPTY early-return (a deterministic shape fault, retryable:false). Offline + fast.
    const exec = createGbrainCliExec({ binary: "echo", timeoutMs: 5_000 });
    const r = await exec("anything", 3);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_CLI_EMPTY");
      expect(r.error.retryable).toBe(false); // same input reproduces it — a retry loop would spin
    }
  });

  // GATED live smoke: shells the REAL local gbrain over the seeded brain. Needs VOYAGE_API_KEY + `gbrain`
  // on PATH + a populated brain + EXCLUSIVE DB access (NO concurrent `gbrain serve` — PGlite is
  // single-connection, so a running serve/MCP holds the lock and this read times out). SKIPPED unless
  // SOW_P3_LIVE=1 (keeps CI deterministic + offline; the mapping/scoping are covered by the unit tests above).
  const LIVE = process.env["SOW_P3_LIVE"] === "1";
  it.skipIf(!LIVE)(
    "LIVE: returns a top-level array of hits the mapper turns into grounded context",
    async () => {
      const exec = createGbrainCliExec();
      const raw = await exec("What did we decide about the Employer-Work egress veto in the Copilot?", 6);
      expect(isOk(raw)).toBe(true);
      if (isOk(raw)) {
        expect(Array.isArray(raw.value)).toBe(true);
        const ctx = parseGbrainSearchResult("personal-business", normalizeGbrainHits(raw.value), 6);
        expect(isOk(ctx)).toBe(true);
        if (isOk(ctx)) {
          expect(ctx.value.blocks.length).toBeGreaterThan(0);
          expect(ctx.value.sources.every((s) => s.citationId.startsWith("gbrain:"))).toBe(true);
        }
      }
    },
    90_000,
  );
});

// ── SC2 (§13.10 gate a) — the P1 workspace-scope filter over the RAW hit array ────────────────────────
describe("createWorkspaceScopeFilter — per-hit workspace scoping over the RAW gbrain hits (before normalize)", () => {
  const BUSINESS = workspaceId("personal-business");
  const REGISTRY: WorkspaceScopeRegistry = {
    descriptors: [
      { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
      { workspaceId: BUSINESS, slugPrefixes: ["personal-business"] },
      { workspaceId: workspaceId("personal-life"), slugPrefixes: ["personal-life"] },
    ],
  };
  const DENY: LegacyContentPolicy = { mode: "deny" };
  const ASSIGN_BUSINESS: LegacyContentPolicy = { mode: "assign", toWorkspaceId: BUSINESS };

  it("drops a FOREIGN-workspace raw hit, keeps a served-workspace raw hit (by raw slug)", () => {
    const filter = createWorkspaceScopeFilter(BUSINESS, REGISTRY, DENY);
    const raw = [
      gbrainHit("personal-business/notes/x", "mine", "Mine"),
      gbrainHit("employer-work/acme/secret", "theirs", "Theirs"),
    ];
    const out = filter(raw) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!["slug"]).toBe("personal-business/notes/x"); // RAW hit preserved (slug not yet normalized)
  });

  it("legacy (unprefixed) hit: DROPPED under {deny}, KEPT under {assign,served}", () => {
    const legacy = [gbrainHit("sessions/041", "seed", "S")];
    expect((createWorkspaceScopeFilter(BUSINESS, REGISTRY, DENY)(legacy) as unknown[]).length).toBe(0);
    expect((createWorkspaceScopeFilter(BUSINESS, REGISTRY, ASSIGN_BUSINESS)(legacy) as unknown[]).length).toBe(1);
  });

  it("reads source_id (Phase B) from the RAW hit: a source-pinned hit attributes by source_id", () => {
    const reg: WorkspaceScopeRegistry = {
      descriptors: [{ workspaceId: BUSINESS, slugPrefixes: ["personal-business"], sourceId: sourceId("src-b") }],
    };
    const raw = [gbrainHit("legacy/unprefixed", "t", "T", { source_id: "src-b" })];
    expect((createWorkspaceScopeFilter(BUSINESS, reg, DENY)(raw) as unknown[]).length).toBe(1);
  });

  it("a malformed/traversal/missing-slug raw hit is DROPPED (fail-closed)", () => {
    const filter = createWorkspaceScopeFilter(BUSINESS, REGISTRY, ASSIGN_BUSINESS);
    expect((filter([gbrainHit("../employer-work/x", "t", "T")]) as unknown[]).length).toBe(0);
    expect((filter([{ chunk_text: "no slug", title: "T" }]) as unknown[]).length).toBe(0); // missing slug
    expect((filter(["not-an-object"]) as unknown[]).length).toBe(0); // non-object hit
    // pin the readRawScopeHit typeof guards: a NON-STRING slug/source_id must not attribute (drop, not throw).
    expect((filter([{ slug: 123, chunk_text: "x", title: "T" }]) as unknown[]).length).toBe(0); // slug not a string
    expect(
      (filter([{ slug: "employer-work/x", source_id: 42, chunk_text: "x", title: "T" }]) as unknown[]).length,
    ).toBe(0); // foreign slug + non-string source_id ⇒ ignore source_id, attribute by slug ⇒ FOREIGN drop
  });

  it("a NON-array input passes through UNCHANGED (so the downstream mapper fails closed on it)", () => {
    const filter = createWorkspaceScopeFilter(BUSINESS, REGISTRY, DENY);
    expect(filter({ not: "array" })).toEqual({ not: "array" });
    expect(filter(null)).toBeNull();
  });
});

describe("createGbrainSubprocessRetrieval — the scopeFilter runs on RAW hits BEFORE normalize (SC2 wiring)", () => {
  const served = "personal-business";
  const fallback = createFixtureRetrieval({});

  it("applies the scopeFilter to the raw exec payload before normalize+parse (foreign hit never reaches the context)", async () => {
    const seen: unknown[] = [];
    const spyFilter: GbrainScopeFilter = (raw) => {
      seen.push(raw);
      // drop the employer hit by its RAW slug (proves the filter sees the un-normalized slug)
      return (raw as Array<Record<string, unknown>>).filter((h) => String(h["slug"]).startsWith("personal-business"));
    };
    const raw = [
      gbrainHit("personal-business/mine", "mine", "Mine"),
      gbrainHit("employer-work/theirs", "theirs", "Theirs"),
    ];
    const { exec } = fakeExec(ok(raw));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback, scopeFilter: spyFilter });
    const r = await retrieval.retrieve(served, "q");
    // the filter saw the RAW array (with slugs still '/'-pathed)
    expect((seen[0] as Array<Record<string, unknown>>)[0]!["slug"]).toBe("personal-business/mine");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual(["mine"]); // only the kept hit
      expect(r.value.sources).toEqual([{ citationId: "gbrain:personal-business:mine", title: "Mine" }]);
    }
  });

  it("absent scopeFilter ⇒ byte-identical to today (passthrough — back-compat)", async () => {
    const raw = [gbrainHit("employer-work/theirs", "theirs", "Theirs")];
    const { exec } = fakeExec(ok(raw));
    const noFilter = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback });
    const r = await noFilter.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual(["theirs"]); // unfiltered, as before
  });

  it("a real createWorkspaceScopeFilter drops the foreign hit end-to-end", async () => {
    const reg: WorkspaceScopeRegistry = {
      descriptors: [
        { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
        { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
      ],
    };
    const filter = createWorkspaceScopeFilter(workspaceId("personal-business"), reg, { mode: "assign", toWorkspaceId: workspaceId("personal-business") });
    const raw = [
      gbrainHit("employer-work/secret", "leak", "Leak"),
      gbrainHit("sessions/041", "legacy-ok", "Legacy"),
    ];
    const { exec } = fakeExec(ok(raw));
    const retrieval = createGbrainSubprocessRetrieval({ exec, servedWorkspaceId: served, fallback, scopeFilter: filter });
    const r = await retrieval.retrieve(served, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // employer hit dropped (foreign); legacy kept (assign,served) — no cross-workspace content survives
      expect(r.value.blocks).toEqual(["legacy-ok"]);
    }
  });
});

// ── Option A (single-brain, MULTI-SERVED) — createMultiServedGbrainRetrieval ───────────────────────────
//
// The multi-served composite: ANY workspace REGISTERED in the scope registry reads the ONE combined brain,
// scoped PER-REQUEST to its own slug prefix; an UNREGISTERED workspace fails closed to the fallback (the
// brain is NEVER read unscoped). Replaces the single-served `servedWorkspaceId` gate with registry
// membership (`descriptorFor`), binding a MANDATORY per-request filter to the asked workspace's descriptor
// id (server-derived). WS-8 by scope filtering (not by construction), so the F2 field-fidelity + A1
// body-embedded residuals go LIVE for any workspace holding real combined-brain content (INERT today —
// only personal-business has content). `decideHitScope`'s legacy branch keeps `{assign,X}` sound: unprefixed
// content is served ONLY to X, never crossing to another asked workspace.
describe("createMultiServedGbrainRetrieval — every REGISTERED workspace reads the one brain, scoped to itself (WS-8)", () => {
  const BUSINESS = workspaceId("personal-business");
  const REGISTRY: WorkspaceScopeRegistry = {
    descriptors: [
      { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
      { workspaceId: BUSINESS, slugPrefixes: ["personal-business"] },
      { workspaceId: workspaceId("personal-life"), slugPrefixes: ["personal-life"] },
    ],
  };
  const ASSIGN_BUSINESS: LegacyContentPolicy = { mode: "assign", toWorkspaceId: BUSINESS };
  const DENY: LegacyContentPolicy = { mode: "deny" };
  // Empty fixtures ⇒ the fallback fails closed (WORKSPACE_NOT_FOUND) for ANY workspace — so an UNREGISTERED
  // workspace (the only path that reaches the fallback under multi-served) is provably fail-closed.
  const fallback = createFixtureRetrieval({});
  // One combined brain holding all four kinds of content (three prefixed workspaces + unprefixed legacy).
  const mixedHits = [
    gbrainHit("personal-business/notes/x", "pb block", "PB Note"),
    gbrainHit("personal-life/goals/y", "pl block", "PL Goals"),
    gbrainHit("employer-work/acme/z", "ew block", "EW Secret"),
    gbrainHit("sessions/041", "legacy block", "Legacy Session"),
  ];

  it("served personal-business ({assign,PB}): reads the brain, keeps own + legacy, drops the two foreign workspaces", async () => {
    const { exec, calls } = fakeExec(ok(mixedHits));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback, limit: 8 });
    const r = await retrieval.retrieve("personal-business", "q");
    expect(calls).toEqual([{ question: "q", limit: 8 }]); // the brain IS read for a registered workspace
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe("personal-business"); // the WS-8 self-check anchor
      expect(r.value.blocks).toEqual(["pb block", "legacy block"]); // own + legacy(assigned to PB); no PL/EW
      expect(r.value.sources).toEqual([
        { citationId: "gbrain:personal-business:notes:x", title: "PB Note" },
        { citationId: "gbrain:sessions:041", title: "Legacy Session" },
      ]);
    }
  });

  it("A DIFFERENT registered workspace (personal-life) ALSO reads the brain, scoped to ITSELF — the multi-served behavior", async () => {
    const { exec, calls } = fakeExec(ok(mixedHits));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback });
    const r = await retrieval.retrieve("personal-life", "q");
    expect(calls).toHaveLength(1); // personal-life now reads the one brain (NOT fixture-fallback)
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe("personal-life");
      // ONLY personal-life-prefixed content: PB + EW dropped (foreign); legacy dropped (assigned to PB≠PL).
      expect(r.value.blocks).toEqual(["pl block"]);
      expect(r.value.sources).toEqual([{ citationId: "gbrain:personal-life:goals:y", title: "PL Goals" }]);
    }
  });

  it("served employer-work ({assign,PB}): keeps ONLY employer-prefixed content — legacy is NOT rescued to it", async () => {
    const { exec } = fakeExec(ok(mixedHits));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback });
    const r = await retrieval.retrieve("employer-work", "q");
    expect(isOk(r)).toBe(true);
    // employer-work sees only its own prefix; the unprefixed legacy is PB-assigned ⇒ LEGACY_NOT_SERVED here.
    if (isOk(r)) expect(r.value.blocks).toEqual(["ew block"]);
  });

  it("under {deny}: a served workspace keeps ONLY its own prefixed content (legacy dropped)", async () => {
    const { exec } = fakeExec(ok(mixedHits));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: DENY, fallback });
    const r = await retrieval.retrieve("personal-business", "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toEqual(["pb block"]); // legacy DENIED, PL/EW foreign
  });

  it("UNREGISTERED workspace: fails closed to the fallback and NEVER reads the brain", async () => {
    const { exec, calls } = fakeExec(ok(mixedHits));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback });
    const r = await retrieval.retrieve("marketing-team", "q"); // not a registered descriptor
    expect(calls).toEqual([]); // no brain read for an unregistered workspace
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("a registered workspace with an exec fault propagates the typed err (retryable)", async () => {
    const fault = failure("degraded_unavailable", "gbrain read failed", {
      retryable: true,
      cause: { code: "GBRAIN_CLI_FAULT" },
    });
    const { exec } = fakeExec(err(fault));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback });
    const r = await retrieval.retrieve("personal-business", "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("GBRAIN_CLI_FAULT");
  });

  it("a non-array exec payload fails CLOSED (parse malformed) even for a registered workspace", async () => {
    const { exec } = fakeExec(ok({ not: "array" }));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback });
    const r = await retrieval.retrieve("personal-business", "q");
    expect(isErr(r)).toBe(true);
  });

  it("caps the accepted response at the limit", async () => {
    const many = Array.from({ length: 20 }, (_v, i) => gbrainHit(`personal-business/${i}`, `block ${i}`, `T${i}`));
    const { exec } = fakeExec(ok(many));
    const retrieval = createMultiServedGbrainRetrieval({ exec, registry: REGISTRY, policy: ASSIGN_BUSINESS, fallback, limit: 3 });
    const r = await retrieval.retrieve("personal-business", "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.blocks).toHaveLength(3);
  });
});
