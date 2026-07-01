// @sow/providers — the shared AgentResult the Broker normalizes (§7 task 5.1).
//
// AgentResult is the envelope BOTH port layers converge on before the schema
// gate (5.5): a `candidateOutput` (candidate data — NEVER applied, NEVER a
// direct write), a usage/cost meter (feeds COST-1 budget accounting, 5.4), and
// an ISOLATED `logs` field the provider-boundary redactor (5.6, §16) strips
// before any log sink. PURE — types + minimal constructors/guards, no imports.

/** Log severity for an isolated, redaction-relevant diagnostic line. */
export const LogLevel = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LogLevel)[number];

/**
 * One diagnostic line emitted by a provider/runtime adapter. Kept ISOLATED on
 * `AgentResult.logs` so the §16 redactor (5.6) is the single owner of scrubbing
 * credential-shaped strings + raw content before any log sink — a raw prompt or
 * secret reaching a sink through any other field is a defect.
 */
export interface AgentLogEntry {
  readonly level: LogLevel;
  readonly message: string;
  /** Wall-clock ms when the line was produced (adapter-supplied; optional). */
  readonly timestampMs?: number;
}

/**
 * Usage/cost meter for one job. `runtimeSeconds` is always present (the COST-1
 * runtime cap is mandatory); the token/cost fields are best-effort — a provider
 * that does not report cost leaves `costUsd` undefined and the Broker estimates.
 */
export interface AgentUsage {
  readonly runtimeSeconds: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * Reported completion status of a driven job. Closed set: a normal finish
 * (`completed`) or a cooperative cancel (`cancelled`). A `cancelled` result
 * carries NO committable output — the strict side-effect rule discards it before
 * any hand-off (REQ-S-007).
 */
export const AgentResultStatus = ["completed", "cancelled"] as const;
export type AgentResultStatus = (typeof AgentResultStatus)[number];

/**
 * The normalized result the Broker feeds into the schema gate (5.5).
 * `candidateOutput` is CANDIDATE DATA — unknown/unvalidated until the gate
 * proves it against the capability schema. It is never applied here.
 */
export interface AgentResult {
  readonly status: AgentResultStatus;
  readonly candidateOutput: unknown;
  readonly usage: AgentUsage;
  readonly logs: readonly AgentLogEntry[];
}

/** A zeroed usage meter — the starting point before any provider call accrues. */
export function emptyUsage(): AgentUsage {
  return { runtimeSeconds: 0 };
}

/** Construct an AgentResult. Pure structural constructor (no validation). */
export function makeAgentResult(fields: {
  status: AgentResultStatus;
  candidateOutput: unknown;
  usage: AgentUsage;
  logs: readonly AgentLogEntry[];
}): AgentResult {
  return {
    status: fields.status,
    candidateOutput: fields.candidateOutput,
    usage: fields.usage,
    logs: fields.logs,
  };
}

/** Type guard: the job finished normally. */
export function isCompleted(r: AgentResult): boolean {
  return r.status === "completed";
}

/** Type guard: the job was cooperatively cancelled (output must be discarded). */
export function isCancelled(r: AgentResult): boolean {
  return r.status === "cancelled";
}
