// 15.8 (desktop leg) — the reroute picker options selector. A PURE projection of the 14.6
// registry read models the renderer already holds into the reroute control's option lists:
//   - workspaces ← the onboarded/registered workspace set (14.1) — the SAME registered source the
//     scope switcher + cross-workspace-link pickers use; never a free-text target (REQ-F-017).
//   - projects   ← the CURRENT scope's project dashboards (14.6 scoped read model). WS-8: these
//     belong to `projectsWorkspaceId` (the resolved current-scope workspace) ONLY — the renderer
//     holds no other workspace's projects, so they are dropped under Global (projectsWorkspaceId
//     null) and offered only when the reroute target IS the current scope (gated in the surface).
//
// WINDOW-FREE (pure data over store types + a UI-safe contract) so the DOM-less node test tsconfig
// compiles it (apps/desktop LESSONS §3). No store/DOM coupling — the caller passes the slices in.
import type { OnboardedWorkspace, WorkspaceBucketScope } from "../store/onboarding";
import type { UiSafeProjectDashboard } from "@sow/contracts/api/ui-safe";

export interface RerouteWorkspaceOption {
  readonly workspaceId: string;
  readonly label: string;
}
export interface RerouteProjectOption {
  readonly projectId: string;
  readonly label: string;
}
export interface ReroutePickerOptions {
  /** The onboarded/registered workspaces — the reroute target workspace choices (never free-text). */
  readonly workspaces: readonly RerouteWorkspaceOption[];
  /** The CURRENT scope's projects (belong to `projectsWorkspaceId`); empty under Global (WS-8). */
  readonly projects: readonly RerouteProjectOption[];
  /** The workspace the `projects` belong to (the resolved current-scope id), or null under Global. */
  readonly projectsWorkspaceId: string | null;
}

/**
 * Project the registry read models into reroute picker options. Workspaces are the onboarded set;
 * projects are the current scope's dashboards bound to `projectsWorkspaceId` — dropped when there
 * is no resolved current-scope workspace (Global / unscoped), so the renderer never offers a
 * project it can't attribute to the right workspace (WS-8 defense-in-depth).
 */
export function reroutePickerOptions(
  onboarded: ReadonlyMap<WorkspaceBucketScope, OnboardedWorkspace>,
  projects: readonly UiSafeProjectDashboard[],
  projectsWorkspaceId: string | null,
): ReroutePickerOptions {
  const workspaces = [...onboarded.values()].map((ow) => ({ workspaceId: ow.workspaceId, label: ow.name }));
  const projectOpts =
    projectsWorkspaceId === null ? [] : projects.map((p) => ({ projectId: p.projectId, label: p.title }));
  return { workspaces, projects: projectOpts, projectsWorkspaceId };
}
