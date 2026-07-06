// SC7a (§13.10 gate a) — the worker-side security composition for the DORMANT agentic gbrain-proxy tool path.
// handleCopilotGbrainToolCall composes the two pure WS-8 guards over an injected generic gbrain MCP exec:
//   SC5a policeGbrainToolArgs (deny widening/foreign-seed/unknown; scope-correct args) → exec(scoped args) →
//   SC5b redactGbrainToolResult (drop foreign hits from the raw MCP envelope).
// Deny / exec-fault / redacted-empty ALL collapse to a fail-closed empty MCP result (leak-safe; the internal
// cause is never surfaced to the model). Never throws.
import { describe, it, expect, vi } from "vitest";
import { ok, err, failure, workspaceId, sourceId } from "@sow/contracts";
import type { Result, FailureVariant } from "@sow/contracts";
import type { CopilotWorkspaceScope, WorkspaceScopeRegistry } from "@sow/policy";
import { handleCopilotGbrainToolCall } from "../src/api/procedures/copilotGbrainProxy";
import type { CopilotGbrainToolExec } from "../src/api/procedures/copilotGbrainProxy";

const BUSINESS = workspaceId("personal-business");
const EMPLOYER = workspaceId("employer-work");
const REGISTRY: WorkspaceScopeRegistry = {
  descriptors: [
    { workspaceId: EMPLOYER, slugPrefixes: ["employer-work"] },
    { workspaceId: BUSINESS, slugPrefixes: ["personal-business"] },
  ],
};
const scope: CopilotWorkspaceScope = { servedWorkspaceId: BUSINESS, registry: REGISTRY, policy: { mode: "assign", toWorkspaceId: BUSINESS } };

/** Build a gbrain MCP result envelope carrying a JSON payload (the http-transport shape). */
const env = (payload: unknown): unknown => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
/** A canned exec returning the given envelope; records the (op, args) it was called with. */
function fakeExec(returnValue: Result<unknown, FailureVariant>): CopilotGbrainToolExec & { calls: Array<{ op: string; args: Record<string, unknown> }> } {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const fn = (async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    return returnValue;
  }) as CopilotGbrainToolExec & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
/** Parse the handler result's first text block back to JSON. */
function parseResult(r: { content: ReadonlyArray<{ type: string; text: string }> }): unknown {
  const item = r.content.find((c) => c.type === "text");
  return item ? JSON.parse(item.text) : undefined;
}

