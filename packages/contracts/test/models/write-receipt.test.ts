// WriteReceipt contract test (task 1.7, §8). RED-first schema-snapshot freeze +
// behavior + invariant coverage, copied from the canonical egress-policy
// template. WriteReceipt is the sub-shape of `ExternalWriteEnvelope.writeReceipt`
// — the proof an external write committed exactly once. PURE — no app/adapter
// imports.
import { describe, expect, it } from "vitest";
import { WriteReceiptSchema, WRITE_RECEIPT_SCHEMA_ID } from "../../src/models/write-receipt";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("WriteReceipt contract — spec(§8)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(WriteReceiptSchema, WRITE_RECEIPT_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("write-receipt"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/write-receipt.schema.json", import.meta.url),
      emitJsonSchema(WriteReceiptSchema, WRITE_RECEIPT_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a minimal receipt (only the required fields)", () => {
    const ok = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a full receipt (all optional fields present)", () => {
    const ok = WriteReceiptSchema.safeParse({
      externalObjectId: "linear-ISSUE-42",
      externalUrl: "https://linear.app/acme/issue/ISSUE-42",
      recordedAt: "2026-06-30T12:00:00.000Z",
      rawRef: "audit:raw/2026-06-30/evt-abc123",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
      recordedAt: "2026-06-30T12:00:00.000Z",
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing externalObjectId (required)", () => {
    const bad = WriteReceiptSchema.safeParse({
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty externalObjectId (required non-empty)", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "",
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing recordedAt (required)", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-datetime recordedAt", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
      recordedAt: "yesterday",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-URL externalUrl when present", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
      externalUrl: "not a url",
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty rawRef when present (optional but non-empty)", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "gcal-evt-abc123",
      recordedAt: "2026-06-30T12:00:00.000Z",
      rawRef: "",
    });
    expect(bad.success).toBe(false);
  });

  // ── Invariant: externalObjectId is the proof an external write committed ────
  // exactly once — a whitespace-only id is not real proof. Passing + failing.
  it("accepts a non-whitespace externalObjectId (invariant, passing)", () => {
    const ok = WriteReceiptSchema.safeParse({
      externalObjectId: "drive-file-1A2b3C",
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a whitespace-only externalObjectId (invariant, failing)", () => {
    const bad = WriteReceiptSchema.safeParse({
      externalObjectId: "   ",
      recordedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});
