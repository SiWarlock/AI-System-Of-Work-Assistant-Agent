// 18.23 step 4 — the AND-locked `selectExtractionRoute` route knob (dormant). Default-OFF: armed===false
// (the shipped default) ⇒ the byte-identical local ollama route (= boot.ts:1094 source.process); armed===true
// (owner step-6 flip) ⇒ the cloud `{runtime}` subscription route. STRICT `=== true` (a truthy-not-`true`
// value ⇒ local, never arms — L28). AND-locked to the SAME arming as `providerTransport` (one flip, no
// split-brain). Reachability-WAIVERED (L11) — boot binds it at the owner ENABLE (step 6).
import { describe, it, expect } from "vitest";
import {
  selectExtractionRoute,
  LOCAL_EXTRACTION_ROUTE,
  CLOUD_EXTRACTION_ROUTE,
} from "../../src/composition/extraction-route-gate";

describe("selectExtractionRoute — AND-locked route knob (18.23 step 4, dormant)", () => {
  it("route_knob_default_is_shipped_local — armed=false ⇒ the byte-identical shipped local route [spec(§5)]", () => {
    const route = selectExtractionRoute(false);
    // byte-identical to the shipped capabilityDefaults["source.process"] route (boot.ts:1094).
    expect(route).toStrictEqual({
      provider: "ollama",
      model: "local-default",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    });
    expect(route).toBe(LOCAL_EXTRACTION_ROUTE); // the exact shipped constant instance
  });

  it("route_knob_armed_is_cloud_runtime — armed=true ⇒ the cloud {runtime} subscription route [spec(§19.5)]", () => {
    const route = selectExtractionRoute(true);
    expect(route).toBe(CLOUD_EXTRACTION_ROUTE);
    expect(route).toStrictEqual({
      runtime: "claude-agent-sdk",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    });
  });

  it("route_knob_truthy_not_true_stays_local — STRICT ===true; a truthy-not-true value ⇒ local, never arms [spec(L28)]", () => {
    for (const truthy of ["true", 1, {}, [], "armed"] as unknown[]) {
      expect(selectExtractionRoute(truthy as boolean)).toBe(LOCAL_EXTRACTION_ROUTE);
    }
  });
});
