// Slice 6.2 — buildEnvelopeFromAction: builds a validated ExternalWriteEnvelope
// from a ProposedAction. Pins: envelope↔action linkage holds (safety invariant
// 3), payloadHash is the foundation payloadHash of the action payload, and a
// tampered key fails the foundation candidate-gate.
import { describe, it, expect } from "vitest";
import { envelopeMatchesAction, isOk, isErr } from "@sow/contracts";
import { payloadHash } from "../src/hash/payload-hash";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import { makeProposedAction } from "./support/fakes";

describe("buildEnvelopeFromAction", () => {
  it("builds an envelope whose linkage matches the originating action", () => {
    const action = makeProposedAction({
      canonicalObjectKey: "cok_drive_link",
      idempotencyKey: "idem_link",
      payload: { title: "hello", body: "world" },
    });
    const res = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const env = res.value;
    expect(envelopeMatchesAction(env, action)).toBe(true);
    expect(env.canonicalObjectKey).toBe("cok_drive_link");
    expect(env.idempotencyKey).toBe("idem_link");
    expect(env.preconditions).toEqual(["exists_check"]);
  });

  it("sets payloadHash to the foundation payloadHash of the action payload", () => {
    const payload = { z: 1, a: 2, nested: { b: 3, a: 4 } };
    const action = makeProposedAction({ payload });
    const res = buildEnvelopeFromAction(action, { preconditions: [] });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.payloadHash).toBe(payloadHash(payload));
  });

  it("carries an approvalId when supplied", () => {
    const action = makeProposedAction();
    const res = buildEnvelopeFromAction(action, {
      preconditions: [],
      approvalId: "approval_1",
    });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.approvalId).toBe("approval_1");
  });

  it("fails the candidate-gate when the action carries a tampered (empty) key", () => {
    // An empty idempotencyKey must be rejected by the gate — never yield an
    // envelope that would pass the pre-write existence check on a blank key.
    const action = makeProposedAction({ idempotencyKey: "" });
    const res = buildEnvelopeFromAction(action, { preconditions: [] });
    expect(isErr(res)).toBe(true);
  });
});
