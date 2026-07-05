// spec(§8 / §9.6 / §9.8) — Phase-C C5.2a: deriveCopilotProposedAction, the propose-action DERIVATION.
//
// The security heart of "write-via-Approvals": the model supplies only an INTENT (targetSystem + operation +
// the object's identity fields + payload) — NEVER the keys. This suite pins that the canonicalObjectKey +
// idempotencyKey are DERIVED server-side (so the model can't smuggle a key that mismatches the payload), that
// approvalPolicy is forced to require human approval, that the derived action is idempotent by its derived
// key, and that malformed intent fails closed.
import { describe, it, expect } from "vitest";
import { isOk, isErr, ProposedActionSchema } from "@sow/contracts";
import {
  deriveCopilotProposedAction,
  COPILOT_PROPOSE_APPROVAL_POLICY,
  MAX_PROPOSE_PAYLOAD_CHARS,
  type CopilotProposeIntent,
} from "../../../src/api/procedures/copilotPropose";

function intent(over: Partial<CopilotProposeIntent> = {}): CopilotProposeIntent {
  return {
    targetSystem: "todoist",
    operation: "todoist.create_task",
    identity: { title: "Draft the Q3 launch checklist" },
    payload: { title: "Draft the Q3 launch checklist", due: "2026-07-08" },
    ...over,
  };
}

describe("deriveCopilotProposedAction — DERIVE the canonical action (keys are server-computed, never model-supplied)", () => {
  it("derives a schema-valid ProposedAction with server-computed cok_/idem_ keys and a human-approval policy", () => {
    const r = deriveCopilotProposedAction(intent());
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const a = r.value;
    expect(ProposedActionSchema.safeParse(a).success).toBe(true);
    expect(a.targetSystem).toBe("todoist");
    expect(a.canonicalObjectKey).toMatch(/^cok_todoist_[0-9a-f]{64}$/);
    expect(a.idempotencyKey).toMatch(/^idem_[0-9a-f]{64}$/);
    // idempotency BY the derived Approval id: actionId === the derived idempotencyKey.
    expect(String(a.actionId)).toBe(a.idempotencyKey);
    // a Copilot proposal ALWAYS requires a human — never auto-applied.
    expect(a.approvalPolicy).toBe(COPILOT_PROPOSE_APPROVAL_POLICY);
    expect(a.payload).toEqual({ title: "Draft the Q3 launch checklist", due: "2026-07-08" });
  });

  it("is DETERMINISTIC — the same intent yields identical keys (idempotent re-drive)", () => {
    const a = deriveCopilotProposedAction(intent());
    const b = deriveCopilotProposedAction(intent());
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    expect(a.value.canonicalObjectKey).toBe(b.value.canonicalObjectKey);
    expect(a.value.idempotencyKey).toBe(b.value.idempotencyKey);
    expect(a.value.actionId).toBe(b.value.actionId);
  });

  it("a DIFFERENT object identity yields DIFFERENT canonical + idempotency keys", () => {
    const a = deriveCopilotProposedAction(intent({ identity: { title: "A" } }));
    const b = deriveCopilotProposedAction(intent({ identity: { title: "B" } }));
    if (!isOk(a) || !isOk(b)) throw new Error("expected ok");
    expect(a.value.canonicalObjectKey).not.toBe(b.value.canonicalObjectKey);
    expect(a.value.idempotencyKey).not.toBe(b.value.idempotencyKey);
  });

  it("the PAYLOAD does not affect the keys (keys are object-identity, not content) — the system's idempotency model", () => {
    const a = deriveCopilotProposedAction(intent({ payload: { due: "2026-07-08" } }));
    const b = deriveCopilotProposedAction(intent({ payload: { due: "2026-07-09" } }));
    if (!isOk(a) || !isOk(b)) throw new Error("expected ok");
    expect(a.value.canonicalObjectKey).toBe(b.value.canonicalObjectKey);
    expect(a.value.idempotencyKey).toBe(b.value.idempotencyKey);
  });

  it("the OPERATION affects the idempotency key but NOT the canonical (object) key", () => {
    const a = deriveCopilotProposedAction(intent({ operation: "todoist.create_task" }));
    const b = deriveCopilotProposedAction(intent({ operation: "todoist.update_task" }));
    if (!isOk(a) || !isOk(b)) throw new Error("expected ok");
    expect(a.value.canonicalObjectKey).toBe(b.value.canonicalObjectKey);
    expect(a.value.idempotencyKey).not.toBe(b.value.idempotencyKey);
  });

  it("REJECTS an unknown targetSystem (fail-closed — a Copilot can't invent an external system)", () => {
    const r = deriveCopilotProposedAction(intent({ targetSystem: "slack" }));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_BAD_TARGET");
  });

  it("REJECTS an empty operation", () => {
    const r = deriveCopilotProposedAction(intent({ operation: "   " }));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_BAD_OPERATION");
  });

  it("REJECTS an empty object identity (would collapse every proposal to one canonical key → wrong-object write)", () => {
    const empty = deriveCopilotProposedAction(intent({ identity: {} }));
    expect(isErr(empty)).toBe(true);
    if (!isErr(empty)) return;
    expect(empty.error.cause?.code).toBe("COPILOT_PROPOSE_EMPTY_IDENTITY");
  });

  it("REJECTS an all-blank object identity", () => {
    const blank = deriveCopilotProposedAction(intent({ identity: { title: "   ", note: "" } }));
    expect(isErr(blank)).toBe(true);
    if (!isErr(blank)) return;
    expect(blank.error.cause?.code).toBe("COPILOT_PROPOSE_EMPTY_IDENTITY");
  });

  // ── fail-closed on the UNTRUSTED intent boundary (never throws — the intent is model output) ──
  it("FAILS CLOSED (no throw) on a non-string identity value — e.g. a numeric external id", () => {
    // the natural update case: `identity: { title, id: 12345 }`. The numeric id must be REJECTED, not throw
    // downstream in normalizeIdentity((12345).trim()).
    const r = deriveCopilotProposedAction({ ...intent(), identity: { title: "x", id: 12345 } });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
  });

  it("FAILS CLOSED on a non-object / missing-field intent (never throws)", () => {
    for (const bad of [null, undefined, "nope", 42, {}, { targetSystem: "todoist" }]) {
      const r = deriveCopilotProposedAction(bad);
      expect(isErr(r)).toBe(true);
      if (!isErr(r)) continue;
      expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
    }
  });

  it("REJECTS an unexpected extra field on the intent (strict — no smuggled key field)", () => {
    const r = deriveCopilotProposedAction({ ...intent(), canonicalObjectKey: "cok_todoist_deadbeef" });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
  });

  it("REJECTS an oversized payload (storage/render DoS bound)", () => {
    const huge = { blob: "x".repeat(MAX_PROPOSE_PAYLOAD_CHARS + 1) };
    const r = deriveCopilotProposedAction(intent({ payload: huge }));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_PAYLOAD_TOO_LARGE");
  });
});
