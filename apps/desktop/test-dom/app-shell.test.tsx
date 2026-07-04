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

// §4.6 Copilot is the persistent RIGHT SIDEBAR (locked design: "collapsible to a thin rail,
// expandable to a full-screen conversation — NOT a separate nav page"). AppShell owns the
// collapsed⇄expanded chrome state (like the scope switcher's local open state) — orthogonal to
// BOTH route and scope.
describe("AppShell — Copilot right sidebar expand/collapse (§4.6)", () => {
  it("is collapsed by default — the thin rail shows, the expanded panel does not", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.getByRole("complementary", { name: "Copilot (collapsed)" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Copilot" })).toBeNull();
  });

  it("clicking Expand opens the panel and hides the collapsed rail", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
    expect(screen.getByRole("complementary", { name: "Copilot" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Copilot (collapsed)" })).toBeNull();
  });

  it("clicking Collapse from the open panel returns to the thin rail", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Copilot sidebar" }));
    expect(screen.getByRole("complementary", { name: "Copilot (collapsed)" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Copilot" })).toBeNull();
  });

  it("expanding the Copilot sidebar never changes scope or route (chrome state is orthogonal)", () => {
    const onScopeChange = vi.fn();
    const onNavigate = vi.fn();
    render(
      <AppShell {...base} onScopeChange={onScopeChange} onNavigate={onNavigate}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
    expect(onScopeChange).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  // Disclosure focus management: toggling is a subtree swap, so keyboard focus must FOLLOW the
  // disclosure (into the panel on open, back to the trigger on close) rather than dropping to body.
  it("moves focus into the panel on expand and back to the rail's Expand chevron on collapse", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
    // Focus followed into the panel (its Collapse control), not <body>.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse Copilot sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Copilot sidebar" }));
    // Focus returned to the trigger, not <body>.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
  });

  it("does not steal focus to the rail on initial mount (no user interaction yet)", () => {
    render(
      <AppShell {...base}>
        <div>content</div>
      </AppShell>,
    );
    // Nothing was toggled — the Expand chevron must NOT have grabbed focus.
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Expand Copilot sidebar" }));
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
