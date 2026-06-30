// spec(§9) — DOMAIN_MODEL.md state machine (phase-exit spec coverage)
// Approval state-machine self-test (PURE, TOTAL — no clock/random/IO).
// DOMAIN_MODEL.md §Approval: pending -> approved | edited | rejected | deferred
// | expired. deferred is NON-TERMINAL (deferred -> pending | expired); the other
// four are terminal/frozen. REQ-F-012 (Mac+Telegram parity): re-applying a
// terminal transition (e.g. approved -> approved) is an idempotent no-op SUCCESS,
// not an error — exactly-once semantics across both channels.
import { describe, it, expect } from "vitest";
import {
  approvalMachine,
  APPROVAL_STATES,
  APPROVAL_DEFAULTS,
} from "../../src/state/approval";
import type { ApprovalState } from "../../src/state/approval";

describe("approvalMachine (REQ-F-012, DOMAIN_MODEL §Approval)", () => {
  it("exposes the declared 6-state set", () => {
    expect([...APPROVAL_STATES].sort()).toEqual([
      "approved",
      "deferred",
      "edited",
      "expired",
      "pending",
      "rejected",
    ]);
    expect([...approvalMachine.states].sort()).toEqual([...APPROVAL_STATES].sort());
  });

  it("isTerminal: approved/edited/rejected/expired are frozen; pending/deferred are not", () => {
    expect(approvalMachine.isTerminal("approved")).toBe(true);
    expect(approvalMachine.isTerminal("edited")).toBe(true);
    expect(approvalMachine.isTerminal("rejected")).toBe(true);
    expect(approvalMachine.isTerminal("expired")).toBe(true);
    expect(approvalMachine.isTerminal("pending")).toBe(false);
    // deferred is NON-TERMINAL — it re-surfaces.
    expect(approvalMachine.isTerminal("deferred")).toBe(false);
  });

  it("happy path: pending may move to any of the five outcomes", () => {
    for (const to of ["approved", "edited", "rejected", "deferred", "expired"] as const) {
      const r = approvalMachine.transition("pending", to);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it("happy path: deferred re-surfaces to pending or expires", () => {
    const toPending = approvalMachine.transition("deferred", "pending");
    expect(toPending.ok).toBe(true);
    if (toPending.ok) expect(toPending.value).toBe("pending");

    const toExpired = approvalMachine.transition("deferred", "expired");
    expect(toExpired.ok).toBe(true);
    if (toExpired.ok) expect(toExpired.value).toBe("expired");
  });

  // --- PINNED cases named in the task brief ---

  it("PIN: deferred -> pending is legal (deferred is non-terminal)", () => {
    expect(approvalMachine.canTransition("deferred", "pending")).toBe(true);
    const r = approvalMachine.transition("deferred", "pending");
    expect(r.ok).toBe(true);
  });

  it("PIN: pending -> approved is legal", () => {
    const r = approvalMachine.transition("pending", "approved");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("approved");
  });

  it("PIN: approved -> approved is an idempotent no-op SUCCESS (exactly-once parity)", () => {
    const r = approvalMachine.transition("approved", "approved");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("approved");
  });

  it("PIN: approved -> rejected is err terminal_state (terminal is frozen)", () => {
    const r = approvalMachine.transition("approved", "rejected");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("terminal_state");
      expect(r.error.from).toBe("approved");
      expect(r.error.to).toBe("rejected");
    }
  });

  it("idempotent reentry is same-state-only: a terminal -> different terminal still errs", () => {
    const r = approvalMachine.transition("edited", "approved");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("terminal_state");
  });

  it("every terminal state is frozen: leaving it errs terminal_state", () => {
    for (const from of ["approved", "edited", "rejected", "expired"] as const) {
      const r = approvalMachine.transition(from, "pending");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("terminal_state");
        expect(r.error.from).toBe(from);
      }
    }
  });

  it("illegal non-terminal edges err illegal_transition (not terminal_state)", () => {
    // pending is non-terminal but has no self-loop.
    const selfLoop = approvalMachine.transition("pending", "pending");
    expect(selfLoop.ok).toBe(false);
    if (!selfLoop.ok) expect(selfLoop.error.code).toBe("illegal_transition");

    // deferred is non-terminal but only re-surfaces to pending|expired.
    const deferredToApproved = approvalMachine.transition("deferred", "approved");
    expect(deferredToApproved.ok).toBe(false);
    if (!deferredToApproved.ok) {
      expect(deferredToApproved.error.code).toBe("illegal_transition");
    }

    // deferred -> deferred is NOT idempotent (idempotency is terminal-only).
    const deferredSelf = approvalMachine.transition("deferred", "deferred");
    expect(deferredSelf.ok).toBe(false);
    if (!deferredSelf.ok) expect(deferredSelf.error.code).toBe("illegal_transition");
  });

  it("is TOTAL: an unknown state never throws — typed rejection", () => {
    const unknownFrom = approvalMachine.transition("frozen" as ApprovalState, "pending");
    expect(unknownFrom.ok).toBe(false);
    if (!unknownFrom.ok) expect(unknownFrom.error.code).toBe("illegal_transition");

    const unknownTo = approvalMachine.transition("pending", "frozen" as ApprovalState);
    expect(unknownTo.ok).toBe(false);
    if (!unknownTo.ok) expect(unknownTo.error.code).toBe("illegal_transition");

    expect(approvalMachine.isTerminal("frozen" as ApprovalState)).toBe(false);
    expect(approvalMachine.canTransition("frozen" as ApprovalState, "pending")).toBe(false);
  });

  it("exposes the configurable snooze/expiry windows as pure constants", () => {
    expect(APPROVAL_DEFAULTS.snoozeMs).toBe(24 * 60 * 60 * 1000); // 24h
    expect(APPROVAL_DEFAULTS.expiryMs).toBe(7 * 24 * 60 * 60 * 1000); // 7d
  });
});
