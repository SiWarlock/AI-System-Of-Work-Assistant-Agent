// §13.10d — the Claude Agent SDK in-process MCP registration for the Copilot's SKILL self-introspection server.
// A THIN wrapper in @sow/providers (the only package that deps the SDK): two tools (`mcp__skills__list` +
// `mcp__skills__get`) under server name "skills", each delegating to an INJECTED worker-side handler with the
// OP name + the raw model args. The per-op zod shape is model-facing ergonomics, NOT the gate.
import { describe, it, expect } from "vitest";
import {
  COPILOT_SKILLS_SERVER_NAME,
  COPILOT_SKILLS_OPS,
  COPILOT_SKILLS_MCP_NAMES,
  buildCopilotSkillsToolDefinitions,
  createCopilotSkillsMcpServer,
  toSkillsCallToolResult,
  type CopilotSkillsProxyHandler,
} from "../src/runtime/copilot-skills-mcp";

const okHandler: CopilotSkillsProxyHandler = async () => ({ content: [{ type: "text", text: "{}" }] });

describe("createCopilotSkillsMcpServer — the in-process SDK MCP server for skill introspection", () => {
  it("names the server 'skills' (⇒ tools are surfaced as mcp__skills__<op>)", () => {
    expect(COPILOT_SKILLS_SERVER_NAME).toBe("skills");
    const server = createCopilotSkillsMcpServer(okHandler);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("skills");
    expect(server.instance).toBeDefined();
  });

  it("exposes exactly the two introspection ops (list + get) — nothing else", () => {
    expect([...COPILOT_SKILLS_OPS]).toEqual(["list", "get"]);
  });

  it("the exposed MCP names are the fully-qualified mcp__skills__<op> tool names", () => {
    expect(COPILOT_SKILLS_MCP_NAMES).toEqual(["mcp__skills__list", "mcp__skills__get"]);
  });
});

describe("buildCopilotSkillsToolDefinitions — the per-op tool() definitions", () => {
  it("builds one tool per op, named by the op (⇒ mcp__skills__<op>)", () => {
    const defs = buildCopilotSkillsToolDefinitions(okHandler);
    expect(defs.map((d) => d.name)).toEqual([...COPILOT_SKILLS_OPS]);
    for (const d of defs) expect(typeof d.handler).toBe("function");
  });

  it("forwards the OP name + args to the injected handler and returns its mapped CallToolResult", async () => {
    const seen: Array<{ op: string; args: unknown }> = [];
    const spy: CopilotSkillsProxyHandler = async (op, args) => {
      seen.push({ op, args });
      return { content: [{ type: "text", text: '{"skill":{"id":"gbrain.search"}}' }] };
    };
    const defs = buildCopilotSkillsToolDefinitions(spy);
    const getDef = defs.find((d) => d.name === "get")!;
    const args = { id: "gbrain.search" };
    const res = await getDef.handler(args as never, undefined);
    // the handler is called with the OP (not the full mcp name) — the worker dispatches on it.
    expect(seen[0]!.op).toBe("get");
    expect(seen[0]!.args).toEqual(args);
    expect(res.content[0]).toEqual({ type: "text", text: '{"skill":{"id":"gbrain.search"}}' });
  });

  it("EACH tool forwards its OWN op ('list' / 'get')", async () => {
    const seen: string[] = [];
    const spy: CopilotSkillsProxyHandler = async (op) => {
      seen.push(op);
      return { content: [{ type: "text", text: "{}" }] };
    };
    const defs = buildCopilotSkillsToolDefinitions(spy);
    for (const d of defs) await d.handler({} as never, undefined);
    expect(seen).toEqual([...COPILOT_SKILLS_OPS]); // 1:1 with the exposed op order
  });

  it("args are forwarded to the handler UNPARSED (the zod shape is ergonomics, not the gate)", async () => {
    let seen: unknown;
    const spy: CopilotSkillsProxyHandler = async (_op, args) => {
      seen = args;
      return { content: [{ type: "text", text: "{}" }] };
    };
    const defs = buildCopilotSkillsToolDefinitions(spy);
    const rogue = { id: "copilot.propose_action", extra: true };
    await defs.find((d) => d.name === "get")!.handler(rogue as never, undefined);
    expect(seen).toEqual(rogue); // the worker handler decides (returns {skill:null} for a non-read id)
  });
});

describe("toSkillsCallToolResult — maps the worker's readonly result to a mutable SDK CallToolResult", () => {
  it("copies the content array (fresh, mutable)", () => {
    const ro = { content: [{ type: "text" as const, text: "{}" }] };
    const out = toSkillsCallToolResult(ro);
    expect(out.content).toEqual([{ type: "text", text: "{}" }]);
    expect(out.content).not.toBe(ro.content); // fresh array, not the frozen input
  });
});
