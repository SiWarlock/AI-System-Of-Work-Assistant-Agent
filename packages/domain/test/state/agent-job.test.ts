// AgentJob state machine (DOMAIN_MODEL.md §Agent Job) — PURE + TOTAL.
// created -> admitted -> provider_selected -> running -> schema_validated
//   -> accepted | rejected | cancelled_budget | failed_retryable | failed_terminal
// plus running -> cancelled_budget (COST-1 mid-run budget breach) and
// failed_retryable -> admitted (re-admit/retry). Terminal (frozen): accepted,
// rejected, cancelled_budget, failed_terminal. Illegal/unknown -> typed err, never throw.
import { describe, it, expect } from "vitest";
import { agentJobMachine, AGENT_JOB_STATES } from "../../src/state/agent-job";
import type { AgentJobState } from "../../src/state/agent-job";

describe("agentJobMachine (Agent Job state machine)", () => {
  it("declares exactly the 10 Agent Job states", () => {
    expect([...agentJobMachine.states].sort()).toEqual(
      [...AGENT_JOB_STATES].sort(),
    );
    expect([...AGENT_JOB_STATES].sort()).toEqual(
      [
        "accepted",
        "admitted",
        "cancelled_budget",
        "created",
        "failed_retryable",
        "failed_terminal",
        "provider_selected",
        "rejected",
        "running",
        "schema_validated",
      ].sort(),
    );
  });

  it("happy path: created -> admitted -> provider_selected -> running -> schema_validated", () => {
    const edges: ReadonlyArray<[AgentJobState, AgentJobState]> = [
      ["created", "admitted"],
      ["admitted", "provider_selected"],
      ["provider_selected", "running"],
      ["running", "schema_validated"],
    ];
    for (const [from, to] of edges) {
      const r = agentJobMachine.transition(from, to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("schema_validated fans out to all 5 outcomes", () => {
    const outcomes: readonly AgentJobState[] = [
      "accepted",
      "rejected",
      "cancelled_budget",
      "failed_retryable",
      "failed_terminal",
    ];
    for (const to of outcomes) {
      expect(agentJobMachine.canTransition("schema_validated", to)).toBe(true);
    }
  });

  // --- PINNED cases (named in the task) ---
  it("PIN: running -> cancelled_budget is legal (COST-1 mid-run budget breach)", () => {
    const r = agentJobMachine.transition("running", "cancelled_budget");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("cancelled_budget");
  });

  it("PIN: cancelled_budget is terminal — no outgoing transitions", () => {
    expect(agentJobMachine.isTerminal("cancelled_budget")).toBe(true);
    for (const to of AGENT_JOB_STATES) {
      expect(agentJobMachine.canTransition("cancelled_budget", to)).toBe(false);
    }
    const r = agentJobMachine.transition("cancelled_budget", "running");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("PIN: created -> accepted is illegal", () => {
    const r = agentJobMachine.transition("created", "accepted");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("illegal_transition");
      expect(r.error.from).toBe("created");
      expect(r.error.to).toBe("accepted");
    }
  });

  // --- retry edge ---
  it("failed_retryable -> admitted is legal (re-admit/retry) and failed_retryable is NOT terminal", () => {
    expect(agentJobMachine.isTerminal("failed_retryable")).toBe(false);
    const r = agentJobMachine.transition("failed_retryable", "admitted");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("admitted");
  });

  // --- terminal-frozen set ---
  it("the frozen terminal set has no outgoing edges", () => {
    const terminals: readonly AgentJobState[] = [
      "accepted",
      "rejected",
      "cancelled_budget",
      "failed_terminal",
    ];
    for (const t of terminals) {
      expect(agentJobMachine.isTerminal(t)).toBe(true);
    }
    // every other state is non-terminal
    const nonTerminals: readonly AgentJobState[] = [
      "created",
      "admitted",
      "provider_selected",
      "running",
      "schema_validated",
      "failed_retryable",
    ];
    for (const s of nonTerminals) {
      expect(agentJobMachine.isTerminal(s)).toBe(false);
    }
  });

  it("leaving a terminal state returns err terminal_state (no implicit idempotency)", () => {
    const r = agentJobMachine.transition("accepted", "accepted");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  // --- totality ---
  it("is TOTAL: an unknown `from` never throws — err illegal_transition", () => {
    const r = agentJobMachine.transition("bogus" as AgentJobState, "admitted");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: a legal-source/unknown-target never throws — err illegal_transition", () => {
    const r = agentJobMachine.transition("created", "bogus" as AgentJobState);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });
});
