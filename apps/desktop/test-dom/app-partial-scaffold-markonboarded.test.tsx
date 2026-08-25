// @vitest-environment jsdom
//
// Task 9.21-B — a direct pin for 9.21's Done-when clause 3 ("onboarding never marks complete on
// a partial"), covering BOTH of markOnboarded's real call sites in renderer/App.tsx:
//   - :104  the 9.17 existing-install BACKFILL effect (`shouldBackfillMarker(firstRunSignal,
//           hasAnyOnboardedWorkspace(state))`) — silent on a partial only because the store never
//           gains a workspace (the store dispatch at :227 lives inside the handler that didn't fire)
//   - :240  the `onOnboarded` handler App binds to `<Onboarding onOnboarded={...}>`
// A test that only pins `onOnboarded`'s own non-invocation (test-dom/onboarding-page.test.tsx)
// proves :240 directly but leaves :104 resting on an inference through `shouldBackfillMarker` and
// `hasAnyOnboardedWorkspace` — this file drives the REAL `App` (mirroring the 9.35 Site-A pattern:
// real production component, ONE seam mocked) so both stay provably silent, not just inferred.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { StartLiveHandle } from "../renderer/lib/live";

// `vi.hoisted` so `onboardWorkspace` exists before the hoisted `vi.mock` factory below runs.
const { onboardWorkspace } = vi.hoisted(() => ({ onboardWorkspace: vi.fn() }));

// Mock the live-wiring stack so `onboardWorkspace` is directly controllable (a real handle avoids
// the no-bridge `seedDevStore` fallback, which would populate `state.onboarded` and skip past the
// Onboarding surface entirely). Every other handle method is an unused stub for this test.
vi.mock("../renderer/lib/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/lib/live")>();
  const stubHandle: StartLiveHandle = {
    stop: () => {},
    drillDown: async () => ({ ok: false }),
    auditDrill: async () => ({ ok: false }),
    hydrateScope: async () => {},
    askCopilot: async () => ({ ok: false }),
    // §9.8's DecisionResult now REQUIRES a closed reason on the ok:false arm. "unavailable" is the
    // honest one for a scaffold stub: this handle has no live worker behind it, which is exactly
    // the case App.tsx:177 maps to "unavailable". "already_resolved" would assert a server fact
    // this stub never observed.
    decideApproval: async () => ({ ok: false, reason: "unavailable" }),
    disposeTriage: async () => ({ ok: false }),
    onboardWorkspace,
    previewPreset: async () => ({ ok: false }),
    registerConnector: async () => ({ ok: false }),
    setConnectorState: async () => ({ ok: false }),
    setConnectorCadence: async () => ({ ok: false }),
    createCrossWorkspaceLink: async () => ({ ok: false }),
    approveCrossWorkspaceLink: async () => ({ ok: false }),
    revokeCrossWorkspaceLink: async () => ({ ok: false }),
    egressStatus: async () => ({ ok: false }),
    revokeEgressAck: async () => ({ ok: false }),
  };
  return { ...actual, startLive: vi.fn(async () => stubHandle) };
});

import { App } from "../renderer/App";

afterEach(cleanup);

function stubBridge(markOnboarded: ReturnType<typeof vi.fn>): void {
  (window as unknown as { sow?: unknown }).sow = {
    app: { getVersion: async () => "0.0.0" },
    session: { getToken: async () => "tok" },
    worker: { getConnection: async () => null },
    vault: { open: async () => ({ ok: true }), reveal: async () => ({ ok: true }) },
    lifecycle: {
      // Not "complete" ⇒ the registry-derived gate decides (fresh store ⇒ shows Onboarding).
      firstRunStatus: async () => ({ ok: false as const }),
      markOnboarded,
    },
  };
}

describe("App — markOnboarded stays silent on a partial scaffold, at BOTH real call sites (9.21-B)", () => {
  it("onOnboarded_handler_and_the_backfill_effect_both_stay_silent_on_a_partial", async () => {
    const markOnboarded = vi.fn().mockResolvedValue({ ok: true, value: true });
    stubBridge(markOnboarded);
    onboardWorkspace.mockResolvedValue({ ok: false, reason: "partial_scaffold" });

    render(<App />);
    // Flush the mocked `startLive(...).then(...)` microtask (binds `liveRef.current` to the fake
    // handle) inside `act` before interacting, so `onCreateWorkspace` calls the REAL bound
    // `onboardWorkspace` spy rather than the no-live-worker `?? Promise.resolve({ok:false})` fallback.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.change(screen.getByRole("textbox", { name: /workspace name/i }), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("radio", { name: "Employer-Work" }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /vault root/i }), { target: { value: "/Users/me/vault" } });
    fireEvent.change(screen.getByRole("textbox", { name: /gbrain brain id/i }), { target: { value: "brain_1" } });
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Professional" }));
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    await screen.findByRole("alert"); // the partial repair state, rendered by the REAL Onboarding
    expect(onboardWorkspace).toHaveBeenCalledTimes(1); // proves the submit reached the real binding
    expect(markOnboarded).not.toHaveBeenCalled(); // BOTH call sites (:104 backfill + :240 handler)
  });
});
