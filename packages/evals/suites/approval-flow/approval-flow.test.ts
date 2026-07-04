// spec(§20.1 "Approval flow" · §8 · REQ-F-012) — task: Approval flow acceptance.
//
// A shared-calendar-invite proposal is surfaced as a PENDING approval card with
// Mac+Telegram parity; it can be edited / approved / rejected / deferred, and each
// human decision is a single durable, auditable transition — decided exactly ONCE
// across BOTH channels. The load-bearing safety here is the real @sow/domain
// `approvalMachine`: it admits only legal transitions, freezes the four terminals,
// and (via `idempotentTerminalReentry`) makes a second same-decision from the other
// channel an ok NO-OP rather than a double transition — the precondition the
// single-transition-single-audit CAS (`createApplyTransitionActivity`, its own
// coverage) rests on.
//
// This drives the REAL machine (not a mock). It scores APPROVAL_FLOW through the
// 12.1 runner with a value DERIVED from the assertions (not hardcoded).
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { approvalMachine, APPROVAL_STATES, type ApprovalState } from "@sow/domain";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// The Approval Inbox / Telegram decision → target status projection (the command
// path only ever drives these four legal transitions out of `pending`).
const DECISION_TO_STATUS = {
  approve: "approved",
  edit: "edited",
  reject: "rejected",
  defer: "deferred",
} as const;
type Decision = keyof typeof DECISION_TO_STATUS;
const TERMINALS: readonly ApprovalState[] = ["approved", "edited", "rejected", "expired"];

describe("§20.1 Approval flow — a surfaced proposal is pending and decidable", () => {
  it("exposes exactly the frozen ApprovalStatus alphabet", () => {
    expect([...approvalMachine.states].sort()).toEqual([...APPROVAL_STATES].sort());
    expect(approvalMachine.isTerminal("pending")).toBe(false); // a fresh card awaits a decision
  });

  it("admits each Mac/Telegram decision as a legal transition out of pending", () => {
    for (const decision of Object.keys(DECISION_TO_STATUS) as Decision[]) {
      const target = DECISION_TO_STATUS[decision];
      const r = approvalMachine.transition("pending", target);
      expect(isOk(r), `decision '${decision}' -> ${target} must be legal`).toBe(true);
      if (isOk(r)) expect(r.value).toBe(target);
    }
  });
});

describe("§20.1 Approval flow — exactly once across BOTH channels (Mac + Telegram)", () => {
  it("a second identical decision from the other channel is an idempotent no-op success", () => {
    // Mac approves → approved. Telegram then also 'approves' the same card: the
    // machine returns ok(approved) WITHOUT a second transition (no double audit/dispatch).
    const second = approvalMachine.transition("approved", "approved");
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value).toBe("approved");
  });

  it("a CONFLICTING decision from the other channel on a decided card is refused (terminal_state)", () => {
    // Mac approved; Telegram tries to reject the same card — a decided card cannot
    // be flipped. Typed err, never a throw.
    const flip = approvalMachine.transition("approved", "rejected");
    expect(isErr(flip)).toBe(true);
    if (isErr(flip)) expect(flip.error.code).toBe("terminal_state");
  });
});

describe("§20.1 Approval flow — terminals are frozen; a decided/expired card can't be re-decided", () => {
  it("marks approved/edited/rejected/expired terminal with no outgoing edges", () => {
    for (const t of TERMINALS) {
      expect(approvalMachine.isTerminal(t), `${t} must be terminal`).toBe(true);
      for (const other of APPROVAL_STATES) {
        if (other === t) continue;
        expect(approvalMachine.canTransition(t, other), `${t} -> ${other} must be forbidden`).toBe(false);
      }
    }
  });

  it("refuses to re-decide a rejected or expired card (terminal_state)", () => {
    for (const from of ["rejected", "expired"] as ApprovalState[]) {
      const r = approvalMachine.transition(from, "approved");
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.code).toBe("terminal_state");
    }
  });
});

describe("§20.1 Approval flow — deferred re-surfaces; illegal moves are typed rejections", () => {
  it("a deferred card re-surfaces to pending (snooze) or expires — but cannot be approved directly", () => {
    expect(approvalMachine.isTerminal("deferred")).toBe(false);
    expect(isOk(approvalMachine.transition("deferred", "pending"))).toBe(true);
    expect(isOk(approvalMachine.transition("deferred", "expired"))).toBe(true);
    const direct = approvalMachine.transition("deferred", "approved");
    expect(isErr(direct)).toBe(true);
    if (isErr(direct)) expect(direct.error.code).toBe("illegal_transition"); // must re-surface first
  });

  it("an illegal self-edge from pending is a typed error, never a throw", () => {
    const r = approvalMachine.transition("pending", "pending");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("illegal_transition");
  });
});

describe("§20.1 Approval flow — EVAL-1 runner scoring", () => {
  // Derive the criterion value from the actual invariants (not a hardcoded true).
  const decisionsLegal = (Object.values(DECISION_TO_STATUS) as ApprovalState[]).every((s) =>
    isOk(approvalMachine.transition("pending", s)),
  );
  const secondChannelNoop = isOk(approvalMachine.transition("approved", "approved"));
  const flipRefused = isErr(approvalMachine.transition("approved", "rejected"));
  const deferredResurfaces =
    isOk(approvalMachine.transition("deferred", "pending")) &&
    isErr(approvalMachine.transition("deferred", "approved"));
  const allHeld = decisionsLegal && secondChannelNoop && flipRefused && deferredResurfaces;

  it("scores APPROVAL_FLOW passing + DoD-valid (deterministic enforcement is the real path)", () => {
    const out = scoreById({ criterionId: "APPROVAL_FLOW", value: allHeld, fromRealIntegration: false });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
    expect(criterionById("APPROVAL_FLOW")?.requiresRealIntegration).toBe(false);
  });

  it("a failing measurement does not pass (runner honesty)", () => {
    const out = scoreById({ criterionId: "APPROVAL_FLOW", value: false, fromRealIntegration: false });
    expect(out.functionalPass).toBe(false);
    expect(out.dodPass).toBe(false);
  });
});
