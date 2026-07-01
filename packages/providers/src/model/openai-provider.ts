// @sow/providers — OpenAI ModelProviderPort adapter (§7 task 5.7, REQ-F-015 / ADR-004).
//
// Raw schema-validated completion via the OpenAI Chat Completions API
// (`POST /v1/chat/completions`) with NO agentic tool loop. OpenAI-compatible
// endpoints are NOT assumed behaviorally identical to any other provider — this
// adapter is conformance-gated per capability×pinned-model (5.10) before eligibility.
// The API key is resolved through the injected SecretsPort accessor from a Keychain
// REFERENCE handle (never inline, REQ-S-003), sent as `Authorization: Bearer`, and
// never logged (5.6). All I/O goes through the injected transport. Never throws (§16).
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

const PROVIDER_ID: ProviderId = "openai";
/** The OpenAI chat-completions path appended to the route's host endpoint. */
export const OPENAI_COMPLETIONS_PATH = "/v1/chat/completions" as const;

export function openAiWireAdapter(): ModelWireAdapter {
  return {
    providerId: PROVIDER_ID,
    buildHttpRequest(
      req: ProviderRequest,
      secret: string | undefined,
    ): Result<HttpTransportRequest, ProviderError> {
      if (secret === undefined || secret.length === 0) {
        return err(
          providerError("auth_unavailable", "openai api key unavailable", { retryable: true }),
        );
      }
      return ok(
        buildOpenAiCompatibleRequest({
          providerId: PROVIDER_ID,
          url: `${trimTrailingSlash(req.route.endpoint)}${OPENAI_COMPLETIONS_PATH}`,
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
 * Construct the OpenAI ModelProviderPort adapter. Resolves the API key through the
 * injected SecretsPort accessor before dispatch; a missing/locked key degrades the
 * provider (auth_unavailable, retryable). Cancellation-aware; returns a typed Result.
 */
export function createOpenAiModelProvider(deps: CloudProviderDeps): ModelProviderPort {
  const wire = openAiWireAdapter();
  return {
    providerId: PROVIDER_ID,
    async complete(
      req: ProviderRequest,
      signal?: AbortSignal,
    ): Promise<Result<ProviderOutput, ProviderError>> {
      if (signal?.aborted === true) {
        return err(providerError("cancelled", "openai call cancelled before dispatch"));
      }
      const secretRes = await deps.secrets.getSecret(deps.secretRef);
      if (isErr(secretRes)) {
        return err(
          providerError(
            "auth_unavailable",
            `openai api key unavailable (${secretRes.error.reason}); provider degraded (5.9)`,
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
