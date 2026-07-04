// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";

afterEach(cleanup);

const base: Omit<AppShellProps, "children"> = {
  connection: "live",
  scope: "global",
  onScopeChange: () => {},
  route: { surface: "today" },
  onNavigate: () => {},
};

describe("AppShell — left-rail routing (§9.5, the R2 nav wiring)", () => {
  it("marks the route's surface active in the left rail (aria-current)", () => {
    render(
      <AppShell {...base} route={{ surface: "projects" }}>
        <div>content</div>
      </AppShell>,
    );
    const projects = screen.getByText("Projects").closest(".sow-nav-item");
    const today = screen.getByText("Today").closest(".sow-nav-item");
    expect(projects?.getAttribute("aria-current")).toBe("page");
    expect(today?.getAttribute("aria-current")).toBeNull();
  });

  it("clicking the Projects nav calls onNavigate({surface:'projects'}) — scope-preserving (no scope arg)", () => {
    const onNavigate = vi.fn();
    render(
      <AppShell {...base} onNavigate={onNavigate}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByText("Projects"));
    expect(onNavigate).toHaveBeenCalledWith({ surface: "projects" });
  });

  it("Enter AND Space on a nav item navigate (keyboard parity with the scope switcher pattern)", () => {
    const onNavigate = vi.fn();
    render(
      <AppShell {...base} route={{ surface: "projects" }} onNavigate={onNavigate}>
        <div>content</div>
      </AppShell>,
    );
    const today = screen.getByText("Today").closest(".sow-nav-item") as HTMLElement;
    fireEvent.keyDown(today, { key: "Enter" });
    fireEvent.keyDown(today, { key: " " });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith({ surface: "today" });
  });

  it("navigation is scope-preserving — clicking a nav item NEVER calls onScopeChange (route ≠ scope)", () => {
    const onScopeChange = vi.fn();
    render(
      <AppShell {...base} onScopeChange={onScopeChange} onNavigate={() => {}}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByText("Projects"));
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("renders the active surface as children", () => {
    render(
      <AppShell {...base}>
        <main>ACTIVE-SURFACE-BODY</main>
      </AppShell>,
    );
    expect(screen.getByText("ACTIVE-SURFACE-BODY")).toBeTruthy();
  });
});

// The §9.4 scope switcher was moved VERBATIM from the prior Today shell into AppShell in R2
// (security-reviewed). These render tests pin its dismissal behavior so the "extraction changes
// structure, not behavior" claim is verified, not just asserted.
describe("AppShell — §9.4 scope switcher (moved verbatim in R2)", () => {
  const open = (): HTMLElement => {
    const btn = screen.getByRole("button", { name: /workspace scope/i });
    fireEvent.click(btn);
    return btn;
  };

  it("opens the listbox and selecting an option calls onScopeChange + closes it", () => {
    const onScopeChange = vi.fn();
    render(
      <AppShell {...base} onScopeChange={onScopeChange}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByRole("listbox")).toBeNull(); // closed initially
    open();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Employer-Work/i }));
    expect(onScopeChange).toHaveBeenCalledWith("employer-work");
    expect(screen.queryByRole("listbox")).toBeNull(); // closed on selection
  });

  it("Escape closes the open listbox", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    const btn = open();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(btn.closest(".sow-ws-switch-wrap") as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("an outside mousedown closes the open listbox (the dismissal the ARIA listbox otherwise lacks)", () => {
    render(
      <AppShell {...base}>
        <div>outside-target</div>
      </AppShell>,
    );
    open();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("outside-target"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
