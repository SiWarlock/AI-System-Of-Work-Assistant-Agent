// spec(§7) — Phase-C C2: the concrete ClaudeAgentTransport (the real SDK query() WITH tools — the one
// production stub the survey found). This suite pins the DETERMINISTIC + SAFETY-CRITICAL surface with a
// fake `queryFn` (no real SDK): the GOVERNED query options (tools:[] — no built-ins; settingSources:[];
// allow/deny lists; bounded turns; never bypassPermissions), the result-extraction (candidate output,
// usage, mutatingToolAttempted via permission_denials, fail-closed error folding), and the redaction-safe
// throw folding. The real SDK query() call is eval/integration-tested, not unit-tested.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  buildAgentQueryOptions,
  buildCanUseTool,
  detectForbiddenToolAttempt,
  extractAgentRawResult,
  foldAgentSdkThrow,
  createClaudeAgentSdkTransport,
} from "../src/runtime/claude-agent-sdk-transport";
import { buildClaudeAgentInvocation } from "../src/runtime/claude-agent-sdk-runtime";
import type { ClaudeAgentInvocation } from "../src/runtime/claude-agent-sdk-runtime";
import { AgentJobSchema } from "@sow/contracts";
import type { AgentJob } from "@sow/contracts";

/** A read_only Copilot AgentJob over a claude-agent-sdk RUNTIME route. */
function agentJob(over: Record<string, unknown> = {}): AgentJob {
  return AgentJobSchema.parse({
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "personal-business",
    capability: "meeting_closeout",
    contextRefs: [{ refKind: "source_envelope", ref: "src-1" }],
    outputSchemaId: "sow:knowledge-mutation-plan",
    toolPolicy: {
      mode: "read_only",
      allowedTools: ["gbrain.search", "gbrain.timeline"],
      deniedTools: ["gbrain.graph"],
      allowsMutating: false,
    },
    providerRoute: {
      runtime: "claude-agent-sdk",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    },
    trustLevel: "trusted",
    carriesRawContent: false,
    maxRuntimeSeconds: 180,
    maxCostUsd: 2.5,
    idempotencyKey: "job-1-key",
    ...over,
  });
}

function inv(over: Record<string, unknown> = {}): ClaudeAgentInvocation {
  const built = buildClaudeAgentInvocation(agentJob(over));
  if (!isOk(built)) throw new Error("fixture invocation failed to build");
  return built.value;
}

/** A minimal SDK `result` success message (only the fields C2 reads). */
function resultSuccess(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 4000,
    is_error: false,
    num_turns: 3,
    result: "the text answer",
    total_cost_usd: 0.02,
    usage: { input_tokens: 100, output_tokens: 40 },
    permission_denials: [],
    structured_output: { answer: ["grounded"], citations: [] },
    session_id: "s",
    uuid: "u",
    ...over,
  } as unknown as SDKMessage;
}

function assistantToolUse(name: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name, input: {} }] },
    parent_tool_use_id: null,
    uuid: "u2",
    session_id: "s",
  } as unknown as SDKMessage;
}

