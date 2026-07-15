// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";

afterEach(cleanup);

const base: Omit<AppShellProps, "children"> = {
  connection: "live",
  scope: "global",
  onScopeChange: () => {},
  route: { surface: "today" },
  onNavigate: () => {},
  copilotWorkspaceScoped: false,
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

  it("Approvals is a routable nav item (§9.8) — clicking navigates, and it marks active on route", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(
      <AppShell {...base} onNavigate={onNavigate}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByText("Approvals"));
    expect(onNavigate).toHaveBeenCalledWith({ surface: "approvals" });
    // aria-current follows the route.
    rerender(
      <AppShell {...base} route={{ surface: "approvals" }} onNavigate={onNavigate}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.getByText("Approvals").closest(".sow-nav-item")?.getAttribute("aria-current")).toBe("page");
  });

  it("the Approvals nav badge reflects the pending count — shown when > 0, absent when 0 (§9.8)", () => {
    const { rerender } = render(
      <AppShell {...base} pendingApprovalCount={4}>
        <div>content</div>
      </AppShell>,
    );
    const nav = screen.getByText("Approvals").closest(".sow-nav-item") as HTMLElement;
    expect(within(nav).getByText("4")).toBeTruthy();
    // 0 → no badge pill (an empty inbox shows no count).
    rerender(
      <AppShell {...base} pendingApprovalCount={0}>
        <div>content</div>
      </AppShell>,
    );
    const nav0 = screen.getByText("Approvals").closest(".sow-nav-item") as HTMLElement;
    expect(within(nav0).queryByText("0")).toBeNull();
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

// The §11 a11y fast-follow (slice 1 deferred it): the ScopeSwitcher popup completes its keyboard
// loop — focus-on-open onto the selected option, return-focus-to-button on a KEYBOARD close (Escape
// / selection, NOT outside-click / tab-away), and reset-to-selected on reopen. ADDITIVE over the
// security-reviewed dismissals (AppShell.tsx:45-46) — the regression test below pins they still fire.
describe("AppShell — §9.4 scope switcher popup keyboard loop (§11 a11y fast-follow)", () => {
  // A non-first selected scope (Employer-Work @ index 1) so reset-on-reopen is distinguishable from index 0.
  const renderShell = (over: Partial<AppShellProps> = {}): void => {
    render(
      <AppShell {...base} scope="employer-work" {...over}>
        <div>outside-target</div>
      </AppShell>,
    );
  };
  const button = (): HTMLElement => screen.getByRole("button", { name: /workspace scope/i });
  const wrap = (): HTMLElement => button().closest(".sow-ws-switch-wrap") as HTMLElement;
  const openMenu = (): void => {
    fireEvent.click(button());
  };

  it("focus_moves_into_listbox_on_open — focus lands on the selected option (§11 focus-on-open)", () => {
    renderShell();
    openMenu();
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.textContent).toMatch(/Employer-Work/);
    expect(document.activeElement).toBe(selected);
  });

  it("escape_returns_focus_to_button — Escape closes + focus returns to the trigger (§11 keyboard loop)", () => {
    renderShell();
    openMenu();
    fireEvent.keyDown(wrap(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("select_returns_focus_to_button — activating an option closes + focus returns to the trigger", () => {
    const onScopeChange = vi.fn();
    renderShell({ onScopeChange });
    openMenu();
    // Enter on the active (selected) option selects it and closes the popup.
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onScopeChange).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("outside_click_does_not_return_focus — an outside-click dismissal does NOT yank focus back (dismissal preserved)", () => {
    renderShell();
    openMenu();
    fireEvent.mouseDown(screen.getByText("outside-target"));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Focus follows the user's action — it is NOT forced back to the trigger.
    expect(document.activeElement).not.toBe(button());
  });

  it("escape_while_closed_does_not_arm_return_focus — a closed-popup Escape can't later yank focus on an outside-click", () => {
    // Flag-lifecycle guard: Escape on the always-mounted wrap fires even when the popup is CLOSED
    // (focus resting on the trigger, which is inside the wrap). It must NOT arm return-focus — else the
    // NEXT outside-click close would wrongly pull focus back to the button (breaking the no-return invariant).
    renderShell();
    button().focus(); // focus on the trigger, popup closed
    fireEvent.keyDown(wrap(), { key: "Escape" }); // Escape while closed
    openMenu();
    fireEvent.mouseDown(screen.getByText("outside-target")); // dismiss via outside-click
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).not.toBe(button());
  });

  it("reopen_resets_active_to_selected — arrowing then reopening starts back on the selected scope (reset-on-open)", () => {
    renderShell();
    openMenu();
    // Browse away from the selected option (index 1 → 2).
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).textContent).toMatch(/Personal-Business/);
    // Close (keyboard) then reopen — the roving position must reset to the selected scope.
    fireEvent.keyDown(wrap(), { key: "Escape" });
    openMenu();
    const selected = screen.getByRole("option", { selected: true });
    expect(selected.textContent).toMatch(/Employer-Work/);
    expect(document.activeElement).toBe(selected);
  });

  it("existing_dismissals_still_work — outside-click, Escape, and tab-away each still close (additive-only regression guard)", () => {
    renderShell();
    // outside-click
    openMenu();
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("outside-target"));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Escape
    openMenu();
    fireEvent.keyDown(wrap(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    // tab-away (focus leaves the switcher entirely)
    openMenu();
    fireEvent.blur(wrap(), { relatedTarget: document.body });
    expect(screen.queryByRole("listbox")).toBeNull();
    // …and tab-away is a NO-return path (acceptance #2, like outside-click): focus is NOT forced
    // back to the trigger — a future refactor can't accidentally make tab-away return focus.
    expect(document.activeElement).not.toBe(button());
  });
});
