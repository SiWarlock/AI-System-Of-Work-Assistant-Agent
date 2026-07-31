// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Today, type TodayProps } from "../renderer/surfaces/today/Today";
import { buildDailyBrief } from "../renderer/lib/daily-brief";

// 9.20 — the two hardcoded Today sections are flipped to real/honest data. The Daily brief renders the
// deterministic assembled `brief` prop (not the illustrative mockup prose); the schedule renders an honest
// empty state (no fabricated meeting rows) until 9.9 Calendar ships. These pin that the mockup strings are
// GONE (a regression to mockups fails the build).

afterEach(cleanup);

const base: Omit<TodayProps, "brief"> = {
  // A workspace scope (not global) so the §9.4 GlobalGroups branch is skipped for this render.
  scope: "employer-work",
  cards: [],
  health: [],
  global: [],
  recentChanges: [],
  workspaceMeta: new Map(),
  tasks: [],
  onDrillDown: () => {},
  onAuditDrill: () => Promise.resolve({ ok: false }),
};

describe("Today — daily brief + schedule are real/honest, not mockups (9.20)", () => {
  it("today_renders_brief_prop_not_hardcoded: the assembled brief summary + meta render", () => {
    // spec(§11) — the Daily brief reflects the passed deterministic brief, not the illustrative prose.
    const brief = buildDailyBrief({ recentChanges: 12, toTriage: 5, pendingApprovals: 0 });
    render(<Today {...base} brief={brief} />);
    expect(screen.getByText(brief.summary)).toBeTruthy();
    expect(screen.getByText(brief.meta)).toBeTruthy();
    // the illustrative mockup prose is gone
    expect(screen.queryByText(/Two meetings on the calendar/)).toBeNull();
  });

  it("schedule_is_honest_empty_no_fabricated_rows: 'No calendar connected', no mockup meetings", () => {
    // spec(§11) — no schedule data source until 9.9 Calendar; honest empty state, never fabricated meetings.
    const brief = buildDailyBrief({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });
    render(<Today {...base} brief={brief} />);
    expect(screen.getByText("No calendar connected")).toBeTruthy();
    expect(screen.queryByText("Standup")).toBeNull();
    expect(screen.queryByText("Vendor review")).toBeNull();
    expect(screen.queryByText("1:1 with Priya")).toBeNull();
  });
});
