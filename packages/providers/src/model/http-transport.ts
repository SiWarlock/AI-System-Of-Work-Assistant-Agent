// @sow/providers — shared ModelProviderPort adapter infrastructure (§7 task 5.7).
//
// The five raw-model-provider adapters (Claude / OpenAI / OpenRouter / Ollama /
// LM Studio) share the SAME cross-cutting behavior — secret handling posture,
// request dispatch through a DEPENDENCY-INJECTED transport, HTTP-status →
// ProviderError mapping, cancel/timeout classification, output candidate framing,
// and §16 log redaction — and differ ONLY in the wire request/response shape.
// That shared behavior lives here; each adapter file supplies a `ModelWireAdapter`
// with its provider-specific request build + response parse.
//
// DEPENDENCY-INJECTED TRANSPORT (load-bearing for testability + purity): adapters
// NEVER open a socket themselves. All I/O goes through the injected `HttpTransport`
// so unit tests substitute a MOCK transport and assert request→port-call→normalized
// -output + error/cancel mapping — no real network call. Real provider conformance
// is the EVAL path (5.10), never a unit test.
//
// STRICT SIDE-EFFECT RULE (safety): output is only ever framed as a `ProviderOutput`
// CANDIDATE (candidate data, never applied) — the schema gate (5.5) validates it
// downstream. Zero import of any write-adapter package. Never throws across the
// boundary — every outcome is a typed Result (§16).
import { ok, err, isErr } from "@sow/contracts";
import type { Result, ProviderId, ContextRef } from "@sow/contracts";
import type {
  ProviderRequest,
  ProviderOutput,
  ProviderError,
} from "../ports/model-provider-port";
import { providerError } from "../ports/model-provider-port";
import type { AgentUsage, AgentLogEntry } from "../ports/agent-result";
import {
  redactString,
  redactLogs,
  buildSafeProviderLog,
  type SafeProviderLog,
} from "../redaction/provider-log-redaction";

// ── injected transport (the substitution seam) ───────────────────────────────

/** One outbound HTTP request an adapter hands to the injected transport. `body`
 * is a JSON-serialized string; `headers` MAY carry a resolved secret (never logged). */
export interface HttpTransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** The transport's raw response — an HTTP status + a raw body string. The adapter
 * classifies the status and parses the body; the transport does no interpretation. */
export interface HttpTransportResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The DEPENDENCY-INJECTED HTTP transport. `send` performs the real call (behind an
 * adapter in production; a MOCK in tests). Cancellation-aware via `signal`. It MAY
 * reject (network fault / abort / timeout); the executor classifies the throw into
 * a typed ProviderError — the transport itself never returns a ProviderError.
 */
export interface HttpTransport {
  send(req: HttpTransportRequest, signal?: AbortSignal): Promise<HttpTransportResponse>;
}

// ── injected secrets accessor (SecretsPort-shaped, never inline) ──────────────

/** Why a provider secret could not be resolved (REQ-S-003 / LIFE-6). A missing or
 * locked key marks the provider degraded (5.9) rather than failing raw — the adapter
 * maps it to `auth_unavailable` (retryable), never throws. */
export const SecretUnavailableReason = ["missing", "locked", "denied"] as const;
export type SecretUnavailableReason = (typeof SecretUnavailableReason)[number];

export interface SecretUnavailable {
  readonly reason: SecretUnavailableReason;
}

/**
 * SecretsPort-shaped accessor injected into cloud adapters. Resolves a macOS
 * Keychain REFERENCE handle (never an inline key, REQ-S-003) to the secret value.
 * Returns a typed Result — a locked/missing/denied key is an Err, not a throw.
 */
export interface SecretsAccessor {
  getSecret(ref: string): Promise<Result<string, SecretUnavailable>>;
}

// ── injected deps for the two adapter shapes ──────────────────────────────────

/** Optional structured sink for the default-level, redacted provider-boundary log. */
export type ProviderLogSink = (log: SafeProviderLog) => void;

/** Deps a CLOUD adapter (Claude / OpenAI / OpenRouter) needs: a transport, the
 * SecretsPort accessor, and the Keychain reference handle for its key. */
