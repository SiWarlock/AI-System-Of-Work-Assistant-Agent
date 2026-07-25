// @sow/providers — RES-1 research/web-retrieval ModelProviderPort processor
// (§7 / REQ-F-022). Cloud web-retrieval WITH citations: Perplexity Sonar + Grok
// Live Search, each its OWN processor (ProviderId `perplexity` / `xai`, NEVER an
// openai/openrouter alias — safety rule 5). Built on the shared cloud adapter
// infra (http-transport.ts): resolve the key via the injected SecretsPort, dispatch
// through the INJECTED transport, frame a 2xx body as a candidate `ProviderOutput`.
//
// DORMANT: the transport is dependency-injected (a FAKE in tests; the real HTTP
// client + paid keys bind ONLY at the §ARM-RESEARCH crossing — owner-gated). This
// module constructs NO real transport — nothing here reaches a real endpoint.
//
// EGRESS VETO (rule 5) is NOT re-implemented here: perplexity/xai are cloud-by-
// construction (absent from @sow/policy LOCAL_PROVIDERS), so the BROKER's egress
// veto fails an employer-work ack-OFF job CLOSED before this run leg is reached.
//
// OUTPUT is CANDIDATE DATA — a `ResearchDossier` with citations preserved VERBATIM
// (the source list is the whole point of RES-1). It is never applied and never
// written to Markdown; the schema gate (5.5) validates it, and 13.14 /research maps
// it to a KnowledgeMutationPlan → KnowledgeWriter downstream. Never throws (§16).
import { ok, err, isErr } from "@sow/contracts";
import type { Result, ProviderId } from "@sow/contracts";
import type {
  ModelProviderPort,
  ProviderRequest,
  ProviderOutput,
  ProviderError,
} from "../ports/model-provider-port";
import { providerError } from "../ports/model-provider-port";
import {
  executeCompletion,
  trimTrailingSlash,
  refsToPromptText,
  usageFrom,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type CloudProviderDeps,
  type HttpTransportRequest,
  type ModelWireAdapter,
  type WireCompletion,
} from "./http-transport";

const PERPLEXITY: ProviderId = "perplexity";
const XAI: ProviderId = "xai";

/** Perplexity Sonar path (OpenAI-compatible chat completions). */
export const PERPLEXITY_COMPLETIONS_PATH = "/chat/completions" as const;
/** xAI Grok Live Search path (the Responses API). */
export const XAI_RESPONSES_PATH = "/v1/responses" as const;

/**
 * A candidate research dossier — CANDIDATE DATA (never applied). `citations` /
 * `searchResults` are preserved VERBATIM from the vendor (the source provenance is
 * RES-1's whole point; a summarized/dropped citation defeats the purpose). The
 * schema gate (5.5) validates this downstream; 13.14 maps it to a
 * KnowledgeMutationPlan → KnowledgeWriter (citations → `sourceRefs`/frontmatter).
 */
export interface ResearchDossier {
  readonly answer: string;
  readonly citations: readonly unknown[];
  readonly searchResults?: readonly unknown[];
}

// Pull the best-effort token counts from either the OpenAI-style (`prompt_tokens`/
// `completion_tokens`, Perplexity) or the input/output style (xAI) usage block.
function usageBlock(doc: Record<string, unknown>): WireCompletion["usage"] {
  const u = (doc.usage ?? undefined) as Record<string, unknown> | undefined;
  return usageFrom(u?.prompt_tokens ?? u?.input_tokens, u?.completion_tokens ?? u?.output_tokens);
}

// Preserve the citation list VERBATIM when present as an array, else an empty list
// (never invent — REQ-F-017). Element values are untouched (candidate data).
function verbatimList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonDoc(providerId: ProviderId, body: string): Result<Record<string, unknown>, ProviderError> {
  try {
    return ok(JSON.parse(body) as Record<string, unknown>);
  } catch {
    return err(providerError("malformed_output", `${providerId} response body was not valid JSON`));
  }
}

function bearerHeaders(secret: string): Record<string, string> {
  return { "content-type": "application/json", Authorization: `Bearer ${secret}` };
}

// Extract the answer text from an xAI Responses body. arch_gap: Context7 documents
// the SDK surface (`response.content`), but the RAW `/v1/responses` JSON is the
// OpenAI-Responses envelope (xAI advertises OpenAI compatibility) — the text nests
// under `output[].content[].text`. Try the flat shape first, then walk the envelope,
// so a real Grok response does not silently fold to `malformed_output` (LESSON 3).
// The definitive envelope is re-confirmed field-by-field at §ARM-RESEARCH.
function extractGrokAnswer(doc: Record<string, unknown>): string | undefined {
  if (typeof doc.content === "string") return doc.content;
  if (typeof doc.output_text === "string") return doc.output_text;
  const output = doc.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        for (const seg of content) {
          const text = (seg as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
      }
    }
  }
  return undefined;
}

/**
 * Perplexity Sonar wire (OpenAI-compatible `POST /chat/completions`). arch_gap:
 * Context7-grounded CANDIDATE (docs.perplexity.ai/api-reference/sonar-post) —
 * `CompletionResponse` carries the answer at `choices[0].message.content` and the
 * source provenance at top-level `citations: string[]` + `search_results[]`. The
 * real wire shape is re-confirmed at the §ARM-RESEARCH arming (LESSON 21).
 */
