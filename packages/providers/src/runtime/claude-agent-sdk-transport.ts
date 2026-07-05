// @sow/providers — the concrete ClaudeAgentTransport (§7 / Phase-C C2, RT-1 / REQ-I-002).
//
// The real Claude Agent SDK `query()` boundary for the AgentRuntimePort — the one production stub the
// P4-C survey found (only `SpyTransport` existed). It runs a TOOL-ENABLED, multi-turn agent, but under a
// GOVERNED config: NO built-in tools (`tools: []` — the SDK availability knob; LESSONS §1), no project
// settings (`settingSources: []`), an explicit allow/deny tool list, never `bypassPermissions`, and MCP
// tool sources supplied by the caller (the gbrain `serve --http` endpoint is the natural one). It emits
// ONLY a candidate `ClaudeAgentRawResult` — never a direct write (the strict side-effect rule); the
// adapter (`createClaudeAgentSdkRuntime`) maps a `mutatingToolAttempted` under a read_only policy to a
// typed `tool_policy_violation`. NEVER throws across the boundary (§16).
//
// Split for TDD: the GOVERNED option-building (`buildAgentQueryOptions` — where the read-only enforcement
// lives), the result extraction (`extractAgentRawResult`), the mutation-attempt detection
// (`detectMutatingToolAttempt` via the result's `permission_denials`), and the redaction-safe throw folding
// (`foldAgentSdkThrow`) are all PURE + unit-tested with fabricated messages. The real `query()` call is
// eval/integration-tested (it spawns the Claude Code CLI), not unit-tested. `queryFn` is INJECTABLE so the
// collection loop is testable too.
import type {
  SDKMessage,
  SDKResultMessage,
  McpServerConfig,
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  ClaudeAgentInvocation,
  ClaudeAgentRawResult,
  ClaudeAgentTransport,
  ClaudeAgentTransportError,
  ClaudeAgentTransportErrorKind,
} from "./claude-agent-sdk-runtime";

/** Default + hard cap on agentic turns — bounds an unbounded tool loop (COST-1-adjacent). */
const DEFAULT_MAX_TURNS = 8;
const MAX_TURNS_CAP = 50;

function txError(
  kind: ClaudeAgentTransportErrorKind,
  message: string,
  retryable?: boolean,
): ClaudeAgentTransportError {
  return retryable === undefined ? { kind, message } : { kind, message, retryable };
}

/** Params for the governed SDK query options. */
export interface AgentQueryOptionsParams {
  readonly inv: ClaudeAgentInvocation;
  readonly systemPrompt: string;
  /** JSON Schema for `outputFormat` (structured output). Omit for a free-text agent. */
  readonly outputSchema?: Record<string, unknown>;
  /** MCP tool sources (e.g. the gbrain `serve --http` endpoint). */
  readonly mcpServers?: Record<string, McpServerConfig>;
  /** SDK auto-approve tool names (ToolId→SDK-name mapping). Defaults to the invocation's own allow-list. */
  readonly allowedToolNames?: readonly string[];
  /** SDK blocked tool names. Defaults to the invocation's own denied-list. */
  readonly disallowedToolNames?: readonly string[];
  readonly maxTurns?: number;
  readonly betas?: readonly string[];
  readonly controller: AbortController;
}

/**
 * PURE: a `canUseTool` callback that DENIES any tool NOT in `allowedNames` — the DETERMINISTIC,
 * SDK-version-INDEPENDENT containment. It does NOT rely on the SDK's default permission behavior (which is
 * undocumented for the headless no-callback case and could loosen across versions): an unrecognized tool
 * name is denied outright, so a built-in (Bash/Write/WebFetch/…) or any un-allow-listed tool cannot run,
 * regardless of what `tools`/`allowedTools` do. Fail-safe: an EMPTY or mismatched allow-set denies
 * EVERYTHING (deny-all), never allows-all.
 */
export function buildCanUseTool(allowedNames: readonly string[]): CanUseTool {
  const allowed = new Set<string>(allowedNames);
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> =>
    allowed.has(toolName)
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: `tool ${toolName} is not in the governed allow-list` };
}

/**
 * PURE: build the GOVERNED Claude Agent SDK `query()` options from an invocation. This is where the
 * read-only / tool governance is enforced in the SDK config. The LOAD-BEARING guard is `canUseTool` (below)
 * — it denies any tool not in the allow-list DETERMINISTICALLY, independent of SDK defaults:
 *   - `canUseTool` — deny-by-default over `allowedTools` (the REAL containment; a built-in cannot run);
 *   - `permissionMode: 'default'` — set EXPLICITLY (never rely on the default; NEVER 'bypassPermissions');
 *   - `settingSources: []` — never load a project CLAUDE.md (untrusted-config / prompt-injection vector);
 *   - `allowedTools` — the SDK auto-approve list (so allowed tools don't prompt); `disallowedTools` — belt;
 *   - `tools: []` — a belt-and-suspenders availability hint (the sibling client's idiom). NOTE: this key
 *     may be IGNORED by the SDK `query()` options (it is NOT the documented restriction knob — do not rely
 *     on it; `canUseTool` is the guarantee);
 *   - `maxTurns` bounded (default 8, hard cap 50) — no unbounded tool loop;
 *   - `outputFormat`/`mcpServers`/`maxBudgetUsd`/`betas` only when provided.
 */
