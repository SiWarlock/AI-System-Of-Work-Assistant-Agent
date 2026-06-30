// Source state machine (task 1.12 / DOMAIN_MODEL.md §Source). PURE/TOTAL — the
// engine never throws; illegal edges, leaving a terminal state, and off-alphabet
// targets (e.g. the forbidden `external_write`) all return a typed err(...).
//
// DOMAIN_MODEL.md §Source:
//   captured -> classified -> (queued_for_review | processing) -> proposed
//             -> applied | rejected | failed_retryable | failed_terminal
//   failed_retryable -> processing  (retry; per task 1.12 bullet)
//   Forbidden: captured -> applied (skips classification + policy validation);
//              processing -> external_write (no such state — source agent cannot
//              drive an external write).
import { describe, it, expect } from "vitest";
import { sourceMachine, SOURCE_STATES } from "../../src/state/source";
import type { SourceState } from "../../src/state/source";

const ALL: readonly SourceState[] = [
  "captured",
  "classified",
  "queued_for_review",
  "processing",
  "proposed",
  "applied",
  "rejected",
  "failed_retryable",
  "failed_terminal",
];

describe("sourceMachine (Source domain state machine)", () => {
  it("exposes the full declared state set (9 states)", () => {
    expect([...SOURCE_STATES].sort()).toEqual([...ALL].sort());
    expect([...sourceMachine.states].sort()).toEqual([...ALL].sort());
  });

  // ---- happy-path edges (all legal) ----
  const legal: ReadonlyArray<readonly [SourceState, SourceState]> = [
    ["captured", "classified"],
    ["classified", "queued_for_review"],
    ["classified", "processing"],
    ["queued_for_review", "proposed"],
    ["processing", "proposed"],
    ["proposed", "applied"],
    ["proposed", "rejected"],
    ["proposed", "failed_retryable"],
    ["proposed", "failed_terminal"],
    ["failed_retryable", "processing"], // retry back-edge
  ];

  it.each(legal)("legal edge %s -> %s returns ok(to)", (from, to) => {
    expect(sourceMachine.canTransition(from, to)).toBe(true);
    const r = sourceMachine.transition(from, to);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(to);
  });

  // ---- terminality ----
  it("terminal states are exactly {applied, rejected, failed_terminal}", () => {
    expect(sourceMachine.isTerminal("applied")).toBe(true);
    expect(sourceMachine.isTerminal("rejected")).toBe(true);
    expect(sourceMachine.isTerminal("failed_terminal")).toBe(true);
    // failed_retryable is NOT terminal — it retries to processing.
    expect(sourceMachine.isTerminal("failed_retryable")).toBe(false);
    for (const s of [
      "captured",
      "classified",
      "queued_for_review",
      "processing",
      "proposed",
    ] as const) {
      expect(sourceMachine.isTerminal(s)).toBe(false);
    }
  });

  it("terminal states are frozen — every outgoing move is err terminal_state", () => {
    const cases: ReadonlyArray<readonly [SourceState, SourceState]> = [
      ["applied", "classified"],
      ["rejected", "proposed"],
      ["failed_terminal", "processing"],
    ];
    for (const [from, to] of cases) {
      const r = sourceMachine.transition(from, to);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("terminal_state");
        expect(r.error.from).toBe(from);
        expect(r.error.to).toBe(to);
      }
    }
  });

  // ---- PINNED forbidden #1: captured -> applied (skips classification/policy) ----
  it("PINNED: captured -> applied is illegal_transition (skips classification + policy)", () => {
    expect(sourceMachine.canTransition("captured", "applied")).toBe(false);
    const r = sourceMachine.transition("captured", "applied");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("illegal_transition");
      expect(r.error.from).toBe("captured");
      expect(r.error.to).toBe("applied");
    }
  });

  // ---- PINNED forbidden #2: no external_write state/edge ----
  it("PINNED: 'external_write' is not a state in this machine", () => {
    expect(SOURCE_STATES).not.toContain("external_write");
    expect(sourceMachine.states).not.toContain("external_write");
  });

  it("PINNED: processing -> external_write is rejected (no external_write target)", () => {
    const ext = "external_write" as SourceState; // off-alphabet on purpose
    expect(sourceMachine.canTransition("processing", ext)).toBe(false);
    const r = sourceMachine.transition("processing", ext);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // processing is a known, non-terminal state, so an unknown target is an
      // illegal edge (not terminal_state) — and never a throw.
      expect(r.error.code).toBe("illegal_transition");
      expect(r.error.from).toBe("processing");
      expect(r.error.to).toBe("external_write");
    }
  });

  // ---- TOTALITY: unknown states never throw, always typed rejection ----
  it("is TOTAL: an unknown `from` returns err illegal_transition (no throw)", () => {
    const r = sourceMachine.transition("nope" as SourceState, "classified");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: an unknown `to` returns err illegal_transition (no throw)", () => {
    const r = sourceMachine.transition("captured", "nope" as SourceState);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: isTerminal/canTransition on an unknown state never throw", () => {
    expect(sourceMachine.isTerminal("nope" as SourceState)).toBe(false);
    expect(sourceMachine.canTransition("nope" as SourceState, "classified")).toBe(
      false,
    );
  });

  // arch_gap guard: queued_for_review converges directly to proposed; the spec
  // does not name a queued_for_review -> processing edge, so it must be illegal.
  it("arch_gap: queued_for_review -> processing is not a declared edge (illegal)", () => {
    const r = sourceMachine.transition("queued_for_review", "processing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("illegal_transition");
  });
});
