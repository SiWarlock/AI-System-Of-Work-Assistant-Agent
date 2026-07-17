// AgentExtraction contract test (CP-1 / task 18.11, §19.5/§7 / Appendix A — GATE-1).
// RED-first schema-snapshot freeze + behavior coverage for the first-class
// `agent_extraction` candidate surface. PURE — no app/adapter imports, and NO
// @sow/domain import (contracts is BELOW domain in the DAG; the domain-side
// round-trip through validateNoInference lives in the domain test).
//
// The load-bearing GATE-1 property this pins is EVIDENCE-PRESERVATION: a concrete
// `value` carrying an `evidenceRef` round-trips through validation with the
// `evidenceRef` INTACT — so a downstream `validateNoInference` (REQ-F-017) sees
// the model's evidence. This is the anti-KMP-stand-in fix: the KMP stand-in
// (`sow:knowledge-mutation-plan`) discards per-field `evidenceRef`, so a real
// model's evidence-bearing fields could not reach the no-inference validator; the
// `sow:agent-extraction` schema carries them faithfully.
import { describe, expect, it } from "vitest";
import {
  AgentExtractionCandidateSchema,
  AGENT_EXTRACTION_SCHEMA_ID,
} from "../../src/models/agent-extraction";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { defaultSchemaRegistry } from "../../src/schema/registry";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// Canonical valid fixture: an evidence-bearing field-map. `owner` is a concrete
// evidence-backed claim; `dueDate` is the REQ-F-017 `TBD` park value (unstated →
// TBD, no evidenceRef required). Reused + spread-overridden by the negatives so
// each test perturbs ONE thing.
const VALID = {
  fields: {
    owner: { value: "Alice", evidenceRef: "transcript#L12" },
    dueDate: { value: "TBD" },
  },
} as const;

