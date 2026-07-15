// Task 14.1 (desktop leg) — the renderer onboarding command-caller. The renderer only
// REQUESTS provisioning — the worker (`onboarding.createWorkspace`) owns the candidate-data
// gate, the one-writer provisioning, the WS-8 registry union, and the redaction-safe typed
// Result. This wrapper folds a typed err OR any transport throw OR a malformed ok to
// `{ ok: false }` so a failed onboarding never surfaces a raw driver cause / partial state
// (desktop Lesson 6 fail-closed pattern).
import { describe, it, expect, vi } from "vitest";
import { createOnboardWorkspace, type OnboardWorkspaceInput } from "../../renderer/lib/onboard-workspace";

// A minimal fake tRPC client exposing only onboarding.createWorkspace.mutate.
function fakeClient(mutateImpl: (input: unknown) => Promise<unknown>): never {
  return { onboarding: { createWorkspace: { mutate: mutateImpl } } } as never;
}

const INPUT: OnboardWorkspaceInput = {
  id: "employer-work",
  name: "Acme",
  type: "employer_work",
  vaultRoot: "/Users/me/vault",
  gbrainBrainId: "brain_1",
  preset: "professional",
};

describe("createOnboardWorkspace", () => {
  it("returns the worker's UI-safe provisioned summary on an ok result", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() =>
        Promise.resolve({
          ok: true,
          value: { workspaceId: "ws_real_01", registryMember: true, preset: "professional" },
        }),
      ),
    );
    const r = await onboard(INPUT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workspace.workspaceId).toBe("ws_real_01");
      expect(r.workspace.registryMember).toBe(true);
      expect(r.workspace.preset).toBe("professional");
    }
  });

  it("forwards the entered name/type/vaultRoot/gbrainBrainId/preset to the worker verbatim", async () => {
    const mutate = vi.fn(() =>
      Promise.resolve({ ok: true, value: { workspaceId: "ws_real_01", registryMember: true, preset: "professional" } }),
    );
    const onboard = createOnboardWorkspace(fakeClient(mutate));
    await onboard(INPUT);
    expect(mutate).toHaveBeenCalledWith(INPUT);
  });

  it("folds a typed err Result (validation / store fault) to { ok: false } — no raw cause surfaced", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() =>
        Promise.resolve({ ok: false, error: { kind: "degraded_unavailable", cause: { code: "ONBOARDING_STORE_FAULT" } } }),
      ),
    );
    const r = await onboard(INPUT);
    expect(r.ok).toBe(false);
  });

  it("folds a malformed ok (missing / non-string workspaceId) to { ok: false } (defense-in-depth)", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() => Promise.resolve({ ok: true, value: { registryMember: true, preset: "professional" } })),
    );
    const r = await onboard(INPUT);
    expect(r.ok).toBe(false);
  });

  it("folds a transport throw to { ok: false } (never surfaces a partial / raw failure)", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() => Promise.reject(new Error("loopback down"))),
    );
    const r = await onboard(INPUT);
    expect(r.ok).toBe(false);
  });
});
