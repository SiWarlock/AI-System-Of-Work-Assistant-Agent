// §9.6 / §7 — Phase-C C3: the AGENTIC Copilot synthesis adapter (worker side).
//
// A SECOND implementation of `CopilotSynthesisPort` (from ./copilot) — the sibling of the tool-LESS
// `createClaudeCopilotSynthesis`. Instead of a one-shot completion, it drives the AgentRuntimePort
// (`createClaudeAgentSdkRuntime` + the C2 `createClaudeAgentSdkTransport`) with the Copilot's READ tools,
// so the model can search this workspace's brain (the gbrain `serve --http` MCP endpoint from #2) while it
// answers. It stays inside every existing gate:
//   - the VETO-CLEARED `route` is BOUND, never re-selected (`toClaudeAgentRuntimeRoute` only maps the
//     provider→runtime discriminant; a non-Claude route fails closed — so the egress veto can't be made
//     advisory). The route reaching here is the same one `decideCopilotEgress` cleared for cloud egress.
//   - the AgentJob's tool policy + trust are CONTENT-derived (C5.1): the default is READ_ONLY over the C1
//     catalog (`copilotReadToolPolicy`) marked `untrusted` (the agent consumes potentially-untrusted brain
//     content) — no mutating tool, ING-7-pure; a `propose` job (trusted + scoped_write) is granted ONLY on
//     affirmed-trusted content. C4's admission gate (`admitJob(job, isMutatingCopilotTool)` +
//     `copilotReadOnlyPolicyIsPure`) is the backstop — an untrusted+mutating job is hard-rejected.
//   - the model's `candidateOutput` flows through the SAME grounding reconciliation the completion path uses
//     (`mapCompletionToCandidate`): a hallucinated citationId is dropped, the authoritative retrieved title
//     wins. Downstream, `answerCopilotQuestion`'s `toUiSafeCopilotAnswer` gate still re-validates the shape.
//
// GROUNDING/CITATION SCOPE (C3 limitation, tracked to C6/eval): citations reconcile ONLY against the
// WORKER-retrieved `context.sources`. Tool-discovered passages inform the model's answer but are NOT yet
// independently citable — so the agent is instructed to cite only the SUPPLIED passages. Folding a run's
// tool-retrieved sources into the citable set is a later refinement (needs the tool-result capture).
//
// TDD split: the route mapping, the ToolId→MCP-name mapping, the prompt builder, the job build, the error
// fold, and the output mapping are all PURE + unit-tested. `createAgentRuntimeCopilotSynthesis` is tested
// over a FAKE `CopilotAgentRunner`; `createClaudeAgentCopilotRunner`'s wiring is tested with an injected
// token + `queryFn`. The real SDK `query()` call is eval/integration-tested, not unit-tested.
import { ok, err, isOk, failure, isToolPolicyConsistent, toolId } from "@sow/contracts";
import type {
  AgentJob,
  AgentJobId,
  Capability,
  FailureVariant,
  FailureVariantKind,
  ProviderRoute,
  Result,
  ToolId,
  WorkflowId,
  WorkspaceId,
} from "@sow/contracts";
import {
  CLAUDE_AGENT_SDK_RUNTIME_ID,
  COPILOT_MCP_SERVER_NAME,
  COPILOT_GBRAIN_PROXY_MCP_NAMES,
  createClaudeAgentSdkRuntime,
  createClaudeAgentSdkTransport,
  runtimeError,
} from "@sow/providers";
import type {
  AgentResult,
  AgentQueryFn,
  CopilotGbrainProxyHandler,
  CopilotProposeToolHandler,
  McpServerConfig,
  RuntimeError,
  RuntimeErrorKind,
} from "@sow/providers";
import {
  admitJob,
  copilotAgentToolPolicy,
  copilotReadToolIds,
  copilotReadToolPolicy,
  copilotReadOnlyPolicyIsPure,
  isDeny,
  isMutatingCopilotTool,
} from "@sow/policy";
import type { CopilotWorkspaceScope } from "@sow/policy";
import type { CandidateCopilotAnswer, CopilotSynthesisPort, RetrievedContext } from "./copilot";
import { handleCopilotProposeToolCall } from "./copilotPropose";
import type { CopilotProposeSink } from "./copilotPropose";
import { handleCopilotGbrainToolCall } from "./copilotGbrainProxy";
import type { CopilotGbrainToolExec } from "./copilotGbrainProxy";
import {
  buildCopilotUserPrompt,
  mapCompletionToCandidate,
  COPILOT_OUTPUT_SCHEMA,
  DEFAULT_COPILOT_BETAS,
} from "./copilotClaudeSynthesis";

// ── the C1 ToolId → SDK MCP tool-name mapping ─────────────────────────────────
//
// The Claude Agent SDK exposes an MCP server's tools under `mcp__<server>__<tool>`. C1's catalog uses dotted
// ids (`gbrain.search`, `vault.read`, …). This maps one to the other. The ONE non-identity case: gbrain's
// semantic-search MCP tool is named `query` (proven live in #2), so `gbrain.search` → `mcp__gbrain__query`.
// A mismatch here is FAIL-SAFE, not silent: `buildCanUseTool` (C2) denies any tool name NOT in the allow
// list, so a wrong/absent mapping denies the tool (deny-all) rather than opening an ungoverned one.

/** The SDK MCP server key for the workspace brain (the gbrain `serve --http` endpoint). */
export const GBRAIN_MCP_SERVER_NAME = "gbrain" as const;

