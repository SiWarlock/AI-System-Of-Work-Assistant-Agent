// §9.6-real P2.3 — the REAL Copilot synthesis adapter (worker side).
//
// Implements `CopilotSynthesisPort` (from ./copilot) over the generic Claude SUBSCRIPTION completion
// client (@sow/providers). This is the WORKER half: the Copilot-specific SYSTEM prompt (grounded-only,
// cite-by-citationId, no-invention/REQ-F-017), the USER prompt (question + citationId-tagged passages),
// the `{answer, citations}` JSON schema, and the deterministic OUTPUT mapping — while the transport
// (the real `query()` call) and the model's prose stay in @sow/providers / the eval harness (P2.5).
//
// GROUNDING is enforced deterministically here, not left to the prompt: the model's citations are
// RECONCILED against the retrieved set (`mapCompletionToCandidate`), so a hallucinated citationId is
// dropped and the AUTHORITATIVE retrieved title always wins over whatever title the model echoed. The
// downstream `toUiSafeCopilotAnswer` gate (in ./copilot) still re-validates the whole shape, so a
// malformed output is dropped, never served (fail-closed at two layers).
//
// The `route` handed to `synthesize` is the VETO-CLEARED route from `decideCopilotEgress` (P2.1) — the
// adapter binds to `route.model` and NEVER re-selects, so the egress veto can't be turned advisory.
import { ok, err, isOk, failure, processorId } from "@sow/contracts";
import type {
  FailureVariant,
  FailureVariantKind,
  ProviderRoute,
  Result,
  WorkspaceId,
  WorkspaceType,
} from "@sow/contracts";
import type {
  ClaudeSubscriptionCompletion,
  CompletionError,
  CompletionRequest,
} from "@sow/providers";
import {
  createFixtureRetrieval,
  createStubSynthesis,
  createLocalRouteSelector,
  createLocalWorkspacePosture,
  localWorkspacePosture,
} from "./copilot";
import type {
  CandidateCopilotAnswer,
  CopilotDeps,
  CopilotSynthesisPort,
  EgressRouteSelector,
  RetrievedContext,
  RetrievedSource,
  WorkspacePosture,
} from "./copilot";

/**
 * The governed Copilot system prompt. Encodes the grounding contract: answer ONLY from the supplied
 * passages, cite by citationId, and NEVER invent/assume/infer a fact the passages don't state
 * (REQ-F-017 no-inference). The reply shape mirrors COPILOT_OUTPUT_SCHEMA.
 */
export const COPILOT_SYSTEM_PROMPT = [
  "You are the System of Work Copilot, a governed assistant that answers a question using ONLY the",
  "citationId-tagged context passages supplied in the user message. Ground every statement in them.",
  "",
  "Rules:",
  "- Cite each passage you rely on by its exact citationId (the bracketed [citationId] tag before the",
  "  passage). Never cite anything that is not in the supplied context.",
  "- Do NOT invent, assume, or infer any fact — an owner, date, status, figure, or name — that the",
  "  passages do not explicitly state. If the answer is not in the context, say you could not find it",
  "  and return an empty citations list.",
  "- Never include secrets, credentials, access tokens, or raw file paths in your answer.",
  '- Reply with the structured object { "answer": string[], "citations": [{ "citationId", "title" }] }:',
  "  answer is one or more short paragraphs; citations lists only passages you actually used.",
].join("\n");

