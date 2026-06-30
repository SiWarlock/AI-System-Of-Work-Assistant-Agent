// Foundation primitive: the shared state-machine engine all 6 domain machines
// (§9 workflows / DOMAIN_MODEL.md) build on. PURE + TOTAL — no clock, no random,
// no I/O; identical input ⇒ identical output (replay-safe). Never throws: an
// illegal edge, a move out of a terminal state, or an unknown state all return a
// typed err(...). REQ-F-012: an idempotent re-apply of a terminal transition
// (terminal → same state) is an opt-in no-op success.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

export type TransitionError = {
  code: "illegal_transition" | "terminal_state";
  from: string;
  to: string;
};

export interface StateMachine<S extends string> {
  readonly states: readonly S[];
  isTerminal(s: S): boolean; // true iff s has no outgoing transitions
  canTransition(from: S, to: S): boolean;
  transition(from: S, to: S): Result<S, TransitionError>; // ok(to) on a legal edge
}

/**
 * Build a state machine from an adjacency table `transitions[from] = [...to]`.
 * A state with a zero-length edge list is terminal (frozen). Unknown states
 * (not keys of the table) are treated as having no outgoing edges and are NOT
 * terminal — a transition from/to them is an illegal_transition, never a throw.
 *
 * @param opts.idempotentTerminalReentry — when set, `transition(from, from)` for
 *   a terminal `from` returns ok(from) (REQ-F-012) instead of err(terminal_state).
 */
export function defineMachine<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  opts?: { idempotentTerminalReentry?: boolean },
): StateMachine<S> {
  const states = Object.keys(transitions) as S[];

  // arch_gap: an unknown `from` (not a key of the table) has no edge list, so it
  // is non-terminal and every move out of it is illegal_transition. DOMAIN_MODEL
  // names only the in-table states; this is the total-function closure for the
  // off-alphabet case (chosen so an illegal move stays representable as a typed
  // rejection rather than a throw).
  const isTerminal = (s: S): boolean => {
    const outs = transitions[s];
    return outs !== undefined && outs.length === 0;
  };

  const canTransition = (from: S, to: S): boolean => {
    const outs = transitions[from];
    return outs !== undefined && outs.includes(to);
  };

  const transition = (from: S, to: S): Result<S, TransitionError> => {
    if (canTransition(from, to)) {
      return ok(to);
    }
    if (isTerminal(from)) {
      if (opts?.idempotentTerminalReentry === true && from === to) {
        return ok(to); // REQ-F-012 idempotent re-apply — no-op success
      }
      return err({ code: "terminal_state", from, to });
    }
    return err({ code: "illegal_transition", from, to });
  };

  return { states, isTerminal, canTransition, transition };
}
