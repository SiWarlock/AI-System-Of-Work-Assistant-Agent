// @sow/providers — the Claude Agent SDK in-process MCP registration for the Copilot's gbrain PROXY (§13.10
// gate a, SC7b). This adapter lives in providers because providers is the ONLY package that deps the Agent SDK;
// the pure DAG root (@sow/contracts) may not import it.
//
// It is a THIN registration wrapper — the WS-8 counterpart of createCopilotProposeMcpServer. `createSdkMcpServer`
// + `tool()` expose one tool per scoped gbrain READ op under server name "gbrain", so each is surfaced to the
// model as `mcp__gbrain__<op>`. Registering this under the `gbrain` key REPLACES the raw `gbrain serve --http`
// entry in the runner's `mcpServers` map (SC8) — so the model can NEVER reach unscoped gbrain: every call is
// delegated to an INJECTED worker-side handler that runs SC5a (arg policing) + the real read + SC5b (result
// redaction), bound to the served workspace.
//
// ⚠ SECURITY: the per-op zod raw shape is MODEL-FACING ERGONOMICS, NOT the gate. A non-strict shape strips
// unknown keys rather than rejecting, and enforces none of the workspace-scope rules. The worker handler's
// SC5a/SC5b are the sole authority over the untrusted model args + the raw result — which is why this adapter
// forwards `args` to the handler as `unknown` (reconstructing only the full `mcp__gbrain__<op>` name the guards
// key off) and never trusts the SDK-parsed shape. providers keeps NO import of @sow/policy or the worker.
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

/** The SDK MCP server name — each tool is surfaced to the model as `mcp__gbrain__<op>` (replaces the http entry). */
export const COPILOT_GBRAIN_PROXY_SERVER_NAME = "gbrain" as const;

/**
 * The exposed gbrain READ ops — the result-filterable (query/traverse_graph/find_contradictions) + arg-scopable
 * (get_recent_salience/get_timeline) set that is SAFE over a non-partitioned combined brain (the SC4 scoping
 * classes). NO mutating tool (put/delete) and NO `unscopable` whole-brain aggregator/code op (find_experts,
 * takes_*, code_*) is exposed — those cannot be per-item scoped, so an agentic Copilot must not hold them. The
 * live gbrain search tool is named `query`; the worker guards map it to `gbrain.search` internally.
 */
export const COPILOT_GBRAIN_PROXY_OPS = [
  "query",
  "traverse_graph",
  "find_contradictions",
  "get_recent_salience",
  "get_timeline",
] as const;

/** The fully-qualified `mcp__gbrain__<op>` tool names — the runner's `allowedTools` auto-approve set (SC8). */
export const COPILOT_GBRAIN_PROXY_MCP_NAMES: readonly string[] = COPILOT_GBRAIN_PROXY_OPS.map(
  (op) => `mcp__${COPILOT_GBRAIN_PROXY_SERVER_NAME}__${op}`,
);

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotGbrainProxyTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** The injected worker handler's result shape (readonly) — matches the worker's CopilotGbrainToolResult. */
export interface CopilotGbrainProxyResult {
  readonly content: ReadonlyArray<CopilotGbrainProxyTextBlock>;
}

/**
 * The injected worker-side handler, typed STRUCTURALLY (args as `unknown`) so providers ↛ worker. The concrete
 * handler is the worker's `handleCopilotGbrainToolCall` closed over the server-bound {scope, exec} (SC8). It is
 * fail-safe (never throws) + leak-safe by its own contract. It receives the FULL `mcp__gbrain__<op>` name
 * (the SC5a/SC5b guards key off it).
 */
export type CopilotGbrainProxyHandler = (
  mcpToolName: string,
  args: unknown,
) => Promise<CopilotGbrainProxyResult>;

/** Map the worker's readonly handler result to a fresh, mutable SDK `CallToolResult`. */
export function toGbrainCallToolResult(
  r: CopilotGbrainProxyResult,
): { content: Array<{ type: "text"; text: string }> } {
  return { content: r.content.map((b) => ({ type: "text" as const, text: b.text })) };
}

/**
 * Per-op model-facing input shapes. The worker's SC5a/SC5b remain the SOLE authority (this is NOT the gate),
 * but a useful side effect makes these a POSITIVE ARG ALLOW-LIST too: the SDK zod-parses the model's raw MCP
 * args against the declared shape and forwards the PARSED result to the handler, and zod's default object mode
 * STRIPS unknown keys. So a model cannot even express a scope-widening `all_sources`/`source_id` here — those
 * undeclared keys are dropped one layer UPSTREAM of SC5a (which is why SC5a's widening-deny is defense-in-depth
 * on this wired path, e.g. for a non-SDK caller or an SDK behavior change). Every key SC5a acts on IS declared
 * (the `slug` seed, `slugPrefix`) so it still reaches the handler: SC5a's foreign-seed deny, slugPrefix force,
 * and source-pin are all load-bearing. Keep undeclared any widening arg the model must never supply.
 */
