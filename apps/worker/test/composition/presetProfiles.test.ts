// Task 14.5 — preset → provisioning-profile mapping. RED-first spec.
//
// The four onboarding presets (Simple/Professional/Founder/Advanced) map to DISTINCT
// provisioning profiles so the tiers are differentiated, not cosmetic — but EVERY arming
// flip in EVERY profile is default-OFF (a preset sets defaults only; arming a real
// spend/write/propose/transport stays owner-confirmed regardless of preset), and every
// profile keeps egress CLOSED (never a preset that pre-acknowledges Employer-Work egress).
import { describe, it, expect } from "vitest";
import { ONBOARDING_PRESETS } from "../../src/api/procedures/onboarding";
import { presetProfiles } from "../../src/composition/presetProfiles";

describe("presetProfiles (14.5 — preset → provisioning profile)", () => {
  it("every_preset_maps_to_a_profile: presetProfiles is total over the 4 onboarding presets [spec(§11)]", () => {
    for (const p of ONBOARDING_PRESETS) {
      const profile = presetProfiles(p);
      expect(profile.preset).toBe(p);
      expect(Array.isArray(profile.connectors)).toBe(true);
      expect(Array.isArray(profile.workflows)).toBe(true);
      expect(Array.isArray(profile.schedules)).toBe(true);
    }
  });

  it("preset_profiles_diverge: the 4 presets yield pairwise-DISTINCT profiles (connector/workflow sets differ) [spec(§11)]", () => {
    const profiles = ONBOARDING_PRESETS.map(presetProfiles);
    // Pairwise-distinct: no two presets share the same (connectors, workflows) signature.
    const sigs = profiles.map((p) => JSON.stringify([[...p.connectors].sort(), [...p.workflows].sort()]));
    expect(new Set(sigs).size).toBe(ONBOARDING_PRESETS.length);
    // Concrete divergence: Simple is the minimal spine; Advanced surfaces the most connectors.
    const simple = presetProfiles("simple");
    const advanced = presetProfiles("advanced");
    expect(advanced.connectors.length).toBeGreaterThan(simple.connectors.length);
    expect(advanced.workflows.length).toBeGreaterThanOrEqual(simple.workflows.length);
  });

  it("no_profile_arms_a_hard_line: EVERY profile's arming flags are default-OFF (no preset arms real-spend/write/propose/transport) [safety]", () => {
    for (const p of ONBOARDING_PRESETS) {
      const { policyDefaults } = presetProfiles(p);
      expect(policyDefaults.proposeArmed).toBe(false);
      expect(policyDefaults.realExternalWriteArmed).toBe(false);
      expect(policyDefaults.realTransportArmed).toBe(false);
      expect(policyDefaults.realSpendArmed).toBe(false);
    }
  });

  it("profile_policy_defaults_egress_closed: EVERY profile keeps egress CLOSED + isolated (never pre-acks Employer-Work egress) [safety rule 5]", () => {
    for (const p of ONBOARDING_PRESETS) {
      const { policyDefaults } = presetProfiles(p);
      expect(policyDefaults.employerRawEgressAcknowledged).toBe(false);
      expect(policyDefaults.rawCloudEgressEnabled).toBe(false);
      expect(policyDefaults.defaultVisibility).toBe("isolated");
    }
  });
});
