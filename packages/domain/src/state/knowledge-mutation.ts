// Knowledge Mutation state machine — DOMAIN_MODEL.md §Knowledge Mutation.
// PURE + TOTAL (built on the Foundation `defineMachine` primitive): no clock,
// no randomness, no env, no I/O; identical input ⇒ identical output. Illegal
// edges, moves out of a terminal state, and unknown states all return a typed
// err(...) — never a throw.
//
// Lifecycle (every KnowledgeMutationPlan rides this graph):
//
//   planned -> validated -> conflict_checked -> approved_if_required
//     -> committed_to_markdown -> gbrain_sync_queued
//       -> indexed | sync_lagging | parity_defect
//   sync_lagging -> indexed   (catch-up)
//
// Load-bearing invariants encoded here:
//  * committed_to_markdown is the DURABILITY POINT (safety rule #1, KN-4/KN-9):
//    once Markdown — the only canonical semantic truth — is written, the plan
//    NEVER rolls back. So committed_to_markdown has exactly ONE outgoing edge,
//    forward to gbrain_sync_queued; no edge returns to an earlier state.
//  * No state-skipping: planned -> committed_to_markdown is illegal.
//  * GBrain is derived/rebuildable; a DB-only semantic fact is a parity defect
//    (quarantined) — hence the parity_defect branch off gbrain_sync_queued.
//  * sync_lagging is a transient lag that catches up to indexed.
//  * indexed is the frozen terminal.
import { defineMachine } from "../state/transition";
import type { StateMachine } from "../state/transition";

/** All states of the Knowledge Mutation lifecycle (DOMAIN_MODEL.md). */
export const KNOWLEDGE_MUTATION_STATES = [
  "planned",
  "validated",
  "conflict_checked",
  "approved_if_required",
  "committed_to_markdown",
  "gbrain_sync_queued",
  "indexed",
  "sync_lagging",
  "parity_defect",
] as const;

export type KnowledgeMutationState =
  (typeof KNOWLEDGE_MUTATION_STATES)[number];

// Adjacency table: a zero-length edge list is terminal (frozen) per the
// Foundation primitive. Every state is a key (total Record).
const TRANSITIONS: Readonly<
  Record<KnowledgeMutationState, readonly KnowledgeMutationState[]>
> = {
  planned: ["validated"],
  validated: ["conflict_checked"],
  conflict_checked: ["approved_if_required"],
  approved_if_required: ["committed_to_markdown"],
  // DURABILITY POINT: only forward to gbrain_sync_queued; no backward edge.
  committed_to_markdown: ["gbrain_sync_queued"],
  gbrain_sync_queued: ["indexed", "sync_lagging", "parity_defect"],
  // sync_lagging is a transient lag → catches up to indexed (no other edge).
  sync_lagging: ["indexed"],
  // indexed: frozen terminal.
  indexed: [],
  // arch_gap: parity_defect remediation (materialize / purge) is Phase-4
  // (task 4.18, ARCHITECTURE.md §6). The brief offers two encodings —
  // "non-terminal with no outgoing edge" OR "a sink". The typed table here
  // (`Readonly<Record<State, readonly State[]>>` + the exported states tuple)
  // requires EVERY state to be a key with an edge list, and the Foundation
  // primitive treats an empty edge list as terminal. So the only encoding
  // compatible with this shape is a SINK: parity_defect reports
  // isTerminal=true and any move out of it returns err(terminal_state).
  // Semantically parity_defect is NOT a true frozen-terminal like indexed — it
  // awaits Phase-4 remediation edges (re-validate after materialize, or purge).
  // Until then it is a structural sink; the remediation edges land at §6/Phase-4.
  parity_defect: [],
};

/**
 * The Knowledge Mutation machine. Annotated with its explicit `StateMachine<…>`
 * type (the primitive returns the same exported type, so no module-private brand
 * leaks — TS4023-safe; see packages/contracts/LESSONS.md §1).
 *
 * Note (not a state): `KnowledgeMutationPlan.provenanceOrigin` discriminates the
 * ENTRY conditions (a `gbrain_proposal` defaults `requiresApproval` true) — that
 * is plan-construction policy, not a node of this graph; see the helper below.
 */
export const knowledgeMutationMachine: StateMachine<KnowledgeMutationState> =
  defineMachine<KnowledgeMutationState>(TRANSITIONS);

/**
 * Whether a plan with the given provenance origin defaults to requiring approval
 * before it may reach `committed_to_markdown`. PURE: a gbrain-originated proposal
 * defaults to approval-required (it is a derived/autonomous suggestion, not a
 * human-authored mutation); any other origin defaults to false. This is a
 * default, not the gate itself — the approval edge is the
 * approved_if_required -> committed_to_markdown step above.
 *
 * arch_gap: DOMAIN_MODEL.md names `provenanceOrigin` discriminating entry but
 * does not enumerate every origin's default. We encode only the one stated case
 * (gbrain_proposal ⇒ true) and default all others to false rather than invent
 * per-origin policy.
 */
export function requiresApprovalByDefault(provenanceOrigin: string): boolean {
  return provenanceOrigin === "gbrain_proposal";
}
