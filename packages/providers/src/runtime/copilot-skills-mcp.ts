// @sow/providers — the Claude Agent SDK in-process MCP registration for the Copilot's SKILL self-introspection
// server (§13.10d). Sibling of `createCopilotGbrainProxyMcpServer` + `createCopilotVaultMcpServer`: a THIN
// registration wrapper that exposes two tools — `mcp__skills__list` + `mcp__skills__get` — under the distinct
// server name "skills", delegating to an INJECTED worker-side handler (the worker's `handleCopilotSkillIntrospect`).
// providers keeps NO import of @sow/policy or the worker.
//
// Unlike the gbrain/vault servers, the skills handler reads only the STATIC tool catalog — no workspace data —
// so there is no scope to bind and no leak to guard (the `workspace-agnostic` scoping class). The `id` zod shape
// on `get` is MODEL-FACING ERGONOMICS, NOT a gate; the worker handler is the sole authority (and its only real
// job is "is this a read-catalog id?" — it returns {skill:null} for anything else, incl. the propose tool).
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

/** The SDK MCP server name — each tool is surfaced to the model as `mcp__skills__<op>`. */
export const COPILOT_SKILLS_SERVER_NAME = "skills" as const;

/** The two exposed introspection ops (list the read-skill catalog / read one skill's metadata). */
export const COPILOT_SKILLS_OPS = ["list", "get"] as const;

/** The fully-qualified `mcp__skills__<op>` tool names — the runner's `allowedTools` auto-approve set. */
export const COPILOT_SKILLS_MCP_NAMES: readonly string[] = COPILOT_SKILLS_OPS.map(
  (op) => `mcp__${COPILOT_SKILLS_SERVER_NAME}__${op}`,
);

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotSkillsProxyTextBlock {
  readonly type: "text";
  readonly text: string;
}
/** The injected worker handler's result shape (readonly) — matches the worker's CopilotSkillIntrospectResult. */
export interface CopilotSkillsProxyResult {
  readonly content: ReadonlyArray<CopilotSkillsProxyTextBlock>;
}

/**
 * The injected worker-side handler, typed STRUCTURALLY (args as `unknown`) so providers ↛ worker. The concrete
 * handler is the worker's `handleCopilotSkillIntrospect`. It receives the OP ("list" | "get") — supplied by the
 * server, one op per tool, so it is trusted — plus the raw, untrusted model `args`. Fail-safe (never throws).
 */
export type CopilotSkillsProxyHandler = (
  op: string,
  args: unknown,
) => Promise<CopilotSkillsProxyResult>;

/** Map the worker's readonly handler result to a fresh, mutable SDK `CallToolResult`. */
export function toSkillsCallToolResult(
  r: CopilotSkillsProxyResult,
): { content: Array<{ type: "text"; text: string }> } {
  return { content: r.content.map((b) => ({ type: "text" as const, text: b.text })) };
}

/** Per-op model-facing input shapes. `list` takes nothing; `get` takes the skill `id`. Ergonomics, not the gate. */
const OP_INPUT_SHAPES: Record<(typeof COPILOT_SKILLS_OPS)[number], z.ZodRawShape> = {
  list: {},
  get: {
    id: z
      .string()
      .describe("The skill id to read (e.g. 'gbrain.search'), as returned by list_skills."),
  },
};

/** Per-op one-line descriptions surfaced to the model. */
const OP_DESCRIPTIONS: Record<(typeof COPILOT_SKILLS_OPS)[number], string> = {
  list: "List the Copilot's own read-skills (id + description) — skill self-introspection.",
  get: "Read one Copilot read-skill's metadata by id.",
};

/** Build the `tool()` definition for one op, delegating to the injected handler with the op name. */
function buildSkillsToolDefinition(
  op: (typeof COPILOT_SKILLS_OPS)[number],
  handler: CopilotSkillsProxyHandler,
): SdkMcpToolDefinition<z.ZodRawShape> {
  return tool(
    op,
    OP_DESCRIPTIONS[op],
    OP_INPUT_SHAPES[op],
    async (args: unknown): Promise<ReturnType<typeof toSkillsCallToolResult>> =>
      toSkillsCallToolResult(await handler(op, args)),
  );
}

/** Build every exposed skills tool definition over the injected handler. */
export function buildCopilotSkillsToolDefinitions(
  handler: CopilotSkillsProxyHandler,
): Array<SdkMcpToolDefinition<z.ZodRawShape>> {
  return COPILOT_SKILLS_OPS.map((op) => buildSkillsToolDefinition(op, handler));
}

/**
 * Construct the in-process MCP server exposing `mcp__skills__list` + `mcp__skills__get`, delegating to the
 * injected handler. The returned `McpSdkServerConfigWithInstance` drops into the runner's `mcpServers` map under
 * the distinct `skills` key (coexisting with the `gbrain` + `vault` servers).
 */
export function createCopilotSkillsMcpServer(
  handler: CopilotSkillsProxyHandler,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COPILOT_SKILLS_SERVER_NAME,
    tools: buildCopilotSkillsToolDefinitions(handler),
  });
}
