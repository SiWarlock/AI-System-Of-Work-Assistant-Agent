// TDD (red-first) for src/candidate-gate.ts — discharges LESSONS §3 for §8:
// the gate is a COMPOSITION (ajv structural + Zod .refine + §3 universal rule +
// envelope↔action linkage), NEVER ajv alone. A candidate that passes ajv but
// fails the Zod refine / universal rule / linkage MUST be rejected.
import { describe, it, expect } from "vitest";
import type { ProposedAction, ExternalWriteEnvelope } from "@sow/contracts";
import { admitProposedAction, admitExternalWriteEnvelope } from "../src/candidate-gate";

const goodAction: ProposedAction = {
  actionId: "action_1" as ProposedAction["actionId"],
  targetSystem: "drive",
  canonicalObjectKey: "cok_drive_abc",
  payload: { title: "x" },
  approvalPolicy: "requires_approval",
  idempotencyKey: "idem_abc",
};

const goodEnvelope: ExternalWriteEnvelope = {
  actionId: "action_1" as ExternalWriteEnvelope["actionId"],
  targetSystem: "drive",
  canonicalObjectKey: "cok_drive_abc",
  idempotencyKey: "idem_abc",
  preconditions: ["exists_check"],
  payloadHash: "sha256:deadbeef",
};

describe("admitProposedAction", () => {
  it("admits a well-formed ProposedAction and returns the branded value", () => {
    const r = admitProposedAction(goodAction);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.actionId).toBe("action_1");
      expect(r.value.canonicalObjectKey).toBe("cok_drive_abc");
    }
  });

  it("rejects a non-object candidate", () => {
    const r = admitProposedAction("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MALFORMED");
  });

  it("rejects an unknown targetSystem (ajv structural)", () => {
    const r = admitProposedAction({ ...goodAction, targetSystem: "salesforce" });
    expect(r.ok).toBe(false);
  });

  it("rejects an empty canonicalObjectKey (universal rule / Zod .min)", () => {
    const r = admitProposedAction({ ...goodAction, canonicalObjectKey: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a whitespace-only idempotencyKey the §3 universal rule catches", () => {
    // "  " passes ajv (a string) but the §3 rule treats trimmed-empty as missing.
    const r = admitProposedAction({ ...goodAction, idempotencyKey: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown extra keys (Zod .strict)", () => {
    const r = admitProposedAction({ ...goodAction, sneaky: true });
    expect(r.ok).toBe(false);
  });
});

describe("admitExternalWriteEnvelope", () => {
  it("admits a well-formed envelope (no action linkage requested)", () => {
    const r = admitExternalWriteEnvelope(goodEnvelope);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.payloadHash).toBe("sha256:deadbeef");
  });

  it("admits when the envelope↔action linkage matches", () => {
    const r = admitExternalWriteEnvelope(goodEnvelope, goodAction);
    expect(r.ok).toBe(true);
  });

  it("rejects when the envelope↔action linkage mismatches (different canonicalObjectKey)", () => {
    const mismatchedAction: ProposedAction = { ...goodAction, canonicalObjectKey: "cok_drive_OTHER" };
    const r = admitExternalWriteEnvelope(goodEnvelope, mismatchedAction);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("LINKAGE_MISMATCH");
  });

  it("rejects when the linked action targets a different system", () => {
    const mismatchedAction: ProposedAction = { ...goodAction, targetSystem: "github" };
    const r = admitExternalWriteEnvelope(goodEnvelope, mismatchedAction);
    expect(r.ok).toBe(false);
  });

  it("rejects an empty canonicalObjectKey", () => {
    const r = admitExternalWriteEnvelope({ ...goodEnvelope, canonicalObjectKey: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a whitespace-only idempotencyKey via the §3 universal rule", () => {
    const r = admitExternalWriteEnvelope({ ...goodEnvelope, idempotencyKey: "  " });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-object candidate", () => {
    const r = admitExternalWriteEnvelope(42);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MALFORMED");
  });
});