/** Map a C1 dotted ToolId to its SDK MCP tool name (`mcp__<server>__<tool>`). Pure. */
export function copilotToolToMcpName(id: ToolId): string {
  const raw = String(id);
  const dot = raw.indexOf(".");
  const server = dot === -1 ? raw : raw.slice(0, dot);
  const op = dot === -1 ? "" : raw.slice(dot + 1);
  // gbrain's semantic-search MCP tool is `query` (the one gbrain MCP tool proven live in #2).
  const tool = server === "gbrain" && op === "search" ? "query" : op;
  return `mcp__${server}__${tool}`;
}

/** The read-only Copilot agent's SDK allow-list — the whole C1 read catalog mapped to MCP names. Pure. */
export function copilotReadToolMcpNames(): string[] {
  return copilotReadToolIds().map(copilotToolToMcpName);
}

/**
 * The GBRAIN-backed subset of the read allow-list — the tools the wired gbrain `serve --http` MCP server
 * actually serves. `vault.read` is EXCLUDED until a vault MCP server is wired: allow-listing a tool for an
 * absent server is inert under `canUseTool` deny-by-default, but the runner's allow-list should match the
 * servers it configures (no phantom entries). Pure.
 */
export function copilotGbrainReadToolMcpNames(): string[] {
  return copilotReadToolIds()
    .filter((t) => String(t).startsWith("gbrain."))
    .map(copilotToolToMcpName);
}

// ── the gbrain http MCP server config ─────────────────────────────────────────

