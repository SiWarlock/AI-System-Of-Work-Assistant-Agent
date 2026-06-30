// EgressPolicy contract test (task 1.3, §3/§5). RED-first schema-snapshot freeze
// + behavior + conditional-invariant coverage. This file is the CANONICAL
// template every other seam-model test copies. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { EgressPolicySchema, EGRESS_POLICY_SCHEMA_ID } from "../../src/models/egress-policy";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("EgressPolicy contract — spec(§3/§5)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(EgressPolicySchema, EGRESS_POLICY_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("egress-policy"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/egress-policy.schema.json", import.meta.url),
      emitJsonSchema(EgressPolicySchema, EGRESS_POLICY_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid policy with acknowledgment OFF and no acknowledgedAt", () => {
    const ok = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      // OpenRouter is its OWN processor (not an OpenAI alias); local Ollama/
      // LM Studio are non-egress and are never listed as required processors.
      allowedProcessors: ["claude-cloud", "openrouter", "drive"],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid policy with acknowledgment ON and an acknowledgedAt timestamp", () => {
    const ok = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: ["claude-cloud", "openrouter"],
      rawContentAllowedProcessors: ["openrouter"],
      employerRawEgressAcknowledged: true,
      acknowledgedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "   ",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace processor id in a list (branded non-empty)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [""],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-datetime acknowledgedAt", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: true,
      acknowledgedAt: "yesterday",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (employerRawEgressAcknowledged)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: acknowledgedAt present IFF acknowledged === true ─
  // Passing case each way is covered by the two "accepts a valid policy" tests
  // above (ON+timestamp, OFF+absent). The two failing directions:
  it("rejects acknowledged === true WITHOUT acknowledgedAt (IFF, forward)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: true,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects acknowledgedAt present WHILE acknowledged === false (IFF, reverse)", () => {
    const bad = EgressPolicySchema.safeParse({
      workspaceId: "ws-employer",
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
      acknowledgedAt: "2026-06-30T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});
