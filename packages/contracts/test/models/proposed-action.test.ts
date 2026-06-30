// ProposedAction contract test (task 1.7, §3/§8/§9). RED-first schema-snapshot
// freeze + behavior coverage. ProposedAction is the §8 Tool-Gateway external-write
// proposal: every external write carries a non-empty canonicalObjectKey AND
// idempotencyKey (§3 universal external-write rule / safety rule 3). PURE — no
// app/adapter imports. Mirrors the EgressPolicy canonical test template.
import { describe, expect, it } from "vitest";
import {
  ProposedActionSchema,
  PROPOSED_ACTION_SCHEMA_ID,
} from "../../src/models/proposed-action";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("ProposedAction contract — spec(§3/§8/§9)", () => {
  // ── Frozen field-name set (spec, hand-authored in __snapshots__) ───────────
  it("freezes its top-level field-name set (spec snapshot)", () => {
    expect(fieldSet(emitJsonSchema(ProposedActionSchema, PROPOSED_ACTION_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("proposed-action"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/proposed-action.schema.json", import.meta.url),
      emitJsonSchema(ProposedActionSchema, PROPOSED_ACTION_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  const valid = {
    actionId: "act-001",
    targetSystem: "github",
    canonicalObjectKey: "github:owner/repo#issue:fix-the-thing",
    payload: { title: "Fix the thing", body: "details" },
    approvalPolicy: "auto",
    idempotencyKey: "idem-abc123",
  } as const;

  // Build a copy of `valid` with one key removed (clean missing-field fixtures
  // without unused destructured bindings).
  const omit = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...valid };
    delete copy[key];
    return copy;
  };

  it("accepts a valid proposed action", () => {
    expect(ProposedActionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an empty-object payload (open shape, arch_gap)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, payload: {} }).success).toBe(true);
  });

  it("accepts every allowed targetSystem (calendar|todoist|linear|asana|drive|github|telegram)", () => {
    for (const ts of [
      "calendar",
      "todoist",
      "linear",
      "asana",
      "drive",
      "github",
      "telegram",
    ] as const) {
      expect(ProposedActionSchema.safeParse({ ...valid, targetSystem: ts }).success).toBe(true);
    }
  });

  it("rejects an unknown targetSystem (closed enum)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, targetSystem: "slack" }).success).toBe(false);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false);
  });

  it("rejects a missing actionId", () => {
    expect(ProposedActionSchema.safeParse(omit("actionId")).success).toBe(false);
  });

  it("rejects an empty/whitespace actionId (branded non-empty)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, actionId: "   " }).success).toBe(false);
  });

  // Universal external-write rule (§3): canonicalObjectKey required + non-empty.
  it("rejects a missing canonicalObjectKey (universal external-write rule)", () => {
    expect(ProposedActionSchema.safeParse(omit("canonicalObjectKey")).success).toBe(false);
  });

  it("rejects an empty canonicalObjectKey (non-empty)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, canonicalObjectKey: "" }).success).toBe(false);
  });

  // Universal external-write rule (§3): idempotencyKey required + non-empty.
  it("rejects a missing idempotencyKey (universal external-write rule)", () => {
    expect(ProposedActionSchema.safeParse(omit("idempotencyKey")).success).toBe(false);
  });

  it("rejects an empty idempotencyKey (non-empty)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, idempotencyKey: "" }).success).toBe(false);
  });

  it("rejects an empty approvalPolicy (open non-empty string, arch_gap)", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, approvalPolicy: "" }).success).toBe(false);
  });

  it("rejects a missing payload", () => {
    expect(ProposedActionSchema.safeParse(omit("payload")).success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(ProposedActionSchema.safeParse({ ...valid, payload: "nope" }).success).toBe(false);
  });
});
