// AgentJob state machine — DOMAIN_MODEL.md §Agent Job. PURE + TOTAL (built on the
// Foundation `defineMachine` primitive): no clock, no randomness, no I/O; identical
// input ⇒ identical output (replay-safe). Illegal edges, moves out of a terminal
// state, and off-alphabet states all return a typed err(...) — never a throw.
//
// DOMAIN_MODEL.md §63 names the spine + the schema_validated fan-out:
//   created -> admitted -> provider_selected -> running -> schema_validated
//     -> accepted | rejected | cancelled_budget | failed_retryable | failed_terminal
// Two edges come from the task bullets (COST-1 / retry), not the DOMAIN_MODEL diagram
// — both flagged as arch_gap interpretations below.
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";

export const AGENT_JOB_STATES = [
  "created",
  "admitted",
  "provider_selected",
  "running",
  "schema_validated",
  "accepted",
  "rejected",
  "cancelled_budget",
  "failed_retryable",
  "failed_terminal",
] as const;

export type AgentJobState = (typeof AGENT_JOB_STATES)[number];

// Adjacency table. Terminal (frozen) states map to [] — they have no outgoing edges.
const TRANSITIONS: Readonly<Record<AgentJobState, readonly AgentJobState[]>> = {
  created: ["admitted"],
  admitted: ["provider_selected"],
  provider_selected: ["running"],
  // arch_gap: running -> cancelled_budget is NOT in the DOMAIN_MODEL.md §63 diagram;
  // it is added per the task bullet (COST-1 budget breach mid-run, leaving no
  // committed side effect at the state level). Encoded as a direct edge so a
  // mid-run budget cancel stays representable rather than forcing a spurious pass
  // through schema_validated.
  running: ["schema_validated", "cancelled_budget"],
  schema_validated: [
    "accepted",
    "rejected",
    "cancelled_budget",
    "failed_retryable",
    "failed_terminal",
  ],
  // Terminal / frozen.
  accepted: [],
  rejected: [],
  cancelled_budget: [],
  // arch_gap: failed_retryable -> admitted (re-admit/retry) comes from the task
  // bullet, not the DOMAIN_MODEL.md §63 diagram (which lists failed_retryable only
  // as a schema_validated outcome). So failed_retryable is the one non-terminal
  // outcome; the loop back to `admitted` re-enters the spine for a retry.
  failed_terminal: [],
  failed_retryable: ["admitted"],
};

// arch_gap: idempotent terminal re-entry (REQ-F-012, the primitive's opt-in
// `idempotentTerminalReentry`) is NOT enabled here — the task does not call for it
// for AgentJob, so terminal -> same is a typed err(terminal_state) (strict default).
export const agentJobMachine: StateMachine<AgentJobState> =
  defineMachine<AgentJobState>(TRANSITIONS);
