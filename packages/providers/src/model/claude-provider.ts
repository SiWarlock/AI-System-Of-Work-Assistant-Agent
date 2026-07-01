// @sow/providers — Claude ModelProviderPort adapter (§7 task 5.7, REQ-F-015 / ADR-004).
//
// The Claude *model* provider — schema-validated extraction/synthesis via the
// Anthropic Messages API (`POST /v1/messages`) with NO agentic tool loop. This is
// DISTINCT from the Claude Agent SDK *runtime* adapter (5.8): "Claude" appears in
// both layers intentionally and a single adapter MUST NOT satisfy both ports.
//
// The API key is resolved through the injected SecretsPort accessor from a Keychain
// REFERENCE handle (never inline, REQ-S-003) and sent on the `x-api-key` header; it
// is never logged (5.6). A missing/locked key marks the provider degraded (5.9)
// rather than failing raw. All I/O goes through the injected transport — a MOCK in
// tests, never a real call. Never throws across the boundary (§16).
import { ok, err, isErr } from "@sow/contracts";
import type { Result, ProviderId } from "@sow/contracts";
import type { ModelProviderPort, ProviderRequest, ProviderOutput, ProviderError } from "../ports/model-provider-port";
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

/** The Anthropic API version header value the Messages API requires. */
export const ANTHROPIC_VERSION = "2023-06-01" as const;
const PROVIDER_ID: ProviderId = "claude";

interface AnthropicTextBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}
interface AnthropicUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
}
interface AnthropicMessageBody {
  readonly content?: readonly AnthropicTextBlock[];
  readonly usage?: AnthropicUsage;
}

/** The Claude wire mapping — the Messages API request shape + response parse. */
export function claudeWireAdapter(secretRef: string): ModelWireAdapter {
  void secretRef; // secret is injected at build time; ref only names the Keychain handle
  return {
    providerId: PROVIDER_ID,
    buildHttpRequest(
      req: ProviderRequest,
      secret: string | undefined,
    ): Result<HttpTransportRequest, ProviderError> {
      if (secret === undefined || secret.length === 0) {
        // Should not happen (the factory resolves the secret first) — fail closed.
        return err(
          providerError("auth_unavailable", "claude api key unavailable", { retryable: true }),
        );
      }
      const url = `${trimTrailingSlash(req.route.endpoint)}/v1/messages`;
      const body = JSON.stringify({
        model: req.model,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: refsToPromptText(req.inputRefs) }],
        // Structured-output request path (no agentic tool loop). The concrete schema
        // is validated by the gate (5.5); the adapter declares the shape by id.
        output_config: { format: { type: "json_schema", schema: { $id: req.outputSchemaId } } },
      });
      return ok({
        url,
        method: "POST",
        headers: {
          "x-api-key": secret,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body,
      });
    },
    parseHttpResponse(status: number, body: string): Result<WireCompletion, ProviderError> {
      let doc: AnthropicMessageBody;
      try {
        doc = JSON.parse(body) as AnthropicMessageBody;
      } catch {
        return err(providerError("malformed_output", "claude response body was not valid JSON"));
      }
      const textBlock = doc.content?.find(
        (b) => b != null && b.type === "text" && typeof b.text === "string",
      );
      const text = textBlock?.text;
      if (typeof text !== "string") {
        return err(
          providerError("malformed_output", "claude response missing a text content block"),
        );
      }
      let candidateOutput: unknown;
      try {
        candidateOutput = JSON.parse(text);
      } catch {
        return err(
          providerError("malformed_output", "claude completion text was not valid JSON"),
        );
      }
      return ok({
        candidateOutput,
        usage: usageFrom(doc.usage?.input_tokens, doc.usage?.output_tokens),
      });
    },
  };
}

/**
 * Construct the Claude ModelProviderPort adapter. Resolves the API key through the
 * injected SecretsPort accessor before dispatch; a missing/locked key degrades the
 * provider (auth_unavailable, retryable) rather than failing raw. Cancellation-aware;
 * returns a typed Result — never throws.
 */
export function createClaudeModelProvider(deps: CloudProviderDeps): ModelProviderPort {
  const wire = claudeWireAdapter(deps.secretRef);
  return {
    providerId: PROVIDER_ID,
    async complete(
      req: ProviderRequest,
      signal?: AbortSignal,
    ): Promise<Result<ProviderOutput, ProviderError>> {
      if (signal?.aborted === true) {
        return err(providerError("cancelled", "claude call cancelled before dispatch"));
      }
      const secretRes = await deps.secrets.getSecret(deps.secretRef);
      if (isErr(secretRes)) {
        return err(
          providerError(
            "auth_unavailable",
            `claude api key unavailable (${secretRes.error.reason}); provider degraded (5.9)`,
            { retryable: true },
          ),
        );
      }
      return executeCompletion({
        wire,
        transport: deps.transport,
        req,
        signal,
        secret: secretRes.value,
        logSink: deps.logSink,
      });
    },
  };
}
