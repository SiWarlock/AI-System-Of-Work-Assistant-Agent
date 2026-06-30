// ExternalWriteEnvelope contract test (task 1.7, §3/§8). RED-first schema-snapshot
// freeze + behavior coverage + the ProposedAction→envelope linkage pin
// (envelopeMatchesAction). PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  ExternalWriteEnvelopeSchema,
  EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID,
  envelopeMatchesAction,
} from "../../src/models/external-write-envelope";
import { ProposedActionSchema } from "../../src/models/proposed-action";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A complete, valid envelope fixture (both optionals present).
const fullEnvelope = {
  actionId: "act-1",
  targetSystem: "linear",
  canonicalObjectKey: "linear:issue:ACME-123",
  idempotencyKey: "idem-abc",
  preconditions: ["object-absent", "connector-reachable"],
  payloadHash: "sha256:deadbeefcafe",
  approvalId: "appr-1",
  writeReceipt: {
    externalObjectId: "ISSUE-9000",
    externalUrl: "https://linear.app/acme/issue/ACME-123",
    recordedAt: "2026-06-30T12:00:00.000Z",
    rawRef: "outbox:write:42",
  },
};

describe("ExternalWriteEnvelope contract — spec(§3/§8)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ──────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(
      fieldSet(
        emitJsonSchema(ExternalWriteEnvelopeSchema, EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID),
      ),
    ).toEqual(loadFieldSnapshot("external-write-envelope"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/external-write-envelope.schema.json", import.meta.url),
      emitJsonSchema(ExternalWriteEnvelopeSchema, EXTERNAL_WRITE_ENVELOPE_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a full valid envelope (both optionals present)", () => {
    const ok = ExternalWriteEnvelopeSchema.safeParse(fullEnvelope);
    expect(ok.success).toBe(true);
  });

  it("accepts a minimal valid envelope (no approvalId / writeReceipt)", () => {
    const ok = ExternalWriteEnvelopeSchema.safeParse({
      actionId: "act-1",
      targetSystem: "calendar",
      canonicalObjectKey: "calendar:event:2026-07-01",
      idempotencyKey: "idem-xyz",
      preconditions: [],
      payloadHash: "sha256:0",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing actionId (required)", () => {
    const { actionId: _omit, ...rest } = fullEnvelope;
    const bad = ExternalWriteEnvelopeSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects a missing canonicalObjectKey (required)", () => {
    const { canonicalObjectKey: _omit, ...rest } = fullEnvelope;
    const bad = ExternalWriteEnvelopeSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects a missing idempotencyKey (required)", () => {
    const { idempotencyKey: _omit, ...rest } = fullEnvelope;
    const bad = ExternalWriteEnvelopeSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects a missing payloadHash (required)", () => {
    const { payloadHash: _omit, ...rest } = fullEnvelope;
    const bad = ExternalWriteEnvelopeSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects a missing preconditions (required array)", () => {
    const { preconditions: _omit, ...rest } = fullEnvelope;
    const bad = ExternalWriteEnvelopeSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace actionId (branded non-empty)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, actionId: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty canonicalObjectKey (min 1)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({
      ...fullEnvelope,
      canonicalObjectKey: "",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty idempotencyKey (min 1)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, idempotencyKey: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty payloadHash (min 1)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, payloadHash: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty-string entry in preconditions (array of non-empty)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({
      ...fullEnvelope,
      preconditions: ["ok", ""],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set targetSystem", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, targetSystem: "jira" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace approvalId when present (branded)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({ ...fullEnvelope, approvalId: "  " });
    expect(bad.success).toBe(false);
  });

  it("rejects an invalid nested writeReceipt (non-datetime recordedAt — transitive freeze)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({
      ...fullEnvelope,
      writeReceipt: { externalObjectId: "ISSUE-9000", recordedAt: "yesterday" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown key inside nested writeReceipt (.strict transitive)", () => {
    const bad = ExternalWriteEnvelopeSchema.safeParse({
      ...fullEnvelope,
      writeReceipt: {
        externalObjectId: "ISSUE-9000",
        recordedAt: "2026-06-30T12:00:00.000Z",
        bogus: "nope",
      },
    });
    expect(bad.success).toBe(false);
  });

  // ── Linkage pin: envelope ↔ ProposedAction agreement (safety rule 3) ───────
  // The §8 Tool Gateway turns a ProposedAction into an ExternalWriteEnvelope;
  // the four shared keys (actionId, targetSystem, canonicalObjectKey,
  // idempotencyKey) MUST agree so the pre-write existence check + replay dedupe
  // target the same object the approval covered.
  const pairedAction = ProposedActionSchema.parse({
    actionId: "act-1",
    targetSystem: "linear",
    canonicalObjectKey: "linear:issue:ACME-123",
    payload: { title: "Ship it" },
    approvalPolicy: "requires_approval",
    idempotencyKey: "idem-abc",
  });

  it("envelopeMatchesAction: true when the four shared keys agree (paired fixture)", () => {
    const env = ExternalWriteEnvelopeSchema.parse(fullEnvelope);
    expect(envelopeMatchesAction(env, pairedAction)).toBe(true);
  });

  it("envelopeMatchesAction: false on actionId mismatch", () => {
    const env = ExternalWriteEnvelopeSchema.parse({ ...fullEnvelope, actionId: "act-OTHER" });
    expect(envelopeMatchesAction(env, pairedAction)).toBe(false);
  });

  it("envelopeMatchesAction: false on targetSystem mismatch", () => {
    const env = ExternalWriteEnvelopeSchema.parse({ ...fullEnvelope, targetSystem: "asana" });
    expect(envelopeMatchesAction(env, pairedAction)).toBe(false);
  });

  it("envelopeMatchesAction: false on canonicalObjectKey mismatch", () => {
    const env = ExternalWriteEnvelopeSchema.parse({
      ...fullEnvelope,
      canonicalObjectKey: "linear:issue:OTHER",
    });
    expect(envelopeMatchesAction(env, pairedAction)).toBe(false);
  });

  it("envelopeMatchesAction: false on idempotencyKey mismatch", () => {
    const env = ExternalWriteEnvelopeSchema.parse({
      ...fullEnvelope,
      idempotencyKey: "idem-OTHER",
    });
    expect(envelopeMatchesAction(env, pairedAction)).toBe(false);
  });
});