describe("handleCopilotGbrainToolCall — SC5a→exec→SC5b (fail-closed; never throws)", () => {
  it("SC5a DENY (scope-widening): exec is NEVER called; returns a fail-closed empty result", async () => {
    const exec = fakeExec(ok(env([{ slug: "personal-business/a" }])));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q", all_sources: true }, { scope, exec });
    expect(exec.calls.length).toBe(0); // denied before the read — no gbrain call happened
    expect(parseResult(r)).toEqual([]); // empty, leak-safe
  });

  it("SC5a DENY (unknown/mutating tool): exec never called; empty result", async () => {
    const exec = fakeExec(ok(env([{ slug: "personal-business/a" }])));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__put_page", { slug: "x" }, { scope, exec });
    expect(exec.calls.length).toBe(0);
    expect(parseResult(r)).toEqual([]);
  });

  it("SC5a DENY (foreign seed for traverse_graph): exec never called; empty result", async () => {
    const exec = fakeExec(ok(env([{ slug: "personal-business/root" }])));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__traverse_graph", { slug: "employer-work/secret", depth: 1 }, { scope, exec });
    expect(exec.calls.length).toBe(0);
    expect(parseResult(r)).toEqual([]);
  });

  it("happy path: passes SCOPE-CORRECTED args to exec and returns the SC5b-redacted result", async () => {
    // model supplies all_sources:false (benign) + a foreign source_id → SC5a deletes both (no descriptor source).
    const hits = [
      { slug: "personal-business/a", title: "A", source_id: "default" },
      { slug: "employer-work/secret", title: "S", source_id: "default" }, // foreign → SC5b drops
    ];
    const exec = fakeExec(ok(env(hits)));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q", all_sources: false, source_id: "other-src" }, { scope, exec });
    expect(exec.calls.length).toBe(1);
    // the exec saw the SCOPE-CORRECTED args, not the raw model args
    expect(exec.calls[0]!.args["all_sources"]).toBeUndefined();
    expect(exec.calls[0]!.args["source_id"]).toBeUndefined();
    expect(exec.calls[0]!.args["query"]).toBe("q");
    // the result is redacted: the foreign hit is gone
    expect((parseResult(r) as Array<{ slug?: string }>).map((h) => h.slug)).toEqual(["personal-business/a"]);
  });

  it("pins a Phase-B descriptor source_id into the exec args when present", async () => {
    const reg: WorkspaceScopeRegistry = { descriptors: [{ workspaceId: BUSINESS, slugPrefixes: ["personal-business"], sourceId: sourceId("src-b") }] };
    const pbScope: CopilotWorkspaceScope = { servedWorkspaceId: BUSINESS, registry: reg, policy: { mode: "deny" } };
    const exec = fakeExec(ok(env([{ slug: "personal-business/a", source_id: "src-b" }])));
    await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q" }, { scope: pbScope, exec });
    expect(exec.calls[0]!.args["source_id"]).toBe("src-b");
  });

  it("get_recent_salience: forces the served slugPrefix into the exec args (discards a model override)", async () => {
    const exec = fakeExec(ok(env([{ slug: "personal-business/a" }])));
    await handleCopilotGbrainToolCall("mcp__gbrain__get_recent_salience", { slugPrefix: "employer-work", days: 7 }, { scope, exec });
    expect(exec.calls[0]!.args["slugPrefix"]).toBe("personal-business");
    expect(exec.calls[0]!.args["days"]).toBe(7);
  });

  it("exec FAULT (typed err): returns a fail-closed empty result (the fault detail is dropped)", async () => {
    const exec = fakeExec(err(failure("degraded_unavailable", "gbrain read failed", { retryable: true, cause: { code: "GBRAIN_HTTP_FAULT" } })));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q" }, { scope, exec });
    expect(parseResult(r)).toEqual([]);
  });

  it("exec THROWS: caught → fail-closed empty result (never throws across the boundary)", async () => {
    const throwingExec = (async () => {
      throw new Error("boom");
    }) as CopilotGbrainToolExec;
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q" }, { scope, exec: throwingExec });
    expect(parseResult(r)).toEqual([]);
  });

  it("exec returns a MALFORMED envelope: SC5b fail-closes → empty result", async () => {
    const exec = fakeExec(ok({ not: "an envelope" }));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q" }, { scope, exec });
    expect(parseResult(r)).toEqual([]);
  });

  it("traverse_graph happy path: redacts foreign nodes AND strips foreign edges from the result", async () => {
    const nodes = [
      { slug: "personal-business/root", links: [{ to: "personal-business/child", context: "in-ws" }, { to: "employer-work/leak", context: "SECRET" }] },
      { slug: "employer-work/foreign", links: [] },
    ];
    const exec = fakeExec(ok(env(nodes)));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__traverse_graph", { slug: "personal-business/root", depth: 1 }, { scope, exec });
    const kept = parseResult(r) as Array<{ slug: string; links: Array<Record<string, unknown>> }>;
    expect(kept.length).toBe(1);
    expect(kept[0]!.slug).toBe("personal-business/root");
    expect(kept[0]!.links.map((l) => l["to"])).toEqual(["personal-business/child"]);
    expect(JSON.stringify(r)).not.toContain("employer-work");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("find_contradictions happy path: drops a pair with a foreign side + strips resolution_command (A3+A4)", async () => {
    const payload = {
      contradictions: [
        { a: { slug: "personal-business/x", title: "X" }, b: { slug: "personal-business/y", title: "Y" }, severity: "high", axis: "time", confidence: 0.7, resolution_command: "gbrain resolve personal-business/x" },
        { a: { slug: "personal-business/x" }, b: { slug: "employer-work/z" }, severity: "low", axis: "fact", confidence: 0.2 }, // foreign far side → dropped
      ],
    };
    const exec = fakeExec(ok(env(payload)));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__find_contradictions", { limit: 5 }, { scope, exec });
    const out = parseResult(r) as { contradictions: Array<Record<string, unknown>> };
    expect(out.contradictions.length).toBe(1);
    expect(out.contradictions[0]!["severity"]).toBe("high");
    expect(out.contradictions[0]!["resolution_command"]).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("employer-work");
  });

  it("get_timeline happy path: in-workspace seed passthrough (SC5a validated the seed); non-array fail-closes", async () => {
    const entries = [{ date: "2026-01-01", summary: "s", detail: "d" }];
    const exec = fakeExec(ok(env(entries)));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__get_timeline", { slug: "personal-business/note" }, { scope, exec });
    expect(parseResult(r)).toEqual(entries);
    // a non-array timeline shape fail-closes through the redactor
    const badExec = fakeExec(ok(env({ entries })));
    const r2 = await handleCopilotGbrainToolCall("mcp__gbrain__get_timeline", { slug: "personal-business/note" }, { scope, exec: badExec });
    expect(parseResult(r2)).toEqual([]);
  });

  it("exec resolves ok(null): SC5b fail-closes on the non-object result → empty result", async () => {
    const exec = fakeExec(ok(null));
    const r = await handleCopilotGbrainToolCall("mcp__gbrain__query", { query: "q" }, { scope, exec });
    expect(parseResult(r)).toEqual([]);
  });

  it("ALWAYS returns non-empty valid MCP content (never returns null/throws)", async () => {
    for (const [name, input, ret] of [
      ["mcp__gbrain__query", { query: "q" }, ok(env([]))],
      ["mcp__gbrain__put_page", {}, ok(env([]))],
      ["bad-name", {}, ok(env([]))],
    ] as const) {
      const exec = fakeExec(ret);
      const r = await handleCopilotGbrainToolCall(name, input, { scope, exec });
      expect(r).not.toBeNull();
      expect(Array.isArray(r.content)).toBe(true);
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.content[0]!.type).toBe("text");
    }
  });
});
