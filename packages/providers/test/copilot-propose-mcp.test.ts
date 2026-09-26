// spec(§9.6/§9.8) — Phase-C C5.3a: the Claude Agent SDK in-process MCP registration adapter for the
// Copilot's propose_action tool. This adapter lives in @sow/providers (the only package that deps the SDK)
// and is a THIN wrapper: it exposes `mcp__copilot__propose_action` over a zod raw shape and delegates every
// call to an INJECTED worker-side handler (typed structurally as args-as-unknown, so providers ↛ worker).
// The zod shape is model-facing ergonomics, NOT the security gate — the worker's strict parse re-validates.
import { describe, it, expect } from "vitest";
import {
  COPILOT_MCP_SERVER_NAME,
  PROPOSE_INPUT_SHAPE,
  PROPOSE_LINEAR_INPUT_SHAPE,
  COPILOT_PROPOSE_LINEAR_TOOL_NAME,
  buildCopilotProposeToolDefinition,
  buildCopilotLinearProposeToolDefinition,
  createCopilotProposeMcpServer,
  copilotProposeToolDefinitions,
  toCallToolResult,
  type CopilotProposeToolHandler,
} from "../src/runtime/copilot-propose-mcp";

const okHandler: CopilotProposeToolHandler = async () => ({
  content: [{ type: "text", text: "Recorded a PENDING approval (appr-1)." }],
});

describe("createCopilotProposeMcpServer — the in-process SDK MCP server for copilot.propose_action", () => {
  it("names the server 'copilot' (⇒ the tool is surfaced as mcp__copilot__propose_action)", () => {
    expect(COPILOT_MCP_SERVER_NAME).toBe("copilot");
    const server = createCopilotProposeMcpServer(okHandler);
    // createSdkMcpServer returns an McpSdkServerConfigWithInstance: { type:'sdk', name, instance }.
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("copilot");
    expect(server.instance).toBeDefined();
  });
});

describe("buildCopilotProposeToolDefinition — the tool() definition", () => {
  it("exposes a tool named 'propose_action' over the propose input shape", () => {
    const def = buildCopilotProposeToolDefinition(okHandler);
    expect(def.name).toBe("propose_action");
    expect(def.inputSchema).toBe(PROPOSE_INPUT_SHAPE);
    expect(typeof def.handler).toBe("function");
  });

  it("forwards the SDK-parsed args to the injected handler and returns the handler's mapped CallToolResult", async () => {
    let seen: unknown;
    const spy: CopilotProposeToolHandler = async (args) => {
      seen = args;
      return { content: [{ type: "text", text: "ok" }] };
    };
    const def = buildCopilotProposeToolDefinition(spy);
    const args = { targetSystem: "todoist", operation: "todoist.create_task", identity: { title: "x" }, payload: {} };
    const res = await def.handler(args as never, undefined);
    expect(seen).toEqual(args); // args flow straight to the worker handler (which re-parses strictly)
    expect(res.content[0]).toEqual({ type: "text", text: "ok" });
    expect(res.isError).toBeUndefined();
  });

  it("propagates an error result (isError) from the handler", async () => {
    const errHandler: CopilotProposeToolHandler = async () => ({
      content: [{ type: "text", text: "Could not record the proposal (COPILOT_PROPOSE_MALFORMED)." }],
      isError: true,
    });
    const def = buildCopilotProposeToolDefinition(errHandler);
    const res = await def.handler({} as never, undefined);
    expect(res.isError).toBe(true);
    const block = res.content[0];
    expect(block?.type).toBe("text");
    expect(block && block.type === "text" ? block.text : "").toContain("COPILOT_PROPOSE_MALFORMED");
  });
});

describe("toCallToolResult — maps the worker's readonly result to a mutable SDK CallToolResult", () => {
  it("copies the content array (fresh, mutable) and preserves isError only when set", () => {
    const ro = { content: [{ type: "text" as const, text: "hi" }] };
    const out = toCallToolResult(ro);
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.content).not.toBe(ro.content); // fresh array, not the frozen input
    expect(out.isError).toBeUndefined();

    const err = toCallToolResult({ content: [{ type: "text" as const, text: "no" }], isError: true });
    expect(err.isError).toBe(true);
  });
});

// Linear slice 5b.3b — the Copilot's own Linear filing tool, `propose_linear_issue`, on the same `copilot` server.
describe("buildCopilotLinearProposeToolDefinition — the propose_linear_issue tool", () => {
  it("is named propose_linear_issue, over its own input shape, and says it never sends anything", () => {
    const def = buildCopilotLinearProposeToolDefinition(okHandler);
    expect(COPILOT_PROPOSE_LINEAR_TOOL_NAME).toBe("propose_linear_issue");
    expect(def.name).toBe("propose_linear_issue");
    expect(def.inputSchema).toBe(PROPOSE_LINEAR_INPUT_SHAPE);
    expect(Object.keys(PROPOSE_LINEAR_INPUT_SHAPE).sort()).toEqual(["assignee", "description", "dueDate", "priority", "team", "title"]);
    expect(def.description).toMatch(/owner must approve/i);
    expect(def.description).toMatch(/only if the owner stated/i);
  });

  it("forwards the args to the injected handler as-is (the worker re-validates strictly)", async () => {
    let seen: unknown;
    const def = buildCopilotLinearProposeToolDefinition(async (a) => ((seen = a), { content: [{ type: "text", text: "ok" }] }));
    const args = { title: "T", description: "D", team: "Core" };
    await def.handler(args as never, undefined);
    expect(seen).toEqual(args);
  });

  it("the server carries propose_linear_issue ONLY when its handler is given", () => {
    expect(copilotProposeToolDefinitions(okHandler).map((d) => d.name)).toEqual(["propose_action"]);
    expect(copilotProposeToolDefinitions(okHandler, okHandler).map((d) => d.name)).toEqual(["propose_action", "propose_linear_issue"]);
    expect(createCopilotProposeMcpServer(okHandler).name).toBe("copilot");
    expect(createCopilotProposeMcpServer(okHandler, okHandler).name).toBe("copilot");
  });

  it("the REAL server holds exactly those tools (review 2026-09-25: the helper alone proved nothing about the server)", () => {
    // Reads the MCP server's registered tools. `_registeredTools` is the SDK's own map (@modelcontextprotocol/sdk
    // McpServer); if an SDK upgrade renames it, this test fails loudly rather than passing on an empty list.
    const toolsOf = (s: ReturnType<typeof createCopilotProposeMcpServer>): string[] =>
      Object.keys((s.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(toolsOf(createCopilotProposeMcpServer(okHandler))).toEqual(["propose_action"]);
    expect(toolsOf(createCopilotProposeMcpServer(okHandler, okHandler))).toEqual(["propose_action", "propose_linear_issue"]);
  });
});
