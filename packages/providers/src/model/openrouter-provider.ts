// @sow/providers — OpenRouter ModelProviderPort adapter (§7 task 5.7, REQ-F-015 / ADR-004).
//
// Raw schema-validated completion via OpenRouter's OpenAI-compatible chat API
// (`POST /api/v1/chat/completions`) with NO agentic tool loop. CRITICAL (safety rule
// 5 / 5.3): OpenRouter is its OWN provider/processor — NOT an OpenAI alias. Its
// `providerId` is `openrouter`, its egress classification is distinct, and it is
// conformance-gated independently (5.10). Routing raw Employer-Work content with
// egress ack=false to OpenRouter is vetoed like any other cloud processor. The API
// key comes via the injected SecretsPort accessor (Keychain ref, never inline —
// REQ-S-003), sent as `Authorization: Bearer`, never logged (5.6). Never throws (§16).
import { ok, err, isErr } from "@sow/contracts";
import type { Result, ProviderId } from "@sow/contracts";
import type { ModelProviderPort, ProviderRequest, ProviderOutput, ProviderError } from "../ports/model-provider-port";
import { providerError } from "../ports/model-provider-port";
import {
  executeCompletion,
  trimTrailingSlash,
  buildOpenAiCompatibleRequest,
  parseOpenAiCompatibleResponse,
  type CloudProviderDeps,
  type HttpTransportRequest,
  type ModelWireAdapter,
  type WireCompletion,
} from "./http-transport";

// OpenRouter's own processor id — NEVER "openai". OpenRouter is a distinct processor.
const PROVIDER_ID: ProviderId = "openrouter";
/** OpenRouter's chat-completions path (distinct from OpenAI's `/v1/...`). */
export const OPENROUTER_COMPLETIONS_PATH = "/api/v1/chat/completions" as const;

export function openRouterWireAdapter(): ModelWireAdapter {
  return {
    providerId: PROVIDER_ID,
    buildHttpRequest(
      req: ProviderRequest,
      secret: string | undefined,
    ): Result<HttpTransportRequest, ProviderError> {
      if (secret === undefined || secret.length === 0) {
        return err(
          providerError("auth_unavailable", "openrouter api key unavailable", { retryable: true }),
        );
      }
      return ok(
        buildOpenAiCompatibleRequest({
          providerId: PROVIDER_ID,
          url: `${trimTrailingSlash(req.route.endpoint)}${OPENROUTER_COMPLETIONS_PATH}`,
          model: req.model,
          outputSchemaId: req.outputSchemaId,
          refs: req.inputRefs,
          secret,
        }),
      );
    },
    parseHttpResponse(status: number, body: string): Result<WireCompletion, ProviderError> {
      return parseOpenAiCompatibleResponse(PROVIDER_ID, status, body);
    },
  };
}

/**
 * Construct the OpenRouter ModelProviderPort adapter. Its own processor identity is
 * load-bearing (never an OpenAI alias). Resolves the key through the injected
 * SecretsPort accessor; a missing/locked key degrades the provider. Never throws.
 */
export function createOpenRouterModelProvider(deps: CloudProviderDeps): ModelProviderPort {
  const wire = openRouterWireAdapter();
  return {
    providerId: PROVIDER_ID,
    async complete(
      req: ProviderRequest,
      signal?: AbortSignal,
    ): Promise<Result<ProviderOutput, ProviderError>> {
      if (signal?.aborted === true) {
        return err(providerError("cancelled", "openrouter call cancelled before dispatch"));
      }
      const secretRes = await deps.secrets.getSecret(deps.secretRef);
      if (isErr(secretRes)) {
        return err(
          providerError(
            "auth_unavailable",
            `openrouter api key unavailable (${secretRes.error.reason}); provider degraded (5.9)`,
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
