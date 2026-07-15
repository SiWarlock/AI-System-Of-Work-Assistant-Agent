// Task 14.5 — the `presetProfiles.preview` query procedure.
//
// The desktop onboarding preset-picker's data source: a READ-ONLY, auth-gated query that
// returns the provisioning profile for a preset so the UI can show what each tier provisions
// BEFORE the user chooses. The profile is UI-safe BY CONSTRUCTION — connector/workflow NAMES
// + policy flags, no secrets, no per-workspace data (global static config, so NO WS-8 scoping).
// Takes NO injected dependency (the mapping is pure static config), so it adds nothing to
// ApiServerDeps. §16: never throws; a malformed preset is a typed validation_rejected.
import { publicProcedure, router, authedResolver } from "../router";
import { ok, err, failure, type Result, type FailureVariant } from "@sow/contracts";
import { ONBOARDING_PRESETS, type OnboardingPreset } from "./onboarding";
import { presetProfiles, type ProvisioningProfile } from "../../composition/presetProfiles";

const passthroughInput = (raw: unknown): unknown => raw;

/** Validate a raw `preview` input → an OnboardingPreset. Malformed ⇒ typed validation_rejected. */
function parsePreset(raw: unknown): Result<OnboardingPreset, FailureVariant> {
  if (typeof raw !== "object" || raw === null) {
    return err(failure("validation_rejected", "invalid preset input", { cause: { code: "PRESET_PREVIEW_INPUT_SHAPE" } }));
  }
  const preset = (raw as Record<string, unknown>)["preset"];
  if (typeof preset !== "string" || !(ONBOARDING_PRESETS as readonly string[]).includes(preset)) {
    return err(failure("validation_rejected", "unknown preset", { cause: { code: "PRESET_PREVIEW_PRESET" } }));
  }
  return ok(preset as OnboardingPreset);
}

/**
 * Build the preset-profiles router the integrator mounts at `appRouter.presetProfiles`. The
 * `preview` procedure is a tRPC `.query()` (read-only, §13) wrapped in the 8.2 `authedResolver`.
 * It returns the profile for the requested preset — UI-safe by construction. No deps.
 */
export function buildPresetProfilesRouter() {
  return router({
    /** Return the provisioning profile for a preset (the picker's preview). Unknown preset ⇒ err. */
    preview: publicProcedure.input(passthroughInput).query(
      authedResolver<unknown, ProvisioningProfile>(
        async (_ctx, input): Promise<Result<ProvisioningProfile, FailureVariant>> => {
          const parsed = parsePreset(input);
          if (!parsed.ok) return err(parsed.error);
          return ok(presetProfiles(parsed.value));
        },
      ),
    ),
  });
}