/** The JSON Schema for the SDK `outputFormat` — the structured `{answer, citations}` reply. */
export const COPILOT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citations"],
  properties: {
    answer: { type: "array", items: { type: "string" } },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["citationId", "title"],
        properties: {
          citationId: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
};

/** A conservative default per-answer cost ceiling (a single Q&A synthesis is typically a few cents). */
export const DEFAULT_COPILOT_MAX_COST_USD = 0.25;

/**
 * Build the USER prompt: the question, then the citable passages — each source tagged with its
 * citationId + title and paired (by index) to its retrieved block, so the model can only cite what it
 * was shown. An empty retrieval yields an explicit "no context" marker (the model then refuses per the
 * system prompt). Pure; carries inline content but is NEVER logged (§16 — the caller doesn't log it).
 *
 * Passages are keyed on `sources` (the CITABLE units). Grounding-first on a length mismatch: a `blocks`
 * entry with NO matching source (`blocks.length > sources.length`) is OMITTED — a passage with no
 * citationId can't be cited, and showing it would invite ungrounded claims; a source with no matching
 * block gets an explicit "(no excerpt available)". The real GBrain retrieval (P3) should return
 * block↔source as aligned pairs so neither arm triggers — tracked as a `RetrievedContext` restructure.
 */
export function buildCopilotUserPrompt(question: string, context: RetrievedContext): string {
  const lines: string[] = ["Question:", question, ""];
  if (context.sources.length === 0) {
    lines.push("Context passages: (no context was retrieved for this workspace)");
    return lines.join("\n");
  }
  lines.push("Context passages:");
  context.sources.forEach((source, i) => {
    const block = context.blocks[i];
    lines.push("", `[${source.citationId}] ${source.title}`, block ?? "(no excerpt available)");
  });
  return lines.join("\n");
}

/** The raw `{answer, citations}` shape the model is asked to produce (candidate data — untrusted). */
interface RawCopilotOutput {
  readonly answer: readonly string[];
  readonly citations: readonly { readonly citationId: string; readonly title: string }[];
}

/**
 * PURE shape guard over the model's structured output (candidate data). Returns the typed shape or
 * `null` when anything is off (not an object, `answer` not a string[], a citation missing a field) —
 * the caller folds `null` to a fail-closed error. Hand-written (no zod dep in the worker).
 */
function parseRawOutput(value: unknown): RawCopilotOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const answer = obj["answer"];
  const citations = obj["citations"];
  if (!Array.isArray(answer) || !answer.every((a): a is string => typeof a === "string")) return null;
  if (!Array.isArray(citations)) return null;
  const parsed: { citationId: string; title: string }[] = [];
  for (const c of citations) {
    if (typeof c !== "object" || c === null) return null;
    const cc = c as Record<string, unknown>;
    const citationId = cc["citationId"];
    const title = cc["title"];
    if (typeof citationId !== "string" || typeof title !== "string") return null;
    parsed.push({ citationId, title });
  }
  // Cast is load-bearing: a type-predicate `.every()` narrows the callback param, NOT the outer array,
  // so `answer` is still `unknown[]` here — but every element was just runtime-proven a string.
  return { answer: answer as string[], citations: parsed };
}

/**
 * PURE: map the model's structured output to a `CandidateCopilotAnswer`, fail-closed on a malformed
 * shape. Citations are RECONCILED against the retrieved set — only a citationId we actually retrieved
 * survives (grounding: the model can't invent a source), the AUTHORITATIVE retrieved title is used (the
 * model's echoed title is never trusted through to the UI), duplicates collapse, and the model's order
 * is preserved. The answer prose is the model's synthesis (EVAL-tested, P2.5); the downstream gate
 * normalizes each line + rejects an empty/over-cap answer.
 */
export function mapCompletionToCandidate(
  structuredOutput: unknown,
  context: RetrievedContext,
): Result<CandidateCopilotAnswer, FailureVariant> {
  const raw = parseRawOutput(structuredOutput);
  if (raw === null) {
    return err(
      failure("schema_rejected", "copilot model output was not the expected shape", {
        cause: { code: "COPILOT_OUTPUT_MALFORMED" },
      }),
    );
  }
  const authoritative = new Map<string, RetrievedSource>(context.sources.map((s) => [s.citationId, s]));
  const citations: RetrievedSource[] = [];
  const seen = new Set<string>();
  for (const c of raw.citations) {
    const source = authoritative.get(c.citationId);
    if (source === undefined || seen.has(c.citationId)) continue; // drop hallucinated / duplicate
    seen.add(c.citationId);
    citations.push(source); // authoritative source object — model's echoed title discarded
  }
  return ok({ answer: raw.answer, citations });
}

/** kind → (FailureVariant kind, stable cause code). Exhaustive over CompletionError["kind"]. */
const COMPLETION_ERROR_FOLD: Readonly<
  Record<CompletionError["kind"], { readonly kind: FailureVariantKind; readonly code: string }>
> = {
  budget: { kind: "budget_exceeded", code: "COPILOT_SYNTHESIS_BUDGET" },
  malformed: { kind: "schema_rejected", code: "COPILOT_SYNTHESIS_MALFORMED" },
  auth: { kind: "provider_failed", code: "COPILOT_SYNTHESIS_AUTH" },
  rate_limited: { kind: "provider_failed", code: "COPILOT_SYNTHESIS_RATE_LIMITED" },
  timeout: { kind: "provider_failed", code: "COPILOT_SYNTHESIS_TIMEOUT" },
  transport: { kind: "provider_failed", code: "COPILOT_SYNTHESIS_TRANSPORT" },
  cancelled: { kind: "provider_failed", code: "COPILOT_SYNTHESIS_CANCELLED" },
};

