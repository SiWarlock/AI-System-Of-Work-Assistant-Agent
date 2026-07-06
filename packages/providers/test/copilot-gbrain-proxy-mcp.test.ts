// SC7b (§13.10 gate a) — the Claude Agent SDK in-process MCP registration for the Copilot's gbrain-proxy.
// This adapter lives in @sow/providers (the only package that deps the SDK) and is a THIN wrapper: it exposes
// one tool per scoped gbrain READ op under server name "gbrain" (so each is surfaced as `mcp__gbrain__<op>`,
// REPLACING the raw `gbrain serve --http` entry) and delegates EVERY call to an INJECTED worker-side handler
// (typed structurally as args-as-unknown, so providers ↛ worker + no @sow/policy import). The per-op zod shape
// is model-facing ergonomics, NOT the gate — the worker handler runs SC5a/SC5b.
import { describe, it, expect } from "vitest";
import {
  COPILOT_GBRAIN_PROXY_SERVER_NAME,
  COPILOT_GBRAIN_PROXY_OPS,
  COPILOT_GBRAIN_PROXY_MCP_NAMES,
  buildCopilotGbrainProxyToolDefinitions,
  createCopilotGbrainProxyMcpServer,
  toGbrainCallToolResult,
  type CopilotGbrainProxyHandler,
} from "../src/runtime/copilot-gbrain-proxy-mcp";

const okHandler: CopilotGbrainProxyHandler = async () => ({ content: [{ type: "text", text: "[]" }] });

describe("createCopilotGbrainProxyMcpServer — the in-process SDK MCP server for the gbrain proxy", () => {
  it("names the server 'gbrain' (⇒ tools are surfaced as mcp__gbrain__<op>, replacing the http entry)", () => {
    expect(COPILOT_GBRAIN_PROXY_SERVER_NAME).toBe("gbrain");
    const server = createCopilotGbrainProxyMcpServer(okHandler);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("gbrain");
    expect(server.instance).toBeDefined();
  });

  it("exposes exactly the scoped read ops (query + the result-filterable/arg-scopable set), and no mutating/unscopable op", () => {
    expect([...COPILOT_GBRAIN_PROXY_OPS]).toEqual(["query", "traverse_graph", "find_contradictions", "get_recent_salience", "get_timeline"]);
    // NO write/aggregator/code op is exposed (those are unscopable on a non-partitioned brain / mutating).
    for (const bad of ["put_page", "delete_page", "find_experts", "takes_list", "code_def"]) {
      expect(COPILOT_GBRAIN_PROXY_OPS as readonly string[]).not.toContain(bad);
    }
  });

  it("the exposed MCP names are the fully-qualified mcp__gbrain__<op> tool names", () => {
    expect(COPILOT_GBRAIN_PROXY_MCP_NAMES).toEqual([
      "mcp__gbrain__query",
      "mcp__gbrain__traverse_graph",
      "mcp__gbrain__find_contradictions",
      "mcp__gbrain__get_recent_salience",
      "mcp__gbrain__get_timeline",
    ]);
  });
});

describe("buildCopilotGbrainProxyToolDefinitions — the per-op tool() definitions", () => {
  it("builds one tool per op, named by the op (⇒ mcp__gbrain__<op>)", () => {
    const defs = buildCopilotGbrainProxyToolDefinitions(okHandler);
    expect(defs.map((d) => d.name)).toEqual([...COPILOT_GBRAIN_PROXY_OPS]);
    for (const d of defs) expect(typeof d.handler).toBe("function");
  });

  it("forwards the FULL mcp tool name + args to the injected handler and returns its mapped CallToolResult", async () => {
    const seen: Array<{ name: string; args: unknown }> = [];
    const spy: CopilotGbrainProxyHandler = async (name, args) => {
      seen.push({ name, args });
      return { content: [{ type: "text", text: '[{"slug":"personal-business/a"}]' }] };
    };
    const defs = buildCopilotGbrainProxyToolDefinitions(spy);
    const queryDef = defs.find((d) => d.name === "query")!;
    const args = { query: "what is x", limit: 5 };
    const res = await queryDef.handler(args as never, undefined);
    // the handler is called with the RECONSTRUCTED full mcp name (SC5a/SC5b key off it), not the bare op
    expect(seen[0]!.name).toBe("mcp__gbrain__query");
    expect(seen[0]!.args).toEqual(args);
    expect(res.content[0]).toEqual({ type: "text", text: '[{"slug":"personal-business/a"}]' });
  });

  it("EVERY tool reconstructs its own full mcp__gbrain__<op> name (all 5 ops)", async () => {
    const seen: string[] = [];
    const spy: CopilotGbrainProxyHandler = async (name) => {
      seen.push(name);
      return { content: [{ type: "text", text: "[]" }] };
    };
    const defs = buildCopilotGbrainProxyToolDefinitions(spy);
    for (const d of defs) await d.handler({} as never, undefined);
    expect(seen).toEqual(COPILOT_GBRAIN_PROXY_MCP_NAMES); // 1:1 with the exposed op order
  });

  it("args are forwarded to the handler UNPARSED (the zod shape is ergonomics, not the gate)", async () => {
    let seen: unknown;
    const spy: CopilotGbrainProxyHandler = async (_name, args) => {
      seen = args;
      return { content: [{ type: "text", text: "[]" }] };
    };
    const defs = buildCopilotGbrainProxyToolDefinitions(spy);
    // a model passing an off-shape widening arg reaches the worker handler verbatim (SC5a there denies it)
    const rogue = { query: "q", all_sources: true, source_id: "__all__" };
    await defs.find((d) => d.name === "query")!.handler(rogue as never, undefined);
    expect(seen).toEqual(rogue);
  });
});

describe("toGbrainCallToolResult — maps the worker's readonly result to a mutable SDK CallToolResult", () => {
  it("copies the content array (fresh, mutable)", () => {
    const ro = { content: [{ type: "text" as const, text: "[]" }] };
    const out = toGbrainCallToolResult(ro);
    expect(out.content).toEqual([{ type: "text", text: "[]" }]);
    expect(out.content).not.toBe(ro.content); // fresh array, not the frozen input
  });
});