export interface CloudProviderDeps {
  readonly transport: HttpTransport;
  readonly secrets: SecretsAccessor;
  /** Keychain reference handle (e.g. `keychain://providers/openai`). NEVER an inline key. */
  readonly secretRef: string;
  readonly logSink?: ProviderLogSink;
}

/** Deps a LOCAL adapter (Ollama / LM Studio) needs: a transport + an explicit
 * loopback allowlist. No secret — local providers are non-egress. An endpoint not
 * on the allowlist is REJECTED for sensitive work (invalid_request). */
export interface LocalProviderDeps {
  readonly transport: HttpTransport;
  /** Explicit local-provider allowlist; a route endpoint not present is rejected. */
  readonly allowedEndpoints: readonly string[];
  readonly logSink?: ProviderLogSink;
}

// ── the per-provider wire contract ────────────────────────────────────────────

/** The normalized shape a wire adapter extracts from a 2xx response. */
export interface WireCompletion {
  readonly candidateOutput: unknown;
  readonly usage: AgentUsage;
}

/**
 * Provider-specific wire mapping. `buildHttpRequest` maps the resolved
 * ProviderRequest (+ optional secret) to a transport request — or fails closed with
 * a typed ProviderError (e.g. a local allowlist miss → invalid_request).
 * `parseHttpResponse` extracts candidate output + usage from a 2xx body, or fails
 * with `malformed_output`. Both are pure — no I/O.
 */
export interface ModelWireAdapter {
  readonly providerId: ProviderId;
  buildHttpRequest(
    req: ProviderRequest,
    secret: string | undefined,
  ): Result<HttpTransportRequest, ProviderError>;
  parseHttpResponse(status: number, body: string): Result<WireCompletion, ProviderError>;
}

// ── shared mappers ────────────────────────────────────────────────────────────

/** Default per-request output ceiling for a raw completion (the provider APIs
 * require a max-output field). The Broker's budget enforcer (5.4) governs cost/
 * runtime separately; this only bounds a single response. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16000 as const;

/** Strip a single trailing slash so `${endpoint}${path}` never doubles it. */
export function trimTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

/**
 * Map the INPUT REFS into prompt text. Refs are REFERENCES (redaction-safe — 5.6),
 * never inlined raw content: each becomes a `[refKind:ref]` marker the resolved
 * provider prompt carries. Raw Employer-Work content never lands in a request body
 * here (the caller resolves material behind these refs elsewhere).
 */
export function refsToPromptText(refs: readonly ContextRef[]): string {
  if (refs.length === 0) return "[no-input-refs]";
  return refs.map((r) => `[${r.refKind}:${r.ref}]`).join("\n");
}

/**
 * Map a non-2xx HTTP status to a typed ProviderError. The retryable flag steers the
 * Broker's retryable/terminal branch (§16). 401/403 → auth_unavailable (retryable —
 * unlock/rotate then re-drive, LIFE-6); 404 → model_unavailable; 408 → timeout; 429
 * → rate_limited; 5xx → transport_error (retryable). Anything else fails closed.
 */
export function providerErrorFromStatus(status: number): ProviderError {
  if (status === 400 || status === 422) {
    return providerError("invalid_request", `provider rejected request (HTTP ${status})`);
  }
  if (status === 401 || status === 403) {
    return providerError(
      "auth_unavailable",
      `provider authentication rejected (HTTP ${status})`,
      { retryable: true },
    );
  }
  if (status === 404) {
    return providerError("model_unavailable", `provider model/endpoint not found (HTTP ${status})`);
  }
  if (status === 408) {
    return providerError("timeout", `provider request timed out (HTTP ${status})`, {
      retryable: true,
    });
  }
  if (status === 429) {
    return providerError("rate_limited", `provider rate limited (HTTP ${status})`, {
      retryable: true,
    });
  }
  if (status >= 500) {
    return providerError("transport_error", `provider server error (HTTP ${status})`, {
      retryable: true,
    });
  }
  return providerError("transport_error", `unexpected provider status (HTTP ${status})`);
}

/**
 * Classify a transport throw/reject into a typed ProviderError. An aborted signal
 * → `cancelled` (cooperative cancel — a budget breach, 5.4, cancels with no partial
 * side effect). A name/code hinting a timeout → `timeout`. Otherwise `transport_error`.
 * The thrown message is REDACTED (5.6) before it enters the typed message — a secret
 * echoed by a transport fault never survives into a sink.
 */
