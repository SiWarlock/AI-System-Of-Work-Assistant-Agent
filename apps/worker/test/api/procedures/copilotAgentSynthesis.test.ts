// spec(§7 / §9.6) — Phase-C C3: createAgentRuntimeCopilotSynthesis, the AGENTIC Copilot synthesis adapter.
//
// A NEW `CopilotSynthesisPort` that drives the AgentRuntimePort (createClaudeAgentSdkRuntime + the C2
// transport) with READ TOOLS, in place of the tool-less completion client. This suite pins the
// DETERMINISTIC + SAFETY-CRITICAL surface with a FAKE runner (no real SDK / no network):
//   - the route guard + provider→runtime route mapping (BIND the veto-cleared route; never re-select);
//   - the C1 ToolId → SDK MCP tool-name mapping (a mismatch fail-safes canUseTool to deny-all);
//   - the governed prompt builder (grounded-only, cite-by-citationId, tools-available);
//   - the AgentJob build (read_only tool policy — ING-7-pure; runtime route; trusted; raw-content);
//   - the redaction-safe RuntimeError → FailureVariant fold;
//   - AgentResult.candidateOutput → CandidateCopilotAnswer via the SAME `mapCompletionToCandidate`
//     reconciliation the completion path uses (grounding preserved: hallucinated cites dropped);
//   - the synthesize orchestration over a fake runner (route guard short-circuits; runner err folds;
//     cancelled result fails closed);
//   - the real runner's WIRING (token → mcpServers → transport → runtime) with an injected token + queryFn.
// The real SDK `query()` call is eval/integration-tested, not unit-tested.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure, toolId, workspaceId, AgentJobSchema } from "@sow/contracts";
import type { AgentJob, ProviderRoute, Result, FailureVariant } from "@sow/contracts";
import { runtimeError, COPILOT_GBRAIN_PROXY_MCP_NAMES, COPILOT_VAULT_SERVER_NAME, COPILOT_VAULT_MCP_NAMES, COPILOT_SKILLS_SERVER_NAME, COPILOT_SKILLS_MCP_NAMES } from "@sow/providers";
import type { AgentResult, RuntimeError, AgentQueryFn, CopilotGbrainProxyHandler, CopilotSkillsProxyHandler, McpServerConfig } from "@sow/providers";
import {
  copilotReadToolIds,
  copilotReadOnlyPolicyIsPure,
  copilotReadToolPolicy,
  copilotAgentToolPolicy,
} from "@sow/policy";
import type { CopilotWorkspaceScope, WorkspaceScopeRegistry, LegacyContentPolicy } from "@sow/policy";
import type { CopilotGbrainToolExec } from "../../../src/api/procedures/copilotGbrainProxy";
import {
  copilotToolToMcpName,
  copilotReadToolMcpNames,
  copilotGbrainReadToolMcpNames,
  admitCopilotAgentJob,
  resolveCopilotAgentCapability,
  type CopilotContentTrust,
  type CopilotAgentCapability,
  DEFAULT_COPILOT_AGENT_MAX_COST_USD,
  GBRAIN_MCP_SERVER_NAME,
  gbrainMcpEndpoint,
  buildGbrainMcpServers,
  toClaudeAgentRuntimeRoute,
  buildCopilotAgentJob,
  foldRuntimeError,
  mapAgentResultToCandidate,
  buildCopilotAgentPrompt,
  COPILOT_AGENT_SYSTEM_PROMPT,
  createAgentRuntimeCopilotSynthesis,
  createClaudeAgentCopilotRunner,
  deriveCopilotContentTrust,
  COPILOT_PROPOSE_MCP_TOOL_NAME,
  type CopilotAgentRunner,
  type CopilotPromptContext,
} from "../../../src/api/procedures/copilotAgentSynthesis";
import { buildCopilotDeps } from "../../../src/api/procedures/copilotClaudeSynthesis";
import type { RetrievedContext } from "../../../src/api/procedures/copilot";

// ── fixtures ────────────────────────────────────────────────────────────────
const CLAUDE_ROUTE: ProviderRoute = {
  provider: "claude",
  model: "claude-sonnet-5",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};
const RUNTIME_ROUTE: ProviderRoute = {
  runtime: "claude-agent-sdk",
  model: "claude-sonnet-5",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};

function ctx(over: Partial<RetrievedContext> = {}): RetrievedContext {
  return {
    workspaceId: "personal-business",
    blocks: ["A meeting note about the Q3 launch.", "A second passage."],
    sources: [
      { citationId: "gbrain:sessions:028", title: "Session 028" },
      { citationId: "gbrain:sessions:029", title: "Session 029" },
    ],
    ...over,
  };
}

/** A queryFn that captures the args it received and yields ONE canned SDK `result` success message. */
function captureQueryFn(structured: unknown): {
  fn: AgentQueryFn;
  seen: () => { prompt: string; options: Record<string, unknown> } | undefined;
} {
  let captured: { prompt: string; options: Record<string, unknown> } | undefined;
  const fn = ((args: { prompt: string; options: Record<string, unknown> }) => {
    captured = args;
    async function* gen(): AsyncIterable<unknown> {
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        num_turns: 2,
        result: "grounded text",
        total_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 40 },
        permission_denials: [],
        structured_output: structured,
        session_id: "s",
        uuid: "u",
      };
    }
    return gen();
  }) as unknown as AgentQueryFn;
  return { fn, seen: () => captured };
}

// ── copilotToolToMcpName / copilotReadToolMcpNames ────────────────────────────
describe("copilotToolToMcpName — C1 ToolId → SDK MCP tool name (mcp__<server>__<tool>)", () => {
  it("maps gbrain.search to the PROVEN gbrain MCP tool name mcp__gbrain__query", () => {
    const byName = new Map(copilotReadToolIds().map((t) => [String(t), copilotToolToMcpName(t)]));
    expect(byName.get("gbrain.search")).toBe("mcp__gbrain__query");
  });
  it("maps other gbrain ops identity-on-the-op-name under the gbrain server", () => {
    const byName = new Map(copilotReadToolIds().map((t) => [String(t), copilotToolToMcpName(t)]));
    expect(byName.get("gbrain.traverse_graph")).toBe("mcp__gbrain__traverse_graph");
    expect(byName.get("gbrain.get_timeline")).toBe("mcp__gbrain__get_timeline");
    expect(byName.get("gbrain.find_contradictions")).toBe("mcp__gbrain__find_contradictions");
  });
  it("gate (d) phantom cleanup: no phantom MCP names survive into the runner allow-list", () => {
    // the pre-cleanup ids graph/timeline/schema_read/health/contained_synthesis mapped to MCP tool names
    // that do NOT exist on the live `gbrain serve --http` surface (v0.35.1) — dead allow-list entries.
    const names = copilotGbrainReadToolMcpNames();
    for (const phantom of [
      "mcp__gbrain__graph",
      "mcp__gbrain__timeline",
      "mcp__gbrain__schema_read",
      "mcp__gbrain__health",
      "mcp__gbrain__contained_synthesis",
    ]) {
      expect(names).not.toContain(phantom);
    }
  });
  it("maps vault.read under the vault server", () => {
    const byName = new Map(copilotReadToolIds().map((t) => [String(t), copilotToolToMcpName(t)]));
    expect(byName.get("vault.read")).toBe("mcp__vault__read");
  });
});

