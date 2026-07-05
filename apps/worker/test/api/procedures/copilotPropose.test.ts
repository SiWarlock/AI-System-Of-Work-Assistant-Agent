// spec(§8 / §9.6 / §9.8) — Phase-C C5.2a: deriveCopilotProposedAction, the propose-action DERIVATION.
//
// The security heart of "write-via-Approvals": the model supplies only an INTENT (targetSystem + operation +
// the object's identity fields + payload) — NEVER the keys. This suite pins that the canonicalObjectKey +
// idempotencyKey are DERIVED server-side (so the model can't smuggle a key that mismatches the payload), that
// approvalPolicy is forced to require human approval, that the derived action is idempotent by its derived
// key, and that malformed intent fails closed.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, failure, ProposedActionSchema, envelopeMatchesAction } from "@sow/contracts";
import type { ProposedAction, WorkspaceId } from "@sow/contracts";
import {
  deriveCopilotProposedAction,
  routeCopilotProposal,
  proposeCopilotAction,
  COPILOT_PROPOSE_APPROVAL_POLICY,
  COPILOT_PROPOSE_PRECONDITION,
  MAX_PROPOSE_PAYLOAD_CHARS,
  type CopilotProposeIntent,
  type CopilotProposeSink,
  type CopilotProposeReceipt,
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

// ── C5.2b: routeCopilotProposal / proposeCopilotAction → §9.8 Approvals (unconditional) ──
const WS = "personal-business" as WorkspaceId;

function validAction(): ProposedAction {
  const r = deriveCopilotProposedAction(intent());
  if (!isOk(r)) throw new Error("fixture derive failed");
  return r.value;
}

/** A fake sink capturing what it recorded; `created` + an optional forced error are injectable. */
function fakeSink(opts: { created?: boolean; fail?: boolean } = {}): {
  sink: CopilotProposeSink;
  calls: () => number;
  last: () => { action: ProposedAction; workspaceId: string } | undefined;
} {
  let n = 0;
  let last: { action: ProposedAction; workspaceId: string } | undefined;
  const sink: CopilotProposeSink = {
    record: async (input) => {
      n += 1;
      last = { action: input.action, workspaceId: String(input.workspaceId) };
      if (opts.fail === true) {
        return err(failure("connector_unreachable", "approvals sink down", { cause: { code: "SINK_DOWN" } }));
      }
      const receipt: CopilotProposeReceipt = { approvalRef: "appr-1", created: opts.created ?? true };
      return ok(receipt);
    },
  };
  return { sink, calls: () => n, last: () => last };
}

describe("routeCopilotProposal — records a pending Approval, envelope linkage-pinned to the action", () => {
  it("builds a linkage-pinned envelope (envelopeMatchesAction) with the copilot precondition and records it pending", async () => {
    const action = validAction();
    const f = fakeSink();
    const captured: { envMatches?: boolean; preconditions?: readonly string[] } = {};
    // wrap to capture the envelope the sink saw
    const sink: CopilotProposeSink = {
      record: async (input) => {
        captured.envMatches = envelopeMatchesAction(input.envelope, input.action);
        captured.preconditions = input.envelope.preconditions;
        return f.sink.record(input);
      },
    };
    const r = await routeCopilotProposal({ action, workspaceId: WS, sink });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value).toEqual({ approvalRef: "appr-1", created: true });
    expect(captured.envMatches).toBe(true); // the §8 linkage pin holds (safety rule 3)
    expect(captured.preconditions).toContain(COPILOT_PROPOSE_PRECONDITION);
  });

  it("is idempotent by the derived key — a re-drive returns created:false (no second card)", async () => {
    const f = fakeSink({ created: false });
    const r = await routeCopilotProposal({ action: validAction(), workspaceId: WS, sink: f.sink });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.created).toBe(false);
  });

  it("passes a sink failure through as a typed FailureVariant", async () => {
    const f = fakeSink({ fail: true });
    const r = await routeCopilotProposal({ action: validAction(), workspaceId: WS, sink: f.sink });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("SINK_DOWN");
  });

  it("folds a THROWING sink to a bounded COPILOT_PROPOSE_SINK_THREW (never rejects; discards the raw error)", async () => {
    const throwingSink: CopilotProposeSink = {
      record: async () => {
        throw new Error("db exploded: secret=hunter2");
      },
    };
    const r = await routeCopilotProposal({ action: validAction(), workspaceId: WS, sink: throwingSink });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_SINK_THREW");
    expect(r.error.message).not.toContain("secret"); // redaction — the raw error is discarded
  });

  it("routes UNCONDITIONALLY — an action whose approvalPolicy is NOT requires_approval STILL records pending (human gate is structural)", async () => {
    // carry-forward #1: the routing must not branch on approvalPolicy. Craft an auto-ish policy and confirm it routes.
    const base = validAction();
    const autoish = ProposedActionSchema.parse({ ...base, approvalPolicy: "auto_apply" });
    const f = fakeSink();
    const r = await routeCopilotProposal({ action: autoish, workspaceId: WS, sink: f.sink });
    expect(isOk(r)).toBe(true);
    expect(f.calls()).toBe(1); // recorded pending regardless of the policy string
  });
});

describe("proposeCopilotAction — the full derive → route path the tool handler invokes", () => {
  it("derives from the intent and routes to Approvals", async () => {
    const f = fakeSink();
    const r = await proposeCopilotAction({ intent: intent(), workspaceId: WS, sink: f.sink });
    expect(isOk(r)).toBe(true);
    expect(f.calls()).toBe(1);
    expect(f.last()?.action.targetSystem).toBe("todoist");
    expect(f.last()?.workspaceId).toBe("personal-business");
  });

  it("SHORT-CIRCUITS on a malformed intent — the sink is never touched (no partial record)", async () => {
    const f = fakeSink();
    const r = await proposeCopilotAction({ intent: { nope: true }, workspaceId: WS, sink: f.sink });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.cause?.code).toBe("COPILOT_PROPOSE_MALFORMED");
    expect(f.calls()).toBe(0);
  });
});
