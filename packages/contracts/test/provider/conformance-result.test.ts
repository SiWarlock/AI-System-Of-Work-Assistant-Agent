// spec(§7) — ConformanceResult contract (task 5.10). RED-first schema-snapshot
// freeze + behavior + invariant coverage: the frozen field-name set (the
// cross-track seam), the generated JSON Schema drift guard, the status/egress/
// subjectKind enums, the redaction-safe optional `detail`, and .strict() rejection
// of any unknown key. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  ConformanceResultSchema,
  CONFORMANCE_RESULT_SCHEMA_ID,
} from "../../src/provider/conformance-result";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// representative valid PASSING cloud provider result; behavior cases override one field.
const valid = {
  subjectKind: "provider",
  subjectId: "openrouter",
  capability: "meeting.close",
  model: "anthropic/claude-haiku-4.5",
  egressClass: "cloud",
  status: "passing",
  checkedAt: "2026-06-30T12:00:00.000Z",
};

describe("ConformanceResult contract — spec(§7)", () => {
  // ── Frozen field-name set (the spec snapshot, hand-authored in __snapshots__) ──
  it("freezes its top-level field-name set (the spec snapshot)", () => {
    expect(
      fieldSet(emitJsonSchema(ConformanceResultSchema, CONFORMANCE_RESULT_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("conformance-result"));
  });

  // ── Generated JSON Schema drift guard (first run writes; runs assert) ──────────
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/conformance-result.schema.json", import.meta.url),
      emitJsonSchema(ConformanceResultSchema, CONFORMANCE_RESULT_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  it("accepts a valid passing cloud provider result", () => {
    expect(ConformanceResultSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a runtime subject with an open runtime id", () => {
    expect(
      ConformanceResultSchema.safeParse({
        ...valid,
        subjectKind: "runtime",
        subjectId: "claude-agent-sdk",
      }).success,
    ).toBe(true);
  });

  it("accepts a failing result carrying a redaction-safe detail", () => {
    expect(
      ConformanceResultSchema.safeParse({
        ...valid,
        status: "failing",
        egressClass: "local",
        detail: "schema_violation:/tasks/0/owner",
      }).success,
    ).toBe(true);
  });

  it("accepts every ConformanceStatus enum value", () => {
    for (const status of ["unknown", "passing", "failing", "disabled"]) {
      expect(ConformanceResultSchema.safeParse({ ...valid, status }).success).toBe(true);
    }
  });

  // ── Enum / required-field rejections ─────────────────────────────────────────
  it("rejects an out-of-enum subjectKind", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, subjectKind: "tool" }).success).toBe(
      false,
    );
  });

  it("rejects an out-of-enum status", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, status: "flaky" }).success).toBe(false);
  });

  it("rejects an out-of-enum egressClass", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, egressClass: "hybrid" }).success).toBe(
      false,
    );
  });

  it("rejects a non-datetime checkedAt", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, checkedAt: "2026-06-30" }).success).toBe(
      false,
    );
  });

  it("rejects an empty subjectId / model / capability (non-empty strings)", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, subjectId: "" }).success).toBe(false);
    expect(ConformanceResultSchema.safeParse({ ...valid, model: "" }).success).toBe(false);
    expect(ConformanceResultSchema.safeParse({ ...valid, capability: " " }).success).toBe(false);
  });

  it("rejects an empty detail when present (non-empty string)", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, detail: "" }).success).toBe(false);
  });

  it("rejects a missing required field (checkedAt)", () => {
    const { checkedAt: _omit, ...withoutCheckedAt } = valid;
    expect(ConformanceResultSchema.safeParse(withoutCheckedAt).success).toBe(false);
  });

  // ── §16 redaction: no raw-content / secret-bearing field at all ───────────────
  it("declares no raw-content or secret-bearing field (redaction posture)", () => {
    const fields = fieldSet(emitJsonSchema(ConformanceResultSchema, CONFORMANCE_RESULT_SCHEMA_ID));
    for (const banned of ["apiKey", "token", "secret", "prompt", "rawContent", "output"]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("rejects an unknown top-level field (.strict())", () => {
    expect(ConformanceResultSchema.safeParse({ ...valid, region: "us" }).success).toBe(false);
  });
});
