// §13.10a — Slice G3: the Claude Agent SDK in-process MCP registration adapter for the Copilot's
// SEMANTIC-write `propose_knowledge` tool. The mirror of copilot-propose-mcp (propose_action). Lives in
// @sow/providers (the only package that deps the SDK) and is a THIN wrapper: it exposes
// `mcp__copilot__propose_knowledge` over a zod raw shape and delegates every call to an INJECTED
// worker-side handler (typed structurally as args-as-unknown, so providers ↛ worker). The zod shape is
// model-facing ergonomics, NOT the security gate — the worker's strict derive re-validates.
import { describe, it, expect } from "vitest";
import {
  COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME,
  PROPOSE_KNOWLEDGE_INPUT_SHAPE,
  buildCopilotProposeKnowledgeToolDefinition,
  createCopilotProposeKnowledgeMcpServer,
  toKnowledgeCallToolResult,
  type CopilotProposeKnowledgeToolHandler,
} from "../src/runtime/copilot-propose-knowledge-mcp";

const okHandler: CopilotProposeKnowledgeToolHandler = async () => ({
  content: [{ type: "text", text: "Recorded a PENDING approval (appr-k-1)." }],
});

describe("createCopilotProposeKnowledgeMcpServer — the in-process SDK MCP server for copilot.propose_knowledge", () => {
  it("names the server 'copilot' (⇒ the tool is surfaced as mcp__copilot__propose_knowledge, catalog id copilot.propose_knowledge)", () => {
    const server = createCopilotProposeKnowledgeMcpServer(okHandler);
    // createSdkMcpServer returns an McpSdkServerConfigWithInstance: { type:'sdk', name, instance }.
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("copilot");
    expect(server.instance).toBeDefined();
  });

  it("uses the tool name 'propose_knowledge' (mirrors the worker's COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME)", () => {
    expect(COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME).toBe("propose_knowledge");
  });
});

describe("buildCopilotProposeKnowledgeToolDefinition — the tool() definition", () => {
  it("exposes a tool named 'propose_knowledge' over the propose-knowledge input shape", () => {
    const def = buildCopilotProposeKnowledgeToolDefinition(okHandler);
    expect(def.name).toBe("propose_knowledge");
    expect(def.inputSchema).toBe(PROPOSE_KNOWLEDGE_INPUT_SHAPE);
    expect(typeof def.handler).toBe("function");
  });

  it("forwards the SDK-parsed args to the injected handler VERBATIM as unknown (the worker re-derives strictly)", async () => {
    let seen: unknown;
    const spy: CopilotProposeKnowledgeToolHandler = async (args) => {
      seen = args;
      return { content: [{ type: "text", text: "ok" }] };
    };
    const def = buildCopilotProposeKnowledgeToolDefinition(spy);
    const args = { projectId: "acme-corp", title: "Acme Corp", lifecycleState: "active", summary: "shipping v2" };
    const res = await def.handler(args as never, undefined);
    expect(seen).toEqual(args); // args flow straight to the worker handler — the shape is not the gate
    expect(res.content[0]).toEqual({ type: "text", text: "ok" });
    expect(res.isError).toBeUndefined();
  });

  it("the adapter callback is TRANSPARENT — it forwards its input verbatim, adding no strip/coerce of its own", async () => {
    // This pins ONLY the adapter layer: whatever it is handed, it forwards unchanged. It does NOT prove the
    // live-path behavior for a smuggled key — in production the SDK's own z.object(shape) parse sits IN FRONT
    // of this callback and strips unknown keys. Containment doesn't depend on either layer: the note path is
    // derived from the SERVER-BOUND workspace, never a model field (see the module SECURITY header).
    let seen: unknown;
    const spy: CopilotProposeKnowledgeToolHandler = async (args) => {
      seen = args;
      return { content: [{ type: "text", text: "ok" }] };
    };
    const def = buildCopilotProposeKnowledgeToolDefinition(spy);
    const withExtra = { projectId: "x", title: "X", lifecycleState: "active", workspaceId: "employer-work", path: "../escape.md" };
    await def.handler(withExtra as never, undefined);
    expect(seen).toEqual(withExtra); // the adapter passes through exactly what it received (transparent layer)
  });

  it("propagates an error result (isError) from the handler", async () => {
    const errHandler: CopilotProposeKnowledgeToolHandler = async () => ({
      content: [{ type: "text", text: "Could not record the proposal (COPILOT_PROPOSE_KNOWLEDGE_MALFORMED)." }],
      isError: true,
    });
    const def = buildCopilotProposeKnowledgeToolDefinition(errHandler);
    const res = await def.handler({} as never, undefined);
    expect(res.isError).toBe(true);
    const block = res.content[0];
    expect(block?.type).toBe("text");
    expect(block && block.type === "text" ? block.text : "").toContain("COPILOT_PROPOSE_KNOWLEDGE_MALFORMED");
  });
});

describe("toKnowledgeCallToolResult — maps the worker's readonly result to a mutable SDK CallToolResult", () => {
  it("copies the content array (fresh, mutable) and preserves isError only when set", () => {
    const ro = { content: [{ type: "text" as const, text: "hi" }] };
    const out = toKnowledgeCallToolResult(ro);
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
    expect(out.content).not.toBe(ro.content); // fresh array, not the frozen input
    expect(out.isError).toBeUndefined();

    const errOut = toKnowledgeCallToolResult({ content: [{ type: "text" as const, text: "no" }], isError: true });
    expect(errOut.isError).toBe(true);
  });
});
