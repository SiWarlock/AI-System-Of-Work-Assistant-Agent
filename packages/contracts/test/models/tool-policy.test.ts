// ToolPolicy contract test (task 1.3, §3/§5/§7). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage + pure-predicate coverage
// (isToolPolicyConsistent / effectiveAllowedTools). PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  ToolPolicySchema,
  TOOL_POLICY_SCHEMA_ID,
  isToolPolicyConsistent,
  effectiveAllowedTools,
} from "../../src/models/tool-policy";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("ToolPolicy contract — spec(§3/§5/§7)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ──────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(fieldSet(emitJsonSchema(ToolPolicySchema, TOOL_POLICY_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("tool-policy"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/tool-policy.schema.json", import.meta.url),
      emitJsonSchema(ToolPolicySchema, TOOL_POLICY_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid read_only policy (allowsMutating false)", () => {
    const ok = ToolPolicySchema.safeParse({
      mode: "read_only",
      allowedTools: ["fs.read", "gbrain.search"],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid scoped_write policy (allowsMutating true)", () => {
    const ok = ToolPolicySchema.safeParse({
      mode: "scoped_write",
      allowedTools: ["fs.write", "calendar.create"],
      deniedTools: ["fs.delete"],
      allowsMutating: true,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "read_only",
      allowedTools: [],
      deniedTools: [],
      allowsMutating: false,
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace tool in allowedTools (branded non-empty)", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "read_only",
      allowedTools: [""],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace tool in deniedTools (branded non-empty)", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "scoped_write",
      allowedTools: ["fs.write"],
      deniedTools: ["   "],
      allowsMutating: true,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set mode value", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "full_access",
      allowedTools: [],
      deniedTools: [],
      allowsMutating: true,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (allowsMutating)", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "read_only",
      allowedTools: [],
      deniedTools: [],
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant (refine): NOT(read_only AND allowsMutating) ──────
  // Passing direction covered by the two "accepts valid policy" tests above
  // (read_only+false, scoped_write+true). An extra passing case + the failing
  // case below pin both directions of the refine.
  it("accepts scoped_write WITH allowsMutating true (refine pass)", () => {
    const ok = ToolPolicySchema.safeParse({
      mode: "scoped_write",
      allowedTools: [],
      deniedTools: [],
      allowsMutating: true,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects read_only WITH allowsMutating true (refine fail)", () => {
    const bad = ToolPolicySchema.safeParse({
      mode: "read_only",
      allowedTools: [],
      deniedTools: [],
      allowsMutating: true,
    });
    expect(bad.success).toBe(false);
  });

  // ── Pure predicate: isToolPolicyConsistent (read_only ⇒ !allowsMutating) ───
  it("isToolPolicyConsistent: true for read_only + allowsMutating false", () => {
    const p = ToolPolicySchema.parse({
      mode: "read_only",
      allowedTools: ["fs.read"],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(isToolPolicyConsistent(p)).toBe(true);
  });

  it("isToolPolicyConsistent: false for read_only + allowsMutating true", () => {
    // Built by spread to bypass the construction-time refine — the predicate is
    // the independent §5 admission-gate check, usable on any ToolPolicy value.
    const base = ToolPolicySchema.parse({
      mode: "read_only",
      allowedTools: ["fs.read"],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(isToolPolicyConsistent({ ...base, allowsMutating: true })).toBe(false);
  });

  it("isToolPolicyConsistent: true for scoped_write regardless of allowsMutating", () => {
    const mutating = ToolPolicySchema.parse({
      mode: "scoped_write",
      allowedTools: ["fs.write"],
      deniedTools: [],
      allowsMutating: true,
    });
    const nonMutating = ToolPolicySchema.parse({
      mode: "scoped_write",
      allowedTools: ["fs.write"],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(isToolPolicyConsistent(mutating)).toBe(true);
    expect(isToolPolicyConsistent(nonMutating)).toBe(true);
  });

  // ── Pure predicate: effectiveAllowedTools (allowed minus denied; deny wins) ─
  it("effectiveAllowedTools: removes denied tools (deny wins on overlap)", () => {
    const p = ToolPolicySchema.parse({
      mode: "scoped_write",
      allowedTools: ["a", "b", "c"],
      deniedTools: ["b"],
      allowsMutating: true,
    });
    expect(effectiveAllowedTools(p)).toEqual(["a", "c"]);
  });

  it("effectiveAllowedTools: returns all allowed when nothing is denied", () => {
    const p = ToolPolicySchema.parse({
      mode: "read_only",
      allowedTools: ["a", "b"],
      deniedTools: [],
      allowsMutating: false,
    });
    expect(effectiveAllowedTools(p)).toEqual(["a", "b"]);
  });

  it("effectiveAllowedTools: returns empty when every allowed tool is denied", () => {
    const p = ToolPolicySchema.parse({
      mode: "scoped_write",
      allowedTools: ["a", "b"],
      deniedTools: ["a", "b"],
      allowsMutating: true,
    });
    expect(effectiveAllowedTools(p)).toEqual([]);
  });
});