export function classifyTransportThrow(e: unknown, signal?: AbortSignal): ProviderError {
  if (signal?.aborted === true) {
    return providerError("cancelled", "provider call cancelled (signal aborted)");
  }
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  const rawMessage =
    typeof e === "object" && e !== null && "message" in e
      ? String((e as { message: unknown }).message)
      : String(e);
  const safeMessage = redactString(rawMessage);
  if (name === "AbortError") {
    return providerError("cancelled", "provider call cancelled (abort)");
  }
  if (name === "TimeoutError" || /timeout|etimedout/i.test(name)) {
    return providerError("timeout", `provider transport timeout: ${safeMessage}`, {
      retryable: true,
    });
  }
  return providerError("transport_error", `provider transport error: ${safeMessage}`, {
    retryable: true,
  });
}

// ── the shared executor ───────────────────────────────────────────────────────

function statusLog(providerId: ProviderId, message: string): AgentLogEntry {
  // A non-content diagnostic line; still routed through the redactor before any sink.
  return { level: "info", message: `provider ${providerId}: ${message}` };
}

function emitLog(
  sink: ProviderLogSink | undefined,
  providerId: ProviderId,
  status: string,
  logs: readonly AgentLogEntry[],
): void {
  if (sink === undefined) return;
  sink(buildSafeProviderLog({ providerId, status, logs }));
}

/**
 * Run one completion: build the wire request, dispatch it through the injected
 * transport, classify the outcome, and frame a 2xx body as a candidate
 * `ProviderOutput`. Every log the adapter emits (including any diagnostic derived
 * from a transport throw) is REDACTED (5.6) before it reaches the optional sink AND
 * before it rides on `ProviderOutput.logs`. Cancellation-aware; never throws.
 *
 * The returned output is CANDIDATE DATA — the schema gate (5.5) validates it before
 * it can become a KnowledgeMutationPlan / ProposedAction. This function performs no
 * write and never touches Markdown / an external system.
 */
export async function executeCompletion(params: {
  readonly wire: ModelWireAdapter;
  readonly transport: HttpTransport;
  readonly req: ProviderRequest;
  readonly signal?: AbortSignal;
  readonly secret?: string;
  readonly logSink?: ProviderLogSink;
}): Promise<Result<ProviderOutput, ProviderError>> {
  const { wire, transport, req, signal, secret, logSink } = params;
  const providerId = wire.providerId;

  // Pre-dispatch cancel check (a budget breach can cancel before the call fires).
  if (signal?.aborted === true) {
    const e = providerError("cancelled", "provider call cancelled before dispatch");
    emitLog(logSink, providerId, "cancelled", [statusLog(providerId, e.message)]);
    return err(e);
  }

  const built = wire.buildHttpRequest(req, secret);
  if (isErr(built)) {
    emitLog(logSink, providerId, built.error.kind, [statusLog(providerId, built.error.message)]);
    return err(built.error);
  }

  let response: HttpTransportResponse;
  try {
    response = await transport.send(built.value, signal);
  } catch (thrown) {
    const e = classifyTransportThrow(thrown, signal);
    emitLog(logSink, providerId, e.kind, [statusLog(providerId, e.message)]);
    return err(e);
  }

  if (response.status < 200 || response.status >= 300) {
    const e = providerErrorFromStatus(response.status);
    emitLog(logSink, providerId, e.kind, [statusLog(providerId, e.message)]);
    return err(e);
  }

  const parsed = wire.parseHttpResponse(response.status, response.body);
  if (isErr(parsed)) {
    emitLog(logSink, providerId, parsed.error.kind, [statusLog(providerId, parsed.error.message)]);
    return err(parsed.error);
  }

  const logs = redactLogs([statusLog(providerId, `completion ok (HTTP ${response.status})`)]);
  emitLog(logSink, providerId, "completed", logs);
  const output: ProviderOutput = {
    status: "completed",
    candidateOutput: parsed.value.candidateOutput,
    usage: parsed.value.usage,
    logs,
  };
  return ok(output);
}

