// Task 14.5 — the `presetProfiles.preview` query procedure. RED-first spec.
//
// The reachable read-only picker data source: preview(preset) → the provisioning profile,
// auth-gated, UI-safe by construction (names + policy flags, no secrets). Malformed preset ⇒
// typed validation_rejected; unauthenticated ⇒ typed err (the resolver body never runs).
import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import { buildPresetProfilesRouter } from "../../../src/api/procedures/presetProfiles";
import { presetProfiles } from "../../../src/composition/presetProfiles";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

function caller(ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ presetProfiles: buildPresetProfilesRouter() });
  return createCallerFactory(appRouter)(ctx);
}

describe("presetProfiles.preview procedure (14.5)", () => {
  it("preview_returns_profile: preview(preset) round-trips the mapping's profile (UI-safe) [spec(§11)]", async () => {
    const res = await caller().presetProfiles.preview({ preset: "founder" });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toEqual(presetProfiles("founder"));
      expect(res.value.policyDefaults.employerRawEgressAcknowledged).toBe(false);
    }
  });

  it("preview_rejects_unknown_preset: a malformed/unknown preset ⇒ validation_rejected (never a throw) [spec(§16)]", async () => {
    const res = await caller().presetProfiles.preview({ preset: "enterprise" });
    expect(isErr(res)).toBe(true);
  });

  it("preview_rejects_non_object_input: a null / non-object payload ⇒ validation_rejected (the input-shape branch) [spec(§16)]", async () => {
    const nullInput = await caller().presetProfiles.preview(null as never);
    const stringInput = await caller().presetProfiles.preview("simple" as never);
    expect(isErr(nullInput)).toBe(true);
    expect(isErr(stringInput)).toBe(true);
  });

  it("preview_requires_auth: an unauthenticated caller gets a typed err [spec(§16)]", async () => {
    const res = await caller(UNAUTH_CTX).presetProfiles.preview({ preset: "simple" });
    expect(isErr(res)).toBe(true);
  });
});
