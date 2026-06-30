// GbrainPin contract test (task 4.20 / WT(§13), §6/§13). RED-first field-set
// freeze + generated-schema drift guard + behavior + conditional-invariant
// coverage. Mirrors the canonical egress-policy.test.ts template. PURE — no
// app/adapter imports. GbrainPin is the typed config-contract for the
// `config/gbrain.pin` startup version-pin file (the file→model snake_case parser
// is Phase-4 task 4.20, NOT this freeze).
import { describe, expect, it } from "vitest";
import { GbrainPinSchema, GBRAIN_PIN_SCHEMA_ID } from "../../src/models/gbrain-pin";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A valid pin matching the current config/gbrain.pin values (camelCased), with
// write-through still OFF and validation still owed (PENDING sentinel).
const validPendingPin = {
  gbrainSha: "3933eb6a7915cb5495b8057b75567e2b1588b5ac",
  gbrainTag: "0.35.1.0",
  gbrainRepo: "https://github.com/garrytan/gbrain.git",
  indexSchemaVersion: 2,
  validatedOn: "PENDING_PHASE12",
  validationRef: "docs/design/gbrain-write-through-divergence.md",
  // writeThroughEnabled omitted on purpose — must default to false.
} as const;

describe("GbrainPin contract — spec(§6/§13)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(GbrainPinSchema, GBRAIN_PIN_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("gbrain-pin"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/gbrain-pin.schema.json", import.meta.url),
      emitJsonSchema(GbrainPinSchema, GBRAIN_PIN_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid pin with a PENDING sentinel and defaults writeThroughEnabled to false", () => {
    const ok = GbrainPinSchema.safeParse(validPendingPin);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.writeThroughEnabled).toBe(false);
  });

  it("accepts the PENDING_LIVE_VALIDATION sentinel with writeThroughEnabled explicitly false", () => {
    const ok = GbrainPinSchema.safeParse({
      ...validPendingPin,
      validatedOn: "PENDING_LIVE_VALIDATION",
      writeThroughEnabled: false,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a validated pin (ISO date validatedOn) with writeThroughEnabled true", () => {
    const ok = GbrainPinSchema.safeParse({
      ...validPendingPin,
      validatedOn: "2026-07-15",
      writeThroughEnabled: true,
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.writeThroughEnabled).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects a gbrainSha that is not 40-char lowercase hex (too short)", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, gbrainSha: "3933eb6a" });
    expect(bad.success).toBe(false);
  });

  it("rejects a gbrainSha with uppercase hex (regex is lowercase-only)", () => {
    const bad = GbrainPinSchema.safeParse({
      ...validPendingPin,
      gbrainSha: "3933EB6A7915CB5495B8057B75567E2B1588B5AC",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-url gbrainRepo", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, gbrainRepo: "not a url" });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-integer indexSchemaVersion", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, indexSchemaVersion: 2.5 });
    expect(bad.success).toBe(false);
  });

  it("rejects a negative indexSchemaVersion", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, indexSchemaVersion: -1 });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (gbrainSha)", () => {
    const { gbrainSha: _omit, ...withoutSha } = validPendingPin;
    const bad = GbrainPinSchema.safeParse(withoutSha);
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: validatedOn = ISO date OR PENDING_* sentinel ────
  // Passing cases are covered by the three "accepts" tests above (both
  // sentinels + an ISO date). The two failing directions:
  it("rejects a validatedOn that is neither an ISO date nor a sentinel", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, validatedOn: "tomorrow" });
    expect(bad.success).toBe(false);
  });

  it("rejects a partial/misspelled sentinel (sentinels are exact)", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, validatedOn: "PENDING" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty validatedOn", () => {
    const bad = GbrainPinSchema.safeParse({ ...validPendingPin, validatedOn: "" });
    expect(bad.success).toBe(false);
  });
});
