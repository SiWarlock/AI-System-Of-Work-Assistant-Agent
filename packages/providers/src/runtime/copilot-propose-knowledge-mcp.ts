// @sow/providers — the Claude Agent SDK in-process MCP registration for the Copilot's SEMANTIC-write
// `propose_knowledge` tool (§13.10a Slice G3). The mirror of `copilot-propose-mcp` (propose_action); it
// lives in providers because providers is the ONLY package that deps the Agent SDK (the pure DAG root
// @sow/contracts may not import it).
//
// A THIN registration wrapper. `createSdkMcpServer` + `tool()` expose the tool as
// `mcp__copilot__propose_knowledge` over a zod raw shape, and EVERY call is delegated to an INJECTED
// worker-side handler (the worker's `handleCopilotProposeKnowledgeToolCall`, bound to a server-side
// {workspaceId, sourceRef, noteExists, sink}). The handler is typed STRUCTURALLY here
// (`CopilotProposeKnowledgeToolHandler`, args-as-`unknown`) so providers keeps NO import of the worker —
// the wiring closure is supplied at construction (G4).
//
// SERVER NAME: reuses the shared `COPILOT_MCP_SERVER_NAME` ("copilot") so the surfaced tool id is
// `copilot.propose_knowledge` — the EXACT id the policy catalog (G2 `COPILOT_PROPOSE_KNOWLEDGE_TOOL`)
// declares, so the runner's `canUseTool` grant + ING-7 admission recognize it. ⚠ COMPOSITION CAVEAT: a
// single agent job wires EITHER this server OR `createCopilotProposeMcpServer` (both are named "copilot"),
// NEVER both in one `mcpServers` map — the knowledge-propose grant is DECOUPLED from the external-write
// grant (G2 `copilotKnowledgeProposeToolPolicy`), so they never co-register.
//
// ⚠ SECURITY: the zod raw shape is MODEL-FACING ERGONOMICS, NOT the gate. Containment does NOT depend on it.
// The SDK's own `z.object(shape)` parse runs BEFORE this adapter's callback and STRIPS unknown keys; the
// worker's strict `parseIntent` then REJECTS any that survive. Decisively, the note PATH and WORKSPACE are
// SERVER-DERIVED (`projectNotePath(server-bound workspaceId, projectId)`), never a model field — so a smuggled
// `workspaceId`/`path` can never retarget the write, whichever layer drops it. The shape uses non-coercing
// `z.string()` (not `z.coerce`), so a provided field is never silently transformed. This adapter forwards
// `args` to the handler as `unknown` (adding no strip/coerce of its OWN); the worker's strict
// `deriveCopilotProjectKnowledgePlan` remains the SOLE authority over the untrusted intent.
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
// Reuse the shared server name (single source of truth — do NOT re-declare/re-export it; the barrel is
// `export *` and a duplicate export would collide).
import { COPILOT_MCP_SERVER_NAME } from "./copilot-propose-mcp";

/** The SDK tool name (mirrors the worker's COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME). */
export const COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME = "propose_knowledge" as const;

/**
 * The zod RAW SHAPE for the tool's input — model-facing ergonomics only (see the header: NOT the gate). It
 * mirrors `CopilotProjectProposeIntent` loosely so the model gets a helpful schema; the worker re-derives
 * strictly (NO path/workspace/percent — those are server-derived; a smuggled key is rejected there).
 */
export const PROPOSE_KNOWLEDGE_INPUT_SHAPE = {
  projectId: z.string().describe("The project's stable id (its note-path leaf). Not a path — the path is derived."),
  title: z.string().describe("The project's display title (the note H1 + frontmatter title)."),
  lifecycleState: z.string().describe("One of: idea | planning | active | paused | done | archived."),
  summary: z.string().optional().describe("OPTIONAL candidate status prose the owner will review and approve."),
} as const;

/** One text block of a tool result (structurally compatible with the SDK's CallToolResult content). */
export interface CopilotProposeKnowledgeTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** The worker handler's result shape (readonly) — matches the worker's CopilotProposeKnowledgeToolResult. */
export interface CopilotProposeKnowledgeHandlerResult {
  readonly content: ReadonlyArray<CopilotProposeKnowledgeTextBlock>;
  readonly isError?: boolean;
}

/**
 * The injected worker-side handler, typed STRUCTURALLY (args as `unknown`) so providers ↛ worker. The
 * concrete handler is the worker's `handleCopilotProposeKnowledgeToolCall` closed over the server-bound
 * {workspaceId, sourceRef, noteExists, sink} (supplied in G4). It is fail-safe (never throws) +
 * redaction-safe by its own contract.
 */
export type CopilotProposeKnowledgeToolHandler = (args: unknown) => Promise<CopilotProposeKnowledgeHandlerResult>;

/** Map the worker's readonly handler result to a fresh, mutable SDK `CallToolResult`. */
export function toKnowledgeCallToolResult(
  r: CopilotProposeKnowledgeHandlerResult,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const content = r.content.map((b) => ({ type: "text" as const, text: b.text }));
  return r.isError === true ? { content, isError: true } : { content };
}

/**
 * Build the `propose_knowledge` SDK tool definition over the injected handler. The SDK parses the args
 * against `PROPOSE_KNOWLEDGE_INPUT_SHAPE`, but we forward them to the worker handler as `unknown` (the
 * worker re-derives strictly — the shape is not the gate). The handler's result is mapped to a `CallToolResult`.
 */
export function buildCopilotProposeKnowledgeToolDefinition(
  handler: CopilotProposeKnowledgeToolHandler,
): SdkMcpToolDefinition<typeof PROPOSE_KNOWLEDGE_INPUT_SHAPE> {
  return tool(
    COPILOT_PROPOSE_KNOWLEDGE_TOOL_NAME,
    [
      "Propose a project note (its status) for the owner's approval.",
      "This NEVER writes to the vault directly — it records a PENDING approval the owner must approve first.",
      "Supply: projectId (the project's stable id), title, lifecycleState (idea/planning/active/paused/done/archived),",
      "and an optional summary. Do NOT supply a path, workspace, or percent — those are derived.",
      "Use this only when the owner asked you to capture or update a project's status from the answer.",
    ].join(" "),
    PROPOSE_KNOWLEDGE_INPUT_SHAPE,
    async (args: unknown): Promise<ReturnType<typeof toKnowledgeCallToolResult>> =>
      toKnowledgeCallToolResult(await handler(args)),
  );
}

/**
 * Construct the in-process MCP server exposing `mcp__copilot__propose_knowledge`, delegating to the
 * injected handler. The returned `McpSdkServerConfigWithInstance` drops into the runner's `mcpServers` map
 * (G4) alongside the gbrain http/read servers (the transport's `mcpServers` type already admits the
 * sdk-instance variant). See the COMPOSITION CAVEAT in the header re: the shared "copilot" server name.
 */
export function createCopilotProposeKnowledgeMcpServer(
  handler: CopilotProposeKnowledgeToolHandler,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: COPILOT_MCP_SERVER_NAME,
    tools: [buildCopilotProposeKnowledgeToolDefinition(handler)],
  });
}
