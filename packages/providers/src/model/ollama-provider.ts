// @sow/providers — Ollama ModelProviderPort adapter (§7 task 5.7, REQ-F-015 / ADR-004).
//
// Raw schema-validated completion via Ollama's OpenAI-compatible endpoint
// (`POST /v1/chat/completions`) with NO agentic tool loop. Ollama binds LOOPBACK and
// is NON-EGRESS (egressClass `local`) — the §5 egress veto's only legal pick for an
// unacknowledged Employer-Work raw-content job (5.3). Its endpoint comes from an
// EXPLICIT local-provider allowlist; an arbitrary/unlisted URL is REJECTED for
// sensitive work. No API key — local providers need no secret. All I/O goes through
// the injected transport (a MOCK in tests). Never throws across the boundary (§16).
import { ok, err, isErr } from "@sow/contracts";
import type { Result, ProviderId } from "@sow/contracts";
import type { ModelProviderPort, ProviderRequest, ProviderOutput, ProviderError } from "../ports/model-provider-port";
import { providerError } from "../ports/model-provider-port";
import {
  executeCompletion,
  trimTrailingSlash,
  assertLocalEndpointAllowed,
  buildOpenAiCompatibleRequest,
  parseOpenAiCompatibleResponse,
  type LocalProviderDeps,
  type HttpTransportRequest,
  type ModelWireAdapter,
  type WireCompletion,
} from "./http-transport";

const PROVIDER_ID: ProviderId = "ollama";
/** Ollama's OpenAI-compatible chat-completions path. */
export const OLLAMA_COMPLETIONS_PATH = "/v1/chat/completions" as const;

export function ollamaWireAdapter(allowedEndpoints: readonly string[]): ModelWireAdapter {
  return {
    providerId: PROVIDER_ID,
    buildHttpRequest(req: ProviderRequest): Result<HttpTransportRequest, ProviderError> {
      // Explicit local allowlist gate — an arbitrary URL is rejected for sensitive work.
      const allowed = assertLocalEndpointAllowed(req.route.endpoint, allowedEndpoints);
      if (isErr(allowed)) return err(allowed.error);
      return ok(
        buildOpenAiCompatibleRequest({
          providerId: PROVIDER_ID,
          url: `${trimTrailingSlash(req.route.endpoint)}${OLLAMA_COMPLETIONS_PATH}`,
          model: req.model,
          outputSchemaId: req.outputSchemaId,
          refs: req.inputRefs,
          // No secret — Ollama is loopback / non-egress (no Authorization header).
        }),
      );
    },
    parseHttpResponse(status: number, body: string): Result<WireCompletion, ProviderError> {
      return parseOpenAiCompatibleResponse(PROVIDER_ID, status, body);
    },
  };
}

/**
 * Construct the Ollama ModelProviderPort adapter. Non-egress loopback provider — no
 * secret; the route endpoint is validated against the explicit allowlist at build
 * time. Cancellation-aware; returns a typed Result — never throws.
 */
export function createOllamaModelProvider(deps: LocalProviderDeps): ModelProviderPort {
  const wire = ollamaWireAdapter(deps.allowedEndpoints);
  return {
    providerId: PROVIDER_ID,
    async complete(
      req: ProviderRequest,
      signal?: AbortSignal,
    ): Promise<Result<ProviderOutput, ProviderError>> {
      if (signal?.aborted === true) {
        return err(providerError("cancelled", "ollama call cancelled before dispatch"));
      }
      return executeCompletion({
        wire,
        transport: deps.transport,
        req,
        signal,
        logSink: deps.logSink,
      });
    },
  };
}
