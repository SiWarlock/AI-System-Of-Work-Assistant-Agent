// Task 14.1 (desktop leg) — the onboarding store slice + its selectors.
//
// The renderer's scope model reflects the fail-closed WS-8 registry: a workspace bucket is
// SELECTABLE / QUERYABLE only once it has been ONBOARDED (a real minted workspaceId enters the
// store). The static `scope.ts` placeholder ids are gone — a bucket absent from the onboarded set
// resolves to `null` (no read path), never a resurrected placeholder id.
import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import {
  WORKSPACE_TYPE_TO_SCOPE,
  scopeForType,
  type OnboardedWorkspace,
} from "../../renderer/store/onboarding";
import {
  recordOnboardedWorkspace,
  resolveOnboardedWorkspaceId,
  hasAnyOnboardedWorkspace,
} from "../../renderer/store/projections";
import type { WorkspaceScope } from "../../renderer/store/scope";

const EMPLOYER: OnboardedWorkspace = {
  workspaceId: "ws_employer_real_01",
  scope: "employer-work",
  name: "Acme",
  type: "employer_work",
  preset: "professional",
};

describe("workspace type → scope bucket mapping (the 3-bucket model)", () => {
  it("maps each WorkspaceType 1:1 to its scope bucket (total)", () => {
    expect(WORKSPACE_TYPE_TO_SCOPE).toEqual({
      employer_work: "employer-work",
      personal_business: "personal-business",
      personal_life: "personal-life",
    });
    expect(scopeForType("employer_work")).toBe("employer-work");
    expect(scopeForType("personal_business")).toBe("personal-business");
    expect(scopeForType("personal_life")).toBe("personal-life");
  });
});

describe("onboarded-workspace store slice", () => {
  it("starts fail-closed empty — no bucket is onboarded on a fresh store", () => {
    expect(hasAnyOnboardedWorkspace(initialStoreState)).toBe(false);
    for (const bucket of ["employer-work", "personal-business", "personal-life"] as const) {
      expect(resolveOnboardedWorkspaceId(initialStoreState, bucket)).toBeNull();
    }
  });

  it("records an onboarded workspace keyed by its bucket, immutably (no in-place mutation)", () => {
    const next = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    expect(next).not.toBe(initialStoreState); // new state object
    expect(initialStoreState.onboarded.size).toBe(0); // prior state untouched
    expect(next.onboarded.get("employer-work")?.workspaceId).toBe("ws_employer_real_01");
  });

  it("resolves an onboarded bucket to its REAL minted id (drives scoped reads)", () => {
    const next = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    expect(resolveOnboardedWorkspaceId(next, "employer-work")).toBe("ws_employer_real_01");
    expect(hasAnyOnboardedWorkspace(next)).toBe(true);
  });

  it("leaves NON-onboarded buckets fail-closed (null) — no placeholder-id resurrection", () => {
    const next = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    // Only employer-work was onboarded; the other two buckets still get zero read path.
    expect(resolveOnboardedWorkspaceId(next, "personal-business")).toBeNull();
    expect(resolveOnboardedWorkspaceId(next, "personal-life")).toBeNull();
  });

  it("Global is never a single queryable workspace — resolves to null (cross-workspace)", () => {
    const next = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    expect(resolveOnboardedWorkspaceId(next, "global")).toBeNull();
  });

  it("fails CLOSED on an unknown / out-of-union scope (a future untyped source) → null", () => {
    const next = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    expect(resolveOnboardedWorkspaceId(next, "not-a-scope" as unknown as WorkspaceScope)).toBeNull();
  });

  it("re-onboarding a bucket replaces its entry (last-write-wins per bucket), never duplicates", () => {
    const first = recordOnboardedWorkspace(initialStoreState, EMPLOYER);
    const second = recordOnboardedWorkspace(first, { ...EMPLOYER, workspaceId: "ws_employer_real_02" });
    expect(second.onboarded.size).toBe(1);
    expect(resolveOnboardedWorkspaceId(second, "employer-work")).toBe("ws_employer_real_02");
  });
});
