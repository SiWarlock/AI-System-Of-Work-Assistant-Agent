// @sow/providers — broker AgentJob lifecycle cursor (§7 task 5.2).
//
// A thin, IMMUTABLE cursor over the FROZEN @sow/domain AgentJob state machine
// (`agentJobMachine`). It does NOT re-invent lifecycle edges — every advance is
// delegated to the domain machine's adjacency, so the spine ordering (created →
// admitted → provider_selected → running → schema_validated → accepted, with the
// branch fan-out) and the "skipping admitted / provider_selected is forbidden"
// rule are inherited, not duplicated. PURE + replay-safe: `advance` returns a NEW
// cursor and never mutates the receiver; identical input ⇒ identical output.
// Never throws — an illegal / terminal edge is the domain machine's typed
// `TransitionError` (§16).
import { agentJobMachine } from "@sow/domain";
import type { Result } from "@sow/contracts";
import type { AgentJobState } from "@sow/domain";
import type { TransitionError } from "@sow/domain";

export type { AgentJobState } from "@sow/domain";
export type { TransitionError } from "@sow/domain";

/**
 * The ordered NON-TERMINAL spine the broker drives a job along. Terminal outcomes
 * are the `JOB_BRANCHES` below. Mirrors the domain adjacency; exported so the
 * broker (and tests) can pin the ordering without re-deriving it.
 */
export const BROKER_SPINE = [
  "created",
  "admitted",
  "provider_selected",
  "running",
  "schema_validated",
] as const;

/** The terminal branch outcomes of a driven job (the schema_validated fan-out + the mid-run cancel). */
export const JOB_BRANCHES = [
  "accepted",
  "rejected",
  "cancelled_budget",
  "failed_retryable",
  "failed_terminal",
] as const;

export type JobBranch = (typeof JOB_BRANCHES)[number];

const BRANCH_SET: ReadonlySet<string> = new Set<string>(JOB_BRANCHES);

/** True iff `s` names one of the five terminal branch outcomes. Pure. */
export function isJobBranch(s: string): s is JobBranch {
  return BRANCH_SET.has(s);
}

/** The state every broker-driven job starts in. */
export function initialJobState(): AgentJobState {
  return "created";
}

/**
 * An immutable lifecycle cursor. `advance` delegates to the domain machine and,
 * on a legal edge, returns a FRESH cursor at the new state — the receiver is
 * never mutated, so re-driving from an earlier cursor is deterministic
 * (replay-safe). On an illegal / terminal edge it returns the domain machine's
 * typed `TransitionError` (never a throw).
 */
export interface JobLifecycle {
  readonly state: AgentJobState;
  readonly isTerminal: boolean;
  advance(to: AgentJobState): Result<JobLifecycle, TransitionError>;
}

/** Build a lifecycle cursor at `initial` (default `created`). Pure. */
export function newJobLifecycle(initial: AgentJobState = "created"): JobLifecycle {
  return {
    state: initial,
    isTerminal: agentJobMachine.isTerminal(initial),
    advance(to: AgentJobState): Result<JobLifecycle, TransitionError> {
      const r = agentJobMachine.transition(initial, to);
      if (!r.ok) return r;
      return { ok: true, value: newJobLifecycle(r.value) };
    },
  };
}
