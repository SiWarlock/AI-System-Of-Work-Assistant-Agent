// Source state machine (task 1.12 / DOMAIN_MODEL.md §Source). Built on the shared
// PURE/TOTAL engine: no clock, no random, no I/O; identical input ⇒ identical
// output (replay-safe). Illegal edges, leaving a terminal state, and off-alphabet
// targets all return a typed err(...) — the machine never throws.
//
// DOMAIN_MODEL.md §Source:
//   captured -> classified -> (queued_for_review | processing) -> proposed
//             -> applied | rejected | failed_retryable | failed_terminal
//   Forbidden: captured -> applied (skips classification + policy validation);
//              processing -> external_write (source-processing agent cannot drive
//              an external write).
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";

/** The full Source state alphabet (DOMAIN_MODEL.md §Source). */
export const SOURCE_STATES = [
  "captured",
  "classified",
  "queued_for_review",
  "processing",
  "proposed",
  "applied",
  "rejected",
  "failed_retryable",
  "failed_terminal",
] as const;

export type SourceState = (typeof SOURCE_STATES)[number];

// Adjacency table. Terminal states (applied, rejected, failed_terminal) map to []
// and are frozen by the engine. failed_retryable is NON-terminal: it retries to
// processing.
// arch_gap: DOMAIN_MODEL.md §Source + task 1.12 list failed_retryable only as a
// proposed-branch endpoint and do NOT pin the retry back-edge; the
// failed_retryable -> processing edge is a defensible interpretation (a state
// named "failed_retryable" must be non-terminal, else it equals failed_terminal).
// Confirm/pin at §9/Phase-7.
//
// Safety: there is deliberately NO `external_write` state or edge — the forbidden
// `processing -> external_write` transition is structurally unrepresentable, so a
// source-processing agent can never drive an external write through this machine.
//
// arch_gap: DOMAIN_MODEL writes `(queued_for_review | processing) -> proposed`,
// i.e. both branches converge directly on `proposed`. It does NOT name a
// `queued_for_review -> processing` hand-off edge, so none is encoded; review and
// processing are alternative paths to `proposed`, not a sequence. Encoding only
// what the spec states leaves no legitimate transition unrepresentable.
const sourceTransitions: Readonly<Record<SourceState, readonly SourceState[]>> = {
  captured: ["classified"],
  classified: ["queued_for_review", "processing"],
  queued_for_review: ["proposed"],
  processing: ["proposed"],
  proposed: ["applied", "rejected", "failed_retryable", "failed_terminal"],
  failed_retryable: ["processing"],
  applied: [],
  rejected: [],
  failed_terminal: [],
};

// Explicit annotation (no idempotent terminal re-entry — DOMAIN_MODEL §Source does
// not call for REQ-F-012 here, so terminal -> same is err terminal_state).
export const sourceMachine: StateMachine<SourceState> =
  defineMachine<SourceState>(sourceTransitions);
