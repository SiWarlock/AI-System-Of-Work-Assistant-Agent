// @sow/providers — the Claude Agent SDK in-process MCP registration for the Copilot's propose_action tool
// (§9.6/§9.8 Phase-C C5.3a). This adapter lives in providers because providers is the ONLY package that deps
// the Agent SDK; the pure DAG root (@sow/contracts) may not import it.
//
// It is a THIN registration wrapper. `createSdkMcpServer` + `tool()` expose the tool as
// `mcp__copilot__propose_action` over a zod raw shape, and EVERY call is delegated to an INJECTED worker-side
// handler (the worker's `handleCopilotProposeToolCall`, bound to a server-side {workspaceId, sink}). The
// handler is typed STRUCTURALLY here (`CopilotProposeToolHandler`, args-as-`unknown`) so providers keeps NO
// import of the worker — the wiring closure is supplied at construction (C5.3c/d).
//
// ⚠ SECURITY: the zod raw shape is MODEL-FACING ERGONOMICS, NOT the gate. A non-strict `z.object` STRIPS
// unknown keys rather than rejecting, and does not enforce the empty-identity / target-enum / payload-bound
// rules. The worker's strict `parseCopilotProposeIntent` + `deriveCopilotProposedAction` remain the sole
// authority over the untrusted model args — which is why this adapter forwards `args` to the handler as
// `unknown` and never trusts the SDK-parsed shape.
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";

/** The SDK MCP server name — the tool is surfaced to the model as `mcp__<name>__propose_action`. */
export const COPILOT_MCP_SERVER_NAME = "copilot" as const;

/** The SDK tool name (mirrors the worker's COPILOT_PROPOSE_TOOL_NAME). */
export const COPILOT_PROPOSE_TOOL_NAME = "propose_action" as const;

/**
 * The zod RAW SHAPE for the tool's input — model-facing ergonomics only (see the header: NOT the gate). It
 * mirrors `CopilotProposeIntent` loosely so the model gets a helpful schema; the worker re-validates strictly.
 */
export const PROPOSE_INPUT_SHAPE = {
  targetSystem: z.string().describe("The connected external system, e.g. 'todoist' | 'calendar' | 'linear'."),
  operation: z.string().describe("The write operation label, e.g. 'todoist.create_task'."),
  identity: z.record(z.string()).describe("The target object's identifying fields, e.g. { title }."),
  payload: z.record(z.unknown()).describe("The write content the owner will review and approve."),
} as const;

/** Linear slice 5b.3b — the Copilot's own Linear filing tool, surfaced as `mcp__copilot__propose_linear_issue`. */
export const COPILOT_PROPOSE_LINEAR_TOOL_NAME = "propose_linear_issue" as const;

/**
 * The zod RAW SHAPE for `propose_linear_issue` — model-facing ergonomics only (NOT the gate: the worker's strict parse
 * refuses any key outside these six and re-validates every value). The model supplies CONTENT, never a key or an id.
 */
export const PROPOSE_LINEAR_INPUT_SHAPE = {
  title: z.string().describe("The issue title — one line."),
  description: z.string().describe("The issue description (Markdown)."),
  team: z.string().optional().describe("The team EXACTLY as the owner named it. Omit it if they named none: the tool then lists the team names."),
  assignee: z.string().optional().describe("The person the owner named (name or email). Omit it to assign the owner."),
  priority: z.number().int().optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low — ONLY if the owner stated it."),
  dueDate: z.string().optional().describe("YYYY-MM-DD — ONLY if the owner stated a due date."),
} as const;

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotProposeTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** The worker handler's result shape (readonly) — matches the worker's CopilotProposeToolResult. */
export interface CopilotProposeHandlerResult {
  readonly content: ReadonlyArray<CopilotProposeTextBlock>;
  readonly isError?: boolean;
}

/**
 * The injected worker-side handler, typed STRUCTURALLY (args as `unknown`) so providers ↛ worker. The concrete
 * handler is the worker's `handleCopilotProposeToolCall` closed over the server-bound {workspaceId, sink}
 * (supplied in C5.3c). It is fail-safe (never throws) + redaction-safe by its own contract.
 */