export function perplexityResearchWireAdapter(): ModelWireAdapter {
  return {
    providerId: PERPLEXITY,
    buildHttpRequest(req: ProviderRequest, secret: string | undefined): Result<HttpTransportRequest, ProviderError> {
      if (secret === undefined || secret.length === 0) {
        return err(providerError("auth_unavailable", "perplexity api key unavailable", { retryable: true }));
      }
      const body = JSON.stringify({
        model: req.model,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: refsToPromptText(req.inputRefs) }],
      });
      return ok({
        url: `${trimTrailingSlash(req.route.endpoint)}${PERPLEXITY_COMPLETIONS_PATH}`,
        method: "POST",
        headers: bearerHeaders(secret),
        body,
      });
    },
    parseHttpResponse(_status: number, body: string): Result<WireCompletion, ProviderError> {
      const docRes = jsonDoc(PERPLEXITY, body);
      if (isErr(docRes)) return docRes;
      const doc = docRes.value;
      const choices = doc.choices;
      const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
      const answer = first?.message?.content;
      if (typeof answer !== "string") {
        return err(providerError("malformed_output", "perplexity response missing choices[0].message.content"));
      }
      const dossier: ResearchDossier = {
        answer,
        citations: verbatimList(doc.citations),
        ...(Array.isArray(doc.search_results) ? { searchResults: doc.search_results } : {}),
      };
      return ok({ candidateOutput: dossier, usage: usageBlock(doc) });
    },
  };
}

/**
 * Grok Live Search wire (xAI `POST /v1/responses`, `tools:[{type:"x_search"}]`).
 * arch_gap: Context7-grounded CANDIDATE (docs.x.ai) — the response carries the
 * answer text (`content` / `output_text`) and the source provenance at
 * `citations[]`. The raw Responses-API envelope is confirmed at §ARM-RESEARCH.
 */
export function grokResearchWireAdapter(): ModelWireAdapter {
  return {
    providerId: XAI,
    buildHttpRequest(req: ProviderRequest, secret: string | undefined): Result<HttpTransportRequest, ProviderError> {
      if (secret === undefined || secret.length === 0) {
        return err(providerError("auth_unavailable", "xai api key unavailable", { retryable: true }));
      }
      const body = JSON.stringify({
        model: req.model,
        // The Responses API caps output via `max_output_tokens` (parity with the
        // Perplexity `max_tokens` cap; the Broker's budget enforcer governs cost/runtime).
        max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        input: [{ role: "user", content: refsToPromptText(req.inputRefs) }],
        // x_search (X/Twitter) + web_search — live retrieval with citations.
        tools: [{ type: "x_search" }, { type: "web_search" }],
      });
      return ok({
        url: `${trimTrailingSlash(req.route.endpoint)}${XAI_RESPONSES_PATH}`,
        method: "POST",
        headers: bearerHeaders(secret),
        body,
      });
    },
    parseHttpResponse(_status: number, body: string): Result<WireCompletion, ProviderError> {
      const docRes = jsonDoc(XAI, body);
      if (isErr(docRes)) return docRes;
      const doc = docRes.value;
      const answer = extractGrokAnswer(doc);
      if (answer === undefined) {
        return err(providerError("malformed_output", "xai response missing the answer content (content/output_text/output[])"));
      }
      const dossier: ResearchDossier = { answer, citations: verbatimList(doc.citations) };
      return ok({ candidateOutput: dossier, usage: usageBlock(doc) });
    },
  };
}

/**
 * Shared cloud research-provider construction: resolve the key through the injected
 * SecretsPort (a missing/locked key degrades to `auth_unavailable`, retryable —
 * never throws), then dispatch through the injected transport via `executeCompletion`.
 * Cancellation-aware; returns a typed Result. Serves exactly one ProviderId.
 */
function createCloudResearchProvider(
  providerId: ProviderId,
  wire: ModelWireAdapter,
  deps: CloudProviderDeps,
): ModelProviderPort {
  return {
    providerId,
    async complete(req: ProviderRequest, signal?: AbortSignal): Promise<Result<ProviderOutput, ProviderError>> {
      if (signal?.aborted === true) {
        return err(providerError("cancelled", `${providerId} call cancelled before dispatch`));
      }
      const secretRes = await deps.secrets.getSecret(deps.secretRef);
      if (isErr(secretRes)) {
        return err(
          providerError("auth_unavailable", `${providerId} api key unavailable (${secretRes.error.reason}); provider degraded (5.9)`, {
            retryable: true,
          }),
        );
      }
      return executeCompletion({ wire, transport: deps.transport, req, signal, secret: secretRes.value, logSink: deps.logSink });
    },
  };
}

/** Construct the Perplexity Sonar research ModelProviderPort (providerId `perplexity`). */
export function createPerplexityResearchProvider(deps: CloudProviderDeps): ModelProviderPort {
  return createCloudResearchProvider(PERPLEXITY, perplexityResearchWireAdapter(), deps);
}

/** Construct the Grok Live Search research ModelProviderPort (providerId `xai`). */
export function createGrokResearchProvider(deps: CloudProviderDeps): ModelProviderPort {
  return createCloudResearchProvider(XAI, grokResearchWireAdapter(), deps);
}
