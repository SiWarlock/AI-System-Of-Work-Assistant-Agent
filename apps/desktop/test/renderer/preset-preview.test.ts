// Task 14.5 (desktop leg) — the renderer preset-preview query-caller. The picker previews what
// each tier provisions (its differentiated connector/workflow set) BEFORE the user chooses, via
// the read-only `presetProfiles.preview` query. Fails closed to `{ ok: false }` on a typed err /
// malformed ok / transport throw (desktop Lesson 6) so the picker never renders a partial/raw
// profile.
import { describe, it, expect, vi } from "vitest";
import { createPresetPreview } from "../../renderer/lib/preset-preview";

// A minimal fake tRPC client exposing only presetProfiles.preview.query.
function fakeClient(queryImpl: (input: unknown) => Promise<unknown>): never {
  return { presetProfiles: { preview: { query: queryImpl } } } as never;
}

const PROFESSIONAL_PROFILE = {
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
};

describe("createPresetPreview", () => {
  it("returns the tier's differentiated provisioning profile on an ok result", async () => {
    const preview = createPresetPreview(fakeClient(() => Promise.resolve({ ok: true, value: PROFESSIONAL_PROFILE })));
    const r = await preview("professional");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.connectors).toEqual(["drive", "calendar"]);
      expect(r.profile.workflows).toEqual(["projectSync", "meetingCloseout"]);
    }
  });

  it("forwards the selected preset to the worker query", async () => {
    const query = vi.fn(() => Promise.resolve({ ok: true, value: PROFESSIONAL_PROFILE }));
    const preview = createPresetPreview(fakeClient(query));
    await preview("professional");
    expect(query).toHaveBeenCalledWith({ preset: "professional" });
  });

  it("folds a typed err (unknown preset) to { ok: false }", async () => {
    const preview = createPresetPreview(
      fakeClient(() => Promise.resolve({ ok: false, error: { kind: "validation_rejected", cause: { code: "PRESET_PREVIEW_PRESET" } } })),
    );
    expect((await preview("bogus")).ok).toBe(false);
  });

  it("folds a malformed ok (non-array connectors) to { ok: false } (defense-in-depth)", async () => {
    const preview = createPresetPreview(
      fakeClient(() => Promise.resolve({ ok: true, value: { preset: "professional", connectors: "nope" } })),
    );
    expect((await preview("professional")).ok).toBe(false);
  });

  it("folds a transport throw to { ok: false }", async () => {
    const preview = createPresetPreview(fakeClient(() => Promise.reject(new Error("down"))));
    expect((await preview("professional")).ok).toBe(false);
  });
});
