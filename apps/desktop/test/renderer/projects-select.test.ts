import { describe, it, expect } from "vitest";
import { resolveSelectedProject } from "../../renderer/surfaces/projects/select";
import { uiSafeProjectDashboard } from "./fixtures";

describe("resolveSelectedProject (§4.5 list→detail — which project's detail to show)", () => {
  const a = uiSafeProjectDashboard("prj-a");
  const b = uiSafeProjectDashboard("prj-b");
  const c = uiSafeProjectDashboard("prj-c");

  it("no projects → undefined (empty state; regardless of a stale selection id)", () => {
    expect(resolveSelectedProject([], undefined)).toBeUndefined();
    expect(resolveSelectedProject([], "prj-a")).toBeUndefined();
  });

  it("a matching projectId → that project", () => {
    expect(resolveSelectedProject([a, b, c], "prj-b")).toBe(b);
  });

  it("no projectId (list view / just entered) → the FIRST project (detail never blank when a list exists)", () => {
    expect(resolveSelectedProject([a, b, c], undefined)).toBe(a);
  });

  it("a STALE projectId (not in the current scoped list) → falls back to the first, never a blank detail", () => {
    // e.g. a selection carried across a scope switch that changed the workspace's project set.
    expect(resolveSelectedProject([a, b], "prj-c")).toBe(a);
  });
});
