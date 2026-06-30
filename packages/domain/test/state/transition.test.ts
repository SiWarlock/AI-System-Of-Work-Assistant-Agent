// spec(§9) — DOMAIN_MODEL.md state machine (phase-exit spec coverage)
// Foundation primitive self-test (PURE, TOTAL): the shared state-machine engine
// every one of the 6 domain machines builds on. Uses a tiny 3-state fixture.
import { describe, it, expect } from "vitest";
import { defineMachine } from "../../src/state/transition";
import type { StateMachine } from "../../src/state/transition";

type S = "a" | "b" | "c";

// a -> b -> c ; c is terminal (no outgoing edges).
const make = (idempotent?: boolean): StateMachine<S> =>
  defineMachine<S>(
    { a: ["b"], b: ["c"], c: [] },
    idempotent ? { idempotentTerminalReentry: true } : undefined,
  );

describe("defineMachine (foundation state-machine primitive)", () => {
  it("exposes the declared state set", () => {
    const m = make();
    expect([...m.states].sort()).toEqual(["a", "b", "c"]);
  });

  it("isTerminal is true iff a state has no outgoing transitions", () => {
    const m = make();
    expect(m.isTerminal("a")).toBe(false);
    expect(m.isTerminal("b")).toBe(false);
    expect(m.isTerminal("c")).toBe(true);
  });

  it("canTransition reflects the edge table", () => {
    const m = make();
    expect(m.canTransition("a", "b")).toBe(true);
    expect(m.canTransition("b", "c")).toBe(true);
    expect(m.canTransition("a", "c")).toBe(false);
    expect(m.canTransition("c", "a")).toBe(false);
  });

  it("transition: a legal edge returns ok(to)", () => {
    const m = make();
    const r = m.transition("a", "b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("b");
  });

  it("transition: an illegal (non-terminal) edge returns err illegal_transition", () => {
    const m = make();
    const r = m.transition("a", "c");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("illegal_transition");
      expect(r.error.from).toBe("a");
      expect(r.error.to).toBe("c");
    }
  });

  it("transition: leaving a terminal state returns err terminal_state", () => {
    const m = make();
    const r = m.transition("c", "a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("terminal_state");
      expect(r.error.from).toBe("c");
      expect(r.error.to).toBe("a");
    }
  });

  it("idempotentTerminalReentry: terminal -> same is an ok no-op (REQ-F-012)", () => {
    const m = make(true);
    const r = m.transition("c", "c");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("c");
  });

  it("idempotentTerminalReentry: terminal -> other is still err terminal_state", () => {
    const m = make(true);
    const r = m.transition("c", "a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("without the flag, terminal -> same is err terminal_state (no implicit idempotency)", () => {
    const m = make();
    const r = m.transition("c", "c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("is TOTAL: an unknown `from` never throws — err illegal_transition", () => {
    const m = make();
    const r = m.transition("z" as S, "a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: an unknown `to` never throws — err illegal_transition", () => {
    const m = make();
    const r = m.transition("a", "z" as S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: isTerminal/canTransition on an unknown state never throw", () => {
    const m = make();
    expect(m.isTerminal("z" as S)).toBe(false);
    expect(m.canTransition("z" as S, "a")).toBe(false);
  });
});
