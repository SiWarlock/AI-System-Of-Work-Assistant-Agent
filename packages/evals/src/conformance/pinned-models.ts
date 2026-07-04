// spec(§7 · §20.2 · REQ-I-001/002) — the PINNED conformance model set (task 12.5).
//
// The release-gate suite runs provider/runtime conformance over a SMALL, EXPLICIT
// table of (subject × capability × pinned-model) pairs — the exact set the §7
// matrix-eligibility gate and the meeting.close DoD gate certify against. Pinning
// the model per subject is the point: "conformance is the contract" is proven for
// a NAMED model, not a floating "latest" — a model swap re-runs conformance.
//
// PURE DATA + pure helpers — no clock, no network, no randomness, NO new contract
// (every field reuses a frozen @sow/contracts primitive). The `route` a provider
// pin carries is the frozen ProviderRoute provider-branch; a runtime pin carries
// its egressClass directly (runtime conformance drives an AgentJob, not a route).
//
// `optional: true` marks a LOCAL zero-egress pair (Ollama / LM Studio). Per §7 a
// local-conformance failure is NEVER release-blocking — the release gate asserts a
// conformant CLOUD subject exists for meeting.close; local pairs are a bonus path.
import type { Capability, EgressClass, ProviderId, ProviderRoute } from "@sow/contracts";
import type { ConformanceSubjectKind } from "@sow/contracts";

/** One pinned (subject × capability × model) pair to run conformance over. */
export interface PinnedModel {
  /** `provider` = a ModelProviderPort subject; `runtime` = an AgentRuntimePort subject. */
  readonly subjectKind: ConformanceSubjectKind;
  /** The conformance `subjectId`: a ProviderId for a provider, an open runtime id for a runtime. */
  readonly subjectId: string;
  /** The closed ProviderId for a provider pin (used to build the ProviderRoute); `null` for a runtime pin. */
  readonly provider: ProviderId | null;
  readonly capability: Capability;
  /** The PINNED model id (§7 arch_gap: open string — no upstream catalog). */
  readonly model: string;
  /** Resolved endpoint address (cloud base URL or a local loopback host:port). */
  readonly endpoint: string;
  /** `local` = a NON-EGRESS (zero-egress) subject; `cloud` = an egress subject. */
  readonly egressClass: EgressClass;
  /**
   * A LOCAL zero-egress pair that is OPTIONAL — its conformance is never a release
   * gate (§7 "Local providers optional zero-egress path, not release gate").
   */
  readonly optional: boolean;
}

const MEETING_CLOSE = "meeting.close" as Capability;

/**
 * The pinned model set. Two OpenAI-compatible CLOUD providers (OpenRouter + OpenAI)
 * are pinned SEPARATELY on purpose — §7 does not assume OpenAI-compatible endpoints
 * behave identically, so each is proven against the schema gate on its own. The
 * Ollama pin is the OPTIONAL local zero-egress path; the claude-agent-sdk pin is the
 * runtime-layer subject (REQ-I-002).
 */
export const PINNED_MODELS: readonly PinnedModel[] = [
  {
    subjectKind: "provider",
    subjectId: "claude",
    provider: "claude",
    capability: MEETING_CLOSE,
    model: "claude-opus-4",
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
    optional: false,
  },
  {
    subjectKind: "provider",
    subjectId: "openrouter",
    provider: "openrouter",
    capability: MEETING_CLOSE,
    model: "anthropic/claude-haiku-4.5",
    endpoint: "https://openrouter.ai/api/v1",
    egressClass: "cloud",
    optional: false,
  },
  {
    subjectKind: "provider",
    subjectId: "openai",
    provider: "openai",
    capability: MEETING_CLOSE,
    model: "gpt-4o",
    endpoint: "https://api.openai.com/v1",
    egressClass: "cloud",
    optional: false,
  },
  {
    subjectKind: "provider",
    subjectId: "ollama",
    provider: "ollama",
    capability: MEETING_CLOSE,
    model: "llama3.1",
    endpoint: "http://127.0.0.1:11434",
    egressClass: "local",
    optional: true,
  },
  {
    subjectKind: "runtime",
    subjectId: "claude-agent-sdk",
    provider: null,
    capability: MEETING_CLOSE,
    model: "claude-opus-4",
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
    optional: false,
  },
] as const;

/** Enumerate every pinned pair (the whole table). */
export function enumeratePinnedPairs(): readonly PinnedModel[] {
  return PINNED_MODELS;
}

/** The provider-layer pins (ModelProviderPort subjects). */
export function pinnedProviderPairs(): readonly PinnedModel[] {
  return PINNED_MODELS.filter((p) => p.subjectKind === "provider");
}

/** The runtime-layer pins (AgentRuntimePort subjects). */
export function pinnedRuntimePairs(): readonly PinnedModel[] {
  return PINNED_MODELS.filter((p) => p.subjectKind === "runtime");
}

/**
 * Build the frozen ProviderRoute (provider-branch) for a provider pin — the route the
 * provider-conformance runner classifies (egressClass) and completes against. Throws
 * for a runtime pin (which has no ProviderId / route).
 */
export function pinnedProviderRoute(pin: PinnedModel): ProviderRoute {
  if (pin.provider === null) {
    throw new Error(`pinnedProviderRoute: ${pin.subjectId} is a runtime pin (no ProviderRoute)`);
  }
  return {
    provider: pin.provider,
    model: pin.model,
    endpoint: pin.endpoint,
    egressClass: pin.egressClass,
  };
}