/** The MCP endpoint under a `gbrain serve --http` base URL (tolerates a trailing slash). Pure. */
export function gbrainMcpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/mcp`;
}

/** One SDK http-MCP server entry (kept structural so the worker needs no direct SDK type dep). */
export interface GbrainHttpMcpServer {
  readonly type: "http";
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Build the SDK `mcpServers` map for the workspace brain: an http MCP server at `mcpUrl`, authenticated with
 * the bearer token from the #2 grant. Loopback-only in practice (the token provider guards the URL). Pure.
 */
export function buildGbrainMcpServers(
  mcpUrl: string,
  bearerToken: string,
): Record<string, GbrainHttpMcpServer> {
  return {
    [GBRAIN_MCP_SERVER_NAME]: {
      type: "http",
      url: mcpUrl,
      headers: { Authorization: `Bearer ${bearerToken}` },
    },
  };
}

// ── route mapping (BIND the veto-cleared route; never re-select) ──────────────

/**
 * Map the veto-CLEARED Claude PROVIDER route to a `claude-agent-sdk` RUNTIME route (which
 * `buildClaudeAgentInvocation` requires). Fail-closed defense-in-depth (mirrors the completion adapter's
 * guard): the agent egresses raw workspace content to Anthropic's cloud, so ONLY a `provider:"claude"` route
 * is accepted — anything else reaching here is a wiring error and is rejected BEFORE any egress, so the
 * upstream notice can't name a processor the content never reached. The model/endpoint/egressClass are
 * BOUND from the passed route (never substituted) — only the discriminant flips provider→runtime, so the
 * egress veto stays authoritative over exactly the route that egresses. Pure.
 *
 * NOTE (endpoint binding, defense-in-depth): the Claude Agent SDK egresses to its OWN configured Anthropic
 * endpoint (`ANTHROPIC_BASE_URL` / api.anthropic.com), not `route.endpoint` — the SDK `query()` options take
 * no per-call base URL. So the operative destination binding on this path is PROCESSOR IDENTITY (only a
 * `provider:"claude"` cloud route is accepted → the SDK reaches Anthropic cloud), exactly as the sibling
 * completion adapter's guard is processor-identity too. `route.endpoint` is carried for the invocation/veto
 * record; asserting the SDK base URL equals it is a deferred hardening (operator-env redirection is not a
 * user-reachable path).
 */
export function toClaudeAgentRuntimeRoute(route: ProviderRoute): Result<ProviderRoute, FailureVariant> {
  if (!("provider" in route) || route.provider !== "claude") {
    return err(
      failure("validation_rejected", "copilot agent route is not a Claude provider route", {
        cause: { code: "COPILOT_ROUTE_NOT_CLAUDE" },
      }),
    );
  }
  return ok({
    runtime: CLAUDE_AGENT_SDK_RUNTIME_ID,
    model: route.model,
    endpoint: route.endpoint,
    egressClass: route.egressClass,
  });
}

// ── the Copilot AgentJob (read_only over the C1 catalog) ─────────────────────

/**
 * A conservative per-answer cost ceiling (USD) for the AGENTIC path. Higher than the single-shot completion
 * default (`DEFAULT_COPILOT_MAX_COST_USD` = 0.25) because an agent run is multi-turn (bounded at 8 turns) and
 * may issue several tool searches — but still bounded so a pathological/injected question can't run away. It
 * binds server-side: `buildClaudeAgentInvocation` carries it → `buildAgentQueryOptions` emits `maxBudgetUsd`,
 * and an over-cap run terminates with a folded (non-silent) `error_max_budget_usd`.
 */
export const DEFAULT_COPILOT_AGENT_MAX_COST_USD = 0.5;

// ── content-derived trust + capability (Phase-C C5.1 — the propose-tool prerequisite) ─────────
//
// The Copilot agent CONSUMES workspace brain content (retrieved passages + tool reads), which may be
// UNTRUSTED — a prompt-injected note ingested from an untrusted source could steer the agent. ING-7 (safety
// rule 6) therefore governs whether the agent may hold a WRITE-capable tool by the trust of that content, NOT
// by the trust of the question. So the job's `trustLevel` + tool policy are CONTENT-derived:
//   - read_only  ⇒ trustLevel "untrusted" (ING-7-safe — a read-only agent holds no write tool, so untrusted
//     content is harmless); the default, fail-closed.
//   - propose    ⇒ trustLevel "trusted" + scoped_write (the C1 `copilotAgentToolPolicy`, which carries the
//     `copilot.propose_action` tool). Granted ONLY when the consumed content is AFFIRMED trusted.
// The propose tool itself is not callable until C5.2/C5.3 wire its handler + allow-list it — C5.1 lands only
// the trust→capability mapping that gates it. ING-7 admission (C4) is the backstop: an untrusted + scoped_write
// job is HARD-rejected even if this resolver were bypassed.

/** Whether the agent's consumed brain content is AFFIRMED trusted (owner-governed) or potentially untrusted. */
export type CopilotContentTrust = "trusted" | "untrusted";

/** The tool capability granted to the Copilot agent job. `propose` = may hold the write-proposing tool. */
export type CopilotAgentCapability = "read_only" | "propose";

/**
 * Resolve the agent's capability from the CONTENT trust + whether propose is enabled. FAIL-CLOSED: the
 * `propose` capability (scoped_write + the `copilot.propose_action` tool) is granted ONLY when the consumed
 * content is affirmed TRUSTED **and** propose is explicitly enabled — otherwise `read_only`. So a
 * prompt-injected untrusted document can never steer the agent into holding a write tool (safety rule 6). Pure.
 *
 * ⚠ C5.2/C5.3 PRECONDITION (security-review MEDIUM, LOAD-BEARING — do not make propose callable until met):
 * a `propose` job STILL carries the gbrain READ tools, so it can tool-fetch MORE brain content mid-run beyond
 * the worker-retrieved seed. Therefore `contentTrust:"trusted"` is sound ONLY if the ENTIRE tool-reachable
 * content surface is trusted-provenance (KnowledgeWriter/owner-governed) — a STRICTLY STRONGER condition than
 * "the seed passages are trusted." It must be derived PER-CONTENT over that whole surface, NOT per-workspace
 * (an owner's brain routinely holds ingested untrusted notes) and NOT per-question. If ANY reachable passage
 * is non-KnowledgeWriter/untrusted-provenance, `contentTrust` MUST be `"untrusted"`. Enforce + eval this
 * before the propose tool is wired callable, or the ING-7 bypass the C4 review closed re-opens.
 */
export function resolveCopilotAgentCapability(params: {
  readonly contentTrust: CopilotContentTrust;
  readonly proposeEnabled: boolean;
}): CopilotAgentCapability {
  return params.contentTrust === "trusted" && params.proposeEnabled ? "propose" : "read_only";
}

/**
 * Derive the trust of the Copilot agent's consumed content (C5.4) — the input to
 * `resolveCopilotAgentCapability`. **PER-CONTENT + FAIL-CLOSED: `"trusted"` IFF the retrieval is non-empty
 * AND EVERY source is explicitly `knowledge_writer`-provenance; otherwise `"untrusted"`.** An empty retrieval,
 * or a SINGLE source of `imported`/`unknown`/absent provenance, collapses the whole verdict to untrusted — so
 * a prompt-injected/untrusted passage in the seed can never make the agent propose-capable (safety rule 6).
 *
 * This is sound at BUILD TIME **only because a propose job is SEED-ONLY**: the runner STRIPS the gbrain read
 * tools from a propose-capable job (see `createClaudeAgentCopilotRunner`), so the tool-reachable content
 * surface equals exactly the seed this function inspects — closing the live-read TOCTOU (a propose agent
 * cannot fetch more/untrusted content mid-run). Do NOT grant a propose job the gbrain read tools without
 * moving trust to a read-time hook, or this build-time verdict becomes unsound again.
 *
 * NOTE (current reality): the live gbrain retrieval adapters do not yet PROVE KnowledgeWriter authorship, so
 * they leave `provenance` ABSENT (⇒ treated as `unknown`) and this returns `"untrusted"` for every live ask
 * today — propose stays OFF. The moment a retrieval source can carry a verified `knowledge_writer` stamp, the
 * verdict (and propose) flip on, with no change here. Pure.
 */
export function deriveCopilotContentTrust(context: RetrievedContext): CopilotContentTrust {
  if (context.sources.length === 0) return "untrusted";
  return context.sources.every((s) => s.provenance === "knowledge_writer") ? "trusted" : "untrusted";
}

/**
 * Build the Copilot's AgentJob over a `claude-agent-sdk` runtime route. Its capability is ALWAYS
 * resolver-derived (fail-closed): pass a `trust` object and `resolveCopilotAgentCapability` decides — the
 * ONLY way to a `propose` job is `{contentTrust:"trusted", proposeEnabled:true}`. No `trust` arg ⇒ the safe
 * default: `read_only`. So a caller can NEVER build an untrusted-labeled propose job, nor set the
 * trust-label/tool-policy inconsistently (they move as one atomic, resolver-gated pair).
 *   - `read_only` ⇒ C1 read catalog (`copilotReadToolPolicy`, no mutating tool, `copilotReadOnlyPolicyIsPure`
 *     holds) + `trustLevel:"untrusted"` (the agent consumes potentially-untrusted brain content; read-only is
 *     ING-7-safe).
 *   - `propose`   ⇒ C1 `copilotAgentToolPolicy` (scoped_write + the propose tool) + `trustLevel:"trusted"`.
 * Carries raw content; sets `maxCostUsd`. Pure. (`AgentJob.capability` below is the branded routing id
 * "copilot.answer" — a DISTINCT concept from the tool capability.)
 *
 * NOTE (idempotency key): static per workspace because this path drives `runtime.runJob` DIRECTLY (not through
 * the Broker's replay ledger), so it is inert — no replay collision. If ever routed through the Broker, scope
 * the key to a question hash first, or every subsequent question in a workspace would short-circuit to the
 * first cached answer (tracked follow-up).
 */
export function buildCopilotAgentJob(
  workspaceId: string,
  runtimeRoute: ProviderRoute,
  trust?: { readonly contentTrust: CopilotContentTrust; readonly proposeEnabled: boolean },
): AgentJob {
  const propose =
    (trust === undefined ? "read_only" : resolveCopilotAgentCapability(trust)) === "propose";
  return {
    id: `job-copilot-agent-${workspaceId}` as AgentJobId,
    workflowRunId: `wf-copilot-agent-${workspaceId}` as WorkflowId,
    workspaceId: workspaceId as WorkspaceId,
    capability: "copilot.answer" as Capability,
    contextRefs: [{ refKind: "source", ref: "ref:copilot" }],
    outputSchemaId: "sow:ui-safe-copilot-answer",
    toolPolicy: propose ? copilotAgentToolPolicy() : copilotReadToolPolicy(),
    providerRoute: runtimeRoute,
    // Content-derived (NOT question-derived): a read-only agent treats its consumed content as untrusted;
    // only an affirmed-trusted, propose-capable job is `trusted`. C4's `admitCopilotAgentJob` is the backstop.
    trustLevel: propose ? "trusted" : "untrusted",
    carriesRawContent: true,
    maxRuntimeSeconds: 300,
    maxCostUsd: DEFAULT_COPILOT_AGENT_MAX_COST_USD,
    idempotencyKey: `idem-copilot-agent-${workspaceId}`,
  };
}

// ── ING-7 admission (Phase-C C4 — ACTIVATES the C1 catalog's classifier) ─────

/**
 * Admit the Copilot AgentJob through the ING-7 gate — the enforcement wiring the C1 catalog shipped INERT.
 * Two checks, both fail-closed:
 *   1. `admitJob(job, isMutatingCopilotTool)` — the ING-7 predicate (safety rule 6): an UNTRUSTED-content job
 *      that declares a MUTATING tool policy is a HARD REJECT. `isMutatingCopilotTool` (C1) is the classifier
 *      the gate needed — fail-safe (an unknown tool ⇒ mutating). It is consulted for a NON-read_only policy
 *      (scoped_write / `allowsMutating`); `admitsMutating` early-returns for a read_only policy, so a read_only
 *      policy's unknown/mutating tool is NOT caught here — it is caught by check (2).
 *   2. `copilotReadOnlyPolicyIsPure(toolPolicy)` — the DEFERRED "read_only ⇒ no mutating tool in the effective
 *      allow-list" clause. `admitJob`/`admitsMutating` STRUCTURALLY can't see this (their read_only branch
 *      early-returns `false` REGARDLESS of trust), so a read_only policy that SECRETLY lists a mutating tool —
 *      the ING-7 tool-stripping smuggle vector for untrusted content — would be admitted by (1) alone. This
 *      second check closes it.
 * Both live shapes pass: the DEFAULT job is content-derived `untrusted` + read_only (admitted — a read_only
 * policy is non-mutating), and a C5.1 `propose` job is `trusted` + scoped_write (admitted — a trusted job may
 * hold a mutating policy). The gate BITES on the dangerous shapes: an untrusted+mutating job (hard-rejected)
 * and a read_only policy that smuggles a mutating tool (rejected by the purity check). Pure.
 */
export function admitCopilotAgentJob(job: AgentJob): Result<AgentJob, FailureVariant> {
  // Defense-in-depth on this PUBLIC gate: re-assert the ToolPolicy cross-field invariant the Zod `.refine`
  // enforces (read_only ⇒ !allowsMutating). `admitCopilotAgentJob` takes an already-typed AgentJob and does
  // NOT re-run the schema gate, so a caller-built read_only policy with `allowsMutating:true` (which
  // `admitsMutating`'s read_only early-return would otherwise admit) is refused here.
  if (!isToolPolicyConsistent(job.toolPolicy)) {
    return err(
      failure("validation_rejected", "copilot tool policy is internally inconsistent", {
        cause: { code: "COPILOT_TOOLPOLICY_INCONSISTENT" },
      }),
    );
  }
  const decision = admitJob(job, isMutatingCopilotTool);
  if (isDeny(decision)) {
    return err(
      failure("validation_rejected", "copilot agent job rejected by the ING-7 admission gate", {
        cause: { code: decision.reason },
      }),
    );
  }
  if (!copilotReadOnlyPolicyIsPure(job.toolPolicy)) {
    return err(
      failure("validation_rejected", "copilot read_only tool policy lists a mutating tool", {
        cause: { code: "COPILOT_READONLY_POLICY_IMPURE" },
      }),
    );
  }
  return ok(job);
}

// ── the governed agentic prompt ───────────────────────────────────────────────

/**
 * The governed agentic system prompt. Same grounding contract as the completion path (cite by citationId,
 * no invention/REQ-F-017), plus: the read-only tools MAY be used to gather more context, but the tools are
 * READ-ONLY (never propose a write) and citations are limited to the SUPPLIED passages (the C3 citation
 * scope — see the module header).
 */
export const COPILOT_AGENT_SYSTEM_PROMPT = [
  "You are the System of Work Copilot, a governed READ-ONLY agent answering a question about ONE workspace.",
  "You are given citationId-tagged context passages. You MAY call the read-only gbrain tools to search this",
  "workspace's brain for additional context that informs your answer.",
  "",
  "Rules:",
  "- Ground every statement in the supplied passages. Cite each passage you rely on by its exact [citationId]",
  "  tag, and cite ONLY passages that were supplied to you in this message.",
  "- Do NOT invent, assume, or infer any fact — an owner, date, status, figure, or name — that the passages",
  "  do not state. If the answer is not in the context, say you could not find it and return no citations.",
  "- The tools are READ-ONLY: you may not create, edit, or delete anything, and you must never propose a write.",
  "- Never include secrets, credentials, access tokens, or raw file paths in your answer.",
  '- Reply with the structured object { "answer": string[], "citations": [{ "citationId", "title" }] }.',
].join("\n");

/** Build the run's prompt + system prompt from the question + retrieved context. Pure. */
export function buildCopilotAgentPrompt(
  question: string,
  context: RetrievedContext,
): { prompt: string; systemPrompt: string } {
  return { prompt: buildCopilotUserPrompt(question, context), systemPrompt: COPILOT_AGENT_SYSTEM_PROMPT };
}

// ── error fold + output mapping ───────────────────────────────────────────────

/** kind → (FailureVariant kind, stable cause code). Exhaustive over RuntimeErrorKind. */
const RUNTIME_ERROR_FOLD: Readonly<
  Record<RuntimeErrorKind, { readonly kind: FailureVariantKind; readonly code: string }>
> = {
  invalid_job: { kind: "validation_rejected", code: "COPILOT_AGENT_INVALID_JOB" },
  auth_unavailable: { kind: "provider_failed", code: "COPILOT_AGENT_AUTH" },
  runtime_unavailable: { kind: "provider_failed", code: "COPILOT_AGENT_UNAVAILABLE" },
  tool_policy_violation: { kind: "validation_rejected", code: "COPILOT_AGENT_TOOL_VIOLATION" },
  transport_error: { kind: "provider_failed", code: "COPILOT_AGENT_TRANSPORT" },
  timeout: { kind: "provider_failed", code: "COPILOT_AGENT_TIMEOUT" },
  cancelled: { kind: "provider_failed", code: "COPILOT_AGENT_CANCELLED" },
  malformed_output: { kind: "schema_rejected", code: "COPILOT_AGENT_MALFORMED" },
};

/**
 * Fold a `RuntimeError` into a `FailureVariant`. Redaction-safe BY CONSTRUCTION: `error.message` is
 * runtime/SDK-origin and MAY carry prompt/content fragments (§16 / safety 7), so it is DROPPED — the variant
 * carries only the enum `kind` and a stable UPPER_SNAKE cause code. Preserves `retryable`. Pure.
 */
export function foldRuntimeError(error: RuntimeError): FailureVariant {
  const mapped = RUNTIME_ERROR_FOLD[error.kind];
  return failure(mapped.kind, `copilot agent synthesis failed: ${error.kind}`, {
    retryable: error.retryable,
    cause: { code: mapped.code },
  });
}

/**
 * Map an `AgentResult` to a `CandidateCopilotAnswer`. A cancelled run carries no committable output → fail
 * closed. A completed run's `candidateOutput` flows through the SAME `mapCompletionToCandidate` grounding
 * reconciliation the completion path uses (hallucinated cites dropped, authoritative titles win, malformed
 * shape → schema_rejected). Pure.
 */
export function mapAgentResultToCandidate(
  result: AgentResult,
  context: RetrievedContext,
): Result<CandidateCopilotAnswer, FailureVariant> {
  if (result.status === "cancelled") {
    return err(
      failure("provider_failed", "copilot agent run was cancelled", {
        cause: { code: "COPILOT_AGENT_CANCELLED" },
      }),
    );
  }
  return mapCompletionToCandidate(result.candidateOutput, context);
}

// ── the runner seam + the agentic CopilotSynthesisPort ───────────────────────

/** The per-call prompt material (the invocation carries refs, not text — see C2). */
export interface CopilotPromptContext {
  readonly question: string;
  readonly context: RetrievedContext;
}

/**
 * The seam between the pure synthesis adapter and the real SDK run. `run` builds the transport (with a
 * prompt builder closed over THIS call's `prompt`) + the runtime, and drives the job. A fake in tests; the
 * concrete `createClaudeAgentCopilotRunner` below does the token + SDK I/O. Returns a typed Result — never
 * throws.
 */
export interface CopilotAgentRunner {
  run(
    job: AgentJob,
    prompt: CopilotPromptContext,
    signal?: AbortSignal,
  ): Promise<Result<AgentResult, RuntimeError>>;
}

/**
 * Options for the agentic synthesis (C5.3). `proposeEnabled` mirrors the boot flag `copilotProposeMode`;
 * `resolveContentTrust` derives the CONTENT trust from the retrieved context per ask. BOTH default fail-closed
 * (propose OFF, trust `deriveCopilotContentTrust` ⇒ untrusted), so the DEFAULT boot path never grants propose.
 */
export interface AgentSynthesisOpts {
  readonly proposeEnabled?: boolean;
  readonly resolveContentTrust?: (context: RetrievedContext) => CopilotContentTrust;
}

/**
 * The AGENTIC `CopilotSynthesisPort`. Binds the veto-cleared route (fail-closed if not Claude), derives the
 * CONTENT trust from the retrieved context (C5.3), builds the Copilot AgentJob at the RESOLVER-gated capability
 * (propose ONLY on trusted content + `proposeEnabled`; else read_only), runs it through the injected runner,
 * folds a runtime error to a typed failure, and maps the candidate output through the grounding reconciliation.
 * With the fail-closed defaults the job is always read_only. No side effects; never throws.
 */
export function createAgentRuntimeCopilotSynthesis(
  runner: CopilotAgentRunner,
  opts?: AgentSynthesisOpts,
): CopilotSynthesisPort {
  const proposeEnabled = opts?.proposeEnabled ?? false;
  const resolveContentTrust = opts?.resolveContentTrust ?? deriveCopilotContentTrust;
  return {
    synthesize: async (
      workspaceId: string,
      question: string,
      context: RetrievedContext,
      route: ProviderRoute,
    ): Promise<Result<CandidateCopilotAnswer, FailureVariant>> => {
      const runtimeRoute = toClaudeAgentRuntimeRoute(route);
      if (!isOk(runtimeRoute)) return runtimeRoute;
      // Content-derived capability (C5.1/C5.3): a propose job is granted ONLY on affirmed-trusted content.
      const contentTrust = resolveContentTrust(context);
      const job = buildCopilotAgentJob(workspaceId, runtimeRoute.value, { contentTrust, proposeEnabled });
      // ING-7 admission (C4) BEFORE the runner — fail closed on an untrusted+mutating or impure-read_only job.
      const admitted = admitCopilotAgentJob(job);
      if (!isOk(admitted)) return admitted;
      const run = await runner.run(admitted.value, { question, context });
      if (!isOk(run)) return err(foldRuntimeError(run.error));
      return mapAgentResultToCandidate(run.value, context);
    },
  };
}

// ── the concrete runner (token → mcpServers → transport → runtime) ───────────

/** Construction deps for the real runner. `getToken` is the #2 grant token seam; `queryFn` injectable for tests. */
export interface ClaudeAgentCopilotRunnerDeps {
  /**
   * The ONE workspace whose brain the gbrain MCP endpoint serves (WS-8 anchor — mirrors the retrieval seam's
   * `servedWorkspaceId`). ONLY a job for this workspace gets the gbrain read tool; every other workspace runs
   * TOOL-LESS (see `run`), so the agent path is never a second cross-workspace read around that guard.
   */
  readonly servedWorkspaceId: string;
  /** The gbrain `serve --http` MCP endpoint (e.g. `gbrainMcpEndpoint(baseUrl)`). */
  readonly gbrainMcpUrl: string;
  /** Mint/return a bearer token for the gbrain MCP endpoint (the #2 `GbrainTokenProvider.getToken`). */
  readonly getToken: () => Promise<Result<string, FailureVariant>>;
  /** SDK MCP allow-list for the SERVED workspace; defaults to `copilotGbrainReadToolMcpNames()` (gbrain-only). */
  readonly allowedToolNames?: readonly string[];
  /** SDK beta flags; defaults to `DEFAULT_COPILOT_BETAS` (the 1M-context window). */
  readonly betas?: readonly string[];
  /** Bound on agentic turns (defaults to the transport's own default). */
  readonly maxTurns?: number;
  /** Injectable SDK `query()` for tests; the default lazily imports the real SDK inside the transport. */
  readonly queryFn?: AgentQueryFn;
  /**
   * OPTIONAL (C5.3) the §9.8 propose sink. Present ⇒ a SERVED trusted+scoped_write job may hold the propose
   * tool. Absent ⇒ propose is never granted (fail-closed defense-in-depth). Boot injects the concrete
   * `createApprovalsProposeSink`.
   */
  readonly proposeSink?: CopilotProposeSink;
  /**
   * OPTIONAL (C5.3) factory that builds the in-process copilot MCP server from a bound tool handler (boot
   * injects `createCopilotProposeMcpServer` from @sow/providers — keeps the worker's runtime SDK-construction
   * out of this pure module + unit-testable). Present with `proposeSink` ⇒ propose can be granted.
   */
  readonly buildProposeMcpServer?: (handler: CopilotProposeToolHandler) => McpServerConfig;
  /**
   * OPTIONAL (SC8, §13.10 gate a) the served workspace's WS-8 scope for the in-process gbrain PROXY. Present
   * (WITH `gbrainProxyExec` + `buildGbrainProxyMcpServer`) ⇒ a SERVED read job reaches gbrain ONLY through the
   * proxy, which runs SC5a arg-policing + SC5b result-redaction per call — CLOSING the WS-8 combined-brain
   * residual noted below. Absent ⇒ today's raw http gbrain server (UNSCOPED; the residual applies). A PARTIAL
   * config (scope set, exec/factory missing) FAILS CLOSED — it never silently falls back to the unscoped path.
   */
  readonly gbrainProxyScope?: CopilotWorkspaceScope;
  /** OPTIONAL (SC8) the generic gbrain MCP-call exec the proxy handler runs (boot: `createGbrainMcpToolCallExec`). */
  readonly gbrainProxyExec?: CopilotGbrainToolExec;
  /**
   * OPTIONAL (SC8) factory that builds the in-process gbrain-proxy MCP server from a bound tool handler (boot
   * injects `createCopilotGbrainProxyMcpServer` from @sow/providers). Present with the scope + exec ⇒ the proxy
   * REPLACES the raw http gbrain server under the SAME `gbrain` map key.
   */
  readonly buildGbrainProxyMcpServer?: (handler: CopilotGbrainProxyHandler) => McpServerConfig;
  /**
   * OPTIONAL (Option A — single-brain, MULTI-SERVED) resolve the PER-ASK WS-8 proxy scope for the asked
   * workspace, or `undefined` when it is not registered (⇒ the job runs TOOL-LESS, fail closed). When present
   * it takes PRECEDENCE over the fixed single-served gate: `served` becomes "the resolver returned a scope for
   * this workspace", and that per-ask scope (bound to the ASKED workspace, server-derived from the registry)
   * is what the proxy runs — so ANY registered workspace's ask reads the one brain, scoped to ITSELF. Absent ⇒
   * today's fixed `servedWorkspaceId` + `gbrainProxyScope` single-served path (back-compat). Still requires
   * `gbrainProxyExec` + `buildGbrainProxyMcpServer` — a partial config FAILS CLOSED, never the unscoped path.
   */
  readonly gbrainProxyScopeFor?: (workspaceId: string) => CopilotWorkspaceScope | undefined;
}

/** The SDK MCP tool name the propose tool is surfaced as (`mcp__copilot__propose_action`). */
export const COPILOT_PROPOSE_MCP_TOOL_NAME = copilotToolToMcpName(toolId("copilot.propose_action"));

/**
 * The concrete `CopilotAgentRunner`. Which workspaces get the gbrain read tool depends on the mode (parity with
 * the retrieval seam — single-served `createGbrainSubprocessRetrieval` vs multi-served
 * `createMultiServedGbrainRetrieval`):
 *   - SINGLE-served (no `gbrainProxyScopeFor`) — WS-8 by CONSTRUCTION: ONLY a job for `servedWorkspaceId` gets
 *     the gbrain read tool; every OTHER workspace runs TOOL-LESS (no MCP server, empty allow-list ⇒
 *     `canUseTool` deny-all) over its fixture-empty context, so the agent can never query another workspace's
 *     brain.
 *   - MULTI-served (Option A, `gbrainProxyScopeFor` wired) — WS-8 by SCOPE FILTERING: ANY workspace the
 *     resolver returns a scope for is served, and its reads go through the in-process gbrain PROXY (SC5a
 *     arg-policing → the exec → SC5b result-redaction) bound to THAT workspace's own scope; an unregistered
 *     workspace still runs tool-less (resolver → undefined). So a workspace ≠ the fixed served id reaches the
 *     brain, scoped to itself — no foreign hit survives the per-ask redaction.
 * On a served READ job WITHOUT the proxy (single-served back-compat, no `gbrainProxyScope`) the runner instead
 * fetches a fresh MCP token (fail closed if unavailable — no SDK call without auth) and wires the RAW http
 * gbrain server + read allow-list. The C2 transport is built with a prompt builder for THIS call, wrapped in
 * the AgentRuntimePort, and drives the job. The token fetch + real SDK `query()` are the eval/integration
 * boundary; the wiring is unit-tested with an injected token + queryFn.
 *
 * RESIDUAL (WS-8): the served brain is a single COMBINED store. The SC8 proxy path (both single- and
 * multi-served with a scope) DOES filter each query result to the (per-ask) served workspace via SC5a/SC5b, so
 * the "unfiltered combined query" gap is CLOSED on that path. What remains is the F2 field-fidelity gap (a kept
 * in-workspace hit is forwarded whole, so a nested foreign ref under an un-scrubbed key could ride along) — the
 * gate-(c) governance eval — and A1 (body-embedded foreign content), an ingest-time fix. Both are INERT while
 * the brain holds only one workspace's content; keep employer-work OUT of the combined brain until F2 closes.
 * The legacy back-compat raw-http path (no proxy scope) is still UNFILTERED and rests on that single-workspace
 * assumption.
 */
export function createClaudeAgentCopilotRunner(deps: ClaudeAgentCopilotRunnerDeps): CopilotAgentRunner {
  const allowedToolNames = deps.allowedToolNames ?? copilotGbrainReadToolMcpNames();
  const betas = deps.betas ?? DEFAULT_COPILOT_BETAS;
  return {
    run: async (
      job: AgentJob,
      prompt: CopilotPromptContext,
      signal?: AbortSignal,
    ): Promise<Result<AgentResult, RuntimeError>> => {
      // Option A (MULTI-SERVED): when the resolver is wired, `served` = "the asked workspace is registered
      // (resolver returned a scope)"; that per-ask scope (bound to the ASKED workspace) is what the proxy runs.
      // Absent resolver ⇒ today's fixed single-served gate + `gbrainProxyScope`. `perAskScope` is `undefined`
      // for an unregistered workspace ⇒ tool-less (fail closed). A pure lookup — never throws (§16).
      const perAskScope = deps.gbrainProxyScopeFor?.(String(job.workspaceId));
      const served =
        deps.gbrainProxyScopeFor !== undefined
          ? perAskScope !== undefined
          : String(job.workspaceId) === deps.servedWorkspaceId;
      // `mcpServers` is widened to the SDK union so it can carry EITHER the gbrain http server (a read job) OR
      // the in-process copilot propose server (a propose job) — see the SEED-ONLY rule below.
      const mcpServers: Record<string, McpServerConfig> = {};
      const toolNames: string[] = [];
      // C5.3 — PROPOSE GRANT (defense-in-depth, ALL required): the workspace is SERVED, the job is
      // content-derived TRUSTED (gate on `trustLevel` too — not just scoped_write mode — so a mode/trust drift
      // can't grant it) with a scoped_write policy, AND both the sink + server factory are injected. With the
      // real `deriveCopilotContentTrust` (C5.4) this is only true when EVERY seed source is KnowledgeWriter-
      // provenance; today's un-provenanced gbrain hits ⇒ untrusted ⇒ this is never true on a live ask.
      // NOTE (multi-served): `served` now means "any REGISTERED workspace" (not just the boot-fixed one), so if
      // `trustLevel` ever flips true at the C5.4b go-live gate the propose surface spans every registered
      // workspace — each writing to ITS OWN server-bound approvals inbox (§9.8 scoping). Inert today (untrusted).
      const proposeGranted =
        served &&
        job.trustLevel === "trusted" &&
        job.toolPolicy.mode === "scoped_write" &&
        deps.proposeSink !== undefined &&
        deps.buildProposeMcpServer !== undefined;
      // C5.4 — SEED-ONLY PROPOSE SURFACE: a propose job gets NO gbrain read tools. Its tool-reachable content
      // surface is exactly the pre-verified seed (which `deriveCopilotContentTrust` already proved all
      // KnowledgeWriter), so it cannot fetch more/untrusted content mid-run — closing the live-read TOCTOU that
      // would otherwise make a build-time trust verdict unsound. Only a NON-propose served job reads gbrain
      // (WS-8: only the served workspace; a non-served workspace runs tool-less).
      if (served && !proposeGranted) {
        // Multi-served: the per-ask scope (bound to the ASKED workspace) takes precedence; single-served: the
        // fixed `gbrainProxyScope`. Under the resolver path `served` already implies `perAskScope !== undefined`.
        const proxyScope = perAskScope ?? deps.gbrainProxyScope;
        if (proxyScope !== undefined) {
          // SC8 — the WS-8 PROXY path: the model reaches gbrain ONLY through the in-process proxy, which runs
          // SC5a arg-policing → the exec → SC5b result-redaction per call, bound to the (per-ask) workspace scope.
          // Scoping was INTENDED, so a partial config FAILS CLOSED (never silently drop to the unscoped raw http
          // server). No token is minted HERE — the exec (the http-grant transport) mints its own, loopback-
          // guarded, per call.
          if (deps.gbrainProxyExec === undefined || deps.buildGbrainProxyMcpServer === undefined) {
            return err(runtimeError("invalid_job", "gbrain proxy scope set without exec/factory", { retryable: false }));
          }
          const scope = proxyScope;
          const exec = deps.gbrainProxyExec;
          const handler: CopilotGbrainProxyHandler = (mcpToolName: string, args: unknown) =>
            handleCopilotGbrainToolCall(mcpToolName, args, { scope, exec });
          // MAP-KEY CONTRACT (security L2): register under the SAME `gbrain` key so the proxy REPLACES the raw
          // http entry — `buildGbrainMcpServers` is NOT called on this path, so the model never sees BOTH a
          // scoped and an unscoped `mcp__gbrain__*` surface.
          mcpServers[GBRAIN_MCP_SERVER_NAME] = deps.buildGbrainProxyMcpServer(handler);
          toolNames.push(...COPILOT_GBRAIN_PROXY_MCP_NAMES);
        } else {
          // Back-compat (no proxy deps): the raw http gbrain server + the gbrain read allow-list (UNSCOPED — the
          // WS-8 combined-brain residual noted on this runner applies). No token ⇒ no read tools ⇒ fail closed
          // (never run the agent tool-blind or unauthenticated). The loopback guarantee is TRANSITIVE: `getToken`
          // fails closed (GBRAIN_HTTP_NON_LOOPBACK) for a non-loopback URL, so the token + content never egress.
          const token = await deps.getToken();
          if (!isOk(token)) {
            return err(runtimeError("auth_unavailable", "gbrain MCP token unavailable", { retryable: true }));
          }
          Object.assign(mcpServers, buildGbrainMcpServers(deps.gbrainMcpUrl, token.value));
          toolNames.push(...allowedToolNames);
        }
      }
      if (proposeGranted) {
        const sink = deps.proposeSink; // narrowed by proposeGranted
        const workspaceId = job.workspaceId; // SERVER-BOUND (WS-4)
        const handler: CopilotProposeToolHandler = (args: unknown) =>
          handleCopilotProposeToolCall(args, { workspaceId, sink });
        mcpServers[COPILOT_MCP_SERVER_NAME] = deps.buildProposeMcpServer(handler);
        toolNames.push(COPILOT_PROPOSE_MCP_TOOL_NAME);
      }
      const hasServers = Object.keys(mcpServers).length > 0;
      const transport = createClaudeAgentSdkTransport({
        promptBuilder: (): { prompt: string; systemPrompt: string } =>
          buildCopilotAgentPrompt(prompt.question, prompt.context),
        outputSchema: COPILOT_OUTPUT_SCHEMA,
        // Empty for a non-served workspace ⇒ `buildCanUseTool([])` denies every tool (deny-all).
        allowedToolNames: toolNames,
        betas,
        ...(hasServers ? { mcpServers } : {}),
        ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
        ...(deps.queryFn !== undefined ? { queryFn: deps.queryFn } : {}),
      });
      const runtime = createClaudeAgentSdkRuntime(transport);
      return runtime.runJob(job, signal);
    },
  };
}
