// Knowledge Mutation state machine (DOMAIN_MODEL.md §Knowledge Mutation).
// PURE/TOTAL self-test built on the Foundation defineMachine primitive.
//
//   planned -> validated -> conflict_checked -> approved_if_required
//     -> committed_to_markdown -> gbrain_sync_queued
//       -> indexed | sync_lagging | parity_defect
//   sync_lagging -> indexed (catch-up)
//
// Load-bearing pins:
//  * committed_to_markdown is the DURABILITY POINT — no edge leaves it backward
//    toward an earlier/rolled-back state (only forward to gbrain_sync_queued).
//  * planned -> committed_to_markdown is illegal (no state-skipping).
//  * indexed is the frozen terminal; parity_defect is a (Phase-4-pending) sink.
import { describe, it, expect } from "vitest";
import {
  knowledgeMutationMachine,
  KNOWLEDGE_MUTATION_STATES,
} from "../../src/state/knowledge-mutation";
import type { KnowledgeMutationState } from "../../src/state/knowledge-mutation";

const m = knowledgeMutationMachine;

describe("knowledgeMutationMachine (DOMAIN_MODEL.md §Knowledge Mutation)", () => {
  it("exposes the full declared state set", () => {
    expect([...m.states].sort()).toEqual(
      [...KNOWLEDGE_MUTATION_STATES].sort(),
    );
    expect([...KNOWLEDGE_MUTATION_STATES].sort()).toEqual(
      [
        "approved_if_required",
        "committed_to_markdown",
        "conflict_checked",
        "gbrain_sync_queued",
        "indexed",
        "parity_defect",
        "planned",
        "sync_lagging",
        "validated",
      ],
    );
  });

  it("walks the happy-path forward edges", () => {
    const forward: ReadonlyArray<
      readonly [KnowledgeMutationState, KnowledgeMutationState]
    > = [
      ["planned", "validated"],
      ["validated", "conflict_checked"],
      ["conflict_checked", "approved_if_required"],
      ["approved_if_required", "committed_to_markdown"],
      ["committed_to_markdown", "gbrain_sync_queued"],
      ["gbrain_sync_queued", "indexed"],
    ];
    for (const [from, to] of forward) {
      expect(m.canTransition(from, to)).toBe(true);
      const r = m.transition(from, to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("gbrain_sync_queued fans out to indexed | sync_lagging | parity_defect", () => {
    for (const to of ["indexed", "sync_lagging", "parity_defect"] as const) {
      expect(m.canTransition("gbrain_sync_queued", to)).toBe(true);
      const r = m.transition("gbrain_sync_queued", to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("sync_lagging catches up to indexed", () => {
    expect(m.canTransition("sync_lagging", "indexed")).toBe(true);
    const r = m.transition("sync_lagging", "indexed");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("indexed");
  });

  it("sync_lagging does not degrade straight to parity_defect (only catch-up modeled)", () => {
    expect(m.canTransition("sync_lagging", "parity_defect")).toBe(false);
    const r = m.transition("sync_lagging", "parity_defect");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  // PIN: durability — committed_to_markdown never rolls back.
  it("committed_to_markdown has NO backward edge (durability point)", () => {
    const earlier: readonly KnowledgeMutationState[] = [
      "planned",
      "validated",
      "conflict_checked",
      "approved_if_required",
    ];
    for (const to of earlier) {
      expect(m.canTransition("committed_to_markdown", to)).toBe(false);
      const r = m.transition("committed_to_markdown", to);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    }
    // its ONLY legal move is forward to gbrain_sync_queued
    expect(m.canTransition("committed_to_markdown", "gbrain_sync_queued")).toBe(
      true,
    );
  });

  // PIN: no state-skipping into the durability point.
  it("planned -> committed_to_markdown is illegal (no skipping)", () => {
    expect(m.canTransition("planned", "committed_to_markdown")).toBe(false);
    const r = m.transition("planned", "committed_to_markdown");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("indexed is the frozen terminal", () => {
    expect(m.isTerminal("indexed")).toBe(true);
    const r = m.transition("indexed", "gbrain_sync_queued");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("terminal_state");
      expect(r.error.from).toBe("indexed");
      expect(r.error.to).toBe("gbrain_sync_queued");
    }
  });

  // arch_gap: parity_defect is a sink here (remediation edges are Phase-4 / §6).
  it("parity_defect is a sink (no outgoing edge until Phase-4 remediation)", () => {
    expect(m.isTerminal("parity_defect")).toBe(true);
    const r = m.transition("parity_defect", "validated");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("non-terminal states report isTerminal=false", () => {
    for (const s of [
      "planned",
      "validated",
      "conflict_checked",
      "approved_if_required",
      "committed_to_markdown",
      "gbrain_sync_queued",
      "sync_lagging",
    ] as const) {
      expect(m.isTerminal(s)).toBe(false);
    }
  });

  it("is TOTAL: an unknown state never throws — typed rejection", () => {
    const bogus = "nope" as KnowledgeMutationState;
    expect(() => m.transition(bogus, "planned")).not.toThrow();
    const r = m.transition(bogus, "planned");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
    expect(m.isTerminal(bogus)).toBe(false);
    expect(m.canTransition(bogus, "planned")).toBe(false);
  });

  it("is TOTAL: an unknown `to` never throws — illegal_transition", () => {
    const r = m.transition("planned", "nope" as KnowledgeMutationState);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });
});
