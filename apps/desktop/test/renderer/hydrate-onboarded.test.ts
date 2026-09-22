// Rebuilding the renderer's onboarded-workspace set on every launch.
//
// ⛔ THE DEFECT, owner-reported 2026-09-21: Connectors said "Select an onboarded workspace" with the
// Employer-Work scope selected, on an install with two real workspaces. The `onboarded` slice had ONE
// writer — the onboarding wizard's completion callback — and nothing rebuilt it at launch, while the
// durable first-run marker (correctly) kept the wizard hidden. So after the first restart every scope
// resolved to "not onboarded" and every scoped surface was dead.
//
// These pins cover the loader's two jobs: re-validate candidate data off the wire (the renderer is
// untrusted and so is the wire — desktop L6), and actually make the scope selectable again, which is
// the property the owner needed and the one the old code silently lacked.
import { describe, it, expect } from "vitest";
import { createStore, initialStoreState as INITIAL_STATE, type UiSafeStoreState } from "../../renderer/store";
import { resolveOnboardedWorkspaceId } from "../../renderer/store/projections";
import { parseOnboardedList, hydrateOnboarded } from "../../renderer/lib/hydrate-onboarded";

const WIRE_OK = {
  ok: true,
  value: [
    { workspaceId: "employer-work", name: "Main-Test", type: "employer_work" },
    { workspaceId: "personal-life", name: "Test", type: "personal_life" },
  ],
};

function fakeClient(query: () => Promise<unknown>): never {
  return { onboarding: { listWorkspaces: { query } } } as never;
}

describe("parseOnboardedList — candidate data off the wire", () => {
  it("maps each item to its bucket, with preset '' (the preset is not persisted)", () => {
    expect(parseOnboardedList(WIRE_OK)).toEqual([
      { workspaceId: "employer-work", scope: "employer-work", name: "Main-Test", type: "employer_work", preset: "" },
      { workspaceId: "personal-life", scope: "personal-life", name: "Test", type: "personal_life", preset: "" },
    ]);
  });

  it("drops a malformed item rather than failing the whole list", () => {
    const parsed = parseOnboardedList({
      ok: true,
      value: [
        { workspaceId: "", name: "x", type: "employer_work" }, // empty id
        { workspaceId: "a", name: "x", type: "not_a_type" }, // unknown type
        { workspaceId: "b", name: 42, type: "personal_life" }, // non-string name
        null,
        "employer-work",
        { workspaceId: "personal-life", name: "Test", type: "personal_life" }, // the one good row
      ],
    });
    expect(parsed?.map((w) => w.workspaceId)).toEqual(["personal-life"]);
  });

  it("copies ONLY the named fields — an extra key on the wire never reaches the store", () => {
    const parsed = parseOnboardedList({
      ok: true,
      value: [{ workspaceId: "employer-work", name: "M", type: "employer_work", markdownRepoPath: "/secret/path" }],
    });
    expect(JSON.stringify(parsed)).not.toContain("/secret/path");
  });

  it("a typed err, a non-array value, or garbage is NULL — 'cannot say', never 'none onboarded'", () => {
    // null means "leave the store alone". Returning [] here would be a false authoritative claim.
    expect(parseOnboardedList({ ok: false, error: { kind: "degraded_unavailable" } })).toBeNull();
    expect(parseOnboardedList({ ok: true, value: "nope" })).toBeNull();
    expect(parseOnboardedList(undefined)).toBeNull();
  });
});

describe("hydrateOnboarded — the scope becomes selectable again after a restart", () => {
  it("⛔ THE OWNER'S CASE — Employer-Work resolves to its real id once the list loads", async () => {
    const store = createStore<UiSafeStoreState>({ ...INITIAL_STATE, scope: "employer-work" });
    // Baseline: exactly the broken state the owner saw — the scope is selected but resolves to nothing.
    expect(resolveOnboardedWorkspaceId(store.getSnapshot(), "employer-work")).toBeNull();
    await hydrateOnboarded(fakeClient(async () => WIRE_OK), store);
    expect(resolveOnboardedWorkspaceId(store.getSnapshot(), "employer-work")).toBe("employer-work");
    expect(resolveOnboardedWorkspaceId(store.getSnapshot(), "personal-life")).toBe("personal-life");
  });

  it("does NOT make a workspace selectable that the worker did not list (WS-8 stays fail-closed)", async () => {
    // `personal-business` exists in the owner's registry read-model but has no config row, so the
    // worker does not list it — and the renderer must not invent it.
    const store = createStore<UiSafeStoreState>({ ...INITIAL_STATE });
    await hydrateOnboarded(fakeClient(async () => WIRE_OK), store);
    expect(resolveOnboardedWorkspaceId(store.getSnapshot(), "personal-business")).toBeNull();
  });

  it("a transport throw or a typed err leaves the store UNCHANGED (never throws)", async () => {
    for (const q of [async () => { throw new Error("socket closed"); }, async () => ({ ok: false, error: {} })]) {
      const store = createStore<UiSafeStoreState>({ ...INITIAL_STATE });
      const before = store.getSnapshot();
      await expect(hydrateOnboarded(fakeClient(q), store)).resolves.toBeUndefined();
      expect(store.getSnapshot()).toBe(before);
    }
  });
});