/**
 * Fold a `CompletionError` into a `FailureVariant`. Redaction-safe BY CONSTRUCTION: `error.message` is
 * SDK-origin and MAY carry prompt/content fragments (§16 / safety 7), so it is DROPPED entirely — the
 * variant carries only the enum `kind` and a stable UPPER_SNAKE cause code (the one field the redaction
 * layer surfaces; a free-form message would be collapsed to REDACTED_RAW anyway). This discharges the
 * P2.2 carry-forward: no SDK message ever reaches a log sink through the failure path.
 */
export function foldCompletionError(error: CompletionError): FailureVariant {
  const mapped = COMPLETION_ERROR_FOLD[error.kind];
  return failure(mapped.kind, `copilot synthesis failed: ${error.kind}`, {
    retryable: error.retryable,
    cause: { code: mapped.code },
  });
}

/** Optional knobs for the real synthesis adapter. */
export interface ClaudeCopilotSynthesisOptions {
  /** Per-answer cost ceiling (USD). Defaults to DEFAULT_COPILOT_MAX_COST_USD. */
  readonly maxCostUsd?: number;
}

/**
 * The REAL `CopilotSynthesisPort` over the Claude subscription completion client. Binds to the
 * VETO-CLEARED `route.model` (never re-selects — else the egress veto is advisory), sends the governed
 * prompts + schema, folds a completion error to a typed failure, and maps a successful output through
 * the grounding reconciliation. No side effects; never throws (the client returns a typed Result).
 */
export function createClaudeCopilotSynthesis(
  client: ClaudeSubscriptionCompletion,
  options?: ClaudeCopilotSynthesisOptions,
): CopilotSynthesisPort {
  const maxCostUsd = options?.maxCostUsd ?? DEFAULT_COPILOT_MAX_COST_USD;
  return {
    synthesize: async (
      _workspaceId: string,
      question: string,
      context: RetrievedContext,
      route: ProviderRoute,
    ): Promise<Result<CandidateCopilotAnswer, FailureVariant>> => {
      // Fail-closed defense-in-depth over the egress veto (safety rule 5): the subscription client
      // ALWAYS ships the prompt (inline employer content) to Anthropic's cloud, so this adapter serves
      // ONLY a Claude PROVIDER route. Anything else reaching here is a wiring error — reject BEFORE any
      // egress. This ties the adapter's true destination (Anthropic) to the route's declared processor,
      // so the upstream notice can't name a processor the content never reached. A `{runtime,…}` route
      // is the P4 AgentRuntimePort path, not this client. The veto stays the primary gate.
      if (!("provider" in route) || route.provider !== "claude") {
        return err(
          failure("validation_rejected", "copilot synthesis route is not a Claude provider route", {
            cause: { code: "COPILOT_ROUTE_NOT_CLAUDE" },
          }),
        );
      }
      const request: CompletionRequest = {
        model: route.model,
        systemPrompt: COPILOT_SYSTEM_PROMPT,
        userPrompt: buildCopilotUserPrompt(question, context),
        outputSchema: COPILOT_OUTPUT_SCHEMA,
        maxCostUsd,
      };
      const result = await client.complete(request);
      if (!isOk(result)) return err(foldCompletionError(result.error));
      return mapCompletionToCandidate(result.value.structuredOutput, context);
    },
  };
}

// ── P2.4 — wire it live: the real cloud route selector + the consent posture ─────────────────
//
// When the `copilotRealModel` flag is ON, boot swaps its interim `createLocalRouteSelector` /
// `localWorkspacePosture` for these, so the egress veto classifies synthesis as CLOUD egress and (under
// employer-work + ack) the notice fires for real. The route MUST be a Claude PROVIDER route — the P2.3
// adapter guard rejects anything else, and `processorOfRoute` labels it "claude" (the notice processor).

/** The Anthropic cloud endpoint the subscription client egresses to. */
export const CLAUDE_CLOUD_COPILOT_ENDPOINT = "https://api.anthropic.com";

/**
 * Default Claude model for Copilot synthesis. Overridable end-to-end via `BootConfig.copilotModel`
 * (threaded through `buildCopilotDeps` → `createClaudeCloudRouteSelector`). NOTE: verify the exact id
 * against the current Anthropic / Agent-SDK model catalog before flipping the flag live — a stale id
 * folds to a typed `CompletionError` (the safe failure mode), never a silent wrong answer.
 */
export const DEFAULT_CLAUDE_COPILOT_MODEL = "claude-opus-4-8";

/**
 * The real cloud Claude PROVIDER route for Copilot synthesis: `provider: "claude"` + `egressClass:
 * "cloud"`, so `processorOfRoute` labels it "claude" (the notice's processor) and the P2.3 adapter
 * guard accepts it. Pure.
 */
