// @vitest-environment jsdom
// spec(§11) — task 9-a11y: the two desktop role="listbox" surfaces (Projects + ScopeSwitcher)
// use the roving-tabindex ARIA-APG pattern (one active option tabIndex=0, rest -1; Up/Down/Home/End
// move roving focus with no wrap; Enter/Space selects; a single tab stop) via a shared
// useRovingListbox hook. These render tests pin the roving behavior for BOTH listboxes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Projects } from "../renderer/surfaces/projects/Projects";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";
import type { UiSafeProjectDashboard } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

function proj(id: string): UiSafeProjectDashboard {
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
  };
}

const options = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const tabIndexOf = (el: HTMLElement | undefined): number => Number(el?.getAttribute("tabindex"));
const zeroCount = (opts: HTMLElement[]): number => opts.filter((o) => tabIndexOf(o) === 0).length;

// ── Projects listbox (always-rendered; selected = "b" @ index 1 of [a,b,c]) ─────────
describe("Projects listbox — roving tabindex (§11 a11y)", () => {
  const renderProjects = (): { onSelectProject: ReturnType<typeof vi.fn> } => {
    const onSelectProject = vi.fn();
    render(
      <Projects
        scope="employer-work"
        projects={[proj("a"), proj("b"), proj("c")]}
        selectedProjectId="b"
        onSelectProject={onSelectProject}
      />,
    );
    return { onSelectProject };
  };

  it("roving_tabindex_exactly_one_zero — exactly one option tabIndex=0 (the selected), rest -1 — spec(§11)", () => {
    renderProjects();
    const opts = options();
    expect(opts).toHaveLength(3);
    expect(zeroCount(opts)).toBe(1);
    expect(tabIndexOf(opts[1])).toBe(0); // selected "b"
    expect(tabIndexOf(opts[0])).toBe(-1);
    expect(tabIndexOf(opts[2])).toBe(-1);
  });

  it("listbox_single_tab_stop — only one option is in the tab order — spec(§11)", () => {
    renderProjects();
    expect(zeroCount(options())).toBe(1);
  });

  it("arrow_down_up_moves_active_and_focus — ArrowDown/Up move tabIndex=0 + activeElement — spec(§11)", () => {
    renderProjects();
    fireEvent.keyDown(options()[1]!, { key: "ArrowDown" });
    expect(tabIndexOf(options()[2])).toBe(0);
    expect(document.activeElement).toBe(options()[2]);
    fireEvent.keyDown(options()[2]!, { key: "ArrowUp" });
    expect(tabIndexOf(options()[1])).toBe(0);
    expect(document.activeElement).toBe(options()[1]);
  });

  it("home_end_jump_first_last — Home→first, End→last — spec(§11)", () => {
    renderProjects();
    fireEvent.keyDown(options()[1]!, { key: "End" });
    expect(tabIndexOf(options()[2])).toBe(0);
    expect(document.activeElement).toBe(options()[2]);
    fireEvent.keyDown(options()[2]!, { key: "Home" });
    expect(tabIndexOf(options()[0])).toBe(0);
    expect(document.activeElement).toBe(options()[0]);
  });

  it("no_wraparound_at_ends — ArrowDown on last / ArrowUp on first is a no-op — spec(§11)", () => {
    renderProjects();
    fireEvent.keyDown(options()[1]!, { key: "End" }); // → last (2)
    fireEvent.keyDown(options()[2]!, { key: "ArrowDown" }); // no wrap
    expect(tabIndexOf(options()[2])).toBe(0);
    fireEvent.keyDown(options()[2]!, { key: "Home" }); // → first (0)
    fireEvent.keyDown(options()[0]!, { key: "ArrowUp" }); // no wrap
    expect(tabIndexOf(options()[0])).toBe(0);
  });

  it("enter_space_selects_active — Enter/Space on the active option opens it (onSelectProject) — spec(§11)", () => {
    const { onSelectProject } = renderProjects();
    fireEvent.keyDown(options()[1]!, { key: "ArrowDown" }); // active → "c" (2)
    fireEvent.keyDown(options()[2]!, { key: "Enter" });
    expect(onSelectProject).toHaveBeenCalledWith("c");
    fireEvent.keyDown(options()[2]!, { key: " " });
    expect(onSelectProject).toHaveBeenLastCalledWith("c");
  });

  it("arrows_browse_without_selecting — Arrow/Home/End move focus but NEVER fire onSelectProject (explicit selection) — spec(§11)", () => {
    const { onSelectProject } = renderProjects();
    fireEvent.keyDown(options()[1]!, { key: "ArrowDown" });
    fireEvent.keyDown(options()[2]!, { key: "ArrowUp" });
    fireEvent.keyDown(options()[1]!, { key: "Home" });
    fireEvent.keyDown(options()[0]!, { key: "End" });
    expect(onSelectProject).not.toHaveBeenCalled();
  });

  it("count_shrink_keeps_single_tab_stop — dropping options below a browsed active index still leaves exactly one tabIndex=0 (never zero) — spec(§11)", () => {
    const onSelectProject = vi.fn();
    const { rerender } = render(
      <Projects scope="employer-work" projects={[proj("a"), proj("b"), proj("c")]} selectedProjectId="a" onSelectProject={onSelectProject} />,
    );
    fireEvent.keyDown(options()[0]!, { key: "End" }); // browse active → index 2 ("c")
    expect(zeroCount(options())).toBe(1);
    // A live projection drops to 2 projects; the browsed active (2) is now out of range, and the
    // selection ("a") is unchanged so the reset effect does NOT fire — the clamp must save the tab stop.
    rerender(
      <Projects scope="employer-work" projects={[proj("a"), proj("b")]} selectedProjectId="a" onSelectProject={onSelectProject} />,
    );
    const opts = options();
    expect(opts).toHaveLength(2);
    expect(zeroCount(opts)).toBe(1);
  });
});

