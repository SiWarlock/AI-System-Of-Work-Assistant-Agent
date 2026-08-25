// §9.6-real P3.1 — the GBrain-backed Copilot retrieval adapter (deterministic surface).
//
// Bridges the workspace-scoped, read-only GbrainReadAdapter (@sow/knowledge) to the Copilot
// CopilotRetrievalPort: pick the workspace's adapter (WS-8 fail-closed on unknown / mis-keyed), call
// `search`, and map the gbrain result → RetrievedContext (ALIGNED block↔source pairs — fixing the P2.3
// pairing carry-forward). The real GbrainReadClient transport + a populated/embedded brain are the
// separate live-wiring blockers; THIS pins the mapping + scoping + fail-closed logic with a fake adapter.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { WorkspaceId, BrainId, AgentJob, ProviderRoute, EgressPolicy } from "@sow/contracts";
import type { GbrainReadAdapter, GbrainReadResult } from "@sow/knowledge";
import { egressVeto, isDeny } from "@sow/policy";
import {
  createGbrainCopilotRetrieval,
  parseGbrainSearchResult,
  RERANK_OVER_FETCH_MULTIPLIER,
} from "../../../src/api/procedures/copilotGbrainRetrieval";

/** A fake read adapter that records the search payload and returns a canned result. */
function fakeAdapter(
  workspaceId: string,
  result: GbrainReadResult,
): { readonly adapter: GbrainReadAdapter; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const adapter: GbrainReadAdapter = {
    workspaceId: workspaceId as WorkspaceId,
    brainId: "brain-x" as BrainId,
    pinnedSha: "sha",
    allowedOps: ["search"],
    search: async (payload) => {
      calls.push(payload);
      return result;
    },
    graph: async () => ok(null),
    timeline: async () => ok(null),
    schemaRead: async () => ok(null),
    health: async () => ok(null),
    containedSynthesis: async () => ok(null),
  };
  return { adapter, calls };
}

const WS = "ws-employer";
const twoHits = [
  { content: "A vendor decision was logged.", source_id: "note-1", title: "Vendor review" },
  { content: "The SLA target is 99.9%.", source_id: "note-2", title: "Pricing memo" },
];

