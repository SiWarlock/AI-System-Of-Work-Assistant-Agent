// @vitest-environment jsdom
//
// Task 14.7 (desktop leg) — the cross-workspace-links surface: the rule-4 owner-approval surface.
// Pins: create submits ONLY the whitelisted fields (no status/approvedAt smuggling) + lands pending;
// approve is a DELIBERATE per-link action showing the full (from→to, scope); revoke is terminal;
// renders only UI-safe fields; WS-8 selectors offer only registered workspaces + self-link disabled;
// typed failures → safe error state.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CrossWorkspaceLinks, type CrossWorkspaceLinksProps } from "../renderer/surfaces/cross-workspace-links";
import type { UiSafeCrossWorkspaceLinkView } from "../renderer/store/cross-workspace-links";

afterEach(cleanup);

const WORKSPACES = [
  { id: "ws_a", label: "Acme" },
  { id: "ws_b", label: "Beta" },
];

const linkView = (over: Partial<UiSafeCrossWorkspaceLinkView> = {}): UiSafeCrossWorkspaceLinkView => ({
  linkId: "ws_a~ws_b~calendar_busy~coordination",
  fromWorkspaceId: "ws_a",
  toWorkspaceId: "ws_b",
  scopeProjectionType: "calendar_busy",
  scopeVisibilityLevel: "coordination",
  status: "pending",
  createdAt: "2026-07-15T00:00:00.000Z",
  approvedAt: null,
  revokedAt: null,
  ...over,
});

function renderLinks(over: Partial<CrossWorkspaceLinksProps> = {}): CrossWorkspaceLinksProps {
  const props: CrossWorkspaceLinksProps = {
    workspaces: WORKSPACES,
    defaultFrom: "ws_a",
    links: [],
    onCreate: vi.fn().mockResolvedValue({ ok: true, link: linkView() }),
    onApprove: vi.fn().mockResolvedValue({ ok: true, link: linkView({ status: "approved" }) }),
    onRevoke: vi.fn().mockResolvedValue({ ok: true, link: linkView({ status: "revoked" }) }),
    ...over,
  };
  render(<CrossWorkspaceLinks {...props} />);
  return props;
}

describe("Cross-workspace links surface", () => {
  it("create submits ONLY the whitelisted fields (no status/approvedAt) with a minted linkId", async () => {
    const props = renderLinks();
    fireEvent.change(screen.getByRole("combobox", { name: /to workspace/i }), { target: { value: "ws_b" } });
    fireEvent.click(screen.getByRole("button", { name: /create link/i }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(1));
    const sent = (props.onCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.fromWorkspaceId).toBe("ws_a");
    expect(sent.toWorkspaceId).toBe("ws_b");
    expect(sent.scopeProjectionType).toBe("calendar_busy");
    expect(sent.scopeVisibilityLevel).toBe("coordination");
    expect(typeof sent.linkId).toBe("string");
    expect((sent.linkId as string).length).toBeGreaterThan(0);
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("approvedAt");
  });

  it("approve is a deliberate per-link action showing the full (from→to, scope) + calls onApprove", async () => {
    const props = renderLinks({ links: [linkView()] }); // one PENDING link
    // The row shows the direction + scope so the owner sees exactly what they authorize.
    expect(screen.getByText(/Acme → Beta/)).toBeTruthy();
    expect(screen.getByText(/calendar_busy \/ coordination/)).toBeTruthy();
    const approveBtn = screen.getByRole("button", { name: /approve cross-workspace link from Acme to Beta scoped calendar_busy coordination/i });
    fireEvent.click(approveBtn);
    await waitFor(() => expect(props.onApprove).toHaveBeenCalledWith("ws_a~ws_b~calendar_busy~coordination"));
  });

  it("an APPROVED link shows approved + offers no re-approve (only revoke)", () => {
    renderLinks({ links: [linkView({ status: "approved", approvedAt: "2026-07-15T01:00:00.000Z" })] });
    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^approve/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^revoke/i })).toBeTruthy();
  });

  it("revoke calls onRevoke; a REVOKED link is terminal (no approve, no revoke)", async () => {
    const props = renderLinks({ links: [linkView()] }); // pending → has a revoke button
    fireEvent.click(screen.getByRole("button", { name: /revoke cross-workspace link from Acme to Beta/i }));
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledWith("ws_a~ws_b~calendar_busy~coordination"));
    cleanup();
    renderLinks({ links: [linkView({ status: "revoked", revokedAt: "2026-07-15T02:00:00.000Z" })] });
    expect(screen.getByText("revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("renders ONLY UI-safe link fields — a smuggled raw field on a link is never surfaced", () => {
    const tainted = { ...linkView(), rawContent: "secret cross-workspace bytes", auditRef: "aud_leak" } as unknown as UiSafeCrossWorkspaceLinkView;
    renderLinks({ links: [tainted] });
    expect(screen.queryByText(/secret cross-workspace bytes/i)).toBeNull();
    expect(screen.queryByText(/aud_leak/i)).toBeNull();
  });

  it("from/to selectors offer ONLY registered workspaces; a self-link (from===to) disables Create (WS-8)", () => {
    renderLinks();
    const toSelect = screen.getByRole("combobox", { name: /to workspace/i });
    const optionValues = [...toSelect.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value).filter((v) => v !== "");
    expect(optionValues.sort()).toEqual(["ws_a", "ws_b"]); // only the registered set — no free-form id
    // Selecting to === from (self-link) disables Create.
    fireEvent.change(toSelect, { target: { value: "ws_a" } });
    expect((screen.getByRole("button", { name: /create link/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("fewer than two workspaces → the create form is gated out (needs two distinct workspaces)", () => {
    renderLinks({ workspaces: [{ id: "ws_a", label: "Acme" }], defaultFrom: "ws_a" });
    expect(screen.getByText(/onboard at least two workspaces/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create link/i })).toBeNull();
  });

  it("a double-click on Approve fires onApprove ONCE (in-flight guard — no spurious error on success)", async () => {
    let resolveApprove!: (v: { ok: true; link: UiSafeCrossWorkspaceLinkView }) => void;
    const onApprove = vi.fn(() => new Promise<{ ok: true; link: UiSafeCrossWorkspaceLinkView }>((res) => (resolveApprove = res)));
    renderLinks({ links: [linkView()], onApprove });
    const btn = screen.getByRole("button", { name: /approve cross-workspace link/i });
    fireEvent.click(btn);
    fireEvent.click(btn); // second click while the first is in flight — must be ignored
    resolveApprove({ ok: true, link: linkView({ status: "approved" }) });
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull(); // no spurious "couldn't approve" on success
  });

  it("styling structure: Approve/Revoke carry distinct button variants + the status renders as a pill", () => {
    renderLinks({ links: [linkView()] }); // one PENDING link
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /approve cross-workspace link/i }).className).toMatch(/sow-btn--approve/);
    expect(screen.getByRole("button", { name: /revoke cross-workspace link/i }).className).toMatch(/sow-btn--reject/);
    expect(document.querySelector(".sow-pill--link-pending")).not.toBeNull();
  });

  it("a typed failure surfaces a SAFE error state (role=alert), never a raw cause", async () => {
    renderLinks({ onCreate: vi.fn().mockResolvedValue({ ok: false }) });
    fireEvent.change(screen.getByRole("combobox", { name: /to workspace/i }), { target: { value: "ws_b" } });
    fireEvent.click(screen.getByRole("button", { name: /create link/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't create the link/i);
  });
});
