// @vitest-environment jsdom
//
// Task 14.1 + 14.5 (desktop legs) — the onboarding surface deterministic flow (the visual layer is
// /design-review). Pins: submit → onboarding.createWorkspace with the entered fields; preset pick →
// presetProfiles.preview + renders the differentiated set; success → onOnboarded (the scope-entry
// hook App uses to leave first-run); a createWorkspace failure → a safe error state, never a raw
// cause (renderer-redaction). The first-run GATE predicate (`hasAnyOnboardedWorkspace`) is unit-
// tested in onboarding-store.test.ts (fresh store ⇒ false ⇒ this surface mounts).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Onboarding, type OnboardingProps } from "../renderer/surfaces/onboarding";

afterEach(cleanup);

const PROFILE = {
  preset: "professional",
  connectors: ["drive", "calendar"],
  workflows: ["projectSync", "meetingCloseout"],
  schedules: [{ workflow: "projectSync", cadence: "@daily" }],
  policyDefaults: {
    employerRawEgressAcknowledged: false,
    rawCloudEgressEnabled: false,
    defaultVisibility: "isolated",
    proposeArmed: false,
    realExternalWriteArmed: false,
    realTransportArmed: false,
    realSpendArmed: false,
  },
} as const;

function renderOnboarding(over: Partial<OnboardingProps> = {}): OnboardingProps {
  const props: OnboardingProps = {
    onCreateWorkspace: vi.fn().mockResolvedValue({ ok: true, workspace: { workspaceId: "ws_1", registryMember: true, preset: "professional" } }),
    onPreviewPreset: vi.fn().mockResolvedValue({ ok: true, profile: PROFILE }),
    onOnboarded: vi.fn(),
    ...over,
  };
  render(<Onboarding {...props} />);
  return props;
}

// Navigate step 0 (name+type) → step 1 (vault) → step 2 (preset). Leaves the user on the preset step.
function walkToPreset(): void {
  fireEvent.change(screen.getByRole("textbox", { name: /workspace name/i }), { target: { value: "Acme" } });
  fireEvent.click(screen.getByRole("radio", { name: "Employer-Work" }));
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  fireEvent.change(screen.getByRole("textbox", { name: /vault root/i }), { target: { value: "/Users/me/vault" } });
  fireEvent.change(screen.getByRole("textbox", { name: /gbrain brain id/i }), { target: { value: "brain_1" } });
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
}

describe("Onboarding surface", () => {
  it("submitting the flow calls onCreateWorkspace with the entered name/type/vaultRoot/gbrainBrainId/preset", async () => {
    const props = renderOnboarding();
    walkToPreset();
    fireEvent.click(screen.getByRole("button", { name: "Professional" }));
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(props.onCreateWorkspace).toHaveBeenCalledTimes(1));
    expect(props.onCreateWorkspace).toHaveBeenCalledWith({
      id: "employer-work",
      name: "Acme",
      type: "employer_work",
      vaultRoot: "/Users/me/vault",
      gbrainBrainId: "brain_1",
      preset: "professional",
    });
  });

  it("selecting a preset calls onPreviewPreset and renders the returned profile's differentiated set (14.5)", async () => {
    const props = renderOnboarding();
    walkToPreset();
    fireEvent.click(screen.getByRole("button", { name: "Professional" }));
    await waitFor(() => expect(props.onPreviewPreset).toHaveBeenCalledWith("professional"));
    // The differentiated connector/workflow set is what makes the tier choice meaningful, not cosmetic.
    expect(await screen.findByText(/drive, calendar/i)).toBeTruthy();
    expect(screen.getByText(/projectSync, meetingCloseout/i)).toBeTruthy();
  });

  it("on a successful createWorkspace, calls onOnboarded with the provisioned workspace + input (enters scope)", async () => {
    const props = renderOnboarding();
    walkToPreset();
    fireEvent.click(screen.getByRole("button", { name: "Professional" }));
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(props.onOnboarded).toHaveBeenCalledTimes(1));
    const [workspace, input] = (props.onOnboarded as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(workspace.workspaceId).toBe("ws_1");
    expect(input.type).toBe("employer_work");
  });

  it("a createWorkspace failure surfaces a SAFE error state (role=alert), never onOnboarded / a raw cause", async () => {
    const props = renderOnboarding({ onCreateWorkspace: vi.fn().mockResolvedValue({ ok: false }) });
    walkToPreset();
    fireEvent.click(screen.getByRole("button", { name: "Professional" }));
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't create the workspace/i);
    // No raw cause / secret leaked; the scope-entry hook is NOT called on failure.
    expect(props.onOnboarded).not.toHaveBeenCalled();
  });

  it("latest-wins: a slow OLDER preview never overwrites a NEWER pick's profile (stale-race guard)", async () => {
    // Simple resolves LATE, Professional resolves first → the panel must show Professional's set,
    // never Simple's, even though Simple was clicked first.
    const simpleProfile = { ...PROFILE, preset: "simple", connectors: ["localOnly"], workflows: ["projectSync"] };
    let releaseSimple!: (v: { ok: true; profile: typeof simpleProfile }) => void;
    const onPreviewPreset = vi.fn((preset: string) => {
      if (preset === "simple") return new Promise<{ ok: true; profile: typeof simpleProfile }>((res) => (releaseSimple = res));
      return Promise.resolve({ ok: true as const, profile: PROFILE });
    });
    renderOnboarding({ onPreviewPreset });
    walkToPreset();
    fireEvent.click(screen.getByRole("button", { name: "Simple" })); // fires slow preview
    fireEvent.click(screen.getByRole("button", { name: "Professional" })); // fires fast preview
    await screen.findByText(/drive, calendar/i); // Professional resolved + rendered
    releaseSimple({ ok: true, profile: simpleProfile }); // the stale Simple preview resolves late
    await waitFor(() => expect(onPreviewPreset).toHaveBeenCalledTimes(2));
    // The stale Simple set must NOT have replaced Professional's.
    expect(screen.queryByText(/localOnly/i)).toBeNull();
    expect(screen.getByText(/drive, calendar/i)).toBeTruthy();
  });

  it("is the first-run entry — renders the set-up heading (mounted by App when no workspace is onboarded)", () => {
    renderOnboarding();
    expect(screen.getByRole("heading", { name: /set up your workspace/i })).toBeTruthy();
  });
});
