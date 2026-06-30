// Meeting Closeout state machine (DOMAIN_MODEL.md §Meeting Closeout, task 1.12).
//
// Happy path (DOMAIN_MODEL literal):
//   detected → correlated → context_loaded → agent_extracted → validated →
//   knowledge_committed → (external_actions_pending | external_actions_applied) →
//   summarized
//
// Failure/recovery states, each reachable FROM its specified point:
//   needs_routing_review (from correlated — low-confidence routing)
//   provider_failed      (from agent_extracted — the provider/extraction step)
//   schema_rejected      (from validated — the schema gate, REQ-S-006)
//   write_conflict       (from knowledge_committed — KnowledgeWriter conflict)
//   approval_pending     (from external_actions_pending — action needs approval)
//   outbox_retry         (from external_actions_* — outbox dispatch retry)
//   completed_with_warnings (terminal alternative to summarized)
//
// PURE + TOTAL (built on the Foundation `defineMachine` primitive): legal edges
// return ok(to); illegal edges return err(illegal_transition); leaving a
// terminal returns err(terminal_state); unknown states never throw. Terminals
// (summarized, completed_with_warnings) are frozen. No clock/random/I/O —
// identical input ⇒ identical output (replay-safe).
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";

export const MEETING_CLOSEOUT_STATES = [
  // happy path
  "detected",
  "correlated",
  "context_loaded",
  "agent_extracted",
  "validated",
  "knowledge_committed",
  "external_actions_pending",
  "external_actions_applied",
  // failure / recovery
  "needs_routing_review",
  "provider_failed",
  "schema_rejected",
  "write_conflict",
  "approval_pending",
  "outbox_retry",
  // terminals
  "summarized",
  "completed_with_warnings",
] as const;

export type MeetingCloseoutState = (typeof MEETING_CLOSEOUT_STATES)[number];

// Adjacency table: transitions[from] = legal successors. A zero-length list is a
// terminal (frozen) state. Pinned edges (spec / task bullets) are unmarked;
// edges the spec does not pin are marked `arch_gap` and reported in flags.
const transitions: Readonly<
  Record<MeetingCloseoutState, readonly MeetingCloseoutState[]>
> = {
  detected: ["correlated"],
  // correlated → needs_routing_review is the low-confidence-routing entry (pinned).
  correlated: ["context_loaded", "needs_routing_review"],
  context_loaded: ["agent_extracted"],
  // agent_extracted → provider_failed: the provider/extraction step failed (pinned entry).
  agent_extracted: ["validated", "provider_failed"],
  // validated → schema_rejected: candidate failed the JSON-Schema gate (pinned entry).
  validated: ["knowledge_committed", "schema_rejected"],
  // knowledge_committed branches to both external_actions_* (happy) and to
  // write_conflict (pinned entry — a KnowledgeWriter write conflict).
  knowledge_committed: [
    "external_actions_pending",
    "external_actions_applied",
    "write_conflict",
  ],
  // external_actions_pending: spec literal `(...pending|...applied)→summarized`,
  // so pending→summarized is direct. approval_pending + outbox_retry are pinned
  // failure entries from external_actions_*.
  // arch_gap: pending→external_actions_applied (advance after dispatch) and
  // arch_gap: pending→completed_with_warnings (terminal alt) are unpinned.
  external_actions_pending: [
    "external_actions_applied",
    "approval_pending",
    "outbox_retry",
    "summarized",
    "completed_with_warnings",
  ],
  // external_actions_applied → summarized is the happy terminal; → outbox_retry
  // is a pinned external_actions_* failure entry.
  // arch_gap: applied→completed_with_warnings (terminal alt) is unpinned.
  external_actions_applied: [
    "summarized",
    "outbox_retry",
    "completed_with_warnings",
  ],
  // needs_routing_review → correlated is the pinned recovery (re-correlate).
  needs_routing_review: ["correlated"],
  // arch_gap: provider_failed → agent_extracted — spec names the entry but not
  // the recovery; modeled as a retry of the extraction step (re-enter
  // agent_extracted). Non-terminal, so it needs ≥1 outgoing edge.
  provider_failed: ["agent_extracted"],
  // arch_gap: schema_rejected → agent_extracted — re-extract to produce a
  // schema-conformant candidate; the spec pins only the entry edge.
  schema_rejected: ["agent_extracted"],
  // arch_gap: write_conflict → knowledge_committed — retry the commit after
  // resolving the conflict; the spec pins only the entry edge.
  write_conflict: ["knowledge_committed"],
  // approval_pending → external_actions_applied is the pinned recovery.
  approval_pending: ["external_actions_applied"],
  // outbox_retry → external_actions_applied is the pinned recovery.
  outbox_retry: ["external_actions_applied"],
  // terminals (frozen)
  summarized: [],
  completed_with_warnings: [],
};

// Explicit annotation (LESSON §1 discipline): pin the exported value's public
// type rather than relying on inference. No idempotent-terminal-reentry opt-in —
// this machine's terminals reject any further transition (the spec does not call
// for REQ-F-012 idempotency here, unlike the Approval machine in task 1.13).
export const meetingCloseoutMachine: StateMachine<MeetingCloseoutState> =
  defineMachine(transitions);
