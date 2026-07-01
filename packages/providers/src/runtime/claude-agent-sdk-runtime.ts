// @sow/providers — ClaudeAgentSdkRuntimeAdapter (§7 task 5.8, RT-1 / REQ-I-002).
//
// The AgentRuntimePort adapter over the Claude Agent SDK. It drives a full
// AgentJob (tool-policy / MCP / structured-output / subagent semantics) and emits
// ONLY a candidate AgentResult — never a direct Markdown/GBrain write, never a
// call into a write adapter (KN-2 / the strict side-effect rule). GBrain MCP is
// read/query-only for the runtime (REQ-F-019).
//
// The real SDK I/O lives behind an INJECTED `ClaudeAgentTransport`, so this
// module is a PURE request→port-call→normalized-output mapper: it builds the
// invocation from the job (honoring the embedded ToolPolicy — enforced INSIDE the
// runtime, never relaxed), invokes the transport, and maps success/error/cancel
// onto the typed AgentResult / RuntimeError surface. NEVER throws across the
// boundary (§16). Real-SDK conformance is the eval path (5.10), not a unit test.
import type { Result, AgentJob, ContextRef } from "@sow/contracts";
import { ok, err, effectiveAllowedTools, isToolPolicyConsistent } from "@sow/contracts";
import type { AgentResult, AgentUsage, AgentLogEntry } from "../ports/agent-result";
import {
  runtimeError,
  type AgentRuntimePort,
  type RuntimeError,
} from "../ports/agent-runtime-port";
import {
  isAborted,
  abortedBeforeDispatch,
  cancelledResult,
  completedResult,
} from "./runtime-support";

/** The open runtime id this adapter implements (§7 two-port split). */
export const CLAUDE_AGENT_SDK_RUNTIME_ID = "claude-agent-sdk" as const;

/**
 * A resolved invocation the transport turns into a real Claude Agent SDK run.
 * Carries the effective (deny-applied) tool allow-list + the read-only / trust
 * flags so the SDK enforces the ToolPolicy binding INSIDE the runtime. Input
 * material is passed as CONTEXT REFS (references, never inlined raw content —
 * redaction-safe, 5.6).
 */
export interface ClaudeAgentInvocation {
  readonly runtimeId: typeof CLAUDE_AGENT_SDK_RUNTIME_ID;
  readonly model: string;
  readonly endpoint: string;
  readonly capability: string;
  readonly outputSchemaId: string;
  /** Effective allow-list (allowedTools minus deniedTools). May be empty (= no tools). */
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  /** ToolPolicy.mode === "read_only" — the SDK must admit no mutating tool. */
  readonly readOnly: boolean;
  /** ToolPolicy.allowsMutating — carried for the SDK's own admission. */
  readonly allowsMutating: boolean;
  /** trustLevel === "untrusted" (ING-7) — untrusted content runs read-only. */
  readonly untrusted: boolean;
  readonly carriesRawContent: boolean;
  readonly contextRefs: readonly ContextRef[];
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd?: number;
  readonly idempotencyKey: string;
}

/**
 * The raw result an invocation yields, before normalization. `candidateOutput` is
 * unvalidated candidate data. `mutatingToolAttempted` lets the SDK report that the
 * run tried a mutating tool a read_only job forbids — the adapter maps that to a
 * typed `tool_policy_violation`, never a silent allow.
 */
export interface ClaudeAgentRawResult {
  readonly status: "completed" | "cancelled";
  readonly candidateOutput: unknown;
  readonly usage: AgentUsage;
  readonly logs?: readonly AgentLogEntry[];
  readonly mutatingToolAttempted?: boolean;
}

/** Transport-level failure kinds — mapped by the adapter onto RuntimeErrorKind. */
export const ClaudeAgentTransportErrorKind = [
  "auth",
  "unavailable",
  "transport",
  "timeout",
  "cancelled",
  "malformed",
  "tool_violation",
] as const;
export type ClaudeAgentTransportErrorKind = (typeof ClaudeAgentTransportErrorKind)[number];

