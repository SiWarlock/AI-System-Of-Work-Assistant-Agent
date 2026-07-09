// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { Approvals } from "../renderer/surfaces/approvals/Approvals";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

function apr(id: string, over: Partial<UiSafeApproval> = {}): UiSafeApproval {
  return { id, actionRef: `action:${id}`, status: "pending", channel: "mac", ...over };
}

describe("Approvals surface (§9.8) — render behavior", () => {
  it("empty inbox shows the 'No pending approvals' state", () => {
    render(<Approvals approvals={[]} onDecide={() => {}} />);
    expect(screen.getByText(/no pending approvals/i)).toBeTruthy();
  });

  it("renders a pending card per pending approval with Approve / Reject / Defer", () => {
    render(<Approvals approvals={[apr("a1"), apr("a2")]} onDecide={() => {}} />);
    expect(screen.getByText("action:a1")).toBeTruthy();
    expect(screen.getByText("action:a2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Defer" })).toHaveLength(2);
  });

  it("clicking a decision button calls onDecide(id, decision)", () => {
    const onDecide = vi.fn();
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
        onDecide={() => {}}
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
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/no pending approvals/i)).toBeTruthy();
    expect(screen.queryByText("action:t1")).toBeNull();
    expect(screen.queryByText("action:t3")).toBeNull();
  });

  it("a pending card shows its channel + expiry date", () => {
    render(<Approvals approvals={[apr("a1", { expiresAt: "2026-07-10T09:00:00.000Z" })]} onDecide={() => {}} />);
    expect(screen.getByText(/via mac/i)).toBeTruthy();
    expect(screen.getByText(/expires 2026-07-10/i)).toBeTruthy();
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
    render(<Approvals approvals={[semantic("s1")]} onDecide={() => {}} />);
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
    const onDecide = vi.fn();
    render(<Approvals approvals={[semantic("s1")]} onDecide={onDecide} />);
    const card = document.querySelector('[data-approval-id="s1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith("s1", "approve");
  });

  it("a semantic card can be snoozed (display-only, descriptive label, no buttons)", () => {
    render(
      <Approvals
        approvals={[semantic("s2", { status: "deferred", snoozeUntil: "2026-07-09T09:00:00.000Z" })]}
        onDecide={() => {}}
      />,
    );
    const card = document.querySelector('[data-approval-id="s2"]') as HTMLElement;
    expect(card.className).toContain("sow-approval-card--semantic");
    expect(within(card).getByText(/proposed note write/i)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("an external card WITHOUT subjectKind stays backward-compatible (shows actionRef, no semantic class)", () => {
    render(<Approvals approvals={[apr("e1")]} onDecide={() => {}} />);
    const card = document.querySelector('[data-approval-id="e1"]') as HTMLElement;
    expect(within(card).getByText("action:e1")).toBeTruthy();
    expect(card.className).not.toContain("sow-approval-card--semantic");
  });
});