describe("AgentExtraction contract — spec(§19.5/§7 / Appendix A) — GATE-1", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ────────
  it("freezes its top-level field-name set to the spec snapshot — spec(§3)", () => {
    expect(fieldSet(emitJsonSchema(AgentExtractionCandidateSchema, AGENT_EXTRACTION_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("agent-extraction"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema — spec(§7 REQ-S-006)", () => {
    freezeGenerated(
      new URL("../../schemas/agent-extraction.schema.json", import.meta.url),
      emitJsonSchema(AgentExtractionCandidateSchema, AGENT_EXTRACTION_SCHEMA_ID),
    );
  });

  // ── Well-formed field-map ──────────────────────────────────────────────────
  it("accepts a well-formed evidence-bearing field-map — spec(§9 REQ-F-017)", () => {
    expect(AgentExtractionCandidateSchema.safeParse(VALID).success).toBe(true);
  });

  // ── The LOAD-BEARING GATE-1 pin: evidenceRef survives validation intact ─────
  it("preserves evidenceRef through validation (evidence-preserving; anti-KMP-stand-in) — spec(§9 REQ-F-017)", () => {
    const parsed = AgentExtractionCandidateSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The KMP stand-in discards this; the agent_extraction schema MUST keep it.
      expect(parsed.data.fields["owner"]?.evidenceRef).toBe("transcript#L12");
    }
  });

  // ── REQ-F-017 park value: TBD needs no evidenceRef ──────────────────────────
  it("accepts a TBD value with no evidenceRef (REQ-F-017 park value) — spec(§9 REQ-F-017)", () => {
    const parsed = AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "TBD" } } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fields["owner"]?.evidenceRef).toBeUndefined();
  });

  // ── Primitive value union: string | number | boolean (the TBD sentinel is a
  //    string, so it rides z.string()). Not null (absence is TBD, never null). ─
  it("accepts number and boolean primitive values (boundary)", () => {
    const parsed = AgentExtractionCandidateSchema.safeParse({
      fields: {
        count: { value: 3, evidenceRef: "src#L1" },
        urgent: { value: true, evidenceRef: "src#L2" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  // ── `number` is `.finite()`: a non-finite value is never a meaningful extraction
  //    value. (This also forces the anyOf emission — see the next test.) ─────────
  it("rejects a non-finite number value (NaN / ±Infinity)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: { n: { value: NaN } } }).success).toBe(false);
    expect(AgentExtractionCandidateSchema.safeParse({ fields: { n: { value: Infinity } } }).success).toBe(
      false,
    );
  });

  // ── The value union MUST emit as JSON-Schema `anyOf`, NOT a `type: [...]` union
  //    array (which ajv strict rejects without `allowUnionTypes`). This keeps the
  //    SHARED candidate-data-gate ajv in strict mode with no global config change;
  //    the registry-all "compiles under ajv strict" test is the end-to-end proof,
  //    this pins the shape locally so a regression is obvious at the model. ──────
  it("emits the value union as `anyOf`, not a union-type array (ajv-strict compatible)", () => {
    const schema = emitJsonSchema(AgentExtractionCandidateSchema, AGENT_EXTRACTION_SCHEMA_ID) as {
      properties: {
        fields: { additionalProperties: { properties: { value: Record<string, unknown> } } };
      };
    };
    const valueSchema = schema.properties.fields.additionalProperties.properties.value;
    expect(Array.isArray(valueSchema["type"])).toBe(false);
    expect(valueSchema["anyOf"]).toBeDefined();
  });

  // ── Division of labor (GATE-1 seam): the frozen schema PRESERVES the field; the
  //    domain `validateNoInference` JUDGES it. So the schema must NOT enforce
  //    non-emptiness of `value` or `evidenceRef` — a future `.min(1)` on either
  //    would be a deliberate re-freeze that defeats the "schema preserves, validator
  //    judges" design, and these positive pins make that impossible to land silently.
  it("accepts an empty-string value at the SCHEMA level (the validator, not the schema, judges an unstated concrete value)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "" } } }).success).toBe(true);
  });

  it("accepts an empty/whitespace evidenceRef at the SCHEMA level (schema PRESERVES; validateNoInference judges backing)", () => {
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "Alice", evidenceRef: "" } } })
        .success,
    ).toBe(true);
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "Alice", evidenceRef: "   " } } })
        .success,
    ).toBe(true);
  });

  // ── Structural: an empty field-map is VALID at the frozen contract level.
  //    Non-emptiness (a meeting must carry ≥1 field) is a DOWNSTREAM candidate-
  //    gate concern (the §9 field catalog is an arch_gap) — the frozen schema
  //    pins STRUCTURE only, not the field catalog. ────────────────────────────
  it("accepts an empty fields map (structural; non-emptiness is a downstream candidate-gate concern)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: {} }).success).toBe(true);
  });

  // ── Malformed rejections (candidate-data gate, REQ-S-006) ───────────────────
  it("rejects a field missing `value` (required) — spec(§7 REQ-S-006)", () => {
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { evidenceRef: "src#L1" } } }).success,
    ).toBe(false);
  });

  it("rejects a non-primitive value (object/array) — spec(§7 REQ-S-006)", () => {
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: { nested: "x" } } } }).success,
    ).toBe(false);
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: ["a", "b"] } } }).success,
    ).toBe(false);
  });

  it("rejects a null value (absence is TBD, never null — parity with the worker structural gate)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: null } } }).success).toBe(
      false,
    );
  });

  it("rejects a non-string evidenceRef", () => {
    expect(
      AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "Alice", evidenceRef: 12 } } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown key INSIDE a field (.strict inner — a model can't smuggle extra keys)", () => {
    expect(
      AgentExtractionCandidateSchema.safeParse({
        fields: { owner: { value: "Alice", evidenceRef: "src#L1", smuggled: "x" } },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown top-level key (.strict outer / additionalProperties:false)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: {}, extra: "nope" }).success).toBe(false);
  });

  it("rejects a missing `fields` (required)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-object fields (must be a record)", () => {
    expect(AgentExtractionCandidateSchema.safeParse({ fields: "owner=Alice" }).success).toBe(false);
  });

  // ── Reserved prototype-pollution field-name BLOCKLIST (catalog-independent) ──
  // A `__proto__`/`constructor`/`prototype` field key is rejected STRUCTURALLY on
  // BOTH gate legs: ajv (the candidate-data gate's structural half, via
  // `propertyNames`) AND Zod. `__proto__` is the load-bearing case — Zod's record
  // parser would SILENTLY DROP it (the L3 ajv↔Zod parity gap the security review
  // found), so we assert the ajv leg REJECTS it, not merely drops it. Keys are
  // built via JSON.parse so `__proto__` is a real own property (an object literal
  // `{ __proto__: … }` would set the prototype, not create the key).
  describe("reserved prototype-pollution field keys (structural blocklist)", () => {
    const raw = (key: string): unknown =>
      JSON.parse(`{"fields":{"${key}":{"value":"InventedOwner"}}}`);
    const ajvValidate = defaultSchemaRegistry.getValidator(AGENT_EXTRACTION_SCHEMA_ID);

    it("ajv (candidate-data gate structural half) REJECTS a __proto__ field key — spec(§7 REQ-S-006)", () => {
      expect(ajvValidate).toBeTypeOf("function");
      expect(ajvValidate?.(raw("__proto__"))).toBe(false);
    });

    it("ajv REJECTS constructor and prototype field keys — spec(§7 REQ-S-006)", () => {
      expect(ajvValidate?.(raw("constructor"))).toBe(false);
      expect(ajvValidate?.(raw("prototype"))).toBe(false);
    });

    it("Zod REJECTS __proto__ / constructor / prototype field keys (not silently dropped)", () => {
      expect(AgentExtractionCandidateSchema.safeParse(raw("__proto__")).success).toBe(false);
      expect(AgentExtractionCandidateSchema.safeParse(raw("constructor")).success).toBe(false);
      expect(AgentExtractionCandidateSchema.safeParse(raw("prototype")).success).toBe(false);
    });

    it("does not pollute Object.prototype from a __proto__-keyed candidate (defense-in-depth)", () => {
      AgentExtractionCandidateSchema.safeParse(raw("__proto__"));
      expect((({}) as Record<string, unknown>)["value"]).toBeUndefined();
    });

    it("still accepts an ordinary field name (the blocklist is narrow, not an allowlist)", () => {
      expect(
        AgentExtractionCandidateSchema.safeParse({ fields: { owner: { value: "Alice", evidenceRef: "s#L1" } } })
          .success,
      ).toBe(true);
    });
  });
});
