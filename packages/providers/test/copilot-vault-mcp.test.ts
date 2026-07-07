// §13.10d — the Claude Agent SDK in-process MCP registration for the Copilot's read-only VAULT server. A THIN
// wrapper exposing one tool `mcp__vault__read` under server "vault", delegating to an INJECTED worker handler
// (args-as-unknown, so providers ↛ worker). The zod `path` shape is model-facing ergonomics, NOT the gate —
// the worker's `handleCopilotVaultReadCall` runs the traversal guard + WS-8 scope + file read.
import { describe, it, expect } from "vitest";
import {
  COPILOT_VAULT_SERVER_NAME,
  COPILOT_VAULT_READ_OP,
  COPILOT_VAULT_MCP_NAMES,
  buildCopilotVaultToolDefinition,
  createCopilotVaultMcpServer,
  toVaultCallToolResult,
  type CopilotVaultProxyHandler,
} from "../src/runtime/copilot-vault-mcp";

const okHandler: CopilotVaultProxyHandler = async () => ({ content: [{ type: "text", text: "" }] });

describe("createCopilotVaultMcpServer — the in-process SDK MCP server for the vault read", () => {
  it("names the server 'vault' (⇒ the tool is surfaced as mcp__vault__read) and coexists with the gbrain server", () => {
    expect(COPILOT_VAULT_SERVER_NAME).toBe("vault");
    expect(COPILOT_VAULT_READ_OP).toBe("read");
    const server = createCopilotVaultMcpServer(okHandler);
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("vault"); // distinct from "gbrain" ⇒ the two servers coexist in mcpServers
    expect(server.instance).toBeDefined();
  });

  it("the exposed MCP name is the fully-qualified mcp__vault__read", () => {
    expect(COPILOT_VAULT_MCP_NAMES).toEqual(["mcp__vault__read"]);
  });
});

describe("buildCopilotVaultToolDefinition — the single read tool()", () => {
  it("builds one tool named 'read' with a function handler", () => {
    const def = buildCopilotVaultToolDefinition(okHandler);
    expect(def.name).toBe("read");
    expect(typeof def.handler).toBe("function");
  });

  it("forwards args UNPARSED to the injected handler and returns its mapped CallToolResult", async () => {
    let seen: unknown;
    const spy: CopilotVaultProxyHandler = async (args) => {
      seen = args;
      return { content: [{ type: "text", text: "# note body" }] };
    };
    const def = buildCopilotVaultToolDefinition(spy);
    // a rogue extra key reaches the worker handler verbatim (the worker guard is the sole authority)
    const args = { path: "personal-business/a", rogue: "../escape" };
    const res = await def.handler(args as never, undefined);
    expect(seen).toEqual(args);
    expect(res.content[0]).toEqual({ type: "text", text: "# note body" });
  });
});

describe("toVaultCallToolResult — maps the worker's readonly result to a mutable SDK CallToolResult", () => {
  it("copies the content array (fresh, mutable)", () => {
    const ro = { content: [{ type: "text" as const, text: "x" }] };
    const out = toVaultCallToolResult(ro);
    expect(out.content).toEqual([{ type: "text", text: "x" }]);
    expect(out.content).not.toBe(ro.content);
  });
});