describe("copilotReadToolMcpNames — the read-only Copilot agent's SDK allow-list", () => {
  it("maps the WHOLE read catalog and contains NO dotted (unmapped) names", () => {
    const names = copilotReadToolMcpNames();
    expect(names).toHaveLength(copilotReadToolIds().length);
    expect(names).toContain("mcp__gbrain__query");
    expect(names.every((n) => n.startsWith("mcp__") && !n.includes("."))).toBe(true);
  });
});

describe("copilotGbrainReadToolMcpNames — the gbrain-backed subset the runner allow-lists", () => {
  it("keeps only the gbrain-served tools and EXCLUDES vault.read (no vault MCP server wired)", () => {
    const names = copilotGbrainReadToolMcpNames();
    expect(names).toContain("mcp__gbrain__query");
    expect(names.every((n) => n.startsWith("mcp__gbrain__"))).toBe(true);
    expect(names).not.toContain("mcp__vault__read");
    // strictly fewer than the full catalog (vault.read dropped).
    expect(names.length).toBeLessThan(copilotReadToolMcpNames().length);
  });

  it("Tier-1 §13.10: contains the analysis tools (find_contradictions/anomalies/orphans) by IDENTITY name", () => {
    const names = copilotGbrainReadToolMcpNames();
    expect(names).toContain("mcp__gbrain__find_contradictions");
    expect(names).toContain("mcp__gbrain__find_anomalies");
    expect(names).toContain("mcp__gbrain__find_orphans");
  });

  it("Tier-1 §13.10: contains the expertise / takes / code-intel reads (identity map), NOT the cache-clear op", () => {
    const names = copilotGbrainReadToolMcpNames();
    expect(names).toContain("mcp__gbrain__find_experts");
    expect(names).toContain("mcp__gbrain__takes_list");
    expect(names).toContain("mcp__gbrain__takes_scorecard");
    expect(names).toContain("mcp__gbrain__code_def");
    expect(names).toContain("mcp__gbrain__code_callers");
    expect(names).toContain("mcp__gbrain__code_flow");
    expect(names).toContain("mcp__gbrain__get_recent_salience");
    // the destructive cache-clear op + the local-only transcripts op are uncataloged ⇒ never allow-listed.
    expect(names).not.toContain("mcp__gbrain__code_traversal_cache_clear");
    expect(names).not.toContain("mcp__gbrain__get_recent_transcripts");
  });
});

describe("copilotToolToMcpName — FAIL-SAFE on a malformed ToolId (never collides with an allow-listed name)", () => {
  it("a dotless id maps deterministically and does not alias any gbrain tool", () => {
    const mapped = copilotToolToMcpName(toolId("weird"));
    expect(mapped).toBe("mcp__weird__");
    expect(copilotGbrainReadToolMcpNames()).not.toContain(mapped);
  });
  it("a multi-dot id keeps the trailing segment (still distinct from mcp__gbrain__query)", () => {
    expect(copilotToolToMcpName(toolId("a.b.c"))).toBe("mcp__a__b.c");
  });
});

// ── gbrainMcpEndpoint / buildGbrainMcpServers ─────────────────────────────────
describe("gbrainMcpEndpoint — the MCP endpoint under a serve base URL", () => {
  it("appends /mcp and tolerates a trailing slash", () => {
    expect(gbrainMcpEndpoint("http://127.0.0.1:8899")).toBe("http://127.0.0.1:8899/mcp");
    expect(gbrainMcpEndpoint("http://127.0.0.1:8899/")).toBe("http://127.0.0.1:8899/mcp");
  });
});

describe("buildGbrainMcpServers — the SDK http MCP server config for gbrain", () => {
  it("keys by the gbrain server name with an http transport + Bearer header", () => {
    const servers = buildGbrainMcpServers("http://127.0.0.1:8899/mcp", "tok-123");
    const g = servers[GBRAIN_MCP_SERVER_NAME] as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(g.type).toBe("http");
    expect(g.url).toBe("http://127.0.0.1:8899/mcp");
    expect(g.headers.Authorization).toBe("Bearer tok-123");
  });
});

// ── toClaudeAgentRuntimeRoute ─────────────────────────────────────────────────
describe("toClaudeAgentRuntimeRoute — BIND the veto-cleared route; never re-select", () => {
  it("maps a claude PROVIDER route to a claude-agent-sdk RUNTIME route, preserving model/endpoint/egress", () => {
    const r = toClaudeAgentRuntimeRoute(CLAUDE_ROUTE);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toEqual(RUNTIME_ROUTE);
  });
  it("binds the PASSED route's model/endpoint (does not substitute a default)", () => {
    const custom: ProviderRoute = { ...CLAUDE_ROUTE, model: "claude-opus-4-8", endpoint: "https://alt.example" };
    const r = toClaudeAgentRuntimeRoute(custom);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toMatchObject({ model: "claude-opus-4-8", endpoint: "https://alt.example" });
  });
  it("fails CLOSED for a non-claude provider route (defense-in-depth over the egress veto)", () => {
    const ollama: ProviderRoute = {
      provider: "ollama",
      model: "llama3.1",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    };
    const r = toClaudeAgentRuntimeRoute(ollama);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_ROUTE_NOT_CLAUDE");
  });
  it("fails CLOSED for a route that is already a runtime route (not a provider route)", () => {
    const r = toClaudeAgentRuntimeRoute(RUNTIME_ROUTE);
    expect(isErr(r)).toBe(true);
  });
});

// ── buildCopilotAgentJob ──────────────────────────────────────────────────────
describe("buildCopilotAgentJob — a schema-valid, ING-7-pure read_only Copilot AgentJob (default)", () => {
  const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE);
  it("is a schema-valid AgentJob", () => {
    expect(AgentJobSchema.safeParse(job).success).toBe(true);
  });
  it("carries the read_only tool policy over the read catalog (no mutating tool; ING-7-pure)", () => {
    expect(job.toolPolicy.mode).toBe("read_only");
    expect(job.toolPolicy.allowsMutating).toBe(false);
    expect([...job.toolPolicy.allowedTools].map(String).sort()).toEqual(
      copilotReadToolIds().map(String).sort(),
    );
    expect(copilotReadOnlyPolicyIsPure(job.toolPolicy)).toBe(true);
  });
  it("is content-derived UNTRUSTED (read-only agent consumes potentially-untrusted brain content), raw-content, copilot capability, scoped", () => {
    expect(job.providerRoute).toEqual(RUNTIME_ROUTE);
    expect(job.trustLevel).toBe("untrusted");
    expect(job.carriesRawContent).toBe(true);
    expect(job.capability).toBe("copilot.answer");
    expect(job.workspaceId).toBe("personal-business");
  });
  it("sets a server-side cost cap (so buildAgentQueryOptions emits maxBudgetUsd)", () => {
    expect(job.maxCostUsd).toBe(DEFAULT_COPILOT_AGENT_MAX_COST_USD);
  });
});

// ── content-derived trust + capability (C5.1 — the propose-tool prerequisite) ────
describe("resolveCopilotAgentCapability — fail-closed: propose ONLY on affirmed-trusted content", () => {
  const cases: ReadonlyArray<[CopilotContentTrust, boolean, CopilotAgentCapability]> = [
    ["trusted", true, "propose"],
    ["trusted", false, "read_only"],
    ["untrusted", true, "read_only"], // untrusted content NEVER gets propose, even when enabled
    ["untrusted", false, "read_only"],
  ];
  it.each(cases)("contentTrust=%s proposeEnabled=%s ⇒ %s", (contentTrust, proposeEnabled, expected) => {
    expect(resolveCopilotAgentCapability({ contentTrust, proposeEnabled })).toBe(expected);
  });
});

