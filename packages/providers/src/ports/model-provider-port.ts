// @sow/providers — ModelProviderPort (§7 task 5.1, REQ-F-015 / ADR-004).
//
// RAW model providers: schema-validated latent extraction/synthesis WITHOUT an
// agentic tool loop (Claude, OpenAI, OpenRouter, Ollama, LM Studio). Distinct
// from AgentRuntimePort — "Claude" appears in both layers intentionally (Claude
// *model* provider here vs Claude *Agent SDK* runtime there); a single adapter
// MUST NOT satisfy both ports. Cancellation-aware (an AbortSignal) so a budget
// breach (5.4) cancels with no partial side effect. Never throws across the
// boundary — every outcome is a typed Result (§16 error convention).
import type { Result, ProviderRoute, Capability, ContextRef, ProviderId } from "@sow/contracts";
import type { AgentResultStatus, AgentUsage, AgentLogEntry } from "./agent-result";

/** Per-job budget pins the request carries (COST-1). Enforced by the Broker (5.4). */
export interface ProviderBudget {
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd?: number;
}

/**
 * A resolved completion request. Carries the resolved ProviderRoute + model, the
 * INPUT REFS (references, never inlined raw content — redaction-safe, 5.6), the
 * capability's output schema id (the gate target, 5.5), and the budget. The
 * adapter maps this to a real provider call behind the port.
 */
export interface ProviderRequest {
  readonly route: ProviderRoute;
  readonly model: string;
  readonly capability: Capability;
  /** References to prompt/input material — resolved by the caller, not inlined. */
  readonly inputRefs: readonly ContextRef[];
  readonly outputSchemaId: string;
  readonly budget: ProviderBudget;
  readonly idempotencyKey: string;
}

/**
 * Raw provider output. `candidateOutput` is CANDIDATE DATA — never applied; the
 * Broker's schema gate (5.5) validates it before it becomes a
 * KnowledgeMutationPlan / ProposedAction. `logs` is the isolated redaction
 * surface (5.6).
 */
export interface ProviderOutput {
  readonly status: AgentResultStatus;
  readonly candidateOutput: unknown;
  readonly usage: AgentUsage;
  readonly logs: readonly AgentLogEntry[];
}

/** Enumerable failure surface of a raw provider call. No thrown-string failures (§16). */
export const ProviderErrorKind = [
  "invalid_request",
  "auth_unavailable",
  "model_unavailable",
  "transport_error",
  "rate_limited",
  "timeout",
  "cancelled",
  "malformed_output",
] as const;
export type ProviderErrorKind = (typeof ProviderErrorKind)[number];

/** A typed provider failure. `retryable` steers the Broker's retryable/terminal branch. */
export interface ProviderError {
  readonly kind: ProviderErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

/** Construct a ProviderError (retryable defaults to false — fail-closed). */
export function providerError(
  kind: ProviderErrorKind,
  message: string,
  opts?: { retryable?: boolean },
): ProviderError {
  return { kind, message, retryable: opts?.retryable ?? false };
}

/**
 * The raw-model-provider port. A ModelProviderPort adapter serves exactly one
 * `providerId` and does schema-validated completion with NO agentic tool loop.
 */
export interface ModelProviderPort {
  /** The closed ProviderId this adapter serves (claude|openai|openrouter|ollama|lm_studio). */
  readonly providerId: ProviderId;
  /**
   * Perform a completion. Cancellation-aware via `signal`; returns a typed
   * Result — never throws. On cancel/timeout the adapter returns Err with no
   * partial side effect.
   */
  complete(
    req: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<Result<ProviderOutput, ProviderError>>;
}