export interface ClaudeAgentTransportError {
  readonly kind: ClaudeAgentTransportErrorKind;
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * The injected boundary that performs the real Claude Agent SDK run. Substituted
 * by a mock in tests; the concrete implementation does the SDK I/O. Returns a
 * typed Result — never throws.
 */
export interface ClaudeAgentTransport {
  invoke(
    inv: ClaudeAgentInvocation,
    signal?: AbortSignal,
  ): Promise<Result<ClaudeAgentRawResult, ClaudeAgentTransportError>>;
}

// --- transport-error → RuntimeError mapping ---------------------------------

function mapTransportError(e: ClaudeAgentTransportError): RuntimeError {
  switch (e.kind) {
    case "auth":
      return runtimeError("auth_unavailable", e.message, { retryable: e.retryable ?? false });
    case "unavailable":
      // Spawn-if-present: SDK absent/unreachable → runtime_unavailable, held
      // retryable so the ProviderMatrix can re-route (REQ-NF-005).
      return runtimeError("runtime_unavailable", e.message, { retryable: e.retryable ?? true });
    case "transport":
      return runtimeError("transport_error", e.message, { retryable: e.retryable ?? true });
    case "timeout":
      return runtimeError("timeout", e.message, { retryable: e.retryable ?? false });
    case "cancelled":
      return runtimeError("cancelled", e.message, { retryable: false });
    case "malformed":
      return runtimeError("malformed_output", e.message, { retryable: false });
    case "tool_violation":
      return runtimeError("tool_policy_violation", e.message, { retryable: false });
  }
}

/**
 * Build the resolved invocation from an AgentJob, or a typed error if the job is
 * not addressable by this runtime. PURE — the tested request-mapping surface:
 * - the providerRoute must be a RUNTIME route for this adapter (else invalid_job);
 * - defense-in-depth ING-7: an untrusted job MUST be read-only + tool-consistent
 *   (admission already enforces this, 5.5 / §5 — the adapter refuses to relax it).
 */
export function buildClaudeAgentInvocation(
  job: AgentJob,
): Result<ClaudeAgentInvocation, RuntimeError> {
  const route = job.providerRoute;
  if (!("runtime" in route) || route.runtime !== CLAUDE_AGENT_SDK_RUNTIME_ID) {
    return err(
      runtimeError(
        "invalid_job",
        `job route is not a ${CLAUDE_AGENT_SDK_RUNTIME_ID} runtime route`,
      ),
    );
  }
  const untrusted = job.trustLevel === "untrusted";
  const readOnly = job.toolPolicy.mode === "read_only";
  if (!isToolPolicyConsistent(job.toolPolicy)) {
    return err(
      runtimeError("tool_policy_violation", "read_only ToolPolicy admits mutation (inconsistent)"),
    );
  }
  // ING-7: untrusted content must run read-only / no mutating tools.
  if (untrusted && (!readOnly || job.toolPolicy.allowsMutating)) {
    return err(
      runtimeError(
        "tool_policy_violation",
        "untrusted (ING-7) job must run read_only with no mutating tools",
      ),
    );
  }
  return ok({
    runtimeId: CLAUDE_AGENT_SDK_RUNTIME_ID,
    model: route.model,
    endpoint: route.endpoint,
    capability: job.capability,
    outputSchemaId: job.outputSchemaId,
    allowedTools: effectiveAllowedTools(job.toolPolicy),
    deniedTools: [...job.toolPolicy.deniedTools],
    readOnly,
    allowsMutating: job.toolPolicy.allowsMutating,
    untrusted,
    carriesRawContent: job.carriesRawContent,
    contextRefs: job.contextRefs,
    maxRuntimeSeconds: job.maxRuntimeSeconds,
    ...(job.maxCostUsd !== undefined ? { maxCostUsd: job.maxCostUsd } : {}),
    idempotencyKey: job.idempotencyKey,
  });
}

/**
 * Construct the ClaudeAgentSdkRuntimeAdapter over an injected transport. Never
 * throws; every outcome is a typed Result. Emits only a candidate AgentResult.
 */
export function createClaudeAgentSdkRuntime(
  transport: ClaudeAgentTransport,
): AgentRuntimePort {
  return {
    runtimeId: CLAUDE_AGENT_SDK_RUNTIME_ID,
    async runJob(
      job: AgentJob,
      signal?: AbortSignal,
    ): Promise<Result<AgentResult, RuntimeError>> {
      // Cancel before we touch the transport → no side effect (COST-1).
      if (isAborted(signal)) return abortedBeforeDispatch();

      const built = buildClaudeAgentInvocation(job);
      if (built.ok === false) return built;

      const outcome = await transport.invoke(built.value, signal);
      if (outcome.ok === false) return err(mapTransportError(outcome.error));

      const raw = outcome.value;
      // The runtime tried a mutating tool a read_only job forbids — typed failure.
      if (raw.mutatingToolAttempted === true && built.value.readOnly) {
        return err(
          runtimeError("tool_policy_violation", "runtime attempted a mutating tool under a read_only policy"),
        );
      }
      if (raw.status === "cancelled") {
        return ok(cancelledResult(raw.usage.runtimeSeconds));
      }
      return ok(completedResult(raw.candidateOutput, raw.usage, raw.logs ?? []));
    },
  };
}