describe("createGbrainCopilotRetrieval — workspace-scoped, WS-8 fail-closed", () => {
  it("a KNOWN workspace maps search hits → aligned block↔source pairs", async () => {
    const { adapter } = fakeAdapter(WS, ok(twoHits));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve(WS, "what did we decide?");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe(WS);
      expect(r.value.blocks).toEqual(["A vendor decision was logged.", "The SLA target is 99.9%."]);
      expect(r.value.sources).toEqual([
        { citationId: "gbrain:note-1", title: "Vendor review" },
        { citationId: "gbrain:note-2", title: "Pricing memo" },
      ]);
      // Aligned: one block per source (the P2.3 pairing carry-forward is satisfied by construction).
      expect(r.value.blocks.length).toBe(r.value.sources.length);
    }
  });

  // 13.17 CHANGED: this used to assert `payload.limit === 7` (the raw display cap). That assertion
  // is now WRONG on its own terms — 13.17 requires an OVER-FETCH window wider than the display cap
  // (so rerank has candidates below the old cutoff to promote), so the adapter is deliberately asked
  // for MORE than `limit`. The old value pinned the pre-13.17 behavior this task exists to change.
  it("passes the question + an OVER-FETCH window (limit × RERANK_OVER_FETCH_MULTIPLIER) to adapter.search — 13.17 reorder-before-cap", async () => {
    const { adapter, calls } = fakeAdapter(WS, ok([]));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]), limit: 7 });
    await retrieval.retrieve(WS, "the question");
    expect(calls).toHaveLength(1);
    const payload = calls[0] as { query?: unknown; limit?: unknown };
    expect(payload.query).toBe("the question");
    expect(payload.limit).toBe(7 * RERANK_OVER_FETCH_MULTIPLIER); // the WIDER over-fetch window, not the display cap
  });

  it("an UNKNOWN workspace (not provisioned) fails CLOSED (WORKSPACE_NOT_FOUND)", async () => {
    const { adapter } = fakeAdapter(WS, ok(twoHits));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve("ws-other", "anything");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("a MIS-KEYED adapter (its workspaceId ≠ the requested key) fails CLOSED (WS-8 defense-in-depth)", async () => {
    // The map key says WS, but the bound adapter is for a FOREIGN workspace — never serve its brain.
    const { adapter } = fakeAdapter("ws-foreign", ok(twoHits));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve(WS, "anything");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH"); // NOT WORKSPACE_NOT_FOUND
  });

  it("an EMPTY result set → ok with an empty context (nothing found; synthesis then refuses)", async () => {
    const { adapter } = fakeAdapter(WS, ok([]));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve(WS, "obscure");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual([]);
      expect(r.value.sources).toEqual([]);
    }
  });

  it("a transport FAULT from the adapter fails CLOSED (degraded + retryable, no answer)", async () => {
    const { adapter } = fakeAdapter(WS, err({ code: "transport_fault", op: "search", cause: "boom" }));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("degraded_unavailable");
      expect(r.error.cause?.code).toBe("GBRAIN_READ_FAULT");
      expect(r.error.retryable).toBe(true); // transient — the ask can be re-driven
      // the underlying transport `cause` (which could carry a URL/content) is NOT threaded into the error
    }
  });

  it("a MALFORMED (non-array) response fails CLOSED (never fabricate context; not retryable)", async () => {
    const { adapter } = fakeAdapter(WS, ok("not an array"));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]) });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.cause?.code).toBe("GBRAIN_RESULT_MALFORMED");
      expect(r.error.retryable).toBe(false); // a bad shape won't fix on retry
    }
  });

  it("CAPS the accepted response at the limit (an over-returning adapter can't inflate the prompt)", async () => {
    const many = Array.from({ length: 20 }, (_v, i) => ({
      content: `passage ${String(i)}`,
      source_id: `n${String(i)}`,
      title: `T${String(i)}`,
    }));
    const { adapter } = fakeAdapter(WS, ok(many));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]), limit: 3 });
    const r = await retrieval.retrieve(WS, "q");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toHaveLength(3);
      expect(r.value.sources).toHaveLength(3);
    }
  });

  // ── 13.17 — over-fetch, rerank, THEN cap (reorder-before-cap) ────────────────────────────────────
  it("13.17: reorders BEFORE capping — a best-matching passage BELOW the raw cap position survives into the final capped set", async () => {
    const QUERY = "quarterly vendor contract renewal deadline";
    // 15 filler hits (positions 0-14) sharing NO lexical overlap with the query, then the ONE best
    // match at position 15 — strictly below the OLD raw cap of 8, so a naive raw-order cap would
    // have dropped it entirely.
    const filler = Array.from({ length: 15 }, (_v, i) => ({
      content: `unrelated filler note number ${String(i)} about the weather`,
      source_id: `filler-${String(i)}`,
      title: `Filler ${String(i)}`,
    }));
    const best = {
      content: "The quarterly vendor contract renewal deadline is next Friday.",
      source_id: "best-match",
      title: "Vendor contract",
    };
    const hits = [...filler, best]; // best sits at index 15
    const { adapter, calls } = fakeAdapter(WS, ok(hits));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]), limit: 8 });
    const r = await retrieval.retrieve(WS, QUERY);
    // The adapter was asked for a window wide enough to include position 15 in the first place.
    const payload = calls[0] as { limit?: number };
    expect(payload.limit).toBeGreaterThanOrEqual(16);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toHaveLength(8); // still capped at the display limit
      // THE assertion: the best-matching passage — which a raw positional cap at 8 would have
      // dropped (it sat at index 15) — is PRESENT in the final capped set.
      expect(r.value.blocks).toContain(best.content);
      expect(r.value.sources.map((s) => s.citationId)).toContain(`gbrain:${best.source_id}`);
      // It should in fact rank FIRST — it is the only hit with any lexical relevance to the query.
      expect(r.value.blocks[0]).toBe(best.content);
    }
  });

  it("13.17: content-preserving — reranking never fabricates or mutates a passage's text or citation", async () => {
    const hits = [
      { content: "Alpha passage about the annual budget review.", source_id: "a", title: "Budget" },
      { content: "Beta passage about the annual budget timeline.", source_id: "b", title: "Timeline" },
      { content: "Gamma passage, unrelated to anything.", source_id: "c", title: "Other" },
    ];
    const originalByCitation = new Map(hits.map((h) => [`gbrain:${h.source_id}`, h.content]));
    const { adapter } = fakeAdapter(WS, ok(hits));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]), limit: 3 });
    const r = await retrieval.retrieve(WS, "annual budget");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toHaveLength(3);
      // Every returned block is EXACTLY one of the original hit contents — never truncated, altered,
      // or synthesized — and stays aligned with its OWN original citation, not a swapped one.
      r.value.sources.forEach((source, i) => {
        const expectedContent = originalByCitation.get(source.citationId);
        expect(expectedContent).toBeDefined();
        expect(r.value.blocks[i]).toBe(expectedContent);
      });
      // No passage id/content pair is invented: the set of returned citationIds is a SUBSET of the
      // original hits' ids (never a synthesized/extra one).
      const returnedIds = new Set(r.value.sources.map((s) => s.citationId));
      for (const id of returnedIds) expect(originalByCitation.has(id)).toBe(true);
    }
  });

  // ── 13.17 SEC-MED pin — a raw Employer-Work retrieval still hits the REAL egressVeto downstream ──
  // Retrieval itself never egresses (gbrain is local); the veto gate sits at SYNTHESIS time, upstream
  // of which retrieved content is handed off (`copilot.ts` `runGovernedCopilotSynthesis`, out of this
  // slice's territory and UNCHANGED by it). This pin proves the REAL, unmodified `egressVeto` still
  // fails closed for exactly the content this port can hand it — never a cloud fallback (safety rule 5).
  describe("13.17 SEC-MED — raw Employer-Work content still hits the real egressVeto and fails closed", () => {
    const cloudRoute: ProviderRoute = {
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    };
    const employerWorkspace = { type: "employer_work" as const, dataOwner: "employer" as const };
    const ackOffPolicy: EgressPolicy = {
      workspaceId: "ws-employer" as EgressPolicy["workspaceId"],
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    };
    const rawContentJob = {
      id: "job-1",
      workflowRunId: "wf-1",
      workspaceId: "ws-employer",
      capability: "copilot.ask",
      contextRefs: [],
      outputSchemaId: "sow:agent-extraction",
      toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
      providerRoute: cloudRoute,
      trustLevel: "trusted",
      carriesRawContent: true, // retrieval fed real Employer-Work passages into the candidate route
      maxRuntimeSeconds: 60,
      idempotencyKey: "idem-1",
    } as unknown as AgentJob;

    it("retrieving Employer-Work content, then routing it through a cloud route, DENIES via the real egressVeto — no cloud fallback", async () => {
      const hits = [{ content: "raw employer content", source_id: "emp-1", title: "Employer note" }];
      const { adapter } = fakeAdapter("ws-employer", ok(hits));
      const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([["ws-employer", adapter]]) });
      const retrieved = await retrieval.retrieve("ws-employer", "q");
      expect(isOk(retrieved)).toBe(true); // retrieval itself succeeds (a local, non-egress read)

      // The REAL, unmodified policy veto — never re-implemented here — denies the cloud route for the
      // raw-content job over this exact ack-OFF employer-work posture.
      const decision = egressVeto(rawContentJob, cloudRoute, ackOffPolicy, employerWorkspace);
      expect(isDeny(decision)).toBe(true);
      if (isDeny(decision)) {
        expect(decision.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
      }
    });

    it("positive control: the SAME job/route/workspace with ack ON is ALLOWED — proves the DENY above is discriminating, not a vacuous always-deny", async () => {
      const ackOnPolicy: EgressPolicy = {
        ...ackOffPolicy,
        employerRawEgressAcknowledged: true,
        allowedProcessors: ["claude" as EgressPolicy["allowedProcessors"][number]],
        rawContentAllowedProcessors: ["claude" as EgressPolicy["rawContentAllowedProcessors"][number]],
        acknowledgedAt: "2026-08-24T00:00:00.000Z",
      };
      const decision = egressVeto(rawContentJob, cloudRoute, ackOnPolicy, employerWorkspace);
      expect(isDeny(decision)).toBe(false);
    });
  });
});

