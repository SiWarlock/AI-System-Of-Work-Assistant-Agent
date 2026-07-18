// @sow/providers — subscription extraction request ASSEMBLER (18.19, §19.5 / §7).
//
// A PURE, TOTAL map from an already-built AgentExtractionRequest (CP-2/CP-3) + resolved inline content
// → a CompletionRequest for the Claude SUBSCRIPTION completion client (createClaudeSubscriptionCompletion).
// The subscription runs the Agent SDK `query()` on the local `claude` login — the worker MUST run with
// ANTHROPIC_API_KEY UNSET (an empty/stale key shadows the subscription profile by resolution precedence).
// This assembler reads NO env / API key and does NO I/O: ambient subscription auth is the client's concern,
// and schema resolution already happened upstream in the builder (buildMeeting/SourceExtractionRequest,
// which fails closed on an unresolved id) — so a future reader must NOT add a key read or a schema resolve here.
//
// COST-1 re-point: the enforced dollar cap reaches the subscription/runtime route ONLY via
// CompletionRequest.maxCostUsd, which complete() forwards to the SDK-native `maxBudgetUsd` option
// (Context7-verified /nothflare/claude-agent-sdk-docs; §19.5 Finding-F). The token-priced broker budget
// gate can't meter a runtime route, so this assembler is the single COST-1 chokepoint for that route.
//
// Reachability-waivered (L11) — no production call-site in this slice; the live consumer is the worker
// subscription-extraction runtime runner (18.20, apps/worker/src/composition/provider-runner.ts). The
// barrel re-export is the reachability mechanism (the worker cannot import the request legs otherwise).
import type { AgentExtractionRequest } from "./extraction-request";
import type { CompletionRequest } from "./claude-subscription-completion";

/**
 * Default SDK beta flags for the extraction route — the 1M-token context window (`context-1m-2025-08-07`),
 * matching the Copilot-synthesis default value. Defined separately from `DEFAULT_COPILOT_BETAS` so a later
 * synthesis/extraction beta divergence doesn't require touching the Copilot path. The worker (18.20) applies
 * this when the enforcer supplies no explicit `betas`.
 */
export const DEFAULT_EXTRACTION_BETAS: readonly string[] = ["context-1m-2025-08-07"];

/** Assembler options: the model, the enforced dollar cap (COST-1), and optional SDK beta flags. */
export interface ExtractionCompletionOptions {
  readonly model: string;
  readonly maxCostUsd?: number;
  readonly betas?: readonly string[];
}

/**
 * PURE + TOTAL: assemble the subscription `CompletionRequest` from a built extraction request + the
 * resolved content. Maps `req.prompt`→`systemPrompt`, `content`→`userPrompt`, the inline
 * `sow:agent-extraction` schema→`outputSchema`, and `opts.model`→`model`. `maxCostUsd` and `betas` are
 * conditional-spread (present ⇒ carried; absent ⇒ the KEY is omitted, so the SDK's own default budget /
 * betas apply). Never throws; no I/O; no schema resolution (done upstream).
 */
export function buildExtractionCompletionRequest(
  req: AgentExtractionRequest,
  content: string,
  opts: ExtractionCompletionOptions,
): CompletionRequest {
  return {
    model: opts.model,
    systemPrompt: req.prompt,
    userPrompt: content,
    outputSchema: req.outputConfig.format.schema,
    // Thread the cap VERBATIM: the BUDGET ENFORCER (resolveEnforcedBudget) is the cap authority and
    // guarantees a positive-finite maxCostUsd in the real path (18.20 sources it from the enforced
    // budget), so this assembler does NOT re-police it. Do NOT add a positive-finite guard that OMITS on
    // non-finite — omitting would fail-OPEN to the SDK's own default budget, worse on a spend cap
    // (Lessons 54/55). `!== undefined` matches the client (claude-subscription-completion.ts:143).
    ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
    ...(opts.betas !== undefined ? { betas: opts.betas } : {}),
  };
}