// ── OpenAI-compatible wire (OpenAI / OpenRouter / Ollama / LM Studio) ──────────
//
// These four providers speak the OpenAI Chat Completions shape. They are NOT assumed
// behaviorally identical (each is conformance-gated per capability×model at 5.10 —
// OpenRouter is its OWN processor, never an OpenAI alias) — but the request build +
// response parse are structurally shared, so they're authored once here and each
// adapter supplies its providerId, endpoint path, and auth mode.

/** Build an OpenAI-compatible chat-completions request with a JSON-Schema
 * structured-output declaration (so 5.4/5.5 can act). `secret` is present for cloud
 * providers (Bearer auth) and absent for loopback local providers (no auth). */
export function buildOpenAiCompatibleRequest(config: {
  readonly providerId: ProviderId;
  readonly url: string;
  readonly model: string;
  readonly outputSchemaId: string;
  readonly refs: readonly ContextRef[];
  readonly secret?: string;
}): HttpTransportRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.secret !== undefined) {
    headers["Authorization"] = `Bearer ${config.secret}`;
  }
  const body = JSON.stringify({
    model: config.model,
    max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: refsToPromptText(config.refs) }],
    // Structured-output request path — a schema-validated completion with NO agentic
    // tool loop (REQ-F-015). The concrete schema is resolved/validated by the gate
    // (5.5); the adapter only DECLARES the structured shape by id.
    response_format: {
      type: "json_schema",
      json_schema: { name: config.outputSchemaId, strict: true },
    },
  });
  return { url: config.url, method: "POST", headers, body };
}

interface OpenAiChoiceMessage {
  readonly content?: unknown;
}
interface OpenAiChoice {
  readonly message?: OpenAiChoiceMessage;
}
interface OpenAiUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
}
interface OpenAiResponseBody {
  readonly choices?: readonly OpenAiChoice[];
  readonly usage?: OpenAiUsage;
}

/** Parse an OpenAI-compatible 2xx body: the first choice's message content is the
 * model's JSON, parsed into a candidate object. A missing choice or non-JSON content
 * → `malformed_output`. Token counts fold into usage (best-effort). */
export function parseOpenAiCompatibleResponse(
  providerId: ProviderId,
  status: number,
  body: string,
): Result<WireCompletion, ProviderError> {
  let doc: OpenAiResponseBody;
  try {
    doc = JSON.parse(body) as OpenAiResponseBody;
  } catch {
    return err(providerError("malformed_output", `${providerId} response body was not valid JSON`));
  }
  const choice = doc.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    return err(
      providerError("malformed_output", `${providerId} response missing choices[0].message.content`),
    );
  }
  let candidateOutput: unknown;
  try {
    candidateOutput = JSON.parse(content);
  } catch {
    return err(
      providerError("malformed_output", `${providerId} completion content was not valid JSON`),
    );
  }
  return ok({ candidateOutput, usage: usageFrom(doc.usage?.prompt_tokens, doc.usage?.completion_tokens) });
}

/** Fold optional numeric token counts into an AgentUsage (runtimeSeconds is metered
 * by the Broker's cost meter, 5.4 — the adapter reports 0 here). */
export function usageFrom(inputTokens: unknown, outputTokens: unknown): AgentUsage {
  const usage: {
    runtimeSeconds: number;
    inputTokens?: number;
    outputTokens?: number;
  } = { runtimeSeconds: 0 };
  if (typeof inputTokens === "number" && Number.isFinite(inputTokens)) usage.inputTokens = inputTokens;
  if (typeof outputTokens === "number" && Number.isFinite(outputTokens)) usage.outputTokens = outputTokens;
  return usage;
}

/** Guard: a route endpoint must be on the explicit local allowlist, else the local
 * provider is rejected for sensitive work (an arbitrary/unlisted URL is not routable). */
export function assertLocalEndpointAllowed(
  endpoint: string,
  allowed: readonly string[],
): Result<string, ProviderError> {
  if (!allowed.includes(endpoint)) {
    return err(
      providerError(
        "invalid_request",
        "local provider endpoint is not on the explicit allowlist (arbitrary URL rejected for sensitive work)",
      ),
    );
  }
  return ok(endpoint);
}