describe("buildCopilotAgentJob — the propose capability (trusted + scoped_write over the C1 agent catalog)", () => {
  const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE, {
    contentTrust: "trusted",
    proposeEnabled: true,
  });
  it("is schema-valid, scoped_write, and TRUSTED (only ever built for affirmed-trusted content)", () => {
    expect(AgentJobSchema.safeParse(job).success).toBe(true);
    expect(job.toolPolicy.mode).toBe("scoped_write");
    expect(job.toolPolicy.allowsMutating).toBe(true);
    expect(job.trustLevel).toBe("trusted");
  });
  it("carries the write-proposing tool (copilot.propose_action) in its allow-list", () => {
    expect([...job.toolPolicy.allowedTools].map(String)).toContain("copilot.propose_action");
  });
  it("still ADMITS through the C4 ING-7 gate (trusted may hold a scoped_write policy)", () => {
    expect(isOk(admitCopilotAgentJob(job))).toBe(true);
  });
});

describe("buildCopilotAgentJob — the resolver is the ONLY funnel to a propose job (no inconsistent shape)", () => {
  it("CANNOT build an untrusted propose job: {contentTrust:untrusted, proposeEnabled:true} ⇒ read_only + untrusted", () => {
    const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE, {
      contentTrust: "untrusted",
      proposeEnabled: true,
    });
    expect(job.toolPolicy.mode).toBe("read_only");
    expect(job.trustLevel).toBe("untrusted");
    expect([...job.toolPolicy.allowedTools].map(String)).not.toContain("copilot.propose_action");
  });
  it("propose DISABLED on trusted content ⇒ read_only + untrusted", () => {
    const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE, {
      contentTrust: "trusted",
      proposeEnabled: false,
    });
    expect(job.toolPolicy.mode).toBe("read_only");
    expect(job.trustLevel).toBe("untrusted");
  });
});

// ── admitCopilotAgentJob (C4 — ING-7 admission; activates the C1 catalog) ────
describe("admitCopilotAgentJob — the ING-7 gate + the read_only-purity clause (activates C1)", () => {
  /** A read_only policy that is Zod-valid (allowsMutating:false) but SECRETLY lists the mutating propose tool. */
  const impureReadOnly = {
    mode: "read_only" as const,
    allowedTools: [...copilotReadToolPolicy().allowedTools, toolId("copilot.propose_action")],
    deniedTools: [],
    allowsMutating: false,
  };

  it("ADMITS the default (untrusted read_only) Copilot job, returning the job unchanged", () => {
    const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE);
    const r = admitCopilotAgentJob(job);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toBe(job); // pass-through identity on the allow path
  });

  it("REJECTS an UNTRUSTED job that declares a mutating (scoped_write) tool policy (ING-7 hard denial)", () => {
    const job: AgentJob = {
      ...buildCopilotAgentJob("personal-business", RUNTIME_ROUTE),
      trustLevel: "untrusted",
      toolPolicy: copilotAgentToolPolicy(), // scoped_write + the propose tool
    };
    const r = admitCopilotAgentJob(job);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
  });

  it("REJECTS a TRUSTED read_only policy that secretly lists a mutating tool (via the purity check)", () => {
    // A trusted job short-circuits admitJob's trust check, so step 1 ADMITS — copilotReadOnlyPolicyIsPure
    // (step 2) is what rejects it. (trustLevel is set EXPLICITLY here — the default job is now untrusted.)
    const job: AgentJob = {
      ...buildCopilotAgentJob("personal-business", RUNTIME_ROUTE),
      trustLevel: "trusted",
      toolPolicy: impureReadOnly,
    };
    const r = admitCopilotAgentJob(job);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_READONLY_POLICY_IMPURE");
  });

  it("REJECTS an UNTRUSTED read_only policy that secretly lists a mutating tool (the load-bearing ING-7 case)", () => {
    // The load-bearing case: admitsMutating's read_only EARLY-RETURN blinds admitJob EVEN for untrusted content
    // (the trust check never gets to fire), so ONLY copilotReadOnlyPolicyIsPure catches the smuggled tool.
    const job: AgentJob = {
      ...buildCopilotAgentJob("personal-business", RUNTIME_ROUTE),
      trustLevel: "untrusted",
      toolPolicy: impureReadOnly,
    };
    const r = admitCopilotAgentJob(job);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_READONLY_POLICY_IMPURE");
  });

  it("REJECTS a read_only policy listing an UNKNOWN tool (pins the fail-safe unknown⇒mutating end-to-end)", () => {
    const unknownTool = {
      mode: "read_only" as const,
      allowedTools: [...copilotReadToolPolicy().allowedTools, toolId("gbrain.unknown_future_op")],
      deniedTools: [],
      allowsMutating: false,
    };
    const job: AgentJob = { ...buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), toolPolicy: unknownTool };
    const r = admitCopilotAgentJob(job);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_READONLY_POLICY_IMPURE");
  });

  it("REJECTS an internally INCONSISTENT tool policy (read_only + allowsMutating:true) — defense-in-depth", () => {
    const inconsistent = {
      mode: "read_only" as const,
      allowedTools: [...copilotReadToolPolicy().allowedTools],
      deniedTools: [],
      allowsMutating: true, // violates read_only ⇒ !allowsMutating
    };
    const job: AgentJob = { ...buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), toolPolicy: inconsistent };
    const r = admitCopilotAgentJob(job);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_TOOLPOLICY_INCONSISTENT");
  });
});

// ── foldRuntimeError ──────────────────────────────────────────────────────────
describe("foldRuntimeError — redaction-safe RuntimeError → FailureVariant", () => {
  const cases: ReadonlyArray<[RuntimeError["kind"], FailureVariant["kind"], string]> = [
    ["invalid_job", "validation_rejected", "COPILOT_AGENT_INVALID_JOB"],
    ["auth_unavailable", "provider_failed", "COPILOT_AGENT_AUTH"],
    ["runtime_unavailable", "provider_failed", "COPILOT_AGENT_UNAVAILABLE"],
    ["tool_policy_violation", "validation_rejected", "COPILOT_AGENT_TOOL_VIOLATION"],
    ["transport_error", "provider_failed", "COPILOT_AGENT_TRANSPORT"],
    ["timeout", "provider_failed", "COPILOT_AGENT_TIMEOUT"],
    ["cancelled", "provider_failed", "COPILOT_AGENT_CANCELLED"],
    ["malformed_output", "schema_rejected", "COPILOT_AGENT_MALFORMED"],
  ];
  it.each(cases)("maps %s → kind %s / code %s", (kind, vkind, code) => {
    const v = foldRuntimeError(runtimeError(kind, "raw SDK detail that MUST NOT leak", { retryable: true }));
    expect(v.kind).toBe(vkind);
    expect(v.cause?.code).toBe(code);
    expect(v.retryable).toBe(true);
    // Redaction: the SDK-origin message must not survive into the variant.
    expect(v.message).not.toContain("raw SDK detail");
  });
});

