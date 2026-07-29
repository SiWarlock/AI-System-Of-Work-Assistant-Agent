// EntityRef contract test (§DEC-CANDGATE leg 1 — task 13.18, §2/§3). RED-first
// schema-snapshot freeze + behavior coverage. EntityRef is the model-supplied
// reference to an entity (person/project/concept) the §6 KN-10 living-vault
// synthesis grounds via resolveEntity (packages/knowledge) before any write.
// Leg 1 of 3 — this slice is the candidate-data gate only (packages/knowledge
// still declares its own identical EntityRef until leg 2 re-points the import).
// Closes L57/L60/L65's class-fix: `kind: EntityKind` was a compile-time claim
// about runtime-untrusted data with nothing enforcing it at the boundary.
// PURE — no app/adapter imports. Mirrors test/models/proposed-action.test.ts.
import { describe, expect, it } from "vitest";
import { EntityRefSchema, ENTITY_REF_SCHEMA_ID } from "../../src/models/entity-ref";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("EntityRef contract — spec(§2/§3)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ───────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(fieldSet(emitJsonSchema(EntityRefSchema, ENTITY_REF_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("entity-ref"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/entity-ref.schema.json", import.meta.url),
      emitJsonSchema(EntityRefSchema, ENTITY_REF_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  const valid = { name: "Jane Doe", kind: "person" } as const;

  // Build a copy of `valid` with one key removed (clean missing-field fixtures
  // without unused destructured bindings) — mirrors proposed-action.test.ts.
  const omit = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...valid };
    delete copy[key];
    return copy;
  };

  it("accepts each valid kind with a valid name (non-vacuity)", () => {
    for (const kind of ["person", "project", "concept"] as const) {
      expect(EntityRefSchema.safeParse({ name: "Acme API", kind }).success).toBe(true);
    }
  });

  it("rejects a kind outside the union, and a missing kind", () => {
    expect(EntityRefSchema.safeParse({ ...valid, kind: "organization" }).success).toBe(false);
    expect(EntityRefSchema.safeParse(omit("kind")).success).toBe(false);
  });

  // L65 — kind must not resolve through the prototype chain when a consumer
  // indexes on it. `ENTITY_NAMESPACES.get(kind ?? "")` is a Map today (prototype-
  // safe already) — this pin is defense-in-depth against a future consumer
  // switching to an object literal, not a live hole this schema alone closes.
  it("rejects prototype-chain kind values (L65 defense-in-depth)", () => {
    for (const kind of ["__proto__", "constructor", "prototype"]) {
      expect(EntityRefSchema.safeParse({ ...valid, kind }).success).toBe(false);
    }
  });

  // L60 — attendee display-name shapes no validator rejected caused two
  // high-severity bugs. Reject, never trim (Q2): a whitespace-only name is
  // exactly as un-evidenced as an empty one.
  it("rejects a non-string, empty, whitespace-only, or missing name", () => {
    expect(EntityRefSchema.safeParse({ ...valid, name: 42 }).success).toBe(false);
    expect(EntityRefSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(EntityRefSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(EntityRefSchema.safeParse(omit("name")).success).toBe(false);
  });

  // Q3 — the 1024 cap (mirrors ui-safe.ts's uiSafeSummaryLine), exercised
  // behaviorally rather than left to the frozen JSON-Schema snapshot alone
  // (code-quality review — a boundary a snapshot pins structurally still wants
  // a behavioral pin, matching every other rejection rule in this file).
  it("accepts a name at the 1024 cap and rejects one over it", () => {
    expect(EntityRefSchema.safeParse({ ...valid, name: "a".repeat(1024) }).success).toBe(true);
    expect(EntityRefSchema.safeParse({ ...valid, name: "a".repeat(1025) }).success).toBe(false);
  });

  // §ARM-RESEARCH residuals (13.8j/13.8k/13.8l) are all about a model-supplied
  // `path` reaching a writer-owned surface — `.strict()` means a smuggled `path`
  // on an EntityRef can't arrive at all.
  it("rejects an unknown top-level key (.strict)", () => {
    expect(EntityRefSchema.safeParse({ ...valid, path: "index.md" }).success).toBe(false);
  });

  // Totality: the field is `readonly EntityRef[]`, so a caller could pass the
  // array where one element is expected — that must fail too.
  it("rejects non-objects, including an array of refs where one ref is expected", () => {
    for (const bad of [null, undefined, "person", [], [valid]]) {
      expect(EntityRefSchema.safeParse(bad).success).toBe(false);
    }
  });
});
