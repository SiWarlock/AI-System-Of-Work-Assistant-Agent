// @sow/providers — AgentRuntimePort (§7 task 5.1, RT-1 / REQ-I-002/003).
//
// AGENTIC runtimes carrying tool-policy / MCP / structured-output / subagent
// semantics (ClaudeAgentSdkRuntimeAdapter, HermesRuntimeAdapter). Distinct layer
// from ModelProviderPort — a single adapter MUST NOT satisfy both ports. Drives
// a full AgentJob (its ToolPolicy binding is enforced INSIDE the runtime, never
// relaxed — 5.8 / ING-7) and returns the shared AgentResult. Cancellation-aware
// so a budget breach (5.4) cancels with no partial side effect. Never throws —
// every outcome is a typed Result (§16 error convention).
import type { Result, AgentJob } from "@sow/contracts";
import type { AgentResult } from "./agent-result";

/** Enumerable failure surface of an agentic runtime. No thrown-string failures (§16). */
export const RuntimeErrorKind = [
  "invalid_job",
  "auth_unavailable",
  "runtime_unavailable",
  // The runtime attempted a mutating tool a read_only job forbids (ties ING-7
  // admission, §5 / 5.8) — a typed failure, never a silent allow.
  "tool_policy_violation",
  "transport_error",
  "timeout",
  "cancelled",
  "malformed_output",
] as const;
export type RuntimeErrorKind = (typeof RuntimeErrorKind)[number];

/** A typed runtime failure. `retryable` steers the Broker's retryable/terminal branch. */
export interface RuntimeError {
  readonly kind: RuntimeErrorKind;
  readonly message: string;
  readonly retryable: boolean;
}

/** Construct a RuntimeError (retryable defaults to false — fail-closed). */
export function runtimeError(
  kind: RuntimeErrorKind,
  message: string,
  opts?: { retryable?: boolean },
): RuntimeError {
  return { kind, message, retryable: opts?.retryable ?? false };
}

/**
 * The agentic-runtime port. An AgentRuntimePort adapter is keyed by an OPEN
 * runtime id (e.g. "claude-agent-sdk" | "hermes") — not the closed ProviderId
 * set — and runs a full AgentJob, emitting only a candidate AgentResult (never a
 * direct Markdown/GBrain write; write-through is forbidden here, KN-2 / REQ-F-019).
 */
export interface AgentRuntimePort {
  /** Open runtime identifier this adapter implements. */
  readonly runtimeId: string;
  /**
   * Drive an AgentJob. Cancellation-aware via `signal`; returns a typed Result —
   * never throws. On cancel/timeout the adapter returns Err with no partial side
   * effect.
   */
  runJob(job: AgentJob, signal?: AbortSignal): Promise<Result<AgentResult, RuntimeError>>;
}
