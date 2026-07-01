// spec(§7) — AgentRuntimePort (agentic runtime) conformance runner (task 5.10).
// Drives ClaudeAgentSdkRuntimeAdapter / HermesRuntimeAdapter (REQ-I-002/003)
// through each conformance case and folds the emitted candidate AgentResult into a
// ConformanceResult via the shared assessment core. The runtime is INJECTED — unit
// tests pass a MOCK runtime (no real SDK/subprocess); real runs are the key-gated
// eval path. Never throws (§16): a typed runtime Err or a cancel becomes `failing`.
import type { AgentRuntimePort } from "@sow/providers/ports/agent-runtime-port";
import { isErr } from "@sow/contracts";
import type { AgentJob, Capability, EgressClass, ConformanceResult } from "@sow/contracts";
import {
  assessCandidate,
  defaultConformanceGate,
  type ConformanceGate,
  type ConformanceSubject,
} from "./conformance-core";

/** One runtime conformance case: the AgentJob the runtime drives + the capability
 * output schema (the gate target) + the egress classification of the runtime. */
export interface RuntimeConformanceCase {
  readonly capability: Capability;
  readonly model: string;
  readonly egressClass: EgressClass;
  readonly outputSchemaId: string;
  readonly job: AgentJob;
}

/**
 * Run every case against `runtime`, producing one ConformanceResult per case.
 * `now` supplies `checkedAt`. DETERMINISTIC given a deterministic runtime.
 */
export async function runRuntimeConformance(
  runtime: AgentRuntimePort,
  cases: readonly RuntimeConformanceCase[],
  now: () => string,
  gate: ConformanceGate = defaultConformanceGate,
  signal?: AbortSignal,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of cases) {
    const subject: ConformanceSubject = {
      kind: "runtime",
      subjectId: runtime.runtimeId,
      capability: c.capability,
      model: c.model,
      egressClass: c.egressClass,
      outputSchemaId: c.outputSchemaId,
    };

    const res = await runtime.runJob(c.job, signal);
    if (isErr(res)) {
      results.push(
        assessCandidate(subject, { ok: false, detail: `runtime_error:${res.error.kind}` }, now(), gate),
      );
      continue;
    }
    const result = res.value;
    if (result.status === "cancelled") {
      results.push(assessCandidate(subject, { ok: false, detail: "cancelled" }, now(), gate));
      continue;
    }
    results.push(
      assessCandidate(subject, { ok: true, candidateOutput: result.candidateOutput }, now(), gate),
    );
  }
  return results;
}

/**
 * Key-gated wrapper for REAL runtime runs (eval path — skip-by-default). Returns
 * `undefined` unless `SOW_RUNTIME_CONFORMANCE` is set. The Claude Agent SDK + Hermes
 * adapters are DoD-tested here, not in the default unit suite.
 */
export async function runRuntimeConformanceIfKeyed(
  runtime: AgentRuntimePort,
  cases: readonly RuntimeConformanceCase[],
  now: () => string,
  gate: ConformanceGate = defaultConformanceGate,
  env: Record<string, string | undefined> = process.env,
): Promise<ConformanceResult[] | undefined> {
  if (!env["SOW_RUNTIME_CONFORMANCE"]) return undefined;
  return runRuntimeConformance(runtime, cases, now, gate);
}