export function buildAgentQueryOptions(p: AgentQueryOptionsParams): Record<string, unknown> {
  const turns = Math.max(1, Math.min(p.maxTurns ?? DEFAULT_MAX_TURNS, MAX_TURNS_CAP));
  const allowedNames = [...(p.allowedToolNames ?? p.inv.allowedTools)];
  return {
    model: p.inv.model,
    systemPrompt: p.systemPrompt,
    tools: [], // belt-and-suspenders only — MAY be ignored; canUseTool is the real guard
    allowedTools: allowedNames,
    disallowedTools: [...(p.disallowedToolNames ?? p.inv.deniedTools)],
    settingSources: [], // do NOT load project settings/CLAUDE.md
    permissionMode: "default", // explicit — never lean on the SDK default; never bypassPermissions
    canUseTool: buildCanUseTool(allowedNames), // DETERMINISTIC deny-by-default (the load-bearing guard)
    maxTurns: turns,
    abortController: p.controller,
    ...(p.outputSchema !== undefined
      ? { outputFormat: { type: "json_schema", schema: p.outputSchema } }
      : {}),
    ...(p.mcpServers !== undefined ? { mcpServers: p.mcpServers } : {}),
    ...(p.inv.maxCostUsd !== undefined ? { maxBudgetUsd: p.inv.maxCostUsd } : {}),
    ...(p.betas !== undefined ? { betas: [...p.betas] } : {}),
  };
}

/**
 * PURE: did the run DENY a tool? A `permission_denial` means the agent tried a tool the governed
 * `canUseTool` refused. This is a SUPERSET of "attempted a mutating tool" — it also fires on a denied
 * *read* tool (e.g. a `deniedTools` entry) — so it is a CONSERVATIVE, fail-closed signal: for a read_only
 * job the adapter maps it to `tool_policy_violation` (a read_only agent that reached for a forbidden tool
 * fails the job). It does NOT (and cannot, from denials alone) prove the reverse — an ALLOW-LISTED mutating
 * tool that RAN yields no denial. The real no-mutation GUARANTEE therefore lives UPSTREAM: the read_only
 * allow-list carries only non-mutating tools (the C1 catalog + admission) and `canUseTool` denies the rest.
 * (A future defense-in-depth pass could also scan executed `tool_use` names — noted, not needed for the
 * guarantee.) The field is named `mutatingToolAttempted` by the ClaudeAgentRawResult contract.
 */
export function detectForbiddenToolAttempt(messages: readonly SDKMessage[]): boolean {
  for (const m of messages) {
    if (m.type === "result" && m.subtype === "success") {
      const denials = (m as { permission_denials?: unknown }).permission_denials;
      if (Array.isArray(denials) && denials.length > 0) return true;
    }
  }
  return false;
}

