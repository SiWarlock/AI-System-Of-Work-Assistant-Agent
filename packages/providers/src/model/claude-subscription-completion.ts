// @sow/providers — Claude SUBSCRIPTION completion via the Claude Agent SDK (§9.6-real P2.2).
//
// A GENERIC schema-validated single completion over the owner's Claude SUBSCRIPTION: the Agent SDK's
// `query()` auto-uses the local `claude` login (no API key), so it bills the subscription — distinct
// from `claude-provider.ts` (the raw Anthropic Messages API, which needs an ANTHROPIC_API_KEY). NO
// tools (`tools: []` — the SDK's availability knob; `allowedTools` is ONLY the auto-approve list, so
// it does NOT disable tools — this package's LESSONS §1: empty toolset ≠ no tools) and a single turn —
// synthesis-only; the agentic/tool path is the AgentRuntimePort (P4). NEVER throws — typed `Result` (§16).
//
// WHY a dedicated client (not the ref-based ModelProviderPort/AgentRuntimePort): those carry
// `inputRefs`/`contextRefs` (references into a persistent store, redaction-safe), but the Copilot use
// carries EPHEMERAL, inline retrieved context. Redaction (§16 / safety 7) is preserved here by NEVER
// logging the prompt — no log sink touches `req.userPrompt` (which carries the content). The
// Copilot-specific prompt + `{answer, citations}` schema live in the WORKER adapter; this stays generic.
//
// The SDK is imported TYPE-ONLY at module scope + LAZILY (`await import`) inside the real call, so the
// PURE `extractCompletion` (the mapping logic — where a bug would silently corrupt an answer) is unit-
// testable without loading the SDK runtime (which spawns the Claude Code CLI subprocess).
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** A resolved single-completion request. `userPrompt` carries the (inline, never-logged) content. */
export interface CompletionRequest {
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** JSON Schema for the SDK `outputFormat` — the structured `{answer, citations}` shape. */
  readonly outputSchema: Record<string, unknown>;
  readonly maxCostUsd?: number;
}

/** Raw completion output. `structuredOutput` is CANDIDATE DATA — the caller's gate validates it. */
export interface CompletionOutput {
  readonly structuredOutput: unknown;
  readonly costUsd: number;
}

/** Enumerable completion-failure surface (`budget`/`rate_limited`/`timeout` are subscription-relevant). */
export const CompletionErrorKind = [
  "auth",
  "transport",
  "timeout",
  "cancelled",
  "malformed",
  "budget",
  "rate_limited",
] as const;
export type CompletionErrorKind = (typeof CompletionErrorKind)[number];

export interface CompletionError {
  readonly kind: CompletionErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

function completionError(
  kind: CompletionErrorKind,
  message: string,
  retryable = false,
): CompletionError {
  return { kind, message, retryable };
}

/**
 * PURE: fold the SDK's collected message stream into a completion or a typed error. The single
 * `type:'result'` message carries the outcome — success → `structured_output` + `total_cost_usd`; an
 * error subtype → the mapped kind. A missing result OR a success with NO `structured_output` is
 * `malformed`/`transport` (FAIL-CLOSED — never fabricate an answer). This is the mapping surface a bug
 * would silently corrupt, so it is isolated + unit-tested with fabricated messages.
 */
export function extractCompletion(
  messages: readonly SDKMessage[],
): Result<CompletionOutput, CompletionError> {
  const result = messages.find((m): m is SDKResultMessage => m.type === "result");
  if (result === undefined) {
    return err(completionError("transport", "no result message from the SDK", true));
  }
  if (result.subtype === "success") {
    // `== null` covers BOTH `undefined` and a JSON `null` output — either is "no answer", fail-closed.
    if (result.structured_output == null) {
      return err(completionError("malformed", "SDK returned no structured_output"));
    }
    return ok({ structuredOutput: result.structured_output, costUsd: result.total_cost_usd });
  }
  const message = result.errors.length > 0 ? result.errors.join("; ") : result.subtype;
  switch (result.subtype) {
    case "error_max_budget_usd":
      return err(completionError("budget", message));
    case "error_max_turns":
    case "error_max_structured_output_retries":
      return err(completionError("malformed", message));
    case "error_during_execution":
    default:
      return err(completionError("transport", message, true));
  }
}

/** The generic Claude-subscription completion client. One method; cancellation-aware; never throws. */
export interface ClaudeSubscriptionCompletion {
  complete(
    req: CompletionRequest,
    signal?: AbortSignal,
  ): Promise<Result<CompletionOutput, CompletionError>>;
}

/**
 * The REAL subscription completion client — the thin I/O boundary around the SDK `query()`
 * (eval/integration-tested, NOT unit-tested; the mapping logic lives in the pure `extractCompletion`).
 * Auth is ambient — the SDK uses the local `claude` login. `settingSources: []` so no project CLAUDE.md
 * is loaded; `allowedTools: []` so no tool can run. A thrown SDK error folds to a typed error.
 */
export function createClaudeSubscriptionCompletion(): ClaudeSubscriptionCompletion {
  return {
    async complete(
      req: CompletionRequest,
      signal?: AbortSignal,
    ): Promise<Result<CompletionOutput, CompletionError>> {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      if (signal !== undefined) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const messages: SDKMessage[] = [];
        for await (const message of query({
          prompt: req.userPrompt,
          options: {
            model: req.model,
            systemPrompt: req.systemPrompt,
            // `tools: []` DISABLES all built-in tools — the SDK's availability knob (LESSONS §1:
            // empty toolset ≠ no tools). `allowedTools: []` is only the secondary auto-approve list.
            tools: [],
            allowedTools: [],
            settingSources: [], // do NOT load project CLAUDE.md — governed, deterministic prompt
            outputFormat: { type: "json_schema", schema: req.outputSchema },
            maxTurns: 1,
            abortController: controller,
            ...(req.maxCostUsd !== undefined ? { maxBudgetUsd: req.maxCostUsd } : {}),
          },
        })) {
          messages.push(message);
        }
        return extractCompletion(messages);
      } catch (e) {
        if (controller.signal.aborted) {
          return err(completionError("cancelled", "completion cancelled", false));
        }
        // NOTE (redaction, §16): `msg` is SDK-origin and MAY carry prompt/content fragments — the
        // consumer MUST route `error.message` through the redaction layer before any log sink.
        const msg = e instanceof Error ? e.message : String(e);
        const kind: CompletionErrorKind = /rate.?limit|\b429\b|quota|overage/i.test(msg)
          ? "rate_limited"
          : /timeout|timed out|etimedout/i.test(msg)
            ? "timeout"
            : /auth|login|oauth|unauthor/i.test(msg)
              ? "auth"
              : "transport";
        // auth is terminal; transport/rate_limited/timeout are worth a retry (the Broker re-routes).
        return err(completionError(kind, msg, kind !== "auth"));
      } finally {
        // Remove the abort listener on NORMAL completion (it never fired) so a reused long-lived
        // signal doesn't accumulate listeners across calls.
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
