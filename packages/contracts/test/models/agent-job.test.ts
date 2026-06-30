// AgentJob contract test (task 1.6, §3/§7/§9). RED-first schema-snapshot freeze
// + behavior (COST-1 budget pins, trust/embedded-policy gates) + the §3
// referential pin (outputSchemaId resolves in a SchemaRegistry). Mirrors the
// canonical egress-policy.test.ts template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentJobSchema,
  AGENT_JOB_SCHEMA_ID,
  isRegisteredOutputSchema,
} from "../../src/models/agent-job";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { buildSchemaRegistry } from "../../src/schema/registry";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// Fresh valid AgentJob; spread + override per case so one bad field is isolated.
function validJob(): Record<string, unknown> {
  return {
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-employer",
    capability: "meeting_closeout",
    contextRefs: [{ refKind: "source_envelope", ref: "src-1" }],
    outputSchemaId: "sow:knowledge-mutation-plan",
    toolPolicy: {
      mode: "read_only",
      allowedTools: ["gbrain.search"],
      deniedTools: [],
      allowsMutating: false,
    },
    providerRoute: {
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    },
    trustLevel: "trusted",
    carriesRawContent: false,
    maxRuntimeSeconds: 180,
    maxCostUsd: 2.5,
    idempotencyKey: "job-1-key",
  };
}

describe("AgentJob contract — spec(§3/§7/§9)", () => {
  // ── Frozen top-level field-name set (the spec, hand-authored snapshot) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(AgentJobSchema, AGENT_JOB_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("agent-job"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/agent-job.schema.json", import.meta.url),
      emitJsonSchema(AgentJobSchema, AGENT_JOB_SCHEMA_ID),
    );
  });

  // ── Behaviors: valid fixtures ──────────────────────────────────────────────
  it("accepts a fully-specified valid job (maxCostUsd present)", () => {
    expect(AgentJobSchema.safeParse(validJob()).success).toBe(true);
  });

  it("accepts a valid job with maxCostUsd omitted (optional budget cap)", () => {
    const { maxCostUsd, ...rest } = validJob();
    void maxCostUsd;
    expect(AgentJobSchema.safeParse(rest).success).toBe(true);
  });

  it("accepts an untrusted, raw-content-carrying job with a local route", () => {
    const ok = AgentJobSchema.safeParse({
      ...validJob(),
      trustLevel: "untrusted",
      carriesRawContent: true,
      providerRoute: {
        provider: "ollama",
        model: "llama3.1",
        endpoint: "http://127.0.0.1:11434",
        egressClass: "local",
      },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a runtime-branch providerRoute (AgentRuntimePort)", () => {
    const ok = AgentJobSchema.safeParse({
      ...validJob(),
      providerRoute: {
        runtime: "claude-agent-sdk",
        model: "claude-opus-4",
        endpoint: "https://api.anthropic.com",
        egressClass: "cloud",
      },
    });
    expect(ok.success).toBe(true);
  });

  // ── Behaviors: rejections (.strict + field-level pins) ─────────────────────
  it("rejects an unknown top-level key (.strict)", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), extra: "nope" }).success).toBe(false);
  });

  it("rejects an empty/whitespace branded id", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), id: "   " }).success).toBe(false);
  });

  it("rejects an empty/whitespace branded workspaceId", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), workspaceId: " " }).success).toBe(false);
  });

  it("rejects an empty/whitespace branded capability", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), capability: "" }).success).toBe(false);
  });

  it("rejects an empty outputSchemaId (non-empty in the schema)", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), outputSchemaId: "" }).success).toBe(false);
  });

  it("rejects a trustLevel outside {trusted,untrusted}", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), trustLevel: "maybe" }).success).toBe(false);
  });

  it("rejects a non-boolean carriesRawContent", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), carriesRawContent: "yes" }).success).toBe(
      false,
    );
  });

  // ── COST-1 budget pins ─────────────────────────────────────────────────────
  it("rejects a missing maxRuntimeSeconds (required budget pin)", () => {
    const { maxRuntimeSeconds, ...rest } = validJob();
    void maxRuntimeSeconds;
    expect(AgentJobSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-positive maxRuntimeSeconds", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), maxRuntimeSeconds: 0 }).success).toBe(false);
  });

  it("rejects a non-positive maxCostUsd when present", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), maxCostUsd: -1 }).success).toBe(false);
  });

  it("rejects an empty idempotencyKey (required non-empty budget pin)", () => {
    expect(AgentJobSchema.safeParse({ ...validJob(), idempotencyKey: "" }).success).toBe(false);
  });

  // ── Embedded seam-model gates bubble up through the parent parse ────────────
  it("rejects an inconsistent embedded ToolPolicy (read_only + allowsMutating)", () => {
    const bad = AgentJobSchema.safeParse({
      ...validJob(),
      toolPolicy: {
        mode: "read_only",
        allowedTools: [],
        deniedTools: [],
        allowsMutating: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a providerRoute carrying BOTH runtime and provider keys", () => {
    const bad = AgentJobSchema.safeParse({
      ...validJob(),
      providerRoute: {
        runtime: "hermes",
        provider: "claude",
        model: "claude-opus-4",
        endpoint: "https://api.anthropic.com",
        egressClass: "cloud",
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a providerRoute with NEITHER runtime nor provider", () => {
    const bad = AgentJobSchema.safeParse({
      ...validJob(),
      providerRoute: {
        model: "claude-opus-4",
        endpoint: "https://api.anthropic.com",
        egressClass: "cloud",
      },
    });
    expect(bad.success).toBe(false);
  });

  // ── §3 referential pin: outputSchemaId must resolve in a SchemaRegistry ─────
  it("isRegisteredOutputSchema is true for a registered id, false otherwise", () => {
    const registry = buildSchemaRegistry([
      emitJsonSchema(z.object({}).strict(), "sow:test-output"),
    ]);
    expect(isRegisteredOutputSchema("sow:test-output", registry)).toBe(true);
    expect(isRegisteredOutputSchema("sow:nope", registry)).toBe(false);
  });
});
