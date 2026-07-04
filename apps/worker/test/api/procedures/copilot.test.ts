// §9.6 A2 — Copilot workspace-scoped knowledge retrieval (WS-8 fail-closed).
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  createFixtureRetrieval,
  enforceRetrievalScope,
  type RetrievedContext,
} from "../../../src/api/procedures/copilot";

const WS = "ws-employer";
const OTHER = "ws-personal";

function ctx(workspaceId: string): RetrievedContext {
  return {
    workspaceId,
    blocks: ["A decision was logged on the vendor review."],
    sources: [{ citationId: "src:note-1", title: "Vendor review — decisions" }],
  };
}

describe("Copilot fixture retrieval — workspace-scoped, fail-closed (WS-8)", () => {
  it("returns candidate context scoped to a KNOWN workspace", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve(WS, "what did we decide?");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.workspaceId).toBe(WS);
      expect(r.value.blocks.length).toBeGreaterThan(0);
      expect(r.value.sources[0]?.citationId).toBe("src:note-1");
    }
  });

  it("an UNKNOWN workspace fails CLOSED (typed err, never a throw — §16)", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve(OTHER, "anything");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("validation_rejected");
      // Codebase-wide cause code (matches readModel.ts / systemHealth), not a bespoke one.
      expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("NEVER returns a FOREIGN workspace's context even if the fixture is mis-keyed (WS-8)", async () => {
    // A fixture keyed under WS but carrying OTHER's scope must fail closed — never leak OTHER.
    const retrieval = createFixtureRetrieval({ [WS]: ctx(OTHER) });
    const r = await retrieval.retrieve(WS, "q");
    expect(isErr(r)).toBe(true);
  });

  it("a prototype-chain key ('__proto__') is 'unknown workspace', never an inherited object", async () => {
    const retrieval = createFixtureRetrieval({ [WS]: ctx(WS) });
    const r = await retrieval.retrieve("__proto__", "q");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("enforceRetrievalScope — cross-workspace guard (defense-in-depth WS-8)", () => {
  it("passes a context whose workspaceId matches the requested scope", () => {
    const r = enforceRetrievalScope(WS, ctx(WS));
    expect(isOk(r)).toBe(true);
  });

  it("REJECTS a context whose workspaceId differs from the requested scope", () => {
    const r = enforceRetrievalScope(WS, ctx(OTHER));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });

  it("REJECTS an empty requested scope (never treat '' as a workspace)", () => {
    const r = enforceRetrievalScope("", ctx(""));
    expect(isErr(r)).toBe(true);
  });

  it("fails CLOSED (typed err, no throw) on a null / non-object context from a malicious adapter", () => {
    const r = enforceRetrievalScope(WS, null as unknown as RetrievedContext);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("RETRIEVAL_SCOPE_MISMATCH");
  });
});
