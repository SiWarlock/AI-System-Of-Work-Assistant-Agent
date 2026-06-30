// GclProjection contract test (task 1.8, §3/§5/§6/§11). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage. Mirrors the canonical
// EgressPolicy test template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID } from "../../src/models/gcl-projection";
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
});