describe("parseGbrainSearchResult — defensive hit → block/source mapping", () => {
  it("SKIPS a hit missing content or a source id (can't ground/cite it), keeping alignment", () => {
    const raw = [
      { content: "usable passage", source_id: "n1", title: "T1" },
      { source_id: "n2", title: "no content" }, // no content → skipped
      { content: "no id, can't cite" }, // no id → skipped
    ];
    const r = parseGbrainSearchResult(WS, raw);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual(["usable passage"]);
      expect(r.value.sources).toEqual([{ citationId: "gbrain:n1", title: "T1" }]);
      expect(r.value.blocks.length).toBe(r.value.sources.length);
    }
  });

  it("SKIPS a hit whose only identifier is a `path` (not a safe/opaque citationId — no leak, no gate drop)", () => {
    const raw = [
      { content: "has an opaque id", source_id: "n1", title: "Keep" },
      { content: "only a path", path: "/Users/vault/employer/plan.md", title: "Drop" },
    ];
    const r = parseGbrainSearchResult(WS, raw);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.sources).toEqual([{ citationId: "gbrain:n1", title: "Keep" }]);
      // The path never becomes a citationId — no `gbrain:/Users/...` reaches synthesis or the UI gate.
      expect(r.value.sources.some((s) => s.citationId.includes("/"))).toBe(false);
    }
  });

  it("tolerates field aliases (text / id / name) and defaults a missing title", () => {
    const raw = [{ text: "aliased content", id: "n9" }];
    const r = parseGbrainSearchResult(WS, raw);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.blocks).toEqual(["aliased content"]);
      expect(r.value.sources[0]?.citationId).toBe("gbrain:n9");
      expect(typeof r.value.sources[0]?.title).toBe("string"); // defaulted, non-empty
      expect(r.value.sources[0]?.title.length).toBeGreaterThan(0);
    }
  });

  it("a non-array raw value → err (fail-closed)", () => {
    expect(isErr(parseGbrainSearchResult(WS, null))).toBe(true);
    expect(isErr(parseGbrainSearchResult(WS, { results: [] }))).toBe(true);
  });
});
