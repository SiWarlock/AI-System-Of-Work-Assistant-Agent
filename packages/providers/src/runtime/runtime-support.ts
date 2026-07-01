// @sow/providers — shared AgentRuntimePort adapter support (§7 task 5.8, §16).
//
// Small PURE helpers both runtime adapters (ClaudeAgentSdkRuntimeAdapter,
// HermesRuntimeAdapter) share so the request→port-call→normalized-output mapping
// stays identical across them: pre-dispatch cancel, the cooperative-cancel
// envelope (NO committable output — the strict side-effect rule discards it), and
// completed-run normalization with the §16 log redactor applied. No I/O, no
// clock, no throw across a boundary.
import type { Result } from "@sow/contracts";
import { err } from "@sow/contracts";
import type { AgentResult, AgentUsage, AgentLogEntry } from "../ports/agent-result";
import { makeAgentResult } from "../ports/agent-result";
import { redactLogs } from "../redaction/provider-log-redaction";
import { runtimeError, type RuntimeError } from "../ports/agent-runtime-port";

/** True iff the caller's cancellation signal is already aborted. Pure. */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * The typed outcome for a dispatch cancelled BEFORE the transport is touched:
 * `Err(cancelled)`. The adapter returns this without invoking its injected
 * transport, so there is provably no partial side effect (COST-1).
 */
export function abortedBeforeDispatch(): Result<AgentResult, RuntimeError> {
  return err(runtimeError("cancelled", "aborted before dispatch"));
}

/**
 * A cooperative-cancel AgentResult. A `cancelled` result carries NO committable
 * output — the strict side-effect rule (REQ-S-007) discards it before any
 * hand-off — so `candidateOutput` is forced to `undefined` regardless of any
 * partial bytes the transport may have surfaced. Pure.
 */
export function cancelledResult(runtimeSeconds = 0): AgentResult {
  return makeAgentResult({
    status: "cancelled",
    candidateOutput: undefined,
    usage: { runtimeSeconds },
    logs: [],
  });
}

/**
 * Normalize a completed run into the shared envelope. `candidateOutput` is
 * CANDIDATE DATA — passed through verbatim, never applied here (the schema gate
 * 5.5 validates it downstream). `logs` are run through the §16 provider-boundary
 * redactor (5.6) so no credential-shaped string survives into the envelope. Pure.
 */
export function completedResult(
  candidateOutput: unknown,
  usage: AgentUsage,
  logs: readonly AgentLogEntry[] = [],
): AgentResult {
  return makeAgentResult({
    status: "completed",
    candidateOutput,
    usage,
    logs: redactLogs(logs),
  });
}
