// @sow/providers — Provider & Runtime Broker (§7). Governed two-port layer:
// AgentRuntimePort (agentic runtimes) + ModelProviderPort (raw model providers),
// converging on the shared AgentResult before the schema gate. The Broker never
// writes Markdown or an external system — provider/runtime output is candidate
// data until the gate (5.5) proves it.
//
// FULL public barrel (Synthesis). `export *` over every module; no cross-module
// name collisions (each identifier is unique across files — verified at synthesis).

// ── ports (5.1) ──────────────────────────────────────────────────────────────
export * from "./ports/agent-result";
export * from "./ports/model-provider-port";
export * from "./model/claude-subscription-completion";
export * from "./ports/agent-runtime-port";

// ── broker core (5.2 / 5.3 / 5.4 / 5.5 / 5.9) ────────────────────────────────
export * from "./broker/agent-job-machine";
export * from "./broker/broker";
export * from "./broker/egress-veto";
export * from "./broker/route-resolution";
export * from "./broker/provider-health";
export * from "./broker/model-availability";
export * from "./broker/budget-enforcer";
export * from "./broker/cost-meter";
export * from "./broker/schema-gate";
export * from "./broker/output-normalizer";

// ── redaction (§16) ──────────────────────────────────────────────────────────
export * from "./redaction/provider-log-redaction";

// ── ModelProviderPort adapters (5.7) ─────────────────────────────────────────
export * from "./model/http-transport";
export * from "./model/claude-provider";
export * from "./model/openai-provider";
export * from "./model/openrouter-provider";
export * from "./model/ollama-provider";
export * from "./model/lmstudio-provider";

// ── AgentRuntimePort adapters (5.8) ──────────────────────────────────────────
export * from "./runtime/runtime-support";
export * from "./runtime/claude-agent-sdk-runtime";
export * from "./runtime/claude-agent-sdk-transport";
export * from "./runtime/hermes-runtime";
export * from "./runtime/copilot-propose-mcp";
export * from "./runtime/copilot-propose-knowledge-mcp";
// §13.10 gate (a) SC7b: the in-process gbrain-PROXY MCP server (the WS-8 tool-path enforcement point).
export * from "./runtime/copilot-gbrain-proxy-mcp";
export * from "./runtime/copilot-vault-mcp";
export * from "./runtime/copilot-skills-mcp";
// Re-export the SDK's MCP server-config union so the worker can type its composed `mcpServers` map (which
// now mixes an http gbrain server + the in-process sdk-instance copilot server) without a direct SDK dep.
export type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
