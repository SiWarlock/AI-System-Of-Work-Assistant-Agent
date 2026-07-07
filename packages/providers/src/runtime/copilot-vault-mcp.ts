// @sow/providers — the Claude Agent SDK in-process MCP registration for the Copilot's read-only VAULT server
// (§13.10d). Sibling of `createCopilotGbrainProxyMcpServer`: a THIN registration wrapper that exposes a single
// `mcp__vault__read` tool, delegating to an INJECTED worker-side handler that does the path-traversal guard +
// WS-8 scope check + file read (the worker's `handleCopilotVaultReadCall`, bound to the served scope +
// vaultRoot). providers keeps NO import of @sow/policy or the worker.
//
// ⚠ SECURITY: the zod `path` shape is MODEL-FACING ERGONOMICS, NOT the gate. The worker handler is the SOLE
// authority over the untrusted `path` (traversal + WS-8 + fail-closed), which is why this forwards `args` to
// the handler as `unknown` and never trusts the SDK-parsed shape.
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

/** The SDK MCP server name — the single tool is surfaced to the model as `mcp__vault__read`. */
export const COPILOT_VAULT_SERVER_NAME = "vault" as const;
/** The single exposed op. */
export const COPILOT_VAULT_READ_OP = "read" as const;
/** The fully-qualified tool name — the runner's `allowedTools` auto-approve entry. */
export const COPILOT_VAULT_MCP_NAMES: readonly string[] = [
  `mcp__${COPILOT_VAULT_SERVER_NAME}__${COPILOT_VAULT_READ_OP}`,
];

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotVaultProxyTextBlock {
  readonly type: "text";
  readonly text: string;
}
/** The injected worker handler's result shape (readonly) — matches the worker's CopilotVaultReadResult. */
export interface CopilotVaultProxyResult {
  readonly content: ReadonlyArray<CopilotVaultProxyTextBlock>;
}

/**
 * The injected worker-side handler, typed STRUCTURALLY (args as `unknown`) so providers ↛ worker. The concrete
 * handler is the worker's `handleCopilotVaultReadCall` closed over the server-bound {scope, vaultRoot, readFile}.
 * It is fail-safe (never throws) + leak-safe by its own contract.
 */
export type CopilotVaultProxyHandler = (args: unknown) => Promise<CopilotVaultProxyResult>;

/** Map the worker's readonly handler result to a fresh, mutable SDK `CallToolResult`. */
export function toVaultCallToolResult(
  r: CopilotVaultProxyResult,
): { content: Array<{ type: "text"; text: string }> } {
  return { content: r.content.map((b) => ({ type: "text" as const, text: b.text })) };
}

/** The model-facing input shape (ergonomics only — the worker handler is the sole authority). */
const VAULT_READ_INPUT_SHAPE: z.ZodRawShape = {
  path: z
    .string()
    .describe("Note path relative to the vault (e.g. 'personal-business/notes/x') — MUST be a note in the served workspace; a foreign or traversal path is denied."),
};

/** Build the single `vault.read` tool definition over the injected handler. */
export function buildCopilotVaultToolDefinition(
  handler: CopilotVaultProxyHandler,
): SdkMcpToolDefinition<z.ZodRawShape> {
  return tool(
    COPILOT_VAULT_READ_OP,
    "Read one canonical Markdown note (by path) from the served workspace's vault.",
    VAULT_READ_INPUT_SHAPE,
    async (args: unknown): Promise<ReturnType<typeof toVaultCallToolResult>> =>
      toVaultCallToolResult(await handler(args)),
  );
}

/**
 * Construct the in-process MCP server exposing `mcp__vault__read`, delegating to the injected handler. The
 * returned `McpSdkServerConfigWithInstance` drops into the runner's `mcpServers` map under the `vault` key
 * (distinct from the `gbrain` key — the two servers coexist; the model sees both `mcp__gbrain__*` + `mcp__vault__read`).
 */
export function createCopilotVaultMcpServer(
  handler: CopilotVaultProxyHandler,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COPILOT_VAULT_SERVER_NAME,
    tools: [buildCopilotVaultToolDefinition(handler)],
  });
}
