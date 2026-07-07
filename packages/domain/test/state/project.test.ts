// spec(§13.5) — the 7th domain state machine (DOMAIN_MODEL.md §State Machines). Project LIFECYCLE self-test
// (PURE, TOTAL — no clock/random/IO). idea → planning → active, with paused ⇄ active, planning → idea fallback,
// archived reachable from every LIVE state, and done/archived terminal/frozen. No exactly-once terminal-reentry
// seam (unlike Approval) — a move out of a terminal errs.
import { describe, it, expect } from "vitest";
import { projectMachine, PROJECT_STATES } from "../../src/state/project";
import type { ProjectState } from "../../src/state/project";

describe("projectMachine (§13.5, DOMAIN_MODEL §State Machines)", () => {
  it("exposes the declared 6-state set", () => {
    expect([...PROJECT_STATES].sort()).toEqual(["active", "archived", "done", "idea", "paused", "planning"]);
    expect([...projectMachine.states].sort()).toEqual([...PROJECT_STATES].sort());
  });

  it("isTerminal: done/archived are frozen; idea/planning/active/paused are not", () => {
    expect(projectMachine.isTerminal("done")).toBe(true);
    expect(projectMachine.isTerminal("archived")).toBe(true);
    for (const live of ["idea", "planning", "active", "paused"] as const) {
      expect(projectMachine.isTerminal(live)).toBe(false);
    }
  });

  it("happy path: idea → planning → active → done", () => {
    for (const [from, to] of [["idea", "planning"], ["planning", "active"], ["active", "done"]] as const) {
      const r = projectMachine.transition(from, to);
      expect(r.ok, `${from}->${to}`).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("active ⇄ paused (pause and resume)", () => {
    expect(projectMachine.transition("active", "paused").ok).toBe(true);
    expect(projectMachine.transition("paused", "active").ok).toBe(true);
  });

  it("planning may fall back to idea (re-scoping)", () => {
    const r = projectMachine.transition("planning", "idea");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("idea");
  });

  it("archived is reachable from EVERY live state (a project can be shelved anytime)", () => {
    for (const from of ["idea", "planning", "active", "paused"] as const) {
      const r = projectMachine.transition(from, "archived");
      expect(r.ok, `${from}->archived`).toBe(true);
    }
  });

  it("done is reachable ONLY from active (you complete active work)", () => {
    expect(projectMachine.canTransition("active", "done")).toBe(true);
    for (const from of ["idea", "planning", "paused"] as const) {
      const r = projectMachine.transition(from, "done");
      expect(r.ok, `${from}->done must be illegal`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    }
  });

  it("every terminal state is frozen: leaving it errs terminal_state (no idempotent reentry)", () => {
    for (const from of ["done", "archived"] as const) {
      const r = projectMachine.transition(from, "active");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("terminal_state");
        expect(r.error.from).toBe(from);
      }
      // same-state re-entry is NOT a no-op here (unlike Approval) — still errs terminal_state.
      const self = projectMachine.transition(from, from);
      expect(self.ok).toBe(false);
      if (!self.ok) expect(self.error.code).toBe("terminal_state");
    }
  });

  it("illegal non-terminal edges err illegal_transition", () => {
    // idea has no self-loop; idea → active skips planning; paused → done must go via active.
    for (const [from, to] of [["idea", "idea"], ["idea", "active"], ["paused", "done"]] as const) {
      const r = projectMachine.transition(from, to);
      expect(r.ok, `${from}->${to}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    }
  });

  it("is TOTAL: an unknown state never throws — typed rejection", () => {
    const unknownFrom = projectMachine.transition("shipped" as ProjectState, "active");
    expect(unknownFrom.ok).toBe(false);
    if (!unknownFrom.ok) expect(unknownFrom.error.code).toBe("illegal_transition");

    const unknownTo = projectMachine.transition("active", "shipped" as ProjectState);
    expect(unknownTo.ok).toBe(false);
    if (!unknownTo.ok) expect(unknownTo.error.code).toBe("illegal_transition");

    expect(projectMachine.isTerminal("shipped" as ProjectState)).toBe(false);
    expect(projectMachine.canTransition("shipped" as ProjectState, "active")).toBe(false);
  });
});
