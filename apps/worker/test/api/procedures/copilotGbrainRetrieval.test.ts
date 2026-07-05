// §9.6-real P3.1 — the GBrain-backed Copilot retrieval adapter (deterministic surface).
//
// Bridges the workspace-scoped, read-only GbrainReadAdapter (@sow/knowledge) to the Copilot
// CopilotRetrievalPort: pick the workspace's adapter (WS-8 fail-closed on unknown / mis-keyed), call
// `search`, and map the gbrain result → RetrievedContext (ALIGNED block↔source pairs — fixing the P2.3
// pairing carry-forward). The real GbrainReadClient transport + a populated/embedded brain are the
// separate live-wiring blockers; THIS pins the mapping + scoping + fail-closed logic with a fake adapter.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { WorkspaceId, BrainId } from "@sow/contracts";
import type { GbrainReadAdapter, GbrainReadResult } from "@sow/knowledge";
import {
  createGbrainCopilotRetrieval,
  parseGbrainSearchResult,
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

  it("passes the question + a bounded limit to adapter.search", async () => {
    const { adapter, calls } = fakeAdapter(WS, ok([]));
    const retrieval = createGbrainCopilotRetrieval({ adapters: new Map([[WS, adapter]]), limit: 7 });
    await retrieval.retrieve(WS, "the question");
    expect(calls).toHaveLength(1);
    const payload = calls[0] as { query?: unknown; limit?: unknown };
    expect(payload.query).toBe("the question");
    expect(payload.limit).toBe(7);
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
