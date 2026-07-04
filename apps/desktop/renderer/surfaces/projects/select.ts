import type { UiSafeProjectDashboard } from "@sow/contracts/api/ui-safe";

// Window-free (no JSX/DOM) so the DOM-less node test tsconfig compiles it (apps/desktop
// LESSONS §3): the deterministic list→detail selection logic, extracted out of the
// Projects.tsx surface so it is unit-testable.

/**
 * Resolve which project's detail to show (§4.5 list→detail). The route's `projectId` is the
 * selection source of truth: return the matching project; if it is absent (just entered the
 * page / list view) or STALE (a selection carried over a scope switch that changed the
 * workspace's project set), fall back to the FIRST project so the detail pane never shows a
 * blank for a non-existent selection. Returns undefined ONLY when there are no projects at all
 * (the empty state).
 */
export function resolveSelectedProject(
  projects: readonly UiSafeProjectDashboard[],
  projectId: string | undefined,
): UiSafeProjectDashboard | undefined {
  if (projects.length === 0) return undefined;
  if (projectId !== undefined) {
    const match = projects.find((p) => p.projectId === projectId);
    if (match !== undefined) return match;
  }
  return projects[0];
}