describe("buildAgentQueryOptions — the GOVERNED SDK query options (read-only enforcement lives here)", () => {
  it("sets the LOAD-BEARING guards: canUseTool (deny-by-default), explicit permissionMode, settingSources:[]", () => {
    const o = buildAgentQueryOptions({ inv: inv(), systemPrompt: "sys", controller: new AbortController() });
    expect(typeof o["canUseTool"]).toBe("function"); // the real deterministic guard
    expect(o["permissionMode"]).toBe("default"); // explicit, never bypassPermissions
    expect(o["settingSources"]).toEqual([]);
    expect(o["tools"]).toEqual([]); // belt-and-suspenders (may be ignored by the SDK)
  });
  it("passes the effective allow-list + denied list (default = the invocation's own lists)", () => {
    const o = buildAgentQueryOptions({ inv: inv(), systemPrompt: "s", controller: new AbortController() });
    expect(o["allowedTools"]).toEqual(["gbrain.search", "gbrain.timeline"]);
    expect(o["disallowedTools"]).toEqual(["gbrain.graph"]);
  });
  it("prefers explicit SDK tool-name mappings when provided (ToolId → mcp__gbrain__query etc.)", () => {
    const o = buildAgentQueryOptions({
      inv: inv(),
      systemPrompt: "s",
      allowedToolNames: ["mcp__gbrain__query"],
      disallowedToolNames: ["mcp__gbrain__graph"],
      controller: new AbortController(),
    });
    expect(o["allowedTools"]).toEqual(["mcp__gbrain__query"]);
    expect(o["disallowedTools"]).toEqual(["mcp__gbrain__graph"]);
  });
  it("bounds maxTurns (default set; clamps an absurd value)", () => {
    const def = buildAgentQueryOptions({ inv: inv(), systemPrompt: "s", controller: new AbortController() });
    expect(typeof def["maxTurns"]).toBe("number");
    expect(def["maxTurns"] as number).toBeGreaterThanOrEqual(1);
    const clamped = buildAgentQueryOptions({ inv: inv(), systemPrompt: "s", maxTurns: 9999, controller: new AbortController() });
    expect(clamped["maxTurns"] as number).toBeLessThanOrEqual(50);
  });
  it("sets outputFormat + mcpServers + maxBudgetUsd only when provided", () => {
    const bare = buildAgentQueryOptions({ inv: inv({ maxCostUsd: undefined }), systemPrompt: "s", controller: new AbortController() });
    expect(bare["outputFormat"]).toBeUndefined();
    expect(bare["mcpServers"]).toBeUndefined();
    expect(bare["maxBudgetUsd"]).toBeUndefined();
    const full = buildAgentQueryOptions({
      inv: inv(),
      systemPrompt: "s",
      outputSchema: { type: "object" },
      mcpServers: { gbrain: { type: "http", url: "http://127.0.0.1:8899/mcp" } as never },
      controller: new AbortController(),
    });
    expect(full["outputFormat"]).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(full["mcpServers"]).toEqual({ gbrain: { type: "http", url: "http://127.0.0.1:8899/mcp" } });
    expect(full["maxBudgetUsd"]).toBe(2.5);
  });
});

describe("buildCanUseTool — the deterministic deny-by-default guard (version-independent containment)", () => {
  it("ALLOWS an allow-listed tool (passing input through)", async () => {
    const can = buildCanUseTool(["mcp__gbrain__query"]);
    const r = await can("mcp__gbrain__query", { q: "x" }, {} as never);
    expect(r?.behavior).toBe("allow");
  });
  it("DENIES any non-allow-listed tool — incl. built-ins (Bash/Write) the fictional tools:[] can't stop", async () => {
    const can = buildCanUseTool(["mcp__gbrain__query"]);
    for (const t of ["Bash", "Write", "WebFetch", "mcp__gbrain__graph"]) {
      const r = await can(t, {}, {} as never);
      expect(r?.behavior).toBe("deny");
    }
  });
  it("FAIL-SAFE: an empty allow-set denies EVERYTHING (never allows-all)", async () => {
    const can = buildCanUseTool([]);
    expect((await can("anything", {}, {} as never))?.behavior).toBe("deny");
  });
});

describe("detectForbiddenToolAttempt — via the result's permission_denials (conservative superset)", () => {
  it("false when no tool was denied", () => {
    expect(detectForbiddenToolAttempt([resultSuccess()])).toBe(false);
  });
  it("true when the run denied a tool (a forbidden-tool attempt — fail-closed for read_only)", () => {
    const denied = resultSuccess({ permission_denials: [{ tool_name: "Bash" }] });
    expect(detectForbiddenToolAttempt([denied])).toBe(true);
  });
});

