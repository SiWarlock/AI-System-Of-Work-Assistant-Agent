// ProviderMatrix contract test (task 1.5, §3/§5/§7). RED-first schema-snapshot
// freeze + behavior + consistency-invariant coverage. Mirrors the canonical
// egress-policy.test.ts template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ProviderMatrixSchema, PROVIDER_MATRIX_SCHEMA_ID } from "../../src/models/provider-matrix";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("ProviderMatrix contract — spec(§3/§5/§7)", () => {
  // ── Frozen top-level field-name set (the spec, hand-authored in __snapshots__) ──
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(ProviderMatrixSchema, PROVIDER_MATRIX_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("provider-matrix"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ──
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/provider-matrix.schema.json", import.meta.url),
      emitJsonSchema(ProviderMatrixSchema, PROVIDER_MATRIX_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  it("accepts a valid matrix whose provider-branch routes are all in allowedProviders", () => {
    const ok = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude", "openrouter", "ollama"],
      capabilityDefaults: {
        "draft-email": {
          provider: "claude",
          model: "claude-opus-4",
          endpoint: "https://api.anthropic.com",
          egressClass: "cloud",
        },
        // runtime-branch route — exempt from the provider-subset check.
        summarize: {
          runtime: "claude-agent-sdk",
          model: "claude-opus-4",
          endpoint: "https://api.anthropic.com",
          egressClass: "cloud",
        },
        "local-extract": {
          provider: "ollama",
          model: "llama3.1",
          endpoint: "http://localhost:11434",
          egressClass: "local",
        },
      },
      rawCloudEgressEnabled: true,
      localProviderPreference: "ollama",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a minimal matrix (empty capabilityDefaults, no localProviderPreference)", () => {
    const ok = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "   ",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an allowedProviders value outside the ProviderId enum", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["aws"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-boolean rawCloudEgressEnabled", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: "yes",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (rawCloudEgressEnabled)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a localProviderPreference outside the ProviderId enum", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {},
      rawCloudEgressEnabled: false,
      localProviderPreference: "aws",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace capability key (branded non-empty)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {
        "": {
          provider: "claude",
          model: "claude-opus-4",
          endpoint: "https://api.anthropic.com",
          egressClass: "cloud",
        },
      },
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a malformed embedded ProviderRoute (missing model)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {
        "draft-email": {
          provider: "claude",
          endpoint: "https://api.anthropic.com",
          egressClass: "cloud",
        },
      },
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an embedded ProviderRoute carrying BOTH runtime and provider (fails both union branches)", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"],
      capabilityDefaults: {
        "draft-email": {
          runtime: "hermes",
          provider: "claude",
          model: "claude-opus-4",
          endpoint: "https://api.anthropic.com",
          egressClass: "cloud",
        },
      },
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  // ── Consistency invariant: every provider-branch route's provider ∈ allowedProviders ──
  // Passing case (provider routes all allowed) is covered by the first "accepts" test.
  it("rejects a capabilityDefaults provider-route whose provider is NOT in allowedProviders", () => {
    const bad = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: ["claude"], // openai intentionally omitted
      capabilityDefaults: {
        "draft-email": {
          provider: "openai",
          model: "gpt-4o",
          endpoint: "https://api.openai.com",
          egressClass: "cloud",
        },
      },
      rawCloudEgressEnabled: false,
    });
    expect(bad.success).toBe(false);
  });

  it("accepts a runtime-only capabilityDefaults even with empty allowedProviders (refine applies only to provider routes)", () => {
    const ok = ProviderMatrixSchema.safeParse({
      workspaceId: "ws-personal",
      allowedProviders: [],
      capabilityDefaults: {
        summarize: {
          runtime: "hermes",
          model: "local-model",
          endpoint: "http://localhost:9000",
          egressClass: "local",
        },
      },
      rawCloudEgressEnabled: false,
    });
    expect(ok.success).toBe(true);
  });
});
