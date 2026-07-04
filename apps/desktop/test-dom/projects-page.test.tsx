// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Projects } from "../renderer/surfaces/projects/Projects";
import type { UiSafeProjectDashboard } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

function proj(id: string, over: Partial<UiSafeProjectDashboard> = {}): UiSafeProjectDashboard {
  return {
    projectId: id,
    title: `Project ${id}`,
    status: "in-progress",
    progress: { completedCount: 2, totalCount: 5, percentComplete: 40 },
    blockers: [],
    waitingItems: [],
    nextActions: [],
    evidenceRefs: [],
    docPack: [],
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...over,
  };
}

describe("Projects page (§4.5 / §9.5) — render behavior", () => {
  it("WS-8: under GLOBAL scope shows the pick-a-workspace state, never project data", () => {
    render(<Projects scope="global" projects={[proj("a")]} selectedProjectId={undefined} onSelectProject={() => {}} />);
    expect(screen.getByText(/select a workspace/i)).toBeTruthy();
    expect(screen.queryByText("Project a")).toBeNull(); // no cross-workspace project blend
  });

  it("a workspace with no projects shows the empty-until-data state (distinct from the Global state)", () => {
    render(<Projects scope="employer-work" projects={[]} selectedProjectId={undefined} onSelectProject={() => {}} />);
    expect(screen.getByText(/no projects in this workspace/i)).toBeTruthy();
    expect(screen.queryByText(/select a workspace/i)).toBeNull();
  });

  it("renders a list + detail; clicking a list row calls onSelectProject(id)", () => {
    const onSelectProject = vi.fn();
    render(<Projects scope="employer-work" projects={[proj("a"), proj("b")]} selectedProjectId="b" onSelectProject={onSelectProject} />);
    fireEvent.click(screen.getByText("Project a")); // "Project a" only in the list (b is the selected detail)
    expect(onSelectProject).toHaveBeenCalledWith("a");
  });

  it("REQ-F-011: the progress bar width is the SERVER percent (no UI computation)", () => {
    const { container } = render(
      <Projects
        scope="employer-work"
        projects={[proj("a", { progress: { completedCount: 3, totalCount: 4, percentComplete: 75 } })]}
        selectedProjectId="a"
        onSelectProject={() => {}}
      />,
    );
    const bars = [...container.querySelectorAll<HTMLElement>(".sow-project-bar")];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((b) => b.style.width === "75%")).toBe(true); // exactly the server value
  });

  it("shows the §4.5 managed doc pack — all 5 slots, every re-add DISABLED (no Drive connector)", () => {
    render(<Projects scope="employer-work" projects={[proj("a")]} selectedProjectId="a" onSelectProject={() => {}} />);
    expect(screen.getByText("00 Brief")).toBeTruthy();
    expect(screen.getByText("04 Open Questions")).toBeTruthy();
    const readd = screen.getAllByRole("button", { name: "Re-add" });
    expect(readd).toHaveLength(5);
    expect(readd.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
