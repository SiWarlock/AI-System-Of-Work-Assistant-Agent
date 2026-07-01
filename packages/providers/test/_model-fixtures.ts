// Shared test fixtures for the ModelProviderPort adapters (§7 task 5.7). NOT a
// suite (no `.test.ts`) — a MOCK transport + SecretsPort accessor + ProviderRequest
// builder so adapter tests run with NO real network/API call.
import { ok, err } from "@sow/contracts";
import type { Result, ProviderRoute, Capability, ProviderId } from "@sow/contracts";
import type { ProviderRequest } from "../src/ports/model-provider-port";
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
  SecretsAccessor,
  SecretUnavailable,
} from "../src/model/http-transport";

/** A recording MOCK transport. Returns a canned response OR throws a canned error;
 * captures the last request + signal so a test can assert request-mapping. */
export class MockTransport implements HttpTransport {
  public lastRequest?: HttpTransportRequest;
  public lastSignal?: AbortSignal;
  public calls = 0;
  constructor(
    private readonly outcome:
      | { readonly kind: "response"; readonly response: HttpTransportResponse }
      | { readonly kind: "throw"; readonly error: unknown },
  ) {}
  async send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse> {
    this.calls += 1;
    this.lastRequest = req;
    this.lastSignal = signal;
    if (this.outcome.kind === "throw") throw this.outcome.error;
    return this.outcome.response;
  }
}

export function respondingTransport(status: number, body: string): MockTransport {
  return new MockTransport({ kind: "response", response: { status, body } });
}
export function throwingTransport(error: unknown): MockTransport {
  return new MockTransport({ kind: "throw", error });
}

/** A MOCK SecretsPort accessor. Resolves the ref to a fixed value, or fails with a
 * typed reason (locked/missing/denied) to exercise the degraded path (5.9 / LIFE-6). */
export function secretsReturning(value: string): SecretsAccessor {
  return { getSecret: async (): Promise<Result<string, SecretUnavailable>> => ok(value) };
}
export function secretsUnavailable(reason: SecretUnavailable["reason"]): SecretsAccessor {
  return { getSecret: async (): Promise<Result<string, SecretUnavailable>> => err({ reason }) };
}

/** Build a well-typed OpenAI-compatible chat-completions success body. */
export function openAiBody(jsonPayload: unknown, tokens = { prompt: 11, completion: 7 }): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(jsonPayload) } }],
    usage: { prompt_tokens: tokens.prompt, completion_tokens: tokens.completion },
  });
}

/** Build a well-typed Anthropic Messages API success body. */
export function anthropicBody(jsonPayload: unknown, tokens = { input: 13, output: 9 }): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(jsonPayload) }],
    usage: { input_tokens: tokens.input, output_tokens: tokens.output },
  });
}

const cap = (id: string): Capability => id as unknown as Capability;

/** Build a ProviderRequest for the given provider/endpoint. */
export function makeRequest(overrides?: {
  provider?: ProviderId;
  model?: string;
  endpoint?: string;
  egressClass?: "local" | "cloud";
  outputSchemaId?: string;
}): ProviderRequest {
  const route: ProviderRoute = {
    provider: overrides?.provider ?? "openai",
    model: overrides?.model ?? "gpt-4o",
    endpoint: overrides?.endpoint ?? "https://api.openai.com",
    egressClass: overrides?.egressClass ?? "cloud",
  };
  return {
    route,
    model: overrides?.model ?? "gpt-4o",
    capability: cap("meeting.close"),
    inputRefs: [
      { refKind: "note", ref: "note-123" },
      { refKind: "transcript", ref: "tr-456" },
    ],
    outputSchemaId: overrides?.outputSchemaId ?? "sow:meeting-close-output",
    budget: { maxRuntimeSeconds: 30, maxCostUsd: 1 },
    idempotencyKey: "idem-key-1",
  };
}
