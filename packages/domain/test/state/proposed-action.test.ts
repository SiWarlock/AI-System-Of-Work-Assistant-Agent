// Proposed External Action machine self-test (task 1.13, DOMAIN_MODEL.md
// §Proposed External Action). PURE + TOTAL: built on the foundation primitive,
// so it never throws — illegal edges, terminal exits, and off-alphabet states
// all return a typed err(...). Pins the happy-path edges, the named legal/illegal
// cases, terminal-frozen, and totality.
import { describe, it, expect } from "vitest";
import {
  proposedActionMachine,
  PROPOSED_ACTION_STATES,
} from "../../src/state/proposed-action";
import type { ProposedActionState } from "../../src/state/proposed-action";

const m = proposedActionMachine;

describe("proposedActionMachine (Proposed External Action state machine)", () => {
  it("exposes exactly the 9 declared states", () => {
    expect([...m.states].sort()).toEqual(
      [...PROPOSED_ACTION_STATES].sort(),
    );
    expect(m.states.length).toBe(9);
  });

  describe("happy-path edges (proposed → … → receipt_recorded)", () => {
    const legal: ReadonlyArray<[ProposedActionState, ProposedActionState]> = [
      ["proposed", "approval_required"],
      ["proposed", "auto_allowed"],
      ["approval_required", "precondition_checked"], // after approval
      ["auto_allowed", "precondition_checked"],
      ["precondition_checked", "dispatched"],
      ["dispatched", "receipt_recorded"],
      ["dispatched", "retry_queued"],
      ["dispatched", "rejected"],
      ["dispatched", "expired"],
      ["retry_queued", "dispatched"], // re-dispatch
    ];
    it.each(legal)("legal: %s -> %s returns ok(to)", (from, to) => {
      expect(m.canTransition(from, to)).toBe(true);
      const r = m.transition(from, to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    });
  });

  describe("PINNED cases", () => {
    it("retry_queued -> dispatched is legal (re-dispatch)", () => {
      const r = m.transition("retry_queued", "dispatched");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("dispatched");
    });

    it("receipt_recorded is terminal (terminal-success): exit returns terminal_state", () => {
      expect(m.isTerminal("receipt_recorded")).toBe(true);
      const r = m.transition("receipt_recorded", "dispatched");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("terminal_state");
        expect(r.error.from).toBe("receipt_recorded");
        expect(r.error.to).toBe("dispatched");
      }
    });

    it("proposed -> dispatched is ILLEGAL (must pass precondition_checked)", () => {
      expect(m.canTransition("proposed", "dispatched")).toBe(false);
      const r = m.transition("proposed", "dispatched");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("illegal_transition");
        expect(r.error.from).toBe("proposed");
        expect(r.error.to).toBe("dispatched");
      }
    });
  });

  describe("terminals are frozen", () => {
    const terminals: ReadonlyArray<ProposedActionState> = [
      "receipt_recorded",
      "rejected",
      "expired",
    ];
    it.each(terminals)("%s is terminal (no outgoing edges)", (s) => {
      expect(m.isTerminal(s)).toBe(true);
    });
    it.each(terminals)(
      "%s -> proposed returns terminal_state (no resurrection)",
      (s) => {
        const r = m.transition(s, "proposed");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("terminal_state");
      },
    );
    it("no implicit idempotency: receipt_recorded -> receipt_recorded is terminal_state", () => {
      const r = m.transition("receipt_recorded", "receipt_recorded");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("terminal_state");
    });
  });

  describe("non-terminal states are non-terminal", () => {
    const nonTerminal: ReadonlyArray<ProposedActionState> = [
      "proposed",
      "approval_required",
      "auto_allowed",
      "precondition_checked",
      "dispatched",
      "retry_queued",
    ];
    it.each(nonTerminal)("%s is not terminal", (s) => {
      expect(m.isTerminal(s)).toBe(false);
    });
  });

  describe("representative illegal (non-terminal) edges", () => {
    const illegal: ReadonlyArray<[ProposedActionState, ProposedActionState]> = [
      ["proposed", "precondition_checked"], // must pass approval/auto first
      ["approval_required", "dispatched"], // must pass precondition_checked
      ["auto_allowed", "dispatched"],
      ["precondition_checked", "receipt_recorded"], // must dispatch first
      ["retry_queued", "receipt_recorded"], // must re-dispatch first
      ["approval_required", "auto_allowed"], // sibling branches don't cross
    ];
    it.each(illegal)("illegal: %s -> %s returns illegal_transition", (from, to) => {
      expect(m.canTransition(from, to)).toBe(false);
      const r = m.transition(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("illegal_transition");
        expect(r.error.from).toBe(from);
        expect(r.error.to).toBe(to);
      }
    });
  });

  describe("TOTAL: off-alphabet states never throw", () => {
    it("unknown `from` -> known returns illegal_transition", () => {
      const r = m.transition("nope" as ProposedActionState, "proposed");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    });
    it("known -> unknown `to` returns illegal_transition", () => {
      const r = m.transition("proposed", "nope" as ProposedActionState);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    });
    it("isTerminal/canTransition on an unknown state never throw", () => {
      expect(m.isTerminal("nope" as ProposedActionState)).toBe(false);
      expect(m.canTransition("nope" as ProposedActionState, "proposed")).toBe(
        false,
      );
    });
  });
});