// ── buildCopilotAgentPrompt ───────────────────────────────────────────────────
describe("buildCopilotAgentPrompt — the governed agentic prompt", () => {
  it("tags citable passages by citationId and carries the question in the user prompt", () => {
    const { prompt, systemPrompt } = buildCopilotAgentPrompt("What shipped in session 28?", ctx());
    expect(prompt).toContain("What shipped in session 28?");
    expect(prompt).toContain("[gbrain:sessions:028]");
    expect(systemPrompt).toBe(COPILOT_AGENT_SYSTEM_PROMPT);
  });
  it("emits the no-context marker for an empty retrieval (the model then refuses per the system prompt)", () => {
    const { prompt } = buildCopilotAgentPrompt("q", ctx({ blocks: [], sources: [] }));
    expect(prompt.toLowerCase()).toContain("no context");
  });
  it("the system prompt states the grounding + no-invention contract", () => {
    expect(COPILOT_AGENT_SYSTEM_PROMPT.toLowerCase()).toContain("cite");
    expect(COPILOT_AGENT_SYSTEM_PROMPT.toLowerCase()).toMatch(/invent|assume|infer/);
  });
});

// ── mapAgentResultToCandidate ─────────────────────────────────────────────────
function completed(candidateOutput: unknown): AgentResult {
  return { status: "completed", candidateOutput, usage: { runtimeSeconds: 1 }, logs: [] };
}

describe("mapAgentResultToCandidate — reuse the grounding reconciliation of the completion path", () => {
  it("reconciles citations against the retrieved set (drops a hallucinated citationId; authoritative title wins)", () => {
    const out = {
      answer: ["The Q3 launch shipped."],
      citations: [
        { citationId: "gbrain:sessions:028", title: "MODEL-ECHOED WRONG TITLE" },
        { citationId: "gbrain:hallucinated", title: "Not retrieved" },
      ],
    };
    const r = mapAgentResultToCandidate(completed(out), ctx());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.citations).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
  });
  it("fails CLOSED (schema_rejected) on a malformed candidateOutput", () => {
    const r = mapAgentResultToCandidate(completed({ nope: true }), ctx());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.kind).toBe("schema_rejected");
  });
  it("fails CLOSED on a cancelled result (no committable output)", () => {
    const cancelled: AgentResult = { status: "cancelled", candidateOutput: null, usage: { runtimeSeconds: 1 }, logs: [] };
    const r = mapAgentResultToCandidate(cancelled, ctx());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_AGENT_CANCELLED");
  });
});

// ── createAgentRuntimeCopilotSynthesis (over a FAKE runner) ───────────────────
function fakeRunner(
  impl: (job: AgentJob, prompt: CopilotPromptContext) => Result<AgentResult, RuntimeError>,
): { runner: CopilotAgentRunner; calls: () => number; lastJob: () => AgentJob | undefined; lastPrompt: () => CopilotPromptContext | undefined } {
  let n = 0;
  let job: AgentJob | undefined;
  let prompt: CopilotPromptContext | undefined;
  const runner: CopilotAgentRunner = {
    run: async (j, p) => {
      n += 1;
      job = j;
      prompt = p;
      return impl(j, p);
    },
  };
  return { runner, calls: () => n, lastJob: () => job, lastPrompt: () => prompt };
}

describe("createAgentRuntimeCopilotSynthesis — the agentic CopilotSynthesisPort", () => {
  it("builds a read_only runtime-route job, runs the runner with the prompt context, maps the reconciled answer", async () => {
    const out = { answer: ["ok"], citations: [{ citationId: "gbrain:sessions:028", title: "x" }] };
    const f = fakeRunner(() => ok(completed(out)));
    const synth = createAgentRuntimeCopilotSynthesis(f.runner);
    const r = await synth.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.citations).toEqual([{ citationId: "gbrain:sessions:028", title: "Session 028" }]);
    // the job the runner saw is a read_only runtime-route Copilot job; the prompt ctx is threaded verbatim.
    expect(f.lastJob()?.providerRoute).toEqual(RUNTIME_ROUTE);
    expect(f.lastJob()?.toolPolicy.mode).toBe("read_only");
    expect(f.lastPrompt()).toEqual({ question: "q?", context: ctx() });
  });
  it("C5.3 AND-term: proposeEnabled:true but the fail-closed trust interim ⇒ the job stays read_only (flag alone never grants propose)", async () => {
    const f = fakeRunner(() => ok(completed({ answer: ["ok"], citations: [] })));
    // proposeEnabled ON, but the DEFAULT resolveContentTrust (deriveCopilotContentTrust ⇒ untrusted) gates it.
    const synth = createAgentRuntimeCopilotSynthesis(f.runner, { proposeEnabled: true });
    await synth.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    expect(f.lastJob()?.toolPolicy.mode).toBe("read_only");
    expect(f.lastJob()?.trustLevel).toBe("untrusted");
  });
  it("C5.4 end-to-end: proposeEnabled + an ALL-KnowledgeWriter context ⇒ the built job IS trusted+scoped_write (propose-capable)", async () => {
    const f = fakeRunner(() => ok(completed({ answer: ["ok"], citations: [] })));
    const synth = createAgentRuntimeCopilotSynthesis(f.runner, { proposeEnabled: true });
    const trustedCtx = ctx({
      sources: [{ citationId: "gbrain:a", title: "A", provenance: "knowledge_writer" }],
    });
    await synth.synthesize("personal-business", "q?", trustedCtx, CLAUDE_ROUTE);
    expect(f.lastJob()?.trustLevel).toBe("trusted");
    expect(f.lastJob()?.toolPolicy.mode).toBe("scoped_write");
  });
  it("route guard SHORT-CIRCUITS before the runner (a non-claude route never reaches the agent)", async () => {
    const f = fakeRunner(() => ok(completed({ answer: ["x"], citations: [] })));
    const synth = createAgentRuntimeCopilotSynthesis(f.runner);
    const bad: ProviderRoute = { provider: "openai", model: "gpt", endpoint: "https://api.openai.com", egressClass: "cloud" };
    const r = await synth.synthesize("personal-business", "q?", ctx(), bad);
    expect(isErr(r)).toBe(true);
    expect(f.calls()).toBe(0);
  });
  it("folds a runner RuntimeError to a typed FailureVariant", async () => {
    const f = fakeRunner(() => err(runtimeError("tool_policy_violation", "reached for a forbidden tool")));
    const synth = createAgentRuntimeCopilotSynthesis(f.runner);
    const r = await synth.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_AGENT_TOOL_VIOLATION");
  });
});

