// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { Approvals } from "../renderer/surfaces/approvals/Approvals";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

function apr(id: string, over: Partial<UiSafeApproval> = {}): UiSafeApproval {
  return { id, actionRef: `action:${id}`, status: "pending", channel: "mac", ...over };
}

describe("Approvals surface (§9.8) — render behavior", () => {
  it("empty inbox shows the 'No pending approvals' state", () => {
    render(<Approvals approvals={[]} onDecide={() => Promise.resolve("applied" as const)} />);
    expect(screen.getByText(/no pending approvals/i)).toBeTruthy();
  });

  it("renders a pending card per pending approval with Approve / Reject / Defer", () => {
    render(<Approvals approvals={[apr("a1"), apr("a2")]} onDecide={() => Promise.resolve("applied" as const)} />);
    expect(screen.getByText("action:a1")).toBeTruthy();
    expect(screen.getByText("action:a2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Defer" })).toHaveLength(2);
  });

  it("clicking a decision button calls onDecide(id, decision)", () => {
    const onDecide = vi.fn(() => Promise.resolve("applied" as const));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Defer" }));
    expect(onDecide).toHaveBeenCalledWith("a1", "defer");
  });

  it("buttons are DISABLED when there is no live worker (onDecide absent)", () => {
    render(<Approvals approvals={[apr("a1")]} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("a DEFERRED item is display-only (snoozed section, NO action buttons) — only pending->… is legal", () => {
    render(
      <Approvals
        approvals={[apr("d1", { status: "deferred", snoozeUntil: "2026-07-08T09:00:00.000Z" })]}
        onDecide={() => Promise.resolve("applied" as const)}
      />,
    );
    // It shows under the snoozed section with its re-surface date, but offers NO decision buttons.
    expect(screen.getByText("action:d1")).toBeTruthy();
    expect(screen.getByText(/re-surfaces 2026-07-08/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("terminal items (approved/rejected/expired/edited) do NOT appear in the inbox", () => {
    render(
      <Approvals
        approvals={[
          apr("t1", { status: "approved" }),
          apr("t2", { status: "rejected" }),
          apr("t3", { status: "expired" }),
          apr("t4", { status: "edited" }),
        ]}
        onDecide={() => Promise.resolve("applied" as const)}
      />,
    );
    expect(screen.getByText(/no pending approvals/i)).toBeTruthy();
    expect(screen.queryByText("action:t1")).toBeNull();
    expect(screen.queryByText("action:t3")).toBeNull();
  });

  it("a pending card shows its channel + expiry date", () => {
    render(<Approvals approvals={[apr("a1", { expiresAt: "2026-07-10T09:00:00.000Z" })]} onDecide={() => Promise.resolve("applied" as const)} />);
    expect(screen.getByText(/via mac/i)).toBeTruthy();
    expect(screen.getByText(/expires 2026-07-10/i)).toBeTruthy();
  });
});

describe("Approvals surface (§9.8) — already-resolved vs unavailable decision outcome", () => {
  it("an ok result with applied:false renders 'already resolved' as a role=status line", async () => {
    const onDecide = vi.fn(() => Promise.resolve<"applied" | "already_resolved" | "unavailable">("already_resolved"));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    // `role="status"` does not derive its accessible NAME from its content (name-from-contents
    // does not apply to that role) — query by role, then assert the text separately.
    const line = await within(card).findByRole("status");
    expect(line.textContent).toMatch(/already resolved/i);
  });

  it("a write_conflict err ALSO renders the same 'already resolved' status line (same outcome, both wire shapes)", async () => {
    const onDecide = vi.fn(() => Promise.resolve<"applied" | "already_resolved" | "unavailable">("already_resolved"));
    render(<Approvals approvals={[apr("a2")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a2").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    const line = await within(card).findByRole("status");
    expect(line.textContent).toMatch(/already resolved/i);
  });

  it("an 'unavailable' outcome renders a distinct 'Couldn't decide — try again' line, not 'already resolved'", async () => {
    const onDecide = vi.fn(() => Promise.resolve<"applied" | "already_resolved" | "unavailable">("unavailable"));
    render(<Approvals approvals={[apr("a3")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a3").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Defer" }));
    expect(await within(card).findByText(/couldn.t decide — try again/i)).toBeTruthy();
    expect(within(card).queryByText(/already resolved/i)).toBeNull();
  });

  it("an 'applied' outcome (a real transition) shows NO outcome line on the card", async () => {
    const onDecide = vi.fn(() => Promise.resolve<"applied" | "already_resolved" | "unavailable">("applied"));
    render(<Approvals approvals={[apr("a4")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a4").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(within(card).queryByText(/already resolved/i)).toBeNull();
    expect(within(card).queryByText(/couldn.t decide/i)).toBeNull();
  });
});

describe("Approvals surface (§13.10a Slice H) — semantic-mutation cards", () => {
  const semantic = (id: string, over: Partial<UiSafeApproval> = {}): UiSafeApproval => ({
    id,
    subjectKind: "semantic_mutation",
    status: "pending",
    channel: "mac",
    ...over,
  });

  it("renders a Copilot-proposed semantic card with a descriptive label (no actionRef) + the decision buttons", () => {
    render(<Approvals approvals={[semantic("s1")]} onDecide={() => Promise.resolve("applied" as const)} />);
    const card = document.querySelector('[data-approval-id="s1"]') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.getAttribute("data-subject-kind")).toBe("semantic_mutation");
    expect(card.className).toContain("sow-approval-card--semantic");
    // A descriptive label stands in for the (absent) actionRef so the card is never blank.
    expect(within(card).getByText(/proposed note write/i)).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  it("a decision on a semantic card calls onDecide(id, decision) (same idempotent path)", () => {
    const onDecide = vi.fn(() => Promise.resolve("applied" as const));
    render(<Approvals approvals={[semantic("s1")]} onDecide={onDecide} />);
    const card = document.querySelector('[data-approval-id="s1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith("s1", "approve");
  });

  it("a semantic card can be snoozed (display-only, descriptive label, no buttons)", () => {
    render(
      <Approvals
        approvals={[semantic("s2", { status: "deferred", snoozeUntil: "2026-07-09T09:00:00.000Z" })]}
        onDecide={() => Promise.resolve("applied" as const)}
      />,
    );
    const card = document.querySelector('[data-approval-id="s2"]') as HTMLElement;
    expect(card.className).toContain("sow-approval-card--semantic");
    expect(within(card).getByText(/proposed note write/i)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("an external card WITHOUT subjectKind stays backward-compatible (shows actionRef, no semantic class)", () => {
    render(<Approvals approvals={[apr("e1")]} onDecide={() => Promise.resolve("applied" as const)} />);
    const card = document.querySelector('[data-approval-id="e1"]') as HTMLElement;
    expect(within(card).getByText("action:e1")).toBeTruthy();
    expect(card.className).not.toContain("sow-approval-card--semantic");
  });
});

describe("Approvals surface (§9.8) — edit payload-editing form", () => {
  it("shows an Edit button among the pending decisions", () => {
    render(<Approvals approvals={[apr("a1")]} onDecide={() => Promise.resolve("applied" as const)} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("clicking Edit opens the payload-editing form WITHOUT deciding yet (no onDecide call)", () => {
    const onDecide = vi.fn(() => Promise.resolve("applied" as const));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(within(card).getByRole("button", { name: "Confirm edit" })).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("Cancel closes the form without calling onDecide", () => {
    const onDecide = vi.fn(() => Promise.resolve("applied" as const));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(within(card).queryByRole("button", { name: "Confirm edit" })).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("Confirm edit calls onDecide(id, 'edit') and closes the form", () => {
    const onDecide = vi.fn(() => Promise.resolve("applied" as const));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(card).getByRole("button", { name: "Confirm edit" }));
    expect(onDecide).toHaveBeenCalledWith("a1", "edit");
    expect(within(card).queryByRole("button", { name: "Confirm edit" })).toBeNull();
  });

  it("the form shows the card's known target system + workspace attribution (the UI-safe payload fields)", () => {
    render(
      <Approvals
        approvals={[apr("a1", { targetSystem: "linear", workspaceId: "ws-1" })]}
        onDecide={() => Promise.resolve("applied" as const)}
      />,
    );
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(within(card).getByText(/linear/i)).toBeTruthy();
    expect(within(card).getByText(/ws-1/i)).toBeTruthy();
  });

  it("shows an honest 'no additional details' message when target system + workspace are both absent — never a fabricated payload", () => {
    render(<Approvals approvals={[apr("a1")]} onDecide={() => Promise.resolve("applied" as const)} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(within(card).getByText(/no additional details/i)).toBeTruthy();
  });

  it("a decided edit shares the same already-resolved/unavailable outcome rendering as the other decisions", async () => {
    const onDecide = vi.fn(() => Promise.resolve<"applied" | "already_resolved" | "unavailable">("unavailable"));
    render(<Approvals approvals={[apr("a1")]} onDecide={onDecide} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(card).getByRole("button", { name: "Confirm edit" }));
    expect(await within(card).findByText(/couldn.t decide — try again/i)).toBeTruthy();
  });

  it("the Edit button is disabled when there is no live worker (onDecide absent)", () => {
    render(<Approvals approvals={[apr("a1")]} />);
    const card = screen.getByText("action:a1").closest("li") as HTMLElement;
    expect((within(card).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Task 9.42 — the navigation TARGET half (§9.42 point (e)): `focusedApprovalId` marks the card a
  // `{ surface: "approvals", approvalId }` route points at. No producer exists yet to supply a real
  // id (see route.ts / App.tsx comments) — this is exercised with a synthetic id, independent of
  // any producer.
  describe("focusedApprovalId (task 9.42 navigation target)", () => {
    it("marks the matching pending card as current — aria-current + a focus class", () => {
      render(<Approvals approvals={[apr("a1"), apr("a2")]} focusedApprovalId="a2" onDecide={() => Promise.resolve("applied" as const)} />);
      const a1 = screen.getByText("action:a1").closest("li") as HTMLElement;
      const a2 = screen.getByText("action:a2").closest("li") as HTMLElement;
      expect(a2.getAttribute("aria-current")).toBe("true");
      expect(a2.className).toContain("sow-approval-card--focused");
      expect(a1.getAttribute("aria-current")).toBeNull();
      expect(a1.className).not.toContain("sow-approval-card--focused");
    });

    it("marks the matching SNOOZED card too — the target may be deferred, not only pending", () => {
      render(<Approvals approvals={[apr("a1", { status: "deferred" })]} focusedApprovalId="a1" />);
      const card = screen.getByText("action:a1").closest("li") as HTMLElement;
      expect(card.getAttribute("aria-current")).toBe("true");
      expect(card.className).toContain("sow-approval-card--focused");
    });

    it("no id matches any card when absent (the default list view — never a fabricated focus)", () => {
      render(<Approvals approvals={[apr("a1")]} onDecide={() => Promise.resolve("applied" as const)} />);
      const card = screen.getByText("action:a1").closest("li") as HTMLElement;
      expect(card.getAttribute("aria-current")).toBeNull();
      expect(card.className).not.toContain("sow-approval-card--focused");
    });

    it("an id that matches no rendered card is inert — never throws, nothing marked", () => {
      expect(() =>
        render(<Approvals approvals={[apr("a1")]} focusedApprovalId="does-not-exist" onDecide={() => Promise.resolve("applied" as const)} />),
      ).not.toThrow();
      const card = screen.getByText("action:a1").closest("li") as HTMLElement;
      expect(card.getAttribute("aria-current")).toBeNull();
    });
  });
});

// Linear slice 3+4, step 5 (owner decisions 2026-09-22): details load ON OPEN and only for a card in the ACTIVE
// workspace; approved cards whose write has not gone out stay visible with their real state; Send now re-runs the
// guarded dispatch, and the screen does not fire it twice (the worker's single-flight sender is the rule-3 guard).
// The screen never passes a workspace — the App resolves the active one.
describe("Approvals — details on open, Not sent, Send now (Linear slice 3+4)", () => {
  const EMP = "employer-work";
  const card = apr("e1", { workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
  const detail = {
    approvalId: "e1",
    sendState: "awaiting_approval" as const,
    targetSystem: "linear" as const,
    title: "Fix the login bug",
    descriptionLines: ["<img src=x onerror=alert(1)>", "second line"],
    priority: 2,
  };

  it("offers Details only for a card in the ACTIVE workspace; another workspace's card says to switch", () => {
    const onOpenDetail = vi.fn(async () => ({ ok: true as const, detail }));
    const { rerender } = render(
      <Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId="personal-life" onOpenDetail={onOpenDetail} />,
    );
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.getByText(/switch to its workspace to see details/i)).toBeTruthy();
    rerender(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId={EMP} onOpenDetail={onOpenDetail} />);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(onOpenDetail).not.toHaveBeenCalled(); // on OPEN, not on render
  });

  it("opening Details shows the title, the priority and each line as TEXT (never as markup)", async () => {
    render(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId={EMP} onOpenDetail={async () => ({ ok: true as const, detail })} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Fix the login bug")).toBeTruthy();
    expect(screen.getByText("Priority: High")).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("second line")).toBeTruthy();
  });

  it("⛔ an open detail is cleared when the active workspace changes, and a late answer is dropped", async () => {
    let answer: (v: { ok: true; detail: typeof detail }) => void = () => {};
    const slow = () => new Promise<{ ok: true; detail: typeof detail }>((r) => (answer = r));
    const { rerender } = render(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId={EMP} onOpenDetail={slow} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    rerender(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId="personal-life" onOpenDetail={slow} />);
    await act(async () => answer({ ok: true, detail }));
    expect(screen.queryByText("Fix the login bug")).toBeNull();
    // …and switching BACK does not resurrect it: the disclosure starts closed, and the late answer was dropped.
    rerender(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId={EMP} onOpenDetail={slow} />);
    expect(screen.queryByText("Fix the login bug")).toBeNull();
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("lists approved-but-unsent cards under 'Not sent', and Send now fires once for two clicks", async () => {
    const unsentCard = apr("u1", { status: "approved", workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
    let finish: (v: { ok: true; result: { approvalId: string; sendState: "sent" } }) => void = () => {};
    const onSendNow = vi.fn(() => new Promise<{ ok: true; result: { approvalId: string; sendState: "sent" } }>((r) => (finish = r)));
    render(<Approvals approvals={[]} unsent={[unsentCard]} activeWorkspaceId={EMP} onSendNow={onSendNow} onDecide={async () => "applied" as const} />);
    expect(screen.getByText("Not sent")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Send now" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSendNow).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, result: { approvalId: "u1", sendState: "sent" } }));
    expect(await screen.findByText("Sent")).toBeTruthy();
  });

  it("says honestly why a card was not sent", async () => {
    const unsentCard = apr("u2", { status: "approved", workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
    render(
      <Approvals
        approvals={[]}
        unsent={[unsentCard]}
        activeWorkspaceId={EMP}
        onSendNow={async () => ({ ok: true as const, result: { approvalId: "u2", sendState: "writes_off" as const } })}
        onDecide={async () => "applied" as const}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("Not sent: writes to Linear are off")).toBeTruthy();
  });

  it("without a live worker, Details and Send now are not offered as working controls", () => {
    const unsentCard = apr("u3", { status: "approved", workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
    render(<Approvals approvals={[card]} unsent={[unsentCard]} activeWorkspaceId={EMP} />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    const send = screen.queryByRole("button", { name: "Send now" }) as HTMLButtonElement | null;
    expect(send === null || send.disabled).toBe(true);
  });
});

// Step-5 review (2026-09-22). Each test here pins ONE guard on its own; the review showed that overlapping guards
// let a test pass with any single one removed.
describe("Approvals — step-5 review fixes", () => {
  const EMP = "employer-work";
  const card = apr("e1", { workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
  const unsentCard = apr("u1", { status: "approved", workspaceId: EMP, targetSystem: "linear", subjectKind: "external_action" });
  const detail = { approvalId: "e1", sendState: "awaiting_approval" as const, targetSystem: "linear" as const, title: "Fix the login bug" };
  const decide = async () => "applied" as const;

  it("⛔ under StrictMode (the dev build the owner runs), opening Details shows the content", async () => {
    render(
      <StrictMode>
        <Approvals approvals={[card]} onDecide={decide} activeWorkspaceId={EMP} onOpenDetail={async () => ({ ok: true as const, detail })} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Fix the login bug")).toBeTruthy();
  });

  it("⛔ under StrictMode, Send now shows its result and can be pressed again", async () => {
    const onSendNow = vi.fn(async () => ({ ok: true as const, result: { approvalId: "u1", sendState: "writes_off" as const } }));
    render(
      <StrictMode>
        <Approvals approvals={[]} unsent={[unsentCard]} activeWorkspaceId={EMP} onSendNow={onSendNow} onDecide={decide} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("Not sent: writes to Linear are off")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Details loads again on every open, so an 'unavailable' answer can be retried", async () => {
    const answers: ({ ok: false } | { ok: true; detail: typeof detail })[] = [{ ok: false }, { ok: true, detail }];
    const onOpenDetail = vi.fn(async (_id: string) => answers.shift() ?? { ok: false as const });
    render(<Approvals approvals={[card]} onDecide={decide} activeWorkspaceId={EMP} onOpenDetail={onOpenDetail} />);
    const btn = screen.getByRole("button", { name: "Details" });
    fireEvent.click(btn);
    expect(await screen.findByText("Details unavailable")).toBeTruthy();
    fireEvent.click(btn); // close
    fireEvent.click(btn); // open again
    expect(await screen.findByText("Fix the login bug")).toBeTruthy();
    expect(onOpenDetail).toHaveBeenCalledTimes(2);
  });

  it("an answer about a DIFFERENT approval is not shown", async () => {
    render(
      <Approvals
        approvals={[card]}
        onDecide={decide}
        activeWorkspaceId={EMP}
        onOpenDetail={async () => ({ ok: true as const, detail: { ...detail, approvalId: "other" } })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Details unavailable")).toBeTruthy();
    expect(screen.queryByText("Fix the login bug")).toBeNull();
  });

  it("the Send now button is disabled while a send is in flight", async () => {
    let finish: (v: { ok: true; result: { approvalId: string; sendState: "writes_off" } }) => void = () => {};
    const onSendNow = vi.fn(() => new Promise<{ ok: true; result: { approvalId: string; sendState: "writes_off" } }>((r) => (finish = r)));
    render(<Approvals approvals={[]} unsent={[unsentCard]} activeWorkspaceId={EMP} onSendNow={onSendNow} onDecide={decide} />);
    const btn = screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await act(async () => finish({ ok: true, result: { approvalId: "u1", sendState: "writes_off" } }));
    expect(btn.disabled).toBe(false);
  });

  it("two clicks before the screen re-renders still send once (the in-flight guard, on its own)", async () => {
    const onSendNow = vi.fn(() => new Promise<never>(() => {}));
    render(<Approvals approvals={[]} unsent={[unsentCard]} activeWorkspaceId={EMP} onSendNow={onSendNow} onDecide={decide} />);
    const btn = screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement;
    act(() => {
      btn.click();
      btn.click(); // same act: React has not re-rendered, so the button is not disabled yet
    });
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it("once a write is SENT, the card says so and Send now is no longer offered as a working control", async () => {
    render(
      <Approvals
        approvals={[]}
        unsent={[unsentCard]}
        activeWorkspaceId={EMP}
        onSendNow={async () => ({ ok: true as const, result: { approvalId: "u1", sendState: "sent" as const } })}
        onDecide={decide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("Sent")).toBeTruthy();
    const li = screen.getByRole("button", { name: "Send now" }).closest("li") as HTMLElement;
    expect(within(li).getByText("sent")).toBeTruthy();
    expect(within(li).queryByText("not sent")).toBeNull();
    expect((screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("after Send now, an open Details panel closes, so it never shows the state from before the send", async () => {
    const unsentDetail = { approvalId: "u1", sendState: "writes_off" as const, targetSystem: "linear" as const, title: "Old state title" };
    render(
      <Approvals
        approvals={[]}
        unsent={[unsentCard]}
        activeWorkspaceId={EMP}
        onOpenDetail={async () => ({ ok: true as const, detail: unsentDetail })}
        onSendNow={async () => ({ ok: true as const, result: { approvalId: "u1", sendState: "sent" as const } })}
        onDecide={decide}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Old state title")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("Sent")).toBeTruthy();
    expect(screen.queryByText("Old state title")).toBeNull();
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("a failed load of the Not sent list is SAID, not shown as an empty list", () => {
    render(<Approvals approvals={[]} unsent={[]} unsentLoadFailed activeWorkspaceId={EMP} onDecide={decide} />);
    expect(screen.getByText("Couldn't load the Not sent list")).toBeTruthy();
  });
});

// Linear slice 5a review (2026-09-25, three lenses): the worker served the team name, but no component showed it — five
// claims said the owner sees where the issue goes before approving. This pins that they do.
describe("Approvals — the team shown in Details (Linear slice 5a)", () => {
  it("shows the team the issue goes to, by name", async () => {
    const card = apr("e1", { workspaceId: "employer-work", targetSystem: "linear", subjectKind: "external_action" });
    const detail = { approvalId: "e1", sendState: "awaiting_approval" as const, targetSystem: "linear" as const, title: "Fix it", teamName: "Core Platform" };
    render(<Approvals approvals={[card]} onDecide={async () => "applied" as const} activeWorkspaceId="employer-work" onOpenDetail={async () => ({ ok: true as const, detail })} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Team: Core Platform")).toBeTruthy();
  });
});
