// ProviderProfile contract test (task 1.4, §3/§4/§7). RED-first schema-snapshot
// freeze + behavior + invariant coverage (conformanceStatus enum, REQ-S-003
// no-inline-secret, positive costCaps). Mirrors the EgressPolicy canonical
// template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  ProviderProfileSchema,
  PROVIDER_PROFILE_SCHEMA_ID,
} from "../../src/models/provider-profile";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A representative valid cloud profile; behavior cases spread + override one field.
const valid = {
  provider: "claude",
  endpoint: "https://api.anthropic.com",
  model: "claude-opus-4",
  capabilities: ["meeting.close", "notebooklm.sync"],
  egressClass: "cloud",
  costCaps: { maxCostUsd: 1.0, maxRuntimeSeconds: 180 },
  conformanceStatus: "passing",
};

describe("ProviderProfile contract — spec(§3/§4/§7)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ───────
  it("freezes its top-level field-name set (the spec snapshot)", () => {
    expect(
      fieldSet(emitJsonSchema(ProviderProfileSchema, PROVIDER_PROFILE_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("provider-profile"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/provider-profile.schema.json", import.meta.url),
      emitJsonSchema(ProviderProfileSchema, PROVIDER_PROFILE_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  it("accepts a valid cloud provider profile", () => {
    expect(ProviderProfileSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a valid local profile with empty costCaps + empty capabilities", () => {
    const ok = ProviderProfileSchema.safeParse({
      provider: "ollama",
      endpoint: "http://localhost:11434",
      model: "llama3",
      capabilities: [],
      egressClass: "local",
      costCaps: {},
      conformanceStatus: "unknown",
    });
    expect(ok.success).toBe(true);
  });

  // conformanceStatus ∈ unknown|passing|failing|disabled — every member valid.
  it("accepts every conformanceStatus enum member", () => {
    for (const conformanceStatus of [
      "unknown",
      "passing",
      "failing",
      "disabled",
    ] as const) {
      expect(
        ProviderProfileSchema.safeParse({ ...valid, conformanceStatus }).success,
      ).toBe(true);
    }
  });

  it("represents a non-passing (failing) profile without rejecting it", () => {
    expect(
      ProviderProfileSchema.safeParse({ ...valid, conformanceStatus: "failing" }).success,
    ).toBe(true);
  });

  it("rejects an out-of-enum conformanceStatus", () => {
    expect(
      ProviderProfileSchema.safeParse({ ...valid, conformanceStatus: "flaky" }).success,
    ).toBe(false);
  });

  it("rejects an out-of-enum provider", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, provider: "gemini" }).success).toBe(
      false,
    );
  });

  it("rejects an out-of-enum egressClass", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, egressClass: "hybrid" }).success).toBe(
      false,
    );
  });

  // ── REQ-S-003: schema FORBIDS any inline secret ─────────────────────────────
  it("rejects an inline apiKey (REQ-S-003 / .strict())", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, apiKey: "sk-secret" }).success).toBe(
      false,
    );
  });

  it("rejects inline token / secret fields (REQ-S-003 / .strict())", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, token: "t" }).success).toBe(false);
    expect(ProviderProfileSchema.safeParse({ ...valid, secret: "s" }).success).toBe(false);
  });

  it("declares no secret-bearing field at all (REQ-S-003 absence)", () => {
    const fields = fieldSet(
      emitJsonSchema(ProviderProfileSchema, PROVIDER_PROFILE_SCHEMA_ID),
    );
    for (const banned of ["apiKey", "apiKeyRef", "secret", "token", "key", "credentials"]) {
      expect(fields).not.toContain(banned);
    }
  });

  it("rejects an unknown top-level field (.strict())", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, region: "us" }).success).toBe(false);
  });

  // ── costCaps: { maxCostUsd?: positive, maxRuntimeSeconds?: positive } ────────
  it("rejects a non-positive costCaps.maxCostUsd", () => {
    expect(
      ProviderProfileSchema.safeParse({ ...valid, costCaps: { maxCostUsd: 0 } }).success,
    ).toBe(false);
    expect(
      ProviderProfileSchema.safeParse({ ...valid, costCaps: { maxCostUsd: -1 } }).success,
    ).toBe(false);
  });

  it("rejects a non-positive costCaps.maxRuntimeSeconds", () => {
    expect(
      ProviderProfileSchema.safeParse({ ...valid, costCaps: { maxRuntimeSeconds: 0 } })
        .success,
    ).toBe(false);
    expect(
      ProviderProfileSchema.safeParse({ ...valid, costCaps: { maxRuntimeSeconds: -5 } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown nested costCaps key (.strict())", () => {
    expect(
      ProviderProfileSchema.safeParse({ ...valid, costCaps: { maxTokens: 100 } }).success,
    ).toBe(false);
  });

  // ── Required-field + non-empty-string guards ────────────────────────────────
  it("rejects a missing required field (provider)", () => {
    const bad = ProviderProfileSchema.safeParse({
      endpoint: "https://api.anthropic.com",
      model: "claude-opus-4",
      capabilities: [],
      egressClass: "cloud",
      costCaps: {},
      conformanceStatus: "passing",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (costCaps)", () => {
    const bad = ProviderProfileSchema.safeParse({
      provider: "claude",
      endpoint: "https://api.anthropic.com",
      model: "claude-opus-4",
      capabilities: [],
      egressClass: "cloud",
      conformanceStatus: "passing",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty endpoint (non-empty string)", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, endpoint: "" }).success).toBe(false);
  });

  it("rejects an empty model (non-empty string)", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, model: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only capability (branded non-empty)", () => {
    expect(ProviderProfileSchema.safeParse({ ...valid, capabilities: ["  "] }).success).toBe(
      false,
    );
  });
});
