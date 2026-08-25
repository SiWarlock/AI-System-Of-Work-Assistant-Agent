// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { UiSafeDashboardCard, UiSafeWorkflowRunRef } from "@sow/contracts/api/ui-safe";
import { Today, type TodayProps } from "../renderer/surfaces/today/Today";
import { buildDailyBrief } from "../renderer/lib/daily-brief";

// 25.6 — surface each output workflow's result in the UI. Two gaps closed here:
//   (a) UiSafeDashboardCard already carries `status` + `updatedAt` (the shared rebuildable
//       read-model dailyBrief/periodReview/projectSync all write into via
//       createDashboardUpdateActivity) but Today's "Waiting on you" cards rendered neither —
//       so a produced card was visible only as a bare count, not AS a workflow's result.
//   (b) `state.workflows` (UiSafeWorkflowRunRef, populated by the already-wired workflow.status
//       stream reducer) had ZERO UI consumers anywhere in the renderer — headless by omission,
//       not by design. "Workflow runs" is the generic per-family-agnostic surface for it (no
//       family discriminator exists on the projection yet — see crossTerritoryNeeds).

afterEach(cleanup);

const brief = buildDailyBrief({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });

const base: Omit<TodayProps, "cards" | "workflowRuns"> = {
  scope: "employer-work",
  health: [],
  global: [],
  recentChanges: [],
  workspaceMeta: new Map(),
  brief,
  tasks: [],
  onDrillDown: () => {},
  onAuditDrill: () => Promise.resolve({ ok: false }),
};

function card(over: Partial<UiSafeDashboardCard> = {}): UiSafeDashboardCard {
  return {
    cardId: "c1",
    kind: "period_review",
    // Deliberately NOT "Daily brief" — that string already appears as the unrelated
    // §9.20 section label rendered on every Today mount (would make getByText ambiguous).
    title: "Weekly period review",
    status: "ok",
    count: 3,
    updatedAt: new Date(Date.now() - 90 * 60_000).toISOString(), // 1h30m ago
    ...over,
  };
}

function run(over: Partial<UiSafeWorkflowRunRef> = {}): UiSafeWorkflowRunRef {
  return {
    workflowId: "wf-daily-brief-1",
    trigger: "schedule",
    state: "done",
    idempotencyKey: "idem-1",
    ...over,
  };
}

describe("Waiting-on-you cards surface a workflow's status + freshness (25.6a)", () => {
  it("renders the card's status token and a relative updatedAt", () => {
    render(<Today {...base} cards={[card()]} workflowRuns={[]} />);
    expect(screen.getByText("Weekly period review")).toBeTruthy();
    expect(screen.getByText(/^Ok/)).toBeTruthy(); // humanized status token
    expect(screen.getByText(/1h/)).toBeTruthy(); // relative updatedAt
  });
});

describe("Workflow runs (25.6b) — the generic UiSafeWorkflowRunRef status list", () => {
  it("empty_state_no_runs", () => {
    render(<Today {...base} cards={[]} workflowRuns={[]} />);
    expect(screen.getByText("No workflow runs yet")).toBeTruthy();
  });

  it("renders_each_run_trigger_and_state", () => {
    render(
      <Today
        {...base}
        cards={[]}
        workflowRuns={[
          run({ workflowId: "wf-a", trigger: "schedule", state: "done" }),
          run({ workflowId: "wf-b", trigger: "connector_event", state: "failed" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem").filter((el) => el.getAttribute("data-workflow-id") !== null);
    expect(rows.map((r) => r.getAttribute("data-workflow-id"))).toEqual(["wf-a", "wf-b"]);
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Connector event")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("renders_only_allowlisted_fields", () => {
    // spec(rule 7 / §16) — a stray raw field on a run reaches neither DOM text nor an attribute.
    const poisoned = { ...run(), rawSecret: "SECRET run detail", idempotencyKey: "SHOULD-NOT-LEAK" } as unknown as UiSafeWorkflowRunRef;
    const { container } = render(<Today {...base} cards={[]} workflowRuns={[poisoned]} />);
    for (const raw of ["SECRET run detail", "SHOULD-NOT-LEAK"]) {
      expect(container.textContent).not.toContain(raw);
      expect(container.innerHTML).not.toContain(raw);
    }
  });
});
