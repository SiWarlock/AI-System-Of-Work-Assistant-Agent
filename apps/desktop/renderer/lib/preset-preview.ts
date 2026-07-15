import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";

// Task 14.5 (desktop leg) — the renderer preset-preview query-caller. The onboarding picker
// previews what each tier PROVISIONS (its differentiated connector/workflow/schedule set) BEFORE
// the user chooses, via the read-only, auth-gated `presetProfiles.preview` query. The profile is
// UI-safe by construction (config-template NAMES + all-OFF policy flags; no secrets, no
// per-workspace data). Fails closed to `{ ok: false }` on a typed err / malformed ok / transport
// throw (desktop Lesson 6) so the picker never renders a partial / raw profile.

/** The per-workflow default cadence in a profile. */
export interface ProvisioningScheduleView {
  readonly workflow: string;
  readonly cadence: string;
}

/** The UI-safe provisioning profile the picker renders (mirrors the worker's `ProvisioningProfile`). */
export interface ProvisioningProfileView {
  readonly preset: string;
  readonly connectors: readonly string[];
  readonly workflows: readonly string[];
  readonly schedules: readonly ProvisioningScheduleView[];
  readonly policyDefaults: {
    readonly employerRawEgressAcknowledged: boolean;
    readonly rawCloudEgressEnabled: boolean;
    readonly defaultVisibility: string;
    readonly proposeArmed: boolean;
    readonly realExternalWriteArmed: boolean;
    readonly realTransportArmed: boolean;
    readonly realSpendArmed: boolean;
  };
}

export type PresetPreviewResult =
  | { readonly ok: true; readonly profile: ProvisioningProfileView }
  | { readonly ok: false };

/** Build the preset-preview query-caller over a live tRPC client. */
export function createPresetPreview(
  client: CreateTRPCClient<AppRouter>,
): (preset: string) => Promise<PresetPreviewResult> {
  return async (preset: string): Promise<PresetPreviewResult> => {
    try {
      const res = await client.presetProfiles.preview.query({ preset });
      // Defense-in-depth: fold a malformed ok (missing / non-array connector|workflow lists) to
      // `{ ok: false }` — the differentiated set IS the picker's value, so a shapeless profile is
      // no profile. The server already returns UI-safe; this guards a future projector regression.
      if (
        res.ok === true &&
        res.value != null &&
        typeof res.value === "object" &&
        Array.isArray(res.value.connectors) &&
        Array.isArray(res.value.workflows)
      ) {
        return { ok: true, profile: res.value };
      }
      // A typed err (unknown preset / auth) → no profile.
      return { ok: false };
    } catch {
      // Transport failure → fail closed.
      return { ok: false };
    }
  };
}