// ── ScopeSwitcher popup listbox (selected = "global" @ index 0 of 4 scopes) ──────────
describe("ScopeSwitcher listbox — roving tabindex (§11 a11y)", () => {
  const base: Omit<AppShellProps, "children"> = {
    connection: "live",
    scope: "global",
    onScopeChange: () => {},
    route: { surface: "today" },
    onNavigate: () => {},
    copilotWorkspaceScoped: false,
  };
  const openSwitcher = (): { onScopeChange: ReturnType<typeof vi.fn> } => {
    const onScopeChange = vi.fn();
    render(
      <AppShell {...base} onScopeChange={onScopeChange}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: /workspace scope/i }));
    return { onScopeChange };
  };

  it("roving_tabindex_exactly_one_zero — exactly one scope option tabIndex=0 (the selected), rest -1 — spec(§11)", () => {
    openSwitcher();
    const opts = options();
    expect(opts).toHaveLength(4);
    expect(zeroCount(opts)).toBe(1);
    expect(tabIndexOf(opts[0])).toBe(0); // "global" selected
    expect(tabIndexOf(opts[1])).toBe(-1);
  });

  it("listbox_single_tab_stop — only one scope option is in the tab order — spec(§11)", () => {
    openSwitcher();
    expect(zeroCount(options())).toBe(1);
  });

  it("arrow_down_up_moves_active_and_focus — ArrowDown/Up move tabIndex=0 + activeElement — spec(§11)", () => {
    openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "ArrowDown" });
    expect(tabIndexOf(options()[1])).toBe(0);
    expect(document.activeElement).toBe(options()[1]);
    fireEvent.keyDown(options()[1]!, { key: "ArrowUp" });
    expect(tabIndexOf(options()[0])).toBe(0);
    expect(document.activeElement).toBe(options()[0]);
  });

  it("home_end_jump_first_last — Home→first, End→last — spec(§11)", () => {
    openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "End" });
    expect(tabIndexOf(options()[3])).toBe(0);
    fireEvent.keyDown(options()[3]!, { key: "Home" });
    expect(tabIndexOf(options()[0])).toBe(0);
  });

  it("no_wraparound_at_ends — ArrowUp on first / ArrowDown on last is a no-op — spec(§11)", () => {
    openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "ArrowUp" }); // no wrap at first
    expect(tabIndexOf(options()[0])).toBe(0);
    fireEvent.keyDown(options()[0]!, { key: "End" }); // → last (3)
    fireEvent.keyDown(options()[3]!, { key: "ArrowDown" }); // no wrap at last
    expect(tabIndexOf(options()[3])).toBe(0);
  });

  it("enter_selects_active_scope — Enter on the active option calls onScopeChange — spec(§11)", () => {
    const { onScopeChange } = openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "ArrowDown" }); // active → employer-work (1)
    fireEvent.keyDown(options()[1]!, { key: "Enter" });
    expect(onScopeChange).toHaveBeenCalledWith("employer-work");
  });

  it("space_selects_active_scope — Space on the active option calls onScopeChange — spec(§11)", () => {
    const { onScopeChange } = openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(options()[1]!, { key: " " });
    expect(onScopeChange).toHaveBeenCalledWith("employer-work");
  });

  it("arrows_browse_without_selecting_scope — Arrow/Home/End do NOT fire onScopeChange (explicit selection) — spec(§11)", () => {
    const { onScopeChange } = openSwitcher();
    fireEvent.keyDown(options()[0]!, { key: "ArrowDown" });
    fireEvent.keyDown(options()[1]!, { key: "End" });
    fireEvent.keyDown(options()[3]!, { key: "Home" });
    expect(onScopeChange).not.toHaveBeenCalled();
  });
});
