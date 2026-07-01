// spec(§7) — broker AgentJob lifecycle cursor over the FROZEN @sow/domain machine.
// Reuses the domain machine's adjacency (never re-invents edges); pins the spine
// ordering (skipping admitted / provider_selected is forbidden), immutability
// (replay-safe), and the terminal-branch fan-out.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  newJobLifecycle,
  initialJobState,
  BROKER_SPINE,
  JOB_BRANCHES,
  isJobBranch,
} from "../src/broker/agent-job-machine";

describe("JobLifecycle — cursor over the domain AgentJob machine", () => {
  it("starts at created", () => {
    expect(initialJobState()).toBe("created");
    expect(newJobLifecycle().state).toBe("created");
    expect(newJobLifecycle().isTerminal).toBe(false);
  });

  it("advances along the legal spine and leaves the original untouched (immutable / replay-safe)", () => {
    const l0 = newJobLifecycle("created");
    const r1 = l0.advance("admitted");
    expect(isOk(r1)).toBe(true);
    if (!isOk(r1)) return;
    // Original cursor is unmutated — re-driving from l0 yields the same edge.
    expect(l0.state).toBe("created");
    expect(r1.value.state).toBe("admitted");
    const again = l0.advance("admitted");
    expect(isOk(again)).toBe(true);
    if (isOk(again)) expect(again.value.state).toBe("admitted");
  });

  it("forbids skipping admitted: created → provider_selected is illegal", () => {
    const r = newJobLifecycle("created").advance("provider_selected");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("illegal_transition");
  });

  it("forbids skipping provider_selected: admitted → running is illegal", () => {
    const admitted = newJobLifecycle("admitted");
    const r = admitted.advance("running");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("illegal_transition");
  });

  it("drives the full spine created → admitted → provider_selected → running → schema_validated → accepted", () => {
    let life = newJobLifecycle("created");
    for (const to of ["admitted", "provider_selected", "running", "schema_validated", "accepted"] as const) {
      const r = life.advance(to);
      expect(isOk(r)).toBe(true);
      if (!isOk(r)) return;
      life = r.value;
    }
    expect(life.state).toBe("accepted");
    expect(life.isTerminal).toBe(true);
  });

  it("running → cancelled_budget is a legal mid-run cancel edge (COST-1)", () => {
    const r = newJobLifecycle("running").advance("cancelled_budget");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.isTerminal).toBe(true);
  });

  it("schema_validated fans out to each branch", () => {
    for (const branch of ["accepted", "rejected", "cancelled_budget", "failed_retryable", "failed_terminal"] as const) {
      const r = newJobLifecycle("schema_validated").advance(branch);
      expect(isOk(r)).toBe(true);
    }
  });

  it("a terminal state is frozen: accepted has no outgoing edge", () => {
    const accepted = newJobLifecycle("accepted");
    expect(accepted.isTerminal).toBe(true);
    const r = accepted.advance("rejected");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("terminal_state");
  });

  it("exposes the spine + branch vocab and a branch guard", () => {
    expect(BROKER_SPINE).toEqual([
      "created",
      "admitted",
      "provider_selected",
      "running",
      "schema_validated",
    ]);
    expect(JOB_BRANCHES).toEqual([
      "accepted",
      "rejected",
      "cancelled_budget",
      "failed_retryable",
      "failed_terminal",
    ]);
    expect(isJobBranch("accepted")).toBe(true);
    expect(isJobBranch("running")).toBe(false);
  });
});
