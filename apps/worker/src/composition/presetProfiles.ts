// Task 14.5 — the preset → provisioning-profile mapping.
//
// Each onboarding preset (Simple/Professional/Founder/Advanced) maps to a DISTINCT
// provisioning profile — the four tiers differ in WHICH connectors/workflows/schedules
// they surface by default. But the SAFETY POSTURE is uniform + fail-closed across every
// preset: EVERY arming flip is default-OFF (a preset sets defaults only — arming a real
// spend/write/propose/transport stays owner-confirmed regardless of preset), and egress
// stays CLOSED (never a preset that pre-acknowledges Employer-Work egress).
//
// The `policyDefaults` fields are typed as LITERAL `false`/`"isolated"` so "no profile arms
// a hard line" is STRUCTURAL (a profile cannot even construct an armed default) as well as
// test-pinned. The connector/workflow entries are config-template NAMES only — listing a
// connector does NOT arm it (its real transport binds at Phase 17/23 arming); the arming
// surface is the `policyDefaults` flags, all OFF.
//
// PURE — no I/O, no clock. Consumed by the reachable `presetProfiles.preview` query (the
// desktop onboarding picker's data source) + (later) the provisioning profile-application.
import type { OnboardingPreset } from "../api/procedures/onboarding";

/** A default cadence for a workflow in a preset profile (opaque cron/interval; Phase-25 consumes). */
export interface ProvisioningSchedule {
  readonly workflow: string;
  readonly cadence: string;
}

/**
 * The uniform fail-closed policy posture EVERY preset profile ships. Literal `false`/
 * `"isolated"` types make "no preset arms a hard line" + "egress closed" STRUCTURAL — a
 * profile cannot construct an armed or egress-open default (safety rules 5 + arm-deliberately).
 */
export interface PresetPolicyDefaults {
  readonly employerRawEgressAcknowledged: false;
  readonly rawCloudEgressEnabled: false;
  readonly defaultVisibility: "isolated";
  readonly proposeArmed: false;
  readonly realExternalWriteArmed: false;
  readonly realTransportArmed: false;
  readonly realSpendArmed: false;
}

/** A concrete provisioning profile for one preset — differentiated defaults, uniform safe posture. */
export interface ProvisioningProfile {
  readonly preset: OnboardingPreset;
  /** Default connector vendor ids surfaced (config templates — NOT armed). */
  readonly connectors: readonly string[];
  /** Default enabled workflow names (Phase-25 scheduling consumes). */
  readonly workflows: readonly string[];
  /** Default per-workflow cadences. */
  readonly schedules: readonly ProvisioningSchedule[];
  /** The uniform fail-closed policy posture (identical across presets). */
  readonly policyDefaults: PresetPolicyDefaults;
}

// The ONE fail-closed policy posture shared by every preset (egress CLOSED, all arming OFF).
// `Object.freeze` makes the "no armed default" guarantee hold at RUNTIME too (TS `readonly` is
// compile-time only) — a consumer holding a returned profile cannot mutate the shared const to
// arm a flip (defense-in-depth; the real arming seams are separate owner-gated `=== true` checks).
const CLOSED_POLICY_DEFAULTS: PresetPolicyDefaults = Object.freeze({
  employerRawEgressAcknowledged: false,
  rawCloudEgressEnabled: false,
  defaultVisibility: "isolated",
  proposeArmed: false,
  realExternalWriteArmed: false,
  realTransportArmed: false,
  realSpendArmed: false,
});

/**
 * The differentiated connector/workflow/schedule SETS per preset (the tiers). Simple is the
 * minimal local spine; each higher tier surfaces more connectors + workflows. Every entry is a
 * dormant config-template name (its real transport binds at arming). policyDefaults is added
 * uniformly by {@link presetProfiles}.
 */
const PRESET_SETS: Record<OnboardingPreset, Omit<ProvisioningProfile, "policyDefaults">> = {
  simple: {
    preset: "simple",
    connectors: [],
    workflows: ["projectSync"],
    schedules: [],
  },
  professional: {
    preset: "professional",
    connectors: ["drive", "calendar"],
    workflows: ["projectSync", "meetingCloseout"],
    schedules: [{ workflow: "projectSync", cadence: "@daily" }],
  },
  founder: {
    preset: "founder",
    connectors: ["drive", "calendar", "linear", "granola"],
    workflows: ["projectSync", "meetingCloseout", "crossCalendarScheduling"],
    schedules: [
      { workflow: "projectSync", cadence: "@daily" },
      { workflow: "crossCalendarScheduling", cadence: "@hourly" },
    ],
  },
  advanced: {
    preset: "advanced",
    connectors: ["drive", "calendar", "linear", "granola", "github", "gmail", "asana"],
    workflows: ["projectSync", "meetingCloseout", "crossCalendarScheduling", "dailyBrief"],
    schedules: [
      { workflow: "projectSync", cadence: "@daily" },
      { workflow: "crossCalendarScheduling", cadence: "@hourly" },
      { workflow: "dailyBrief", cadence: "@daily" },
    ],
  },
};

/**
 * Map an onboarding preset to its concrete provisioning profile. Total over the four presets.
 * The connector/workflow/schedule SETS differentiate the tiers; the `policyDefaults` posture is
 * the SAME fail-closed, all-arming-OFF, egress-CLOSED default for every preset.
 */
export function presetProfiles(preset: OnboardingPreset): ProvisioningProfile {
  return { ...PRESET_SETS[preset], policyDefaults: CLOSED_POLICY_DEFAULTS };
}