describe("extractAgentRawResult — SDK messages → ClaudeAgentRawResult (fail-closed)", () => {
  it("maps a success: candidateOutput (structured), usage, completed, no mutation", () => {
    const r = extractAgentRawResult([resultSuccess()], { expectStructured: true });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.status).toBe("completed");
      expect(r.value.candidateOutput).toEqual({ answer: ["grounded"], citations: [] });
      expect(r.value.usage.runtimeSeconds).toBe(4);
      expect(r.value.usage.costUsd).toBe(0.02);
      expect(r.value.mutatingToolAttempted).toBe(false);
    }
  });
  it("flags mutatingToolAttempted from permission_denials", () => {
    const r = extractAgentRawResult([resultSuccess({ permission_denials: [{ tool_name: "Write" }] })]);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.mutatingToolAttempted).toBe(true);
  });
  it("expectStructured + no structured_output → malformed (fail-closed, never fabricate)", () => {
    const r = extractAgentRawResult([resultSuccess({ structured_output: null })], { expectStructured: true });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("malformed");
  });
  it("no result message → transport (retryable)", () => {
    const r = extractAgentRawResult([assistantToolUse("mcp__gbrain__query")]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.kind).toBe("transport");
      expect(r.error.retryable).toBe(true);
    }
  });
  it("an error result subtype folds to a typed transport error", () => {
    const errMsg = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["boom"],
      duration_ms: 10,
      num_turns: 1,
      total_cost_usd: 0,
      session_id: "s",
      uuid: "u",
    } as unknown as SDKMessage;
    const r = extractAgentRawResult([errMsg]);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("transport");
  });
});

describe("foldAgentSdkThrow — redaction-safe error classification", () => {
  it("aborted → cancelled", () => {
    expect(foldAgentSdkThrow(new Error("x"), true).kind).toBe("cancelled");
  });
  it("auth-shaped → auth (terminal); SDK-absent → unavailable (retryable)", () => {
    expect(foldAgentSdkThrow(new Error("oauth login failed"), false).kind).toBe("auth");
    expect(foldAgentSdkThrow(new Error("ENOENT: spawn claude"), false).kind).toBe("unavailable");
  });
  it("unknown → transport (retryable)", () => {
    const e = foldAgentSdkThrow(new Error("weird"), false);
    expect(e.kind).toBe("transport");
    expect(e.retryable).toBe(true);
  });
});

describe("createClaudeAgentSdkTransport — the transport over an injected queryFn", () => {
  it("builds options via the promptBuilder + runs queryFn + maps the result", async () => {
    const seen: { prompt?: string; options?: Record<string, unknown> } = {};
    const transport = createClaudeAgentSdkTransport({
      promptBuilder: (i) => ({ prompt: `Q for ${i.capability}`, systemPrompt: "SYS" }),
      outputSchema: { type: "object" },
      // eslint-disable-next-line @typescript-eslint/require-await
      queryFn: async function* (args) {
        seen.prompt = args.prompt;
        seen.options = args.options;
        yield resultSuccess();
      },
    });
    const r = await transport.invoke(inv());
    expect(seen.prompt).toBe("Q for meeting_closeout");
    expect(seen.options?.["systemPrompt"]).toBe("SYS");
    expect(seen.options?.["tools"]).toEqual([]); // governed config reached the SDK
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.candidateOutput).toEqual({ answer: ["grounded"], citations: [] });
  });
  it("a thrown queryFn folds to a typed transport error (never throws across the boundary)", async () => {
    const transport = createClaudeAgentSdkTransport({
      promptBuilder: () => ({ prompt: "q", systemPrompt: "s" }),
      // eslint-disable-next-line require-yield
      queryFn: async function* () {
        throw new Error("connection reset secret-frag");
      },
    });
    const r = await transport.invoke(inv());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("transport");
  });
  it("a pre-aborted signal cancels before any query", async () => {
    let ran = false;
    const controller = new AbortController();
    controller.abort();
    const transport = createClaudeAgentSdkTransport({
      promptBuilder: () => ({ prompt: "q", systemPrompt: "s" }),
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      queryFn: async function* () {
        ran = true;
      },
    });
    const r = await transport.invoke(inv(), controller.signal);
    expect(ran).toBe(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("cancelled");
  });
});