export function buildClaudeCloudCopilotRoute(
  model: string = DEFAULT_CLAUDE_COPILOT_MODEL,
): ProviderRoute {
  return { provider: "claude", model, endpoint: CLAUDE_CLOUD_COPILOT_ENDPOINT, egressClass: "cloud" };
}

/**
 * Route selector for the REAL cloud path — always the Claude cloud route. Replaces boot's interim
 * `createLocalRouteSelector` when the real-model flag is on, so the veto sees cloud egress.
 */
export function createClaudeCloudRouteSelector(
  model: string = DEFAULT_CLAUDE_COPILOT_MODEL,
): EgressRouteSelector {
  const route = buildClaudeCloudCopilotRoute(model);
  return { select: (_workspaceId, _posture): Result<ProviderRoute, FailureVariant> => ok(route) };
}

/**
 * The interim CONSENT posture for the real cloud path. Allowlists the Claude processor for raw content
 * (the veto then ALLOWS the cloud route — the copilot job always carries raw content) and, for
 * EMPLOYER-WORK, sets `employerRawEgressAcknowledged: true` — the owner's explicit consent ("I'm fine
 * with Employer-Work going to a cloud model, I just want a notice"). Employer-work then egresses to
 * Anthropic WITH the visible notice; a personal workspace egresses with none. Interim until the
 * AUTHORITATIVE `WorkspaceConfigRepository.get(id)` posture lands — the ack becomes a real per-workspace
 * setting then, not a flag-derived default. Pure.
 */
export function cloudCopilotPosture(workspaceId: string, type: WorkspaceType): WorkspacePosture {
  const claude = processorId("claude");
  return {
    type,
    dataOwner: type === "employer_work" ? "employer" : "user",
    egress: {
      workspaceId: workspaceId as WorkspaceId,
      allowedProcessors: [claude],
      rawContentAllowedProcessors: [claude],
      employerRawEgressAcknowledged: type === "employer_work",
    },
  };
}

/** A provisioned workspace + its resolved type — the input `buildCopilotDeps` builds postures over. */
export interface CopilotWorkspace {
  readonly id: string;
  readonly type: WorkspaceType;
}

/** Inputs for assembling the Copilot deps — the whole real-vs-interim decision, in one tested place. */
export interface CopilotDepsOptions {
  /** ON ⇒ real Claude-subscription cloud path; OFF ⇒ deterministic stub over a local route. */
  readonly realCopilot: boolean;
  /** The provisioned workspaces (fixtures + postures are built per id). Empty ⇒ every ask fails closed. */
  readonly workspaces: readonly CopilotWorkspace[];
  /** Optional model override (BootConfig.copilotModel); defaults to DEFAULT_CLAUDE_COPILOT_MODEL. */
  readonly model?: string;
  /**
   * Factory for the real subscription completion client — invoked ONLY on the real path (so the SDK
   * client is never even constructed when the flag is off). Boot passes `createClaudeSubscriptionCompletion`.
   */
  readonly completion: () => ClaudeSubscriptionCompletion;
}

/**
 * Assemble the Copilot ask deps from the flag + provisioned workspaces — the single place the
 * real-vs-interim wiring is decided, so the branch is UNIT-TESTED (a flipped ternary can't ship
 * silently). Real path: Claude-subscription synthesis + cloud route + the CONSENT posture per workspace
 * (employer-work egresses to Anthropic WITH the notice). Interim path: the deterministic stub + a
 * loopback-local route + the fail-closed `localWorkspacePosture` (nothing egresses). Retrieval is the
 * fixture read either way; the authoritative posture-by-workspaceId resolution is identical. Pure apart
 * from the injected `completion` factory (called at most once, only on the real path).
 */
export function buildCopilotDeps(opts: CopilotDepsOptions): CopilotDeps {
  const fixtures: Record<string, RetrievedContext> = {};
  const postures: Record<string, WorkspacePosture> = {};
  for (const ws of opts.workspaces) {
    fixtures[ws.id] = { workspaceId: ws.id, blocks: [], sources: [] };
    postures[ws.id] = opts.realCopilot
      ? cloudCopilotPosture(ws.id, ws.type)
      : localWorkspacePosture(ws.id, ws.type);
  }
  return {
    retrieval: createFixtureRetrieval(fixtures),
    synthesis: opts.realCopilot
      ? createClaudeCopilotSynthesis(opts.completion())
      : createStubSynthesis(),
    // Authoritative posture resolved by workspaceId (server-side).
    workspacePosture: createLocalWorkspacePosture(postures),
    routeSelector: opts.realCopilot
      ? createClaudeCloudRouteSelector(opts.model)
      : createLocalRouteSelector(),
  };
}
