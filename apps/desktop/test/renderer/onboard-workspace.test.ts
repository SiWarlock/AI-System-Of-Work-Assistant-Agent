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
    // Discriminant: exact-shape, not just `.ok` — proves a store fault (a DIFFERENT degraded_unavailable
    // cause than ONBOARDING_PARTIAL_SCAFFOLD) does NOT also pick up the widened `reason: "partial_scaffold"`.
    expect(r).toEqual({ ok: false });
  });

  it("folds a malformed ok (missing / non-string workspaceId) to { ok: false } (defense-in-depth)", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() => Promise.resolve({ ok: true, value: { registryMember: true, preset: "professional" } })),
    );
    const r = await onboard(INPUT);
    expect(r).toEqual({ ok: false });
  });

  it("folds a transport throw to { ok: false } (never surfaces a partial / raw failure)", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() => Promise.reject(new Error("loopback down"))),
    );
    const r = await onboard(INPUT);
    expect(r).toEqual({ ok: false });
  });

  // Task 9.21-B — widen the fold by EXACTLY one case: worker's ONBOARDING_PARTIAL_SCAFFOLD
  // (9.21-A, `provisionErrorToFailure` in apps/worker/src/api/procedures/onboarding.ts) must
  // survive the transport as a distinguishable outcome, not collapse into the opaque failure.
  it("partial_scaffold_is_distinguishable_from_a_generic_failure — spec(§11)", async () => {
    const onboard = createOnboardWorkspace(
      fakeClient(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "degraded_unavailable",
            message: "workspace scaffold incomplete — resume required",
            retryable: true,
            cause: { code: "ONBOARDING_PARTIAL_SCAFFOLD" },
          },
        }),
      ),
    );
    const r = await onboard(INPUT);
    expect(r).toEqual({ ok: false, reason: "partial_scaffold" });
  });

  // Non-vacuity + desktop L6: proves the widening admits EXACTLY the partial case — every other
  // typed err (validation / a DIFFERENT degraded_unavailable cause), malformed ok, and transport
  // throw must still fold to the reasonless opaque failure, never acquiring `reason`.
  it("other_typed_failures_still_fold_to_a_reasonless_opaque_result — spec(§11) desktop L6", async () => {
    const cases: ReadonlyArray<{ readonly label: string; readonly mutate: () => Promise<unknown> }> = [
      {
        label: "validation_rejected err",
        mutate: () =>
          Promise.resolve({
            ok: false,
            error: { kind: "validation_rejected", message: "invalid onboarding input", retryable: false, cause: { code: "CREATE_WORKSPACE_VAULT_ROOT" } },
          }),
      },
      {
        label: "degraded_unavailable err with a DIFFERENT cause (store fault, not partial)",
        mutate: () =>
          Promise.resolve({
            ok: false,
            error: { kind: "degraded_unavailable", message: "onboarding store unavailable", retryable: true, cause: { code: "ONBOARDING_STORE_FAULT" } },
          }),
      },
      {
        label: "malformed ok (missing workspaceId)",
        mutate: () => Promise.resolve({ ok: true, value: { registryMember: true, preset: "professional" } }),
      },
      {
        label: "transport throw",
        mutate: () => Promise.reject(new Error("loopback down")),
      },
    ];
    for (const { label, mutate } of cases) {
      const onboard = createOnboardWorkspace(fakeClient(mutate));
      const r = await onboard(INPUT);
      expect(r, label).toEqual({ ok: false });
      expect(r, label).not.toHaveProperty("reason");
    }
  });

  // Rule 7 / desktop L6, mirroring the 9.35 ErrorBoundary's "withhold from the type" move: the
  // partial case's shape is CLOSED (exactly ok+reason) so a server-derived message/cause string
  // has nowhere to travel even if a future edit tried to thread it through.
  it("partial_scaffold_result_shape_is_closed_no_server_message_or_code_included — spec(§16) rule 7", async () => {
    const driverIshMessage = "sqlite: table workspace_registry locked at /Users/x/.sow/vault.db";
    const onboard = createOnboardWorkspace(
      fakeClient(() =>
        Promise.resolve({
          ok: false,
          error: {
            kind: "degraded_unavailable",
            message: driverIshMessage,
            retryable: true,
            cause: { code: "ONBOARDING_PARTIAL_SCAFFOLD" },
          },
        }),
      ),
    );
    const r = await onboard(INPUT);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
    expect(JSON.stringify(r)).not.toContain(driverIshMessage);
    expect(JSON.stringify(r)).not.toContain("sqlite");
  });
});
