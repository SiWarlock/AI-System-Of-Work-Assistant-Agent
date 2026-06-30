// ProviderRoute contract test (task 1.4, §3/§7). RED-first schema-snapshot freeze
// + behavior coverage. Copies the canonical EgressPolicy template. PURE — no
// app/adapter imports.
//
// ProviderRoute is a TWO-BRANCH union: exactly one of { runtime } | { provider },
// plus the shared { model, endpoint, egressClass }. Mutual exclusivity is enforced
// STRUCTURALLY by `.strict()` (the foreign discriminator becomes an unknown key on
// the other branch), so there is no `.refine()`; the both/neither rejection cases
// below stand in for the refine pass/fail pair.
import { describe, expect, it } from "vitest";
import { ProviderRouteSchema, PROVIDER_ROUTE_SCHEMA_ID } from "../../src/models/provider-route";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

describe("ProviderRoute contract — spec(§3/§7)", () => {
  // ── Frozen field-name set (union of both branch keys; hand-authored snap) ──
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(ProviderRouteSchema, PROVIDER_ROUTE_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("provider-route"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/provider-route.schema.json", import.meta.url),
      emitJsonSchema(ProviderRouteSchema, PROVIDER_ROUTE_SCHEMA_ID),
    );
  });

  // ── Behaviors: valid fixtures, each branch ────────────────────────────────
  it("accepts a valid runtime-branch route (agent-runtime id, no provider)", () => {
    const ok = ProviderRouteSchema.safeParse({
      runtime: "claude-agent-sdk",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid provider-branch route (ProviderId, no runtime)", () => {
    const ok = ProviderRouteSchema.safeParse({
      provider: "openrouter",
      model: "anthropic/claude-opus-4",
      endpoint: "https://openrouter.ai/api/v1",
      egressClass: "cloud",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts egressClass==='local' (a non-egress route — the §5 veto's legal pick)", () => {
    const parsed = ProviderRouteSchema.safeParse({
      provider: "ollama",
      model: "llama3.1",
      endpoint: "http://localhost:11434",
      egressClass: "local",
    });
    expect(parsed.success).toBe(true);
    // The parsed shape carries the non-egress marker through unchanged.
    if (parsed.success) expect(parsed.data.egressClass).toBe("local");
  });

  // ── Mutual exclusivity (enforced by .strict(), not a refine) ──────────────
  it("rejects a route with BOTH runtime and provider set", () => {
    const bad = ProviderRouteSchema.safeParse({
      runtime: "claude-agent-sdk",
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a route with NEITHER runtime nor provider set", () => {
    const bad = ProviderRouteSchema.safeParse({
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
    expect(bad.success).toBe(false);
  });

  // ── Behaviors: invalid fixtures ───────────────────────────────────────────
  it("rejects an unknown top-level key (.strict)", () => {
    const bad = ProviderRouteSchema.safeParse({
      runtime: "claude-agent-sdk",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace runtime id (non-empty string)", () => {
    const bad = ProviderRouteSchema.safeParse({
      runtime: "",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set provider id (closed ProviderId enum)", () => {
    const bad = ProviderRouteSchema.safeParse({
      provider: "anthropic", // not a ProviderId member
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set egressClass (closed EgressClass enum)", () => {
    const bad = ProviderRouteSchema.safeParse({
      provider: "claude",
      model: "claude-opus-4",
      endpoint: "https://api.anthropic.com",
      egressClass: "edge", // not local|cloud
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required shared field (endpoint)", () => {
    const bad = ProviderRouteSchema.safeParse({
      provider: "claude",
      model: "claude-opus-4",
      egressClass: "cloud",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace model id (non-empty string)", () => {
    const bad = ProviderRouteSchema.safeParse({
      runtime: "hermes",
      model: "",
      endpoint: "http://localhost:8080",
      egressClass: "local",
    });
    expect(bad.success).toBe(false);
  });
});