// ── createClaudeAgentCopilotRunner (token → mcpServers → transport → runtime) ──
describe("createClaudeAgentCopilotRunner — the real runner's WIRING (injected token + queryFn)", () => {
  const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE);
  const foreignJob = buildCopilotAgentJob("personal-life", RUNTIME_ROUTE);
  const prompt: CopilotPromptContext = { question: "q?", context: ctx() };

  it("mints a token, builds the gbrain MCP server + read allow-list, and returns the SDK's structured output", async () => {
    const structured = { answer: ["grounded"], citations: [{ citationId: "gbrain:sessions:028", title: "x" }] };
    const cap = captureQueryFn(structured);
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
    });
    const r = await runner.run(job, prompt);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.candidateOutput).toEqual(structured);
    expect(tokenCalls).toBe(1);
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, { headers: Record<string, string> }>;
    expect(servers[GBRAIN_MCP_SERVER_NAME]?.headers.Authorization).toBe("Bearer tok-abc");
    expect(opts["allowedTools"]).toContain("mcp__gbrain__query");
    // Tier-1 §13.10: the analysis tools auto-flow from the catalog into the served allow-list via the BOOT
    // DEFAULT (no explicit `allowedToolNames` here) — if boot ever passes one, this regresses (the catalog
    // add would silently stop reaching the runner grant → admitted-but-unreachable).
    expect(opts["allowedTools"]).toContain("mcp__gbrain__find_contradictions");
    expect(opts["allowedTools"]).toContain("mcp__gbrain__find_anomalies");
    expect(opts["allowedTools"]).toContain("mcp__gbrain__find_orphans");
    // deny-by-default containment is present (the load-bearing guard from C2)
    expect(typeof opts["canUseTool"]).toBe("function");
  });

  it("WS-8: a NON-served workspace runs TOOL-LESS (no token, no gbrain server, deny-all allow-list)", async () => {
    const cap = captureQueryFn({ answer: ["from context only"], citations: [] });
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business", // the ask is for personal-life ≠ served
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
    });
    const r = await runner.run(foreignJob, prompt);
    expect(isOk(r)).toBe(true);
    expect(tokenCalls).toBe(0); // never mints a token for a foreign workspace
    const opts = cap.seen()?.options ?? {};
    expect(opts["mcpServers"]).toBeUndefined(); // no gbrain server exposed
    expect(opts["allowedTools"]).toEqual([]); // deny-all — the agent can call no tool
  });

  it("fails CLOSED with an AUTH failure (no SDK call) when the served workspace's token cannot be minted", async () => {
    const cap = captureQueryFn({ answer: ["x"], citations: [] });
    let queried = false;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => err(failure("provider_failed", "token mint failed", { cause: { code: "X" } })),
      queryFn: ((args: unknown) => {
        queried = true;
        return cap.fn(args as never);
      }) as unknown as AgentQueryFn,
    });
    const r = await runner.run(job, prompt);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // the runner returns a raw RuntimeError; the synthesis layer folds auth_unavailable → COPILOT_AGENT_AUTH.
    expect(r.error.kind).toBe("auth_unavailable");
    expect(queried).toBe(false);
  });
});

// ── SC8b (§13.10 gate a) — the runner wires the in-process gbrain PROXY (WS-8), replacing the raw http server ──
describe("createClaudeAgentCopilotRunner — SC8 gbrain PROXY wiring (WS-8)", () => {
  const job = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE);
  const prompt: CopilotPromptContext = { question: "q?", context: ctx() };
  const SCOPE: CopilotWorkspaceScope = {
    servedWorkspaceId: workspaceId("personal-business"),
    registry: {
      descriptors: [
        { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
        { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
      ],
    },
    policy: { mode: "assign", toWorkspaceId: workspaceId("personal-business") },
  };

  /** A spy proxy-server factory: captures the bound handler + returns a marker sdk-server config (no http headers). */
  function spyProxyServer(): { build: (h: CopilotGbrainProxyHandler) => McpServerConfig; marker: McpServerConfig; handler: () => CopilotGbrainProxyHandler | undefined } {
    let captured: CopilotGbrainProxyHandler | undefined;
    const marker = { type: "sdk", name: "gbrain", instance: {} } as unknown as McpServerConfig;
    return {
      build: (h) => {
        captured = h;
        return marker;
      },
      marker,
      handler: () => captured,
    };
  }

  it("wires the PROXY under the gbrain key (replacing raw http), mints NO token, and uses the scoped proxy allow-list", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const srv = spyProxyServer();
    let tokenCalls = 0;
    const exec: CopilotGbrainToolExec = async () => ok({ content: [{ type: "text", text: "[]" }] });
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
      gbrainProxyScope: SCOPE,
      gbrainProxyExec: exec,
      buildGbrainProxyMcpServer: srv.build,
    });
    const r = await runner.run(job, prompt);
    expect(isOk(r)).toBe(true);
    expect(tokenCalls).toBe(0); // the proxy exec mints its own per call — the runner does NOT
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, { headers?: Record<string, string> }>;
    // MAP-KEY CONTRACT: the gbrain key holds the PROXY marker, NOT a raw http {headers:{Authorization}} server
    expect(servers[GBRAIN_MCP_SERVER_NAME]).toBe(srv.marker);
    expect(servers[GBRAIN_MCP_SERVER_NAME]?.headers).toBeUndefined(); // no raw http entry under the key
    // the allow-list is EXACTLY the scoped proxy set (query IN; the unscopable find_anomalies OUT)
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES]);
    expect(opts["allowedTools"]).toContain("mcp__gbrain__query");
    expect(opts["allowedTools"]).not.toContain("mcp__gbrain__find_anomalies");
    expect(typeof srv.handler()).toBe("function"); // a handler was bound to the proxy
  });

  it("the bound handler is SCOPED: a scope-widening arg is denied by SC5a (the exec is never called)", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const srv = spyProxyServer();
    let execCalls = 0;
    const exec: CopilotGbrainToolExec = async () => {
      execCalls += 1;
      return ok({ content: [{ type: "text", text: "[]" }] });
    };
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok-abc"),
      queryFn: cap.fn,
      gbrainProxyScope: SCOPE,
      gbrainProxyExec: exec,
      buildGbrainProxyMcpServer: srv.build,
    });
    await runner.run(job, prompt);
    const handler = srv.handler();
    expect(handler).toBeDefined();
    const out = await handler!("mcp__gbrain__query", { query: "q", all_sources: true }); // widening → SC5a deny
    expect(execCalls).toBe(0); // denied before any read — proves SC5a/SC5b are bound to the served scope
    expect(out.content[0]?.text).toBe("[]"); // leak-safe empty
  });

  it("a PARTIAL proxy config (scope set, factory missing) FAILS CLOSED — never the unscoped raw http path", async () => {
    const cap = captureQueryFn({ answer: ["x"], citations: [] });
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
      gbrainProxyScope: SCOPE,
      gbrainProxyExec: async () => ok({ content: [] }),
      // buildGbrainProxyMcpServer MISSING → partial config
    });
    const r = await runner.run(job, prompt);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_job");
    expect(tokenCalls).toBe(0); // never fell back to the raw http (token) path
  });

  it("the OTHER partial permutation (exec missing, factory present) ALSO fails closed", async () => {
    const cap = captureQueryFn({ answer: ["x"], citations: [] });
    const srv = spyProxyServer();
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
      gbrainProxyScope: SCOPE,
      buildGbrainProxyMcpServer: srv.build,
      // gbrainProxyExec MISSING → the other half of the OR guard
    });
    const r = await runner.run(job, prompt);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_job");
    expect(tokenCalls).toBe(0);
    expect(srv.handler()).toBeUndefined(); // the factory was never invoked
  });
});

