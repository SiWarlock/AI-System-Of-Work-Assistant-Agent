// Project state machine (§13.5 — the 7th domain state machine; DOMAIN_MODEL.md §State Machines). PURE + TOTAL
// — no clock, no randomness, no I/O; identical input ⇒ identical output (replay-safe). Models a project's
// LIFECYCLE (distinct from the projectSync workflow's RUN lifecycle in packages/workflows): a project moves
// idea → planning → active, may pause + resume, may be shelved at any live state, and ends done (completed) or
// archived (abandoned). `done` + `archived` are terminal. The machine validates an edge; the resulting state
// string is persisted by the owning record — here, the Project's Markdown frontmatter timeline head (the
// machine itself is stateless).
import { defineMachine } from "./transition";
import type { StateMachine } from "./transition";
import type { ProjectLifecycleState } from "@sow/contracts";

/**
 * Declared state alphabet. Mirrors `@sow/contracts` `ProjectLifecycleState` (the frozen seam enum) — the
 * static assertion below pins them in lockstep so neither can drift from the other.
 */
export const PROJECT_STATES = [
  "idea",
  "planning",
  "active",
  "paused",
  "done",
  "archived",
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

// Compile-time drift guard: ProjectState ≡ the frozen contract enum (both ways). If either set changes, one of
// these assignments stops type-checking (mirrors approval.ts).
type _AssertStateMatchesContract = ProjectState extends ProjectLifecycleState
  ? ProjectLifecycleState extends ProjectState
    ? true
    : never
  : never;
const _stateContractParity: _AssertStateMatchesContract = true;
void _stateContractParity;

/**
 * The lifecycle transitions. `archived` is reachable from every LIVE state (a project can be shelved from idea,
 * planning, active, or paused). `planning` may fall back to `idea` (re-scoping); `active` ⇄ `paused`. `done` is
 * reached only from `active` (you complete work that is active). `done` + `archived` are frozen terminals
 * (empty edge lists) — a project machine has no exactly-once terminal-reentry seam (unlike Approval), so a move
 * out of a terminal returns a typed `err(terminal_state)`.
 */
const PROJECT_TRANSITIONS: Readonly<Record<ProjectState, readonly ProjectState[]>> = {
  idea: ["planning", "archived"],
  planning: ["active", "idea", "archived"],
  active: ["paused", "done", "archived"],
  paused: ["active", "archived"],
  done: [],
  archived: [],
};

/**
 * The Project machine. Total + pure; illegal edges and moves out of a frozen terminal return a typed `err(...)`
 * (never throw). Annotated with the explicit `StateMachine<ProjectState>` type per the strict-TS / TS4023
 * guidance (no reliance on bare inference at the export).
 */
export const projectMachine: StateMachine<ProjectState> = defineMachine(PROJECT_TRANSITIONS);