export type CopilotProposeToolHandler = (args: unknown) => Promise<CopilotProposeHandlerResult>;

/** Map the worker's readonly handler result to a fresh, mutable SDK `CallToolResult`. */
export function toCallToolResult(
  r: CopilotProposeHandlerResult,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const content = r.content.map((b) => ({ type: "text" as const, text: b.text }));
  return r.isError === true ? { content, isError: true } : { content };
}

/**
 * Build the `propose_action` SDK tool definition over the injected handler. The SDK parses the args against
 * `PROPOSE_INPUT_SHAPE`, but we forward them to the worker handler as `unknown` (the worker re-validates
 * strictly — the shape is not the gate). The handler's result is mapped to a `CallToolResult`.
 */
export function buildCopilotProposeToolDefinition(
  handler: CopilotProposeToolHandler,
): SdkMcpToolDefinition<typeof PROPOSE_INPUT_SHAPE> {
  return tool(
    COPILOT_PROPOSE_TOOL_NAME,
    [
      "Propose an external write (e.g. create a task, calendar event, or doc) for the owner's approval.",
      "This NEVER performs the write directly — it records a PENDING approval the owner must approve first.",
      "Use this only when the owner explicitly asked you to act on the answer.",
    ].join(" "),
    PROPOSE_INPUT_SHAPE,
    async (args: unknown): Promise<ReturnType<typeof toCallToolResult>> =>
      toCallToolResult(await handler(args)),
  );
}

/**
 * Build the `propose_linear_issue` SDK tool definition over the injected handler (Linear slice 5b.3b). Like
 * `propose_action`, the args go to the worker handler as `unknown` — the shape is not the gate.
 */
export function buildCopilotLinearProposeToolDefinition(
  handler: CopilotProposeToolHandler,
): SdkMcpToolDefinition<typeof PROPOSE_LINEAR_INPUT_SHAPE> {
  return tool(
    COPILOT_PROPOSE_LINEAR_TOOL_NAME,
    [
      "Propose ONE Linear issue for the owner's approval. This NEVER creates the issue — it records a PENDING card the owner must approve first.",
      "Use it only when the owner explicitly asked you to file an issue.",
      "Set `team` only to the team the owner named; if they named none, call without it — the answer lists the team names; suggest one and ask the owner to confirm or pick another.",
      "Set `assignee` only to the person the owner named (by default the owner is assigned).",
      "Set `priority` and `dueDate` only if the owner stated them — never guess.",
    ].join(" "),
    PROPOSE_LINEAR_INPUT_SHAPE,
    async (args: unknown): Promise<ReturnType<typeof toCallToolResult>> => toCallToolResult(await handler(args)),
  );
}

/**
 * Construct the in-process MCP server exposing `mcp__copilot__propose_action` — and, when a Linear handler is supplied
 * (slice 5b.3b), `mcp__copilot__propose_linear_issue` beside it — delegating to the injected handlers. The returned
 * `McpSdkServerConfigWithInstance` drops into the runner's `mcpServers` map (the transport's `mcpServers` type already
 * admits the sdk-instance variant).
 */
export function createCopilotProposeMcpServer(
  handler: CopilotProposeToolHandler,
  linearHandler?: CopilotProposeToolHandler,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: COPILOT_MCP_SERVER_NAME, tools: copilotProposeToolDefinitions(handler, linearHandler) });
}

/** The tools the `copilot` propose server carries: `propose_action`, plus `propose_linear_issue` when its handler is given. */
export function copilotProposeToolDefinitions(
  handler: CopilotProposeToolHandler,
  linearHandler?: CopilotProposeToolHandler,
): Array<ReturnType<typeof buildCopilotProposeToolDefinition> | ReturnType<typeof buildCopilotLinearProposeToolDefinition>> {
  return [
    buildCopilotProposeToolDefinition(handler),
    ...(linearHandler !== undefined ? [buildCopilotLinearProposeToolDefinition(linearHandler)] : []),
  ];
}