/** Read the token/cost/runtime meter off a success result (best-effort; runtimeSeconds always set). */
function usageOf(result: SDKResultMessage & { subtype: "success" }): ClaudeAgentRawResult["usage"] {
  const u = (result.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
  return {
    runtimeSeconds: result.duration_ms / 1000,
    costUsd: result.total_cost_usd,
    ...(typeof u.input_tokens === "number" ? { inputTokens: u.input_tokens } : {}),
    ...(typeof u.output_tokens === "number" ? { outputTokens: u.output_tokens } : {}),
  };
}

/**
 * PURE: fold the collected SDK message stream into a `ClaudeAgentRawResult` or a typed transport error.
 * The single `type:'result'` message carries the outcome. FAIL-CLOSED: no result → transport (retryable);
 * a success that expected structured output but produced none → malformed (never fabricate a candidate).
 * `mutatingToolAttempted` comes from `permission_denials`. Error subtypes map onto transport-error kinds.
 */
export function extractAgentRawResult(
  messages: readonly SDKMessage[],
  opts?: { readonly expectStructured?: boolean },
): Result<ClaudeAgentRawResult, ClaudeAgentTransportError> {
  const result = messages.find((m): m is SDKResultMessage => m.type === "result");
  if (result === undefined) {
    return err(txError("transport", "no result message from the SDK", true));
  }
  if (result.subtype === "success") {
    const structured = result.structured_output;
    if (opts?.expectStructured === true && structured == null) {
      return err(txError("malformed", "SDK returned no structured_output"));
    }
    // Prefer structured output; fall back to the free-text `result`. Both empty ⇒ fail-closed.
    const candidateOutput: unknown = structured != null ? structured : result.result;
    if (candidateOutput == null || (typeof candidateOutput === "string" && candidateOutput.length === 0)) {
      return err(txError("malformed", "SDK success produced no output"));
    }
    return ok({
      status: "completed",
      candidateOutput,
      usage: usageOf(result),
      mutatingToolAttempted: detectForbiddenToolAttempt(messages),
    });
  }
  // An error result subtype. NOTE (redaction, §16): `errors[]` is SDK-origin and MAY carry prompt/content
  // fragments — the consumer MUST route `error.message` through the §16 redactor before ANY log sink (same
  // contract as `foldAgentSdkThrow` + the sibling completion client).
  const errs = (result as { errors?: readonly string[] }).errors ?? [];
  const message = errs.length > 0 ? errs.join("; ") : result.subtype;
  switch (result.subtype) {
    case "error_max_turns":
    case "error_max_structured_output_retries":
      return err(txError("malformed", message));
    case "error_max_budget_usd":
      // No dedicated 'budget' transport kind — a cost cap is terminal, not retryable.
      return err(txError("transport", message, false));
    case "error_during_execution":
    default:
      return err(txError("transport", message, true));
  }
}

/**
 * PURE: classify a THROWN SDK error into a typed transport error. `aborted` (the controller fired) →
 * cancelled. NOTE (redaction, §16): the message is SDK-origin and MAY carry prompt/content fragments — the
 * consumer MUST route `error.message` through the §16 redactor before ANY log sink (same contract as the
 * subscription completion client).
 */
export function foldAgentSdkThrow(e: unknown, aborted: boolean): ClaudeAgentTransportError {
  if (aborted) return txError("cancelled", "agent run cancelled", false);
  const msg = e instanceof Error ? e.message : String(e);
  if (/auth|login|oauth|unauthor/i.test(msg)) return txError("auth", msg, false);
  if (/timeout|timed out|etimedout/i.test(msg)) return txError("timeout", msg, false);
  if (/enoent|spawn|not found|unavailable|econnrefused|unreachable/i.test(msg)) {
    return txError("unavailable", msg, true);
  }
  return txError("transport", msg, true);
}

/** The injectable SDK `query()` shape (a subset). Default lazily imports the real SDK. */
export type AgentQueryFn = (args: {
  readonly prompt: string;
  readonly options: Record<string, unknown>;
}) => AsyncIterable<SDKMessage>;

/** Construction deps for the transport (the Copilot-specific bits are supplied here, keeping C2 generic). */
export interface ClaudeAgentSdkTransportDeps {
  /** Build the run's prompt + system prompt from the invocation (the invocation carries refs, not text). */
  readonly promptBuilder: (inv: ClaudeAgentInvocation) => {
    readonly prompt: string;
    readonly systemPrompt: string;
  };
  readonly outputSchema?: Record<string, unknown>;
  readonly mcpServers?: Record<string, McpServerConfig>;
  readonly allowedToolNames?: readonly string[];
  readonly disallowedToolNames?: readonly string[];
  readonly maxTurns?: number;
  readonly betas?: readonly string[];
  /** Injectable for tests; the default lazily imports the SDK `query()`. */
  readonly queryFn?: AgentQueryFn;
}

/**
 * Construct the concrete `ClaudeAgentTransport`. Wires an abort signal, builds the governed options, runs
 * the (injected or lazily-imported) SDK `query()`, collects the stream, and folds it via the pure mappers.
 * Never throws — a thrown SDK error / abort folds to a typed `ClaudeAgentTransportError` (§16).
 */
export function createClaudeAgentSdkTransport(
  deps: ClaudeAgentSdkTransportDeps,
): ClaudeAgentTransport {
  return {
    async invoke(
      inv: ClaudeAgentInvocation,
      signal?: AbortSignal,
    ): Promise<Result<ClaudeAgentRawResult, ClaudeAgentTransportError>> {
      // Cancel before we touch the SDK → no side effect (COST-1).
      if (signal?.aborted === true) return err(txError("cancelled", "agent run cancelled", false));
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      try {
        const { prompt, systemPrompt } = deps.promptBuilder(inv);
        const options = buildAgentQueryOptions({
          inv,
          systemPrompt,
          controller,
          ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
          ...(deps.mcpServers !== undefined ? { mcpServers: deps.mcpServers } : {}),
          ...(deps.allowedToolNames !== undefined ? { allowedToolNames: deps.allowedToolNames } : {}),
          ...(deps.disallowedToolNames !== undefined ? { disallowedToolNames: deps.disallowedToolNames } : {}),
          ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          ...(deps.betas !== undefined ? { betas: deps.betas } : {}),
        });
        const runQuery: AgentQueryFn =
          deps.queryFn ??
          (((await import("@anthropic-ai/claude-agent-sdk")).query as unknown) as AgentQueryFn);
        const messages: SDKMessage[] = [];
        for await (const message of runQuery({ prompt, options })) {
          messages.push(message);
        }
        return extractAgentRawResult(messages, { expectStructured: deps.outputSchema !== undefined });
      } catch (e) {
        return err(foldAgentSdkThrow(e, controller.signal.aborted));
      } finally {
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
