import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import { navigate, setScope } from "../../renderer/store/projections";
import { DEFAULT_ROUTE, routeEquals } from "../../renderer/store/route";

describe("route model (§9.5 routing foundation — surface selection, independent of scope)", () => {
  it("initial route is Today (DEFAULT_ROUTE)", () => {
    expect(initialStoreState.route).toEqual(DEFAULT_ROUTE);
    expect(initialStoreState.route.surface).toBe("today");
  });

  it("navigate changes only the route field — unrelated slices stay ref-stable", () => {
    const s = navigate(initialStoreState, { surface: "projects" });
    expect(s.route).toEqual({ surface: "projects" });
    expect(s.cards).toBe(initialStoreState.cards);
    expect(s.scope).toBe(initialStoreState.scope);
    expect(s.projects).toBe(initialStoreState.projects);
    expect(s.recentChanges).toBe(initialStoreState.recentChanges);
  });

  it("navigate is a ref-stable no-op when the route is unchanged", () => {
    // today→today
    expect(navigate(initialStoreState, { surface: "today" })).toBe(initialStoreState);
    // projects+id → projects+same id
    const proj = navigate(initialStoreState, { surface: "projects", projectId: "p1" });
    expect(navigate(proj, { surface: "projects", projectId: "p1" })).toBe(proj);
    // projects (list view, no id) → projects (no id): the undefined===undefined branch is a no-op
    const list = navigate(initialStoreState, { surface: "projects" });
    expect(navigate(list, { surface: "projects" })).toBe(list);
  });

  it("navigate distinguishes a different selected projectId (detail selection changes state)", () => {
    const a = navigate(initialStoreState, { surface: "projects", projectId: "p1" });
    const b = navigate(a, { surface: "projects", projectId: "p2" });
    expect(b).not.toBe(a);
    expect(b.route).toEqual({ surface: "projects", projectId: "p2" });
    // The list view (no id) is distinct from a detail view (id) — de-selecting is a real change.
    const list = navigate(a, { surface: "projects" });
    expect(list).not.toBe(a);
    expect(list.route).toEqual({ surface: "projects" });
  });

  it("route is INDEPENDENT of scope — navigating leaves scope; switching scope leaves route", () => {
    const navd = navigate(initialStoreState, { surface: "projects" });
    expect(navd.scope).toBe(initialStoreState.scope); // navigate did not touch scope
    const scoped = setScope(navd, "employer-work");
    expect(scoped.route).toBe(navd.route); // scope switch left the route reference intact
    expect(scoped.scope).toBe("employer-work");
  });

  it("routeEquals is structural — same surface AND same selected id", () => {
    expect(routeEquals({ surface: "today" }, { surface: "today" })).toBe(true);
    expect(routeEquals({ surface: "today" }, { surface: "projects" })).toBe(false);
    expect(routeEquals({ surface: "projects", projectId: "p1" }, { surface: "projects", projectId: "p1" })).toBe(true);
    expect(routeEquals({ surface: "projects", projectId: "p1" }, { surface: "projects", projectId: "p2" })).toBe(false);
    expect(routeEquals({ surface: "projects" }, { surface: "projects", projectId: "p1" })).toBe(false);
  });
});