// ── Option A (single-brain, MULTI-SERVED) — the runner's per-ASK proxy scope (gbrainProxyScopeFor) ──────
//
// Under multi-served, the fixed `servedWorkspaceId` gate is replaced by a per-ask resolver: ANY workspace the
// resolver returns a scope for is SERVED (its ask gets the scoped gbrain proxy, bound to ITS OWN scope); an
// unregistered one (resolver → undefined) runs TOOL-LESS. So a workspace OTHER than the boot-fixed served id
// now reaches the brain — scoped to itself. WS-8 holds via the per-ask scope (proven by driving the bound
// handler: a foreign hit is dropped for the asked workspace).
describe("createClaudeAgentCopilotRunner — Option A multi-served proxy scope (gbrainProxyScopeFor)", () => {
  const REGISTRY: WorkspaceScopeRegistry = {
    descriptors: [
      { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
      { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
      { workspaceId: workspaceId("personal-life"), slugPrefixes: ["personal-life"] },
    ],
  };
  const POLICY: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };
  /** The boot-shaped resolver: a REGISTERED workspace → its own scope (bound to ITSELF); else undefined. */
  const scopeFor = (ws: string): CopilotWorkspaceScope | undefined => {
    const d = REGISTRY.descriptors.find((x) => String(x.workspaceId) === ws);
    return d === undefined ? undefined : { servedWorkspaceId: d.workspaceId, registry: REGISTRY, policy: POLICY };
  };
  const prompt: CopilotPromptContext = { question: "q?", context: ctx() };

  function spyProxyServer(): { build: (h: CopilotGbrainProxyHandler) => McpServerConfig; marker: McpServerConfig; handler: () => CopilotGbrainProxyHandler | undefined } {
    let captured: CopilotGbrainProxyHandler | undefined;
    const marker = { type: "sdk", name: "gbrain", instance: {} } as unknown as McpServerConfig;
    return { build: (h) => { captured = h; return marker; }, marker, handler: () => captured };
  }

  it("a REGISTERED workspace ≠ the fixed served id is served AND scoped to ITSELF (per-ask, not the boot-fixed scope)", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const srv = spyProxyServer();
    let tokenCalls = 0;
    // The exec returns a combined-brain envelope holding BOTH a personal-life and a personal-business hit; the
    // per-ask redaction (bound to personal-life) must keep only personal-life — proving the scope is the ASKED
    // workspace's, not the boot-fixed personal-business.
    const rawHits = [
      { slug: "personal-life/goals", chunk_text: "PL", title: "PL", source_id: "default" },
      { slug: "personal-business/notes", chunk_text: "PB", title: "PB", source_id: "default" },
    ];
    const exec: CopilotGbrainToolExec = async () => ok({ content: [{ type: "text", text: JSON.stringify(rawHits) }] });
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business", // the boot-fixed served id — the resolver OVERRIDES it per ask
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => { tokenCalls += 1; return ok("tok-abc"); },
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: exec,
      buildGbrainProxyMcpServer: srv.build,
    });
    const r = await runner.run(buildCopilotAgentJob("personal-life", RUNTIME_ROUTE), prompt);
    expect(isOk(r)).toBe(true);
    expect(tokenCalls).toBe(0); // the proxy exec mints its own; the runner does NOT
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, { headers?: Record<string, string> }>;
    expect(servers[GBRAIN_MCP_SERVER_NAME]).toBe(srv.marker); // proxy under the gbrain key (not raw http)
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES]);
    // Drive the bound handler: the redaction is scoped to personal-life (the ASKED ws) — the personal-business
    // hit is FOREIGN and dropped; only the personal-life hit survives.
    const handler = srv.handler();
    expect(handler).toBeDefined();
    const out = await handler!("mcp__gbrain__query", { query: "q" });
    const survived = JSON.parse(out.content[0]!.text) as Array<{ slug: string }>;
    expect(survived.map((h) => h.slug)).toEqual(["personal-life/goals"]); // scoped to personal-life, NOT personal-business
  });

  it("an UNREGISTERED workspace (resolver → undefined) runs TOOL-LESS — no server, deny-all, no token", async () => {
    const cap = captureQueryFn({ answer: ["from context only"], citations: [] });
    const srv = spyProxyServer();
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => { tokenCalls += 1; return ok("tok-abc"); },
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: async () => ok({ content: [{ type: "text", text: "[]" }] }),
      buildGbrainProxyMcpServer: srv.build,
    });
    const r = await runner.run(buildCopilotAgentJob("marketing-team", RUNTIME_ROUTE), prompt); // not registered
    expect(isOk(r)).toBe(true);
    expect(tokenCalls).toBe(0);
    const opts = cap.seen()?.options ?? {};
    expect(opts["mcpServers"]).toBeUndefined(); // no gbrain server
    expect(opts["allowedTools"]).toEqual([]); // deny-all
    expect(srv.handler()).toBeUndefined(); // no proxy handler bound
  });

  it("multi-served + a PARTIAL config (resolver returns a scope, exec missing) FAILS CLOSED (invalid_job)", async () => {
    const cap = captureQueryFn({ answer: ["x"], citations: [] });
    const srv = spyProxyServer();
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => { tokenCalls += 1; return ok("tok-abc"); },
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      buildGbrainProxyMcpServer: srv.build,
      // gbrainProxyExec MISSING → partial config on the multi-served path
    });
    const r = await runner.run(buildCopilotAgentJob("personal-life", RUNTIME_ROUTE), prompt);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("invalid_job");
    expect(tokenCalls).toBe(0); // never fell back to the raw http (token) path
  });
});

// ── §13.10d — the runner ALSO exposes the read-only VAULT (vault.read) bound to the per-ask scope ──────────
describe("createClaudeAgentCopilotRunner — vault.read wiring (§13.10d, additive to the gbrain proxy)", () => {
  const REGISTRY: WorkspaceScopeRegistry = {
    descriptors: [
      { workspaceId: workspaceId("employer-work"), slugPrefixes: ["employer-work"] },
      { workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] },
    ],
  };
  const POLICY: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };
  const scopeFor = (ws: string): CopilotWorkspaceScope | undefined => {
    const d = REGISTRY.descriptors.find((x) => String(x.workspaceId) === ws);
    return d === undefined ? undefined : { servedWorkspaceId: d.workspaceId, registry: REGISTRY, policy: POLICY };
  };
  const prompt: CopilotPromptContext = { question: "q?", context: ctx() };
  const spyProxyServer = (): { build: (h: unknown) => McpServerConfig; marker: McpServerConfig } => {
    const marker = { type: "sdk", name: "gbrain", instance: {} } as unknown as McpServerConfig;
    return { build: () => marker, marker };
  };
  function spyVaultServer(): { build: (h: (a: unknown) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }> }>) => McpServerConfig; marker: McpServerConfig; handler: () => ((a: unknown) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }> }>) | undefined } {
    let captured: ((a: unknown) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }> }>) | undefined;
    const marker = { type: "sdk", name: "vault", instance: {} } as unknown as McpServerConfig;
    return { build: (h) => { captured = h; return marker; }, marker, handler: () => captured };
  }
  const gbrainExec: CopilotGbrainToolExec = async () => ok({ content: [{ type: "text", text: "[]" }] });

  it("with ALL vault deps: registers mcp__vault__read under the 'vault' key (coexisting with gbrain) + scopes reads to the asked workspace", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const proxy = spyProxyServer();
    const vault = spyVaultServer();
    const files: Record<string, string> = { "/vault/personal-business/notes/x.md": "PB body", "/vault/employer-work/secret.md": "EW body" };
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok"),
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: gbrainExec,
      buildGbrainProxyMcpServer: proxy.build,
      buildVaultMcpServer: vault.build,
      vaultReadFile: async (abs) => (abs in files ? ok(files[abs]!) : err(runtimeErrorFault())),
      vaultRealpath: async (p) => ok(p), // identity (no symlinks) — the handler's symlink-safe layer
      vaultRoot: "/vault",
    });
    const r = await runner.run(buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), prompt);
    expect(isOk(r)).toBe(true);
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, unknown>;
    expect(servers[COPILOT_VAULT_SERVER_NAME]).toBe(vault.marker); // vault registered under its own key
    expect(servers["gbrain"]).toBe(proxy.marker); // gbrain still there (coexist)
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES, ...COPILOT_VAULT_MCP_NAMES]);
    // the bound vault handler is scoped to personal-business: reads its own note, DENIES the employer note.
    const h = vault.handler();
    expect(h).toBeDefined();
    expect((await h!({ path: "personal-business/notes/x" })).content[0]!.text).toBe("PB body");
    expect((await h!({ path: "employer-work/secret" })).content[0]!.text).toBe(""); // foreign ⇒ denied
  });

  it("PARTIAL vault config (factory present, vaultRoot missing) SKIPS vault (fail-closed on the capability; gbrain still works)", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const proxy = spyProxyServer();
    const vault = spyVaultServer();
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok"),
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: gbrainExec,
      buildGbrainProxyMcpServer: proxy.build,
      buildVaultMcpServer: vault.build,
      vaultReadFile: async () => ok("x"),
      // vaultRoot MISSING ⇒ partial
    });
    const r = await runner.run(buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), prompt);
    expect(isOk(r)).toBe(true);
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, unknown>;
    expect(servers[COPILOT_VAULT_SERVER_NAME]).toBeUndefined(); // vault NOT exposed on partial
    expect(vault.handler()).toBeUndefined();
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES]); // gbrain only
  });
});

