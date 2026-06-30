// Meeting Closeout state machine (DOMAIN_MODEL.md §Meeting Closeout, task 1.12).
// PURE + TOTAL: legal edges return ok(to); illegal edges return a typed
// err(illegal_transition); leaving a terminal returns err(terminal_state); an
// unknown state never throws. Terminals (summarized, completed_with_warnings)
// are frozen. Built on the Foundation `defineMachine` primitive.
import { describe, it, expect } from "vitest";
import {
  meetingCloseoutMachine,
  MEETING_CLOSEOUT_STATES,
} from "../../src/state/meeting-closeout";
import type { MeetingCloseoutState } from "../../src/state/meeting-closeout";

const m = meetingCloseoutMachine;

describe("meetingCloseoutMachine — state set + terminals", () => {
  it("exposes the full declared 16-state set", () => {
    expect([...m.states].sort()).toEqual(
      [...MEETING_CLOSEOUT_STATES].sort(),
    );
    expect(MEETING_CLOSEOUT_STATES).toContain("detected");
    expect(MEETING_CLOSEOUT_STATES).toContain("summarized");
    expect(MEETING_CLOSEOUT_STATES).toContain("completed_with_warnings");
    expect(MEETING_CLOSEOUT_STATES.length).toBe(16);
  });

  it("summarized and completed_with_warnings are the only terminal states", () => {
    const terminals = MEETING_CLOSEOUT_STATES.filter((s) => m.isTerminal(s));
    expect([...terminals].sort()).toEqual(
      ["completed_with_warnings", "summarized"],
    );
  });
});

describe("meetingCloseoutMachine — happy path", () => {
  // detected → correlated → context_loaded → agent_extracted → validated →
  // knowledge_committed → (external_actions_pending|external_actions_applied) →
  // summarized
  const linear: ReadonlyArray<[MeetingCloseoutState, MeetingCloseoutState]> = [
    ["detected", "correlated"],
    ["correlated", "context_loaded"],
    ["context_loaded", "agent_extracted"],
    ["agent_extracted", "validated"],
    ["validated", "knowledge_committed"],
    ["knowledge_committed", "external_actions_applied"],
    ["external_actions_applied", "summarized"],
  ];

  it("walks the canonical happy path edge-by-edge (ok(to) each step)", () => {
    for (const [from, to] of linear) {
      expect(m.canTransition(from, to)).toBe(true);
      const r = m.transition(from, to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("knowledge_committed branches to BOTH external_actions_pending and external_actions_applied", () => {
    expect(m.canTransition("knowledge_committed", "external_actions_pending")).toBe(true);
    expect(m.canTransition("knowledge_committed", "external_actions_applied")).toBe(true);
  });

  it("both external_actions_* states reach summarized (spec literal '(...|...)→summarized')", () => {
    expect(m.canTransition("external_actions_pending", "summarized")).toBe(true);
    expect(m.canTransition("external_actions_applied", "summarized")).toBe(true);
  });

  it("external_actions_pending advances to external_actions_applied", () => {
    expect(m.canTransition("external_actions_pending", "external_actions_applied")).toBe(true);
  });
});

describe("meetingCloseoutMachine — pinned failure entry edges", () => {
  const entries: ReadonlyArray<[MeetingCloseoutState, MeetingCloseoutState]> = [
    ["correlated", "needs_routing_review"], // low-confidence routing
    ["agent_extracted", "provider_failed"], // provider step
    ["validated", "schema_rejected"], // schema gate rejection
    ["knowledge_committed", "write_conflict"], // KW write conflict
    ["external_actions_pending", "approval_pending"], // needs approval
    ["external_actions_pending", "outbox_retry"], // external_actions_* → retry
    ["external_actions_applied", "outbox_retry"], // external_actions_* → retry
  ];

  it.each(entries)("%s → %s is a legal failure entry", (from, to) => {
    expect(m.canTransition(from, to)).toBe(true);
    const r = m.transition(from, to);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(to);
  });
});

describe("meetingCloseoutMachine — pinned recovery edges", () => {
  const recoveries: ReadonlyArray<[MeetingCloseoutState, MeetingCloseoutState]> = [
    ["needs_routing_review", "correlated"],
    ["approval_pending", "external_actions_applied"],
    ["outbox_retry", "external_actions_applied"],
  ];

  it.each(recoveries)("%s → %s is a legal recovery edge", (from, to) => {
    expect(m.canTransition(from, to)).toBe(true);
    const r = m.transition(from, to);
    expect(r.ok).toBe(true);
  });
});

describe("meetingCloseoutMachine — illegal transitions (typed rejection, no throw)", () => {
  const illegal: ReadonlyArray<[MeetingCloseoutState, MeetingCloseoutState]> = [
    ["detected", "summarized"], // skips the whole pipeline
    ["detected", "knowledge_committed"], // skips correlate/load/extract/validate
    ["correlated", "validated"], // skips context_load + extract
    ["context_loaded", "knowledge_committed"], // skips extract + validate
    ["validated", "summarized"], // skips commit + external actions
    ["needs_routing_review", "context_loaded"], // recovery only returns to correlated
    ["provider_failed", "validated"], // not a legal recovery target
  ];

  it.each(illegal)("%s → %s returns err(illegal_transition)", (from, to) => {
    const r = m.transition(from, to);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("illegal_transition");
      expect(r.error.from).toBe(from);
      expect(r.error.to).toBe(to);
    }
  });
});

describe("meetingCloseoutMachine — terminal states are frozen", () => {
  it("summarized accepts no further transitions (err terminal_state)", () => {
    const r = m.transition("summarized", "correlated");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("terminal_state");
      expect(r.error.from).toBe("summarized");
    }
  });

  it("completed_with_warnings accepts no further transitions (err terminal_state)", () => {
    const r = m.transition("completed_with_warnings", "summarized");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("terminal → same state is err terminal_state (no implicit idempotency)", () => {
    const r = m.transition("summarized", "summarized");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });
});

describe("meetingCloseoutMachine — TOTAL (unknown state never throws)", () => {
  it("unknown `from` returns err(illegal_transition), not a throw", () => {
    const r = m.transition("bogus" as MeetingCloseoutState, "detected");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("unknown `to` returns err(illegal_transition), not a throw", () => {
    const r = m.transition("detected", "bogus" as MeetingCloseoutState);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("isTerminal / canTransition on an unknown state never throw", () => {
    expect(m.isTerminal("bogus" as MeetingCloseoutState)).toBe(false);
    expect(m.canTransition("bogus" as MeetingCloseoutState, "detected")).toBe(false);
  });
});
