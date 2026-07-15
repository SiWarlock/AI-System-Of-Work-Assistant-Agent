// §9.4 slice 4 + §19.1 / 14.1: the workspace scope model. The switcher offers the Global
// aggregate + the three isolated workspace buckets. A scope's REAL query workspaceId is NO
// LONGER static here (placeholder ids dropped) — it is minted by onboarding and lives in the
// store's `onboarded` slice, resolved via `resolveOnboardedWorkspaceId` (see onboarding-store.test).
// This module now holds ONLY the static per-scope METADATA (label + accent + the isGlobal flag).
import { describe, it, expect } from "vitest";
import {
  WORKSPACE_SCOPES,
  DEFAULT_SCOPE,
  scopeMeta,
  isWorkspaceScope,
  type WorkspaceScope,
} from "../../renderer/store/scope";

describe("workspace scope model", () => {
  it("offers exactly the four locked-design scopes in order (Global first)", () => {
    expect(WORKSPACE_SCOPES.map((m) => m.id)).toEqual([
      "global",
      "employer-work",
      "personal-business",
      "personal-life",
    ]);
    expect(DEFAULT_SCOPE).toBe("global");
  });

  it("Global is the ONLY isGlobal scope (cross-workspace aggregate — reads via the gate)", () => {
    expect(scopeMeta("global").isGlobal).toBe(true);
    expect(isWorkspaceScope("global")).toBe(false);
  });

  it("no ScopeMeta carries a static query workspaceId — real ids come from the onboarded store slice", () => {
    // The placeholder ids are gone (§19.1 / 14.1): a bucket's real id lives in the store, not here.
    for (const m of WORKSPACE_SCOPES) {
      expect("workspaceId" in m).toBe(false);
    }
  });

  it("each workspace bucket is isolated (isGlobal false) + carries its subtle accent", () => {
    for (const id of ["employer-work", "personal-business", "personal-life"] as const) {
      const m = scopeMeta(id);
      expect(m.isGlobal).toBe(false);
      expect(isWorkspaceScope(id)).toBe(true);
      expect(m.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it("uses the locked per-workspace accents (blue / emerald / indigo)", () => {
    expect(scopeMeta("employer-work").accent).toBe("#0a84ff");
    expect(scopeMeta("personal-business").accent).toBe("#1fae6b");
    expect(scopeMeta("personal-life").accent).toBe("#5e5ce6");
  });

  it("scopeMeta is total (defensive fallback on any value, never throws)", () => {
    expect(scopeMeta("not-a-scope" as unknown as WorkspaceScope).id).toBe("global");
  });

  it("isWorkspaceScope fails CLOSED on an unknown scope — the isolation gate suppresses, never blends", () => {
    // §9.5: unlike scopeMeta's display fallback (fails OPEN to Global's accent), the
    // read_model.change isolation gate must treat an out-of-union scope (a future
    // untyped source: persisted last-scope / deep link / IPC) as workspace-scoped, so a
    // pushed card is SUPPRESSED rather than blended under the wrong tab.
    expect(isWorkspaceScope("not-a-scope" as unknown as WorkspaceScope)).toBe(true);
  });
});
