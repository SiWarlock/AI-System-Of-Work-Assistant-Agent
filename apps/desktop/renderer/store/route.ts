// The renderer ROUTE model (§9.5 routing foundation): which SURFACE is mounted.
//
// Hand-rolled (NO router lib) — a discriminated union + pure structural equality,
// mirroring the scope model (store/scope.ts). Window-free so the DOM-less node test
// tsconfig compiles it (apps/desktop LESSONS §3).
//
// The route is INDEPENDENT of the workspace SCOPE (§9.4): SCOPE gates the DATA (which
// workspace's read-models hydrate — Today AND Projects both read scope-hydrated state),
// ROUTE selects the SURFACE. Switching scope never changes the route; navigating never
// changes the scope. A project detail is addressed by `projectId`; its ABSENCE = the
// list view.

export type Route =
  | { readonly surface: "today" }
  | { readonly surface: "projects"; readonly projectId?: string };

/**
 * The surface mounted on launch: Today (home). Frozen — it is shared by reference across
 * `initialStoreState.route` and every ref-stable no-op comparison, so an accidental in-place
 * mutation would corrupt the shared singleton for all consumers.
 */
export const DEFAULT_ROUTE: Route = Object.freeze({ surface: "today" });

/** Structural route equality — same surface AND (for projects) the same selected projectId. */
export function routeEquals(a: Route, b: Route): boolean {
  if (a.surface !== b.surface) return false;
  if (a.surface === "projects" && b.surface === "projects") {
    return a.projectId === b.projectId;
  }
  return true;
}