function runtimeErrorFault(): import("@sow/contracts").FailureVariant {
  return failure("degraded_unavailable", "not found", { retryable: false, cause: { code: "VAULT_READ_ENOENT" } });
}

// ── §13.10d — the runner ALSO exposes read-only SKILL self-introspection (workspace-agnostic; no scope) ──────
describe("createClaudeAgentCopilotRunner — skill introspection wiring (§13.10d, additive to gbrain + vault)", () => {
  const REGISTRY: WorkspaceScopeRegistry = {
    descriptors: [{ workspaceId: workspaceId("personal-business"), slugPrefixes: ["personal-business"] }],
  };
  const POLICY: LegacyContentPolicy = { mode: "assign", toWorkspaceId: workspaceId("personal-business") };
  const scopeFor = (ws: string): CopilotWorkspaceScope | undefined => {
    const d = REGISTRY.descriptors.find((x) => String(x.workspaceId) === ws);
    return d === undefined ? undefined : { servedWorkspaceId: d.workspaceId, registry: REGISTRY, policy: POLICY };
  };
  const prompt: CopilotPromptContext = { question: "q?", context: ctx() };
  const spyProxyServer = (): { build: (h: unknown) => McpServerConfig; marker: McpServerConfig } => {
    const marker = { type: "sdk", name: "gbrain", instance: {} } as unknown as McpServerConfig;
    return { build: () => marker, marker };
  };
  const gbrainExec: CopilotGbrainToolExec = async () => ok({ content: [{ type: "text", text: "[]" }] });
  type SkillsHandler = (op: string, a: unknown) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }> }>;
  function spySkillsServer(): { build: (h: SkillsHandler) => McpServerConfig; marker: McpServerConfig; handler: () => SkillsHandler | undefined } {
    let captured: SkillsHandler | undefined;
    const marker = { type: "sdk", name: "skills", instance: {} } as unknown as McpServerConfig;
    return { build: (h) => { captured = h; return marker; }, marker, handler: () => captured };
  }

  it("with buildSkillsMcpServer: registers mcp__skills__list + mcp__skills__get under the 'skills' key (coexisting) and the bound handler lists skills WITHOUT the propose tool", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const proxy = spyProxyServer();
    const skills = spySkillsServer();
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok"),
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: gbrainExec,
      buildGbrainProxyMcpServer: proxy.build,
      buildSkillsMcpServer: skills.build,
    });
    const r = await runner.run(buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), prompt);
    expect(isOk(r)).toBe(true);
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, unknown>;
    expect(servers[COPILOT_SKILLS_SERVER_NAME]).toBe(skills.marker); // skills registered under its own key
    expect(servers["gbrain"]).toBe(proxy.marker); // gbrain still there (coexist)
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES, ...COPILOT_SKILLS_MCP_NAMES]);
    // the runner binds the REAL handleCopilotSkillIntrospect: list enumerates the read catalog, get hides propose.
    const h = skills.handler();
    expect(h).toBeDefined();
    const listed = JSON.parse((await h!("list", {})).content[0]!.text) as { skills: Array<{ id: string }> };
    expect(listed.skills.map((s) => s.id)).toContain("gbrain.search");
    expect(listed.skills.map((s) => s.id)).not.toContain("copilot.propose_action");
    const got = JSON.parse((await h!("get", { id: "copilot.propose_action" })).content[0]!.text) as { skill: unknown };
    expect(got.skill).toBeNull(); // never revealed via get either
  });

  it("without buildSkillsMcpServer: skills NOT exposed (gbrain-only allow-list)", async () => {
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const proxy = spyProxyServer();
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok"),
      queryFn: cap.fn,
      gbrainProxyScopeFor: scopeFor,
      gbrainProxyExec: gbrainExec,
      buildGbrainProxyMcpServer: proxy.build,
      // buildSkillsMcpServer omitted
    });
    const r = await runner.run(buildCopilotAgentJob("personal-business", RUNTIME_ROUTE), prompt);
    expect(isOk(r)).toBe(true);
    const opts = cap.seen()?.options ?? {};
    const servers = opts["mcpServers"] as Record<string, unknown>;
    expect(servers[COPILOT_SKILLS_SERVER_NAME]).toBeUndefined(); // skills NOT exposed
    expect(opts["allowedTools"]).toEqual([...COPILOT_GBRAIN_PROXY_MCP_NAMES]); // gbrain only
  });
});

// ── C5.3c: content-trust fail-closed interim + the runner's propose grant ──
describe("deriveCopilotContentTrust — per-source provenance, fail-closed", () => {
  it("'trusted' IFF non-empty AND every source is knowledge_writer", () => {
    const trusted = ctx({
      sources: [
        { citationId: "gbrain:a", title: "A", provenance: "knowledge_writer" },
        { citationId: "gbrain:b", title: "B", provenance: "knowledge_writer" },
      ],
    });
    expect(deriveCopilotContentTrust(trusted)).toBe("trusted");
  });
  it("'untrusted' if ANY source is imported/unknown/absent (a single untrusted passage taints the whole)", () => {
    const mixed = ctx({
      sources: [
        { citationId: "gbrain:a", title: "A", provenance: "knowledge_writer" },
        { citationId: "gbrain:b", title: "B", provenance: "imported" },
      ],
    });
    expect(deriveCopilotContentTrust(mixed)).toBe("untrusted");
    const bare = ctx({ sources: [{ citationId: "gbrain:a", title: "A" }] }); // no provenance ⇒ untrusted
    expect(deriveCopilotContentTrust(bare)).toBe("untrusted");
  });
  it("'untrusted' on an empty retrieval (nothing to trust)", () => {
    expect(deriveCopilotContentTrust(ctx({ blocks: [], sources: [] }))).toBe("untrusted");
  });
  it("today's un-provenanced live ctx() ⇒ untrusted (propose stays OFF until real KW provenance is plumbed)", () => {
    expect(deriveCopilotContentTrust(ctx())).toBe("untrusted");
  });
});

