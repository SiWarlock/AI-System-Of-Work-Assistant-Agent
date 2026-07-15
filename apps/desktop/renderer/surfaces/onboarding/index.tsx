import { useState, useRef, type ReactElement } from "react";
import { WorkspaceType } from "@sow/contracts/primitives/enums";
import { scopeForType } from "../../store/onboarding";
import type { OnboardWorkspaceInput, UiSafeProvisioned, OnboardResult } from "../../lib/onboard-workspace";
import type { PresetPreviewResult, ProvisioningProfileView } from "../../lib/preset-preview";

// Task 14.1 + 14.5 (desktop legs) — the ONBOARDING surface: the real first-run flow that lets a
// user EXIST in the system. A 3-step flow — (1) name + workspace type → (2) vault root + gbrain
// brain id → (3) preset pick (with a live differentiated preview) — that drives the shipped worker
// backends (`onboarding.createWorkspace`, `presetProfiles.preview`) via INJECTED callbacks (so the
// deterministic flow is unit-testable without a live bridge; App binds the real live-handle methods).
//
// FAIL-CLOSED / renderer-redaction: a createWorkspace failure surfaces a generic, user-visible error
// state (role="alert") — NEVER a raw driver cause / secret (the command-caller already folds every
// typed err / transport throw to `{ ok: false }`; this surface shows only a safe generic message).

/** The four §11 first-run presets (a UI concern — the worker re-validates against its frozen set). */
const PRESETS = ["simple", "professional", "founder", "advanced"] as const;

/** Friendly labels for the three workspace types (the 3-bucket model). */
const TYPE_LABEL: Record<WorkspaceType, string> = {
  employer_work: "Employer-Work",
  personal_business: "Personal-Business",
  personal_life: "Personal-Life",
};

const PRESET_LABEL: Record<(typeof PRESETS)[number], string> = {
  simple: "Simple",
  professional: "Professional",
  founder: "Founder",
  advanced: "Advanced",
};

export interface OnboardingProps {
  /** Provision the workspace (App binds live-handle.onboardWorkspace → onboarding.createWorkspace). */
  readonly onCreateWorkspace: (input: OnboardWorkspaceInput) => Promise<OnboardResult>;
  /** Preview a preset's profile (App binds live-handle.previewPreset → presetProfiles.preview). */
  readonly onPreviewPreset: (preset: string) => Promise<PresetPreviewResult>;
  /** Called on a successful provision — App records the onboarded workspace into the scope store. */
  readonly onOnboarded: (workspace: UiSafeProvisioned, input: OnboardWorkspaceInput) => void;
}

export function Onboarding(props: OnboardingProps): ReactElement {
  const { onCreateWorkspace, onPreviewPreset, onOnboarded } = props;
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState("");
  const [type, setType] = useState<WorkspaceType | "">("");
  const [vaultRoot, setVaultRoot] = useState("");
  const [gbrainBrainId, setGbrainBrainId] = useState("");
  const [preset, setPreset] = useState<(typeof PRESETS)[number] | "">("");
  const [profile, setProfile] = useState<ProvisioningProfileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Latest-wins guard for the async preview (mirrors scope-refresh.ts): a slow OLDER preview must
  // never overwrite a NEWER pick's profile — else the panel could show tier A's set while tier B is
  // selected. Tracks the most-recently requested preset; a resolution for a superseded pick is dropped.
  const latestPresetRef = useRef<string | null>(null);

  const step0Ready = name.trim().length > 0 && type !== "";
  const step1Ready = vaultRoot.trim().length > 0 && gbrainBrainId.trim().length > 0;
  const canCreate = step0Ready && step1Ready && preset !== "" && !busy;

  const pickPreset = (p: (typeof PRESETS)[number]): void => {
    setPreset(p);
    setProfile(null);
    latestPresetRef.current = p;
    void onPreviewPreset(p).then((r) => {
      // Latest-wins: drop a resolution for a preset the user has since switched away from.
      if (latestPresetRef.current !== p) return;
      // Fail-closed: a preview failure leaves the profile absent (the picker shows no set) but the
      // choice still stands — the worker re-derives the real profile at provisioning.
      setProfile(r.ok ? r.profile : null);
    });
  };

  const submit = (): void => {
    // `canCreate` transitively requires `type !== ""` (via step0Ready) AND `preset !== ""`, so TS
    // narrows both to their non-empty unions here (aliased-condition narrowing).
    if (!canCreate) return;
    const input: OnboardWorkspaceInput = {
      // The 3-bucket model: one workspace per type → the bucket scope is a stable, idempotent id.
      id: scopeForType(type),
      name: name.trim(),
      type,
      vaultRoot: vaultRoot.trim(),
      gbrainBrainId: gbrainBrainId.trim(),
      preset,
    };
    setBusy(true);
    setError(null);
    void onCreateWorkspace(input).then((r) => {
      setBusy(false);
      if (r.ok) {
        onOnboarded(r.workspace, input);
        return;
      }
      // Redaction-safe: a generic message only — the caller already dropped any raw cause.
      setError("Couldn't create the workspace. Check the vault path and try again.");
    });
  };

  return (
    <div className="sow-onboarding" role="main" aria-label="Onboarding">
      <h1>Set up your workspace</h1>

      {step === 0 && (
        <section aria-label="Workspace">
          <label>
            Workspace name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Workspace name"
            />
          </label>
          <fieldset>
            <legend>Workspace type</legend>
            {WorkspaceType.map((t) => (
              <label key={t}>
                <input
                  type="radio"
                  name="workspace-type"
                  value={t}
                  checked={type === t}
                  onChange={() => setType(t)}
                />
                {TYPE_LABEL[t]}
              </label>
            ))}
          </fieldset>
          <button type="button" disabled={!step0Ready} onClick={() => setStep(1)}>
            Next
          </button>
        </section>
      )}

      {step === 1 && (
        <section aria-label="Vault">
          <label>
            Vault root
            <input
              type="text"
              value={vaultRoot}
              onChange={(e) => setVaultRoot(e.target.value)}
              aria-label="Vault root"
            />
          </label>
          <label>
            gbrain brain id
            <input
              type="text"
              value={gbrainBrainId}
              onChange={(e) => setGbrainBrainId(e.target.value)}
              aria-label="gbrain brain id"
            />
          </label>
          <button type="button" onClick={() => setStep(0)}>
            Back
          </button>
          <button type="button" disabled={!step1Ready} onClick={() => setStep(2)}>
            Next
          </button>
        </section>
      )}

      {step === 2 && (
        <section aria-label="Preset">
          <fieldset>
            <legend>Choose a preset</legend>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={preset === p}
                onClick={() => pickPreset(p)}
              >
                {PRESET_LABEL[p]}
              </button>
            ))}
          </fieldset>

          {profile !== null && (
            <div className="sow-preset-preview" aria-label="Preset preview">
              <p>
                Connectors:{" "}
                {profile.connectors.length > 0 ? profile.connectors.join(", ") : "none"}
              </p>
              <p>Workflows: {profile.workflows.join(", ")}</p>
            </div>
          )}

          {error !== null && (
            <div role="alert" className="sow-onboarding-error">
              {error}
            </div>
          )}

          <button type="button" onClick={() => setStep(1)}>
            Back
          </button>
          <button type="button" disabled={!canCreate} onClick={submit}>
            Create workspace
          </button>
        </section>
      )}
    </div>
  );
}
