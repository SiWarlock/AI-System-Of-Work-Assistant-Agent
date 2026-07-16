// 15.8 (desktop leg) — the reroute picker options selector. A pure projection of the 14.6
// registry read models the renderer already holds (the onboarded-workspace set + the scoped
// project dashboards) into the reroute control's option lists. WS-8: the workspace options are
// the onboarded/registered set (never free-text); the project options belong ONLY to the current
// scope's workspace (`projectsWorkspaceId`) — dropped under Global (no cross-scope blend).
import { describe, it, expect } from "vitest";
import { reroutePickerOptions } from "../../renderer/lib/reroute-picker";
import type { OnboardedWorkspace, WorkspaceBucketScope } from "../../renderer/store/onboarding";
import type { UiSafeProjectDashboard } from "@sow/contracts/api/ui-safe";

function ow(
  over: Pick<OnboardedWorkspace, "workspaceId" | "scope" | "name" | "type">,
): OnboardedWorkspace {
  return { preset: "simple", ...over };
}
function onboarded(entries: readonly OnboardedWorkspace[]): ReadonlyMap<WorkspaceBucketScope, OnboardedWorkspace> {
  return new Map(entries.map((e) => [e.scope, e]));
}
/** The selector reads ONLY `projectId` + `title` — a minimal structural fixture (mirrors fakeClient casts). */
function proj(projectId: string, title: string): UiSafeProjectDashboard {
  return { projectId, title } as unknown as UiSafeProjectDashboard;
}

describe("reroutePickerOptions — registry-sourced picker options (15.8, WS-8)", () => {
  it("picker_options_come_from_the_registry_read_model — workspaces from the onboarded set, projects from the scope read model", () => {
    // spec(§19.2) the picker lists REAL registry entries — the user selects, never types a raw target.
    const opts = reroutePickerOptions(
      onboarded([
        ow({ workspaceId: "ws_a", scope: "employer-work", name: "Acme", type: "employer_work" }),
        ow({ workspaceId: "ws_b", scope: "personal-business", name: "Side", type: "personal_business" }),
      ]),
      [proj("p_1", "Redesign"), proj("p_2", "Launch")],
      "ws_a",
    );
    expect(opts.workspaces).toEqual([
      { workspaceId: "ws_a", label: "Acme" },
      { workspaceId: "ws_b", label: "Side" },
    ]);
    expect(opts.projects).toEqual([
      { projectId: "p_1", label: "Redesign" },
      { projectId: "p_2", label: "Launch" },
    ]);
    expect(opts.projectsWorkspaceId).toBe("ws_a");
  });

  it("no_free_text — an empty registry yields empty options (never a fabricated/typed target)", () => {
    // spec(REQ-F-017) with nothing onboarded there is nothing to select — the control offers no invented target.
    const opts = reroutePickerOptions(onboarded([]), [], null);
    expect(opts.workspaces).toEqual([]);
    expect(opts.projects).toEqual([]);
    expect(opts.projectsWorkspaceId).toBeNull();
  });

  it("projects_bound_to_current_scope — under Global (projectsWorkspaceId null) projects are dropped (WS-8, no cross-scope blend)", () => {
    // spec(WS-8) projects belong to the current scope's workspace; without a resolved scope id they are NOT offered.
    const opts = reroutePickerOptions(
      onboarded([ow({ workspaceId: "ws_a", scope: "employer-work", name: "Acme", type: "employer_work" })]),
      [proj("p_1", "Redesign")],
      null,
    );
    expect(opts.workspaces).toHaveLength(1); // workspaces are still offered (choosing a target workspace is fine)
    expect(opts.projects).toEqual([]); // but no scoped project list without a resolved current workspace
  });
});
