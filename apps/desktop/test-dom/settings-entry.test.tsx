// @vitest-environment jsdom
//
// The Settings entry points — owner report 2026-09-21: "the dark mode toggle looks weird and doesn't
// work". It was not a dark-mode toggle. It was the toolbar SETTINGS gear, drawn with a circle and
// eight rays that reads as a sun, and it had NO click handler. The sidebar "Settings" row was dead
// too: a focusable `role="link"` with nothing behind it. And there was no Settings screen for either
// to open. Its hint line also advertised "Models · Audit · Workspaces", none of which exist.
//
// These pins cover what the owner chose ("just fix the button"): both entry points open a real
// Settings page, the page links only to settings screens that exist, and the hint stops promising
// sections that do not.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";
import { Settings } from "../renderer/surfaces/settings";

afterEach(cleanup);

const base: Omit<AppShellProps, "children"> = {
  connection: "live",
  scope: "global",
  onScopeChange: () => {},
  route: { surface: "today" },
  onNavigate: () => {},
  copilotWorkspaceScoped: false,
};

describe("Settings entry points in the shell", () => {
  it("⛔ the toolbar gear OPENS Settings (it used to do nothing)", () => {
    const onNavigate = vi.fn();
    render(<AppShell {...base} onNavigate={onNavigate}><div /></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onNavigate).toHaveBeenCalledWith({ surface: "settings" });
  });

  it("⛔ the sidebar Settings row OPENS Settings, by click and by keyboard", () => {
    const onNavigate = vi.fn();
    render(<AppShell {...base} onNavigate={onNavigate}><div /></AppShell>);
    const row = screen.getByRole("link", { name: /settings/i });
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith({ surface: "settings" });
  });

  it("the sidebar row is marked current while Settings is open", () => {
    render(<AppShell {...base} route={{ surface: "settings" }}><div /></AppShell>);
    expect(screen.getByRole("link", { name: /settings/i }).getAttribute("aria-current")).toBe("page");
  });

  it("the hint line lists only sections that exist — no Models, Audit or Workspaces", () => {
    render(<AppShell {...base}><div /></AppShell>);
    const hint = screen.getByLabelText("Settings sections").textContent ?? "";
    expect(hint).not.toMatch(/Models|Audit|Workspaces/);
    // Positive control: the hint is still there and names the real sections.
    expect(hint).toMatch(/Connectors/);
    expect(hint).toMatch(/Egress/);
  });
});

describe("Settings page", () => {
  it("links to the settings screens that exist, and each one navigates", () => {
    const onNavigate = vi.fn();
    render(<Settings onNavigate={onNavigate} />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /connectors/i }));
    expect(onNavigate).toHaveBeenLastCalledWith({ surface: "connectors" });
    fireEvent.click(screen.getByRole("button", { name: /egress/i }));
    expect(onNavigate).toHaveBeenLastCalledWith({ surface: "workspace-settings" });
  });

  it("offers nothing that is not built — every row leads somewhere real", () => {
    render(<Settings onNavigate={() => {}} />);
    const rows = screen.getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/Models|Audit/);
  });
});