const OP_INPUT_SHAPES: Record<(typeof COPILOT_GBRAIN_PROXY_OPS)[number], z.ZodRawShape> = {
  query: {
    query: z.string().describe("The natural-language question to semantically search the workspace brain for."),
    limit: z.number().optional().describe("Max passages to return."),
  },
  traverse_graph: {
    slug: z.string().describe("Seed note slug — MUST be a note in the served workspace (a foreign seed is denied)."),
    depth: z.number().optional().describe("How many hops to walk from the seed."),
  },
  find_contradictions: {
    slug: z.string().optional().describe("Optional slug substring to scope the conflict scan."),
    severity: z.string().optional().describe("Optional severity filter: low | medium | high."),
    limit: z.number().optional().describe("Max findings."),
  },
  get_recent_salience: {
    days: z.number().optional().describe("Look-back window in days."),
    limit: z.number().optional().describe("Max pages."),
    slugPrefix: z.string().optional().describe("Slug-prefix filter (the served workspace's prefix is enforced)."),
  },
  get_timeline: {
    slug: z.string().describe("Note slug whose timeline to read — MUST be in the served workspace."),
  },
};

/** Per-op one-line descriptions surfaced to the model. */
const OP_DESCRIPTIONS: Record<(typeof COPILOT_GBRAIN_PROXY_OPS)[number], string> = {
  query: "Semantic search over the workspace brain — returns grounded passages with citations.",
  traverse_graph: "Walk the knowledge-graph neighborhood of a seed note (in the served workspace).",
  find_contradictions: "Surface suspected contradictions in the workspace brain (conflict/gap detection).",
  get_recent_salience: "List recently-salient pages (activity + salience ranked over a window).",
  get_timeline: "Read a note's timeline entries (per-page history) for a note in the served workspace.",
};

/** Build the `tool()` definition for one exposed op, delegating to the injected handler under its full mcp name. */
function buildGbrainProxyToolDefinition(
  op: (typeof COPILOT_GBRAIN_PROXY_OPS)[number],
  handler: CopilotGbrainProxyHandler,
): SdkMcpToolDefinition<z.ZodRawShape> {
  const mcpToolName = `mcp__${COPILOT_GBRAIN_PROXY_SERVER_NAME}__${op}`;
  return tool(
    op,
    OP_DESCRIPTIONS[op],
    OP_INPUT_SHAPES[op],
    async (args: unknown): Promise<ReturnType<typeof toGbrainCallToolResult>> =>
      toGbrainCallToolResult(await handler(mcpToolName, args)),
  );
}

/** Build every exposed gbrain-proxy tool definition over the injected handler. */
export function buildCopilotGbrainProxyToolDefinitions(
  handler: CopilotGbrainProxyHandler,
): Array<SdkMcpToolDefinition<z.ZodRawShape>> {
  return COPILOT_GBRAIN_PROXY_OPS.map((op) => buildGbrainProxyToolDefinition(op, handler));
}

/**
 * Construct the in-process MCP server exposing `mcp__gbrain__<op>` for every scoped read op, delegating to the
 * injected handler. The returned `McpSdkServerConfigWithInstance` drops into the runner's `mcpServers` map.
 *
 * ⚠ SC8 WIRING CONTRACT (the replacement mechanism is the MAP KEY, not the instance name): SC8 MUST register
 * this under the map key `COPILOT_GBRAIN_PROXY_SERVER_NAME` ("gbrain") AND MUST ensure the raw `gbrain serve
 * --http` server is NOT also present in the map. Same key ⇒ the proxy REPLACES the http entry, so the model
 * reaches ONLY the scoped proxy. A DIFFERENT key (e.g. "gbrain-proxy") that leaves the http `gbrain` entry in
 * place would surface BOTH the scoped `mcp__gbrain-proxy__*` AND the UNSCOPED `mcp__gbrain__*` tools — a full
 * WS-8 bypass. SC8's wiring test must assert the http entry's absence under the served-proxy key.
 */
export function createCopilotGbrainProxyMcpServer(
  handler: CopilotGbrainProxyHandler,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COPILOT_GBRAIN_PROXY_SERVER_NAME,
    tools: buildCopilotGbrainProxyToolDefinitions(handler),
  });
}