describe("createClaudeAgentCopilotRunner — the C5.3 propose grant (defense-in-depth)", () => {
  const proposeJob = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE, {
    contentTrust: "trusted",
    proposeEnabled: true,
  });
  const readOnlyJob = buildCopilotAgentJob("personal-business", RUNTIME_ROUTE);
  const prompt: CopilotPromptContext = { question: "act on it", context: ctx() };

  type FakeHandler = (a: unknown) => Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; isError?: boolean }>;
  /** A fake propose-MCP-server factory returning an sdk-instance-shaped config + capturing the bound handler. */
  function fakeProposeServer(): {
    build: (h: FakeHandler) => { type: "sdk"; name: string; instance: never };
    handler: () => FakeHandler | undefined;
  } {
    let captured: FakeHandler | undefined;
    return {
      build: (h) => {
        captured = h;
        return { type: "sdk", name: "copilot", instance: {} as never };
      },
      handler: () => captured,
    };
  }
  const noopSink = { record: async () => ok({ approvalRef: "appr-1", created: true }) };

  function runnerWith(over: Record<string, unknown>) {
    return createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok-abc"),
      queryFn: captureQueryFn({ answer: ["ok"], citations: [] }).fn,
      ...over,
    });
  }

  it("GRANTS propose SEED-ONLY: the propose tool + copilot server, but NO gbrain read tools/server (TOCTOU-safe)", async () => {
    const srv = fakeProposeServer();
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    let tokenCalls = 0;
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => {
        tokenCalls += 1;
        return ok("tok-abc");
      },
      queryFn: cap.fn,
      proposeSink: noopSink,
      buildProposeMcpServer: srv.build,
    });
    const r = await runner.run(proposeJob, prompt);
    expect(isOk(r)).toBe(true);
    const opts = cap.seen()?.options ?? {};
    // propose tool present; gbrain read tools STRIPPED (seed-only surface bounds the tool-reachable content).
    expect(opts["allowedTools"]).toContain(COPILOT_PROPOSE_MCP_TOOL_NAME);
    expect(opts["allowedTools"]).not.toContain("mcp__gbrain__query");
    // Tier-1 §13.10: the analysis tools are stripped too (C5.4a build-time-trust TOCTOU closure holds as the
    // read surface grows — a propose job's tool-reachable surface stays == the pre-verified seed).
    expect(opts["allowedTools"]).not.toContain("mcp__gbrain__find_contradictions");
    expect(opts["allowedTools"]).not.toContain("mcp__gbrain__find_anomalies");
    expect(opts["allowedTools"]).not.toContain("mcp__gbrain__find_orphans");
    const servers = opts["mcpServers"] as Record<string, { type?: string }>;
    expect(servers["copilot"]?.type).toBe("sdk");
    expect(servers[GBRAIN_MCP_SERVER_NAME]).toBeUndefined(); // no gbrain server on a propose job
    expect(tokenCalls).toBe(0); // no gbrain token minted for a seed-only propose job
  });

  it("a SERVED read_only job gets NO propose tool + NO copilot server (default path byte-identical)", async () => {
    const srv = fakeProposeServer();
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok-abc"),
      queryFn: cap.fn,
      proposeSink: noopSink,
      buildProposeMcpServer: srv.build,
    });
    await runner.run(readOnlyJob, prompt);
    const opts = cap.seen()?.options ?? {};
    expect(opts["allowedTools"]).not.toContain(COPILOT_PROPOSE_MCP_TOOL_NAME);
    expect((opts["mcpServers"] as Record<string, unknown>)["copilot"]).toBeUndefined();
  });

  it("a trusted+scoped_write job but proposeSink UNDEFINED ⇒ propose NOT granted (fail-closed)", async () => {
    const srv = fakeProposeServer();
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok-abc"),
      queryFn: cap.fn,
      buildProposeMcpServer: srv.build, // sink missing
    });
    await runner.run(proposeJob, prompt);
    const opts = cap.seen()?.options ?? {};
    expect(opts["allowedTools"]).not.toContain(COPILOT_PROPOSE_MCP_TOOL_NAME);
  });

  it("a trusted+scoped_write job for a NON-served workspace ⇒ tool-less, no propose", async () => {
    const foreignProposeJob = buildCopilotAgentJob("personal-life", RUNTIME_ROUTE, {
      contentTrust: "trusted",
      proposeEnabled: true,
    });
    const srv = fakeProposeServer();
    const cap = captureQueryFn({ answer: ["ok"], citations: [] });
    const runner = createClaudeAgentCopilotRunner({
      servedWorkspaceId: "personal-business",
      gbrainMcpUrl: "http://127.0.0.1:8899/mcp",
      getToken: async () => ok("tok-abc"),
      queryFn: cap.fn,
      proposeSink: noopSink,
      buildProposeMcpServer: srv.build,
    });
    await runner.run(foreignProposeJob, prompt);
    const opts = cap.seen()?.options ?? {};
    expect(opts["allowedTools"]).toEqual([]); // deny-all
    expect(opts["mcpServers"]).toBeUndefined();
  });

  it("binds the handler to the SERVER-BOUND job.workspaceId (a model-supplied workspace can't reach the sink)", async () => {
    const srv = fakeProposeServer();
    let sinkWorkspace: string | undefined;
    const spySink = {
      record: async (input: { workspaceId: string }) => {
        sinkWorkspace = String(input.workspaceId);
        return ok({ approvalRef: "appr-1", created: true });
      },
    };
    const runner = runnerWith({ proposeSink: spySink, buildProposeMcpServer: srv.build });
    await runner.run(proposeJob, prompt);
    const handler = srv.handler();
    expect(handler).toBeDefined();
    // The model supplies ONLY the intent (targetSystem/operation/identity/payload); workspace is NOT an intent
    // field — it's the server-bound closure value. Invoke with valid args and assert the sink saw job.workspaceId.
    await handler?.({
      targetSystem: "todoist",
      operation: "todoist.create_task",
      identity: { title: "x" },
      payload: {},
    });
    expect(sinkWorkspace).toBe("personal-business"); // bound from job.workspaceId, never the model
  });
});

// ── buildCopilotDeps — an injected agentSynthesis factory (a flipped ternary can't ship silently) ──
describe("buildCopilotDeps — an injected agentSynthesis factory swaps in the agent-runtime synthesis", () => {
  const baseCompletion = () =>
    ({ complete: async () => ok({ structuredOutput: { answer: ["stub"], citations: [] } }) }) as never;

  it("routes synthesis through the injected agent synthesis when realCopilot + agentSynthesis are present", async () => {
    let ran = false;
    const runner: CopilotAgentRunner = {
      run: async () => {
        ran = true;
        return ok(completed({ answer: ["from agent"], citations: [] }));
      },
    };
    const deps = buildCopilotDeps({
      realCopilot: true,
      agentSynthesis: () => createAgentRuntimeCopilotSynthesis(runner),
      workspaces: [{ id: "personal-business", type: "personal_business" }],
      completion: baseCompletion,
    });
    const r = await deps.synthesis.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    expect(isOk(r)).toBe(true);
    expect(ran).toBe(true);
  });

  it("uses the completion path when NO agentSynthesis is injected (the default real path is unchanged)", async () => {
    const deps = buildCopilotDeps({
      realCopilot: true,
      workspaces: [{ id: "personal-business", type: "personal_business" }],
      completion: baseCompletion,
    });
    const r = await deps.synthesis.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    // the completion stub answers; the agent path was never constructed.
    expect(isOk(r)).toBe(true);
  });

  it("does NOT invoke the agentSynthesis factory when realCopilot is OFF (stub wins; nothing is constructed)", async () => {
    let factoryCalls = 0;
    const deps = buildCopilotDeps({
      realCopilot: false,
      agentSynthesis: () => {
        factoryCalls += 1;
        return createAgentRuntimeCopilotSynthesis({ run: async () => ok(completed({ answer: ["x"], citations: [] })) });
      },
      workspaces: [{ id: "personal-business", type: "personal_business" }],
      completion: baseCompletion,
    });
    // the stub answers "nothing found yet" over the empty fixture; the agent factory is never even called.
    const r = await deps.synthesis.synthesize("personal-business", "q?", ctx(), CLAUDE_ROUTE);
    expect(isOk(r)).toBe(true);
    expect(factoryCalls).toBe(0);
  });
});
