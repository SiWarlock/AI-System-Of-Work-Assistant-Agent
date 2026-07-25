// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RepoActions } from "../renderer/surfaces/projects/RepoActions";

// 9.12r — the renderer open/reveal-in-vault affordance (Option A: identifier-based). The component is a
// PURE, path-BLIND prop-render: it passes a CLOSED target ("workspace" | "global") to injected callbacks,
// never a filesystem path (main resolves the path). No electron/node/window import (§5 renderer isolation).

afterEach(cleanup);

describe("RepoActions — repo open/reveal affordance (path-blind, closed target only)", () => {
  it("open_affordance_invokes_with_workspace_target: Open/Reveal call the callbacks with 'workspace'", () => {
    // spec(§11/REQ-UX-003) — open-by-target via the bridge; the renderer never supplies a path.
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(<RepoActions workspaceRepoAvailable onOpen={onOpen} onReveal={onReveal} />);

    fireEvent.click(screen.getByRole("button", { name: /open workspace repo/i }));
    expect(onOpen).toHaveBeenCalledWith("workspace");

    fireEvent.click(screen.getByRole("button", { name: /reveal workspace repo/i }));
    expect(onReveal).toHaveBeenCalledWith("workspace");
  });

  it("global_coordination_actions_use_global_target_and_are_always_enabled", () => {
    // spec(§11) — the Global/Coordination repo entry is always available (it exists once the app is set up).
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(<RepoActions workspaceRepoAvailable={false} onOpen={onOpen} onReveal={onReveal} />);

    const openGlobal = screen.getByRole("button", { name: /open coordination repo/i });
    expect((openGlobal as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openGlobal);
    expect(onOpen).toHaveBeenCalledWith("global");

    fireEvent.click(screen.getByRole("button", { name: /reveal coordination repo/i }));
    expect(onReveal).toHaveBeenCalledWith("global");
  });

  it("no_configured_workspace_disables_the_workspace_affordance: no unconfigured repo is offered", () => {
    // spec(§5/REQ-UX-003) — a repo without an onboarded workspace shows a DISABLED action (no arbitrary open).
    const onOpen = vi.fn();
    render(<RepoActions workspaceRepoAvailable={false} onOpen={onOpen} onReveal={vi.fn()} />);

    const openWs = screen.getByRole("button", { name: /open workspace repo/i });
    expect((openWs as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(openWs);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("passes_only_a_closed_target_literal_never_a_path", () => {
    // spec(§5) — the renderer only ever emits a member of the closed union, never a filesystem path.
    const onOpen = vi.fn();
    const onReveal = vi.fn();
    render(<RepoActions workspaceRepoAvailable onOpen={onOpen} onReveal={onReveal} />);
    fireEvent.click(screen.getByRole("button", { name: /open workspace repo/i }));
    fireEvent.click(screen.getByRole("button", { name: /open coordination repo/i }));
    for (const call of [...onOpen.mock.calls]) {
      expect(["workspace", "global"]).toContain(call[0]);
    }
  });
});
