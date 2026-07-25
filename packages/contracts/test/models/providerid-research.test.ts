// ProviderId research-provider frozen round (§13.13, §7/§5). RED-first: additive `perplexity` + `xai`
// enum members, each egress-CLOUD-representable + its OWN member (NEVER an openai/openrouter alias —
// safety rule 5). The §5 egress veto is ProviderId-AGNOSTIC (packages/policy keys on route.egressClass
// === "local" + a loopback-endpoint PROOF, never the provider id), so an employer-work ack-OFF call on
// a cloud research route fails closed BY CONSTRUCTION — the live veto DENY test lives in packages/policy
// (generic). This contract round adds the members, keeps them distinct, and pins the egressClass surface.
// PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ProviderId, isProviderId } from "../../src/primitives/enums";
import { ProviderIdSchema } from "../../src/models/shared-enums";
import { ProviderRouteSchema } from "../../src/models/provider-route";
import { ProviderProfileSchema } from "../../src/models/provider-profile";

const NEW = ["perplexity", "xai"] as const;

describe("ProviderId research providers — spec(§7/§5)", () => {
  it("ProviderId gains perplexity + xai (both validate through the enum) spec(§7)", () => {
    for (const p of NEW) {
      expect(isProviderId(p)).toBe(true);
      expect(ProviderIdSchema.safeParse(p).success).toBe(true);
    }
  });

  // The egress veto is generic over egressClass (+ loopback proof) — a cloud research route fails
  // closed for employer-work ack-OFF by construction. Here we pin the CONTRACT surface: a cloud
  // ProviderRoute + ProviderProfile for each new provider validate, and egressClass is a REQUIRED
  // closed field a research route can't omit/forge (the field the veto reads). spec(§5)
  it("a cloud ProviderRoute + ProviderProfile validate for each; egressClass is required spec(§5)", () => {
    for (const p of NEW) {
      expect(
        ProviderRouteSchema.safeParse({ provider: p, model: "m", endpoint: "https://api", egressClass: "cloud" }).success,
      ).toBe(true);
      const profile = {
        provider: p,
        endpoint: "https://api",
        model: "m",
        capabilities: ["research"],
        egressClass: "cloud",
        costCaps: {},
        conformanceStatus: "unknown",
      };
      expect(ProviderProfileSchema.safeParse(profile).success).toBe(true);
      // egressClass REQUIRED: a provider-branch route that omits it is rejected (rule-5 surface).
      expect(ProviderRouteSchema.safeParse({ provider: p, model: "m", endpoint: "https://api" }).success).toBe(false);
    }
  });

  // rule 5 verbatim ("its own processor, not an alias") — at the enum/contract level the no-alias is
  // DISTINCT membership (the SOW_EGRESS_ALLOWED_PROCESSORS per-vendor processor id is §ARM-RESEARCH).
  it("perplexity + xai are DISTINCT members, never aliased to openai/openrouter (rule 5) spec(§5)", () => {
    expect(new Set(ProviderId).size).toBe(ProviderId.length); // no collapsed/duplicate member
    for (const p of NEW) {
      expect(p).not.toBe("openai");
      expect(p).not.toBe("openrouter");
      expect(ProviderId).toContain(p);
    }
  });

  it("is additive — every prior ProviderId member survives (no rename/remove) spec(§7)", () => {
    for (const prior of ["claude", "openai", "openrouter", "ollama", "lm_studio"] as const) {
      expect(ProviderId).toContain(prior);
    }
  });
});
