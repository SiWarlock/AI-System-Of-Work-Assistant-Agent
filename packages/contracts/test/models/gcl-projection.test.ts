// GclProjection contract test (task 1.8, §3/§5/§6/§11). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage. Mirrors the canonical
// EgressPolicy test template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  GclProjectionSchema,
  GCL_PROJECTION_SCHEMA_ID,
  isRawContentShaped,
  carriesRawContent,
} from "../../src/models/gcl-projection";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("GclProjection contract — spec(§3/§5/§6/§11)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ──────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(fieldSet(emitJsonSchema(GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("gcl-projection"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; runs assert) ─────
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/gcl-projection.schema.json", import.meta.url),
      emitJsonSchema(GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid sanitized cross-workspace projection", () => {
    const ok = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      // projectionType is an OPEN string (taxonomy unspecified upstream — §5/§6).
      projectionType: "busy_free_window",
      // sanitizedPayload carries only summary/metadata — never raw content.
      sanitizedPayload: { title: "Standup", start: "2026-06-30T09:00:00.000Z", priority: 2 },
      sourceRefs: [{ sourceId: "src-cal-1" }],
    });
    expect(ok.success).toBe(true);
  });

  it("accepts an empty sanitizedPayload and empty sourceRefs (shape gate only)", () => {
    const ok = GclProjectionSchema.safeParse({
      workspaceId: "ws-personal",
      visibilityLevel: "sanitized",
      projectionType: "deadline",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: {},
      sourceRefs: [],
      leakedExtra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  // ── reject-on-missing: workspaceId AND visibilityLevel required (§6 Gate) ──
  it("rejects a projection missing workspaceId (source workspace required)", () => {
    const bad = GclProjectionSchema.safeParse({
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a projection missing visibilityLevel (visibility required)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      projectionType: "busy_free_window",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "   ",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a visibilityLevel outside the closed enum", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "public",
      projectionType: "busy_free_window",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty projectionType (non-empty string)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "",
      sanitizedPayload: {},
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: sanitizedPayload forbids raw-content-shaped keys ─
  // Passing direction covered by the "accepts a valid ..." tests above.
  // Each forbidden raw-content-shaped key is a failing direction:
  it("rejects sanitizedPayload carrying a rawContent key (leakage shape gate)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: { rawContent: "secret transcript bytes" },
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects sanitizedPayload carrying a body key (leakage shape gate)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: { body: "full note body" },
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects sanitizedPayload carrying a content key (leakage shape gate)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: { content: "raw content" },
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a raw-content-shaped key regardless of case (Content / RawContent)", () => {
    const bad = GclProjectionSchema.safeParse({
      workspaceId: "ws-employer",
      visibilityLevel: "coordination",
      projectionType: "busy_free_window",
      sanitizedPayload: { Content: "raw content" },
      sourceRefs: [],
    });
    expect(bad.success).toBe(false);
  });

  // ── REGRESSION (adversarial verify): the raw-content gate is KEY-NAME-INDEPENDENT.
  // The prior 3-key denylist let verbatim raw content ride ANY other key name. Now a
  // multi-line or over-length string value is rejected regardless of key, recursively.
  const proj = (sanitizedPayload: Record<string, unknown>) => ({
    workspaceId: "ws-employer",
    visibilityLevel: "coordination",
    projectionType: "busy_free_window",
    sanitizedPayload,
    sourceRefs: [],
  });
  it("rejects a MULTI-LINE string value under a non-denylist key", () => {
    expect(GclProjectionSchema.safeParse(proj({ summary: "line one\nline two — raw transcript" })).success).toBe(false);
  });
  it("rejects an OVER-LENGTH string value under a non-denylist key", () => {
    expect(GclProjectionSchema.safeParse(proj({ digest: "x".repeat(1025) })).success).toBe(false);
  });
  it("rejects raw content nested under a non-denylist key (recursive scan)", () => {
    expect(GclProjectionSchema.safeParse(proj({ meta: { detail: "para one\npara two" } })).success).toBe(false);
    expect(GclProjectionSchema.safeParse(proj({ items: [{ transcript: "verbatim" }] })).success).toBe(false);
  });
  it("still ACCEPTS short single-line summary values (no false positive)", () => {
    expect(GclProjectionSchema.safeParse(proj({ busySlots: 3, label: "Standup", priority: 2 })).success).toBe(true);
  });

  // ── REGRESSION (adversarial verify, round 2 — task 24.19 / WS-1 finding F15):
  // the gate's own in-code claim is "KEY-NAME-INDEPENDENT: it scans EVERY value
  // recursively (nested objects + arrays)... regardless of key name." The
  // traversal is `Object.entries`, which yields [] for Map/Set instances (their
  // entries are internal slots, not own enumerable string-keyed properties) and
  // skips non-enumerable own properties — both shapes pass silently today,
  // contradicting the stated guarantee. These test the TRAVERSAL FUNCTIONS
  // directly (not only via GclProjectionSchema.safeParse) because a DIRECTLY
  // TOP-LEVEL non-enumerable `sanitizedPayload` property is NOT reachable
  // through the schema entry point: empirically verified, Zod's own
  // `z.record(z.string(), z.unknown())` parsing drops a top-level non-enumerable
  // property before .refine() ever runs (it never survives into the parsed
  // output) — inert through the real caller for THAT one shape. ⚠ Precisely
  // scoped, not a blanket claim (security-reviewer, 24.19 Step 8): a
  // non-enumerable property NESTED one level down inside a plain-object VALUE
  // is NOT dropped by Zod (object identity is preserved by z.unknown(), so it
  // DOES reach .refine()) — it's simply already caught there, by the same
  // getOwnPropertyNames-based fix these tests pin, at every depth. Map and Set
  // values, and a Symbol-keyed own property, all pass through Zod's z.unknown()
  // UNCHANGED regardless of nesting depth, so those bypasses ARE reachable
  // end-to-end — the Map/Set case is covered separately below via
  // GclProjectionSchema.safeParse to prove that; the Symbol case similarly,
  // further down.
  it("raw_content_gate_rejects_map_with_raw_string_value: a Map value carrying a multi-line string is raw-content-shaped [spec(§6)]", () => {
    const m = new Map([["x", "line one\nline two — raw transcript"]]);
    expect(carriesRawContent({ schedule: m })).toBe(true);
  });

  it("raw_content_gate_rejects_set_with_raw_string_value: a Set value carrying an over-length string is raw-content-shaped [spec(§6)]", () => {
    const s = new Set(["x".repeat(1025)]);
    expect(carriesRawContent({ tags: s })).toBe(true);
  });

  it("raw_content_gate_rejects_non_enumerable_raw_property: a non-enumerable own property carrying raw content is raw-content-shaped [spec(§6)]", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "secret", {
      value: "line one\nline two — hidden raw text",
      enumerable: false,
    });
    expect(isRawContentShaped(obj)).toBe(true);
  });

  // Depth ≥2 coverage (code-quality-reviewer, 24.19 Step 8) — the recursion is
  // structurally uniform, but pin it directly rather than infer it: a
  // non-enumerable property NESTED inside a plain-object value (not
  // sanitizedPayload's own top level) is caught too — it survives Zod's
  // z.unknown() pass-through (object identity preserved) and reaches
  // isRawContentShaped's own getOwnPropertyNames scan, unlike the top-level
  // case above, which Zod's z.record parsing drops before .refine() ever runs.
  it("raw_content_gate_rejects_a_non_enumerable_property_nested_two_levels_deep [spec(§6)]", () => {
    const inner: Record<string, unknown> = {};
    Object.defineProperty(inner, "secret", {
      value: "line one\nline two — hidden raw text, nested",
      enumerable: false,
    });
    const bad = GclProjectionSchema.safeParse(proj({ meta: inner }));
    expect(bad.success).toBe(false);
  });

  it("raw_content_gate_still_passes_correctly_shaped_nested_content: nested objects/arrays/short-values are unchanged (no regression) [spec(§6)]", () => {
    expect(carriesRawContent({ meta: { detail: "para one\npara two" } })).toBe(true);
    expect(carriesRawContent({ items: [{ transcript: "verbatim" }] })).toBe(true);
    expect(carriesRawContent({ busySlots: 3, label: "Standup", priority: 2 })).toBe(false);
  });

  it("raw_content_gate_rejects_non_plain_object_structurally: ANY non-plain-object/array value is rejected by construction, not only Map/Set [spec(§6)]", () => {
    expect(carriesRawContent({ when: new Date() })).toBe(true);
    expect(carriesRawContent({ handle: new WeakMap() })).toBe(true);
    class Custom {
      x = 1;
    }
    expect(carriesRawContent({ custom: new Custom() })).toBe(true);
  });

  // security-reviewer (24.19 Step 8): Object.getOwnPropertyNames returns only
  // STRING-keyed own properties — a Symbol-keyed own property carrying raw
  // content is invisible to it, the SAME bug class this task exists to fix
  // (empirically verified LIVE through the real schema entry point: z.unknown()
  // preserves object identity, so a Symbol-keyed property survives Zod's own
  // parsing untouched — this is not a theoretical shape).
  it("raw_content_gate_rejects_a_symbol_keyed_raw_property: a Symbol-keyed own property carrying raw content is raw-content-shaped [spec(§6)]", () => {
    const sym = Symbol("hidden");
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, sym, {
      value: "line one\nline two — raw symbol-keyed",
      enumerable: true,
    });
    expect(isRawContentShaped(obj)).toBe(true);
  });

  it("rejects a sanitizedPayload value carrying a Symbol-keyed raw property, via the real schema entry point", () => {
    const sym = Symbol("hidden");
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, sym, {
      value: "line one\nline two — raw symbol-keyed",
      enumerable: true,
    });
    const bad = GclProjectionSchema.safeParse(proj({ meta: nested }));
    expect(bad.success).toBe(false);
  });

  // ── Schema-level (real entry point) confirmation: proves the Map/Set bypass
  // is reachable through GclProjectionSchema.safeParse itself, not merely a
  // traversal-function-level concern (verified: Zod's z.unknown() passes a
  // Map/Set VALUE through untouched — it does not reshape it).
  it("rejects a sanitizedPayload value that is a Map carrying raw content, via the real schema entry point", () => {
    const bad = GclProjectionSchema.safeParse(
      proj({ schedule: new Map([["slot1", "line one\nline two — raw"]]) }),
    );
    expect(bad.success).toBe(false);
  });

  it("rejects a sanitizedPayload value that is a Set carrying raw content, via the real schema entry point", () => {
    const bad = GclProjectionSchema.safeParse(proj({ tags: new Set(["x".repeat(1025)]) }));
    expect(bad.success).toBe(false);
  });
});
