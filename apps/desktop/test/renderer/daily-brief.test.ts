import { describe, it, expect } from "vitest";
import { buildDailyBrief, type DailyBriefStats } from "../../renderer/lib/daily-brief";

// 9.20 — the deterministic, model-FREE Today daily brief. A pure assembler over UI-safe store COUNTS
// (recent-changes · items-to-triage · pending-approvals) → an honest summary + a compact meta chip line, so
// `SOW_DEMO_SEED=1 ./dev.sh` shows a genuinely populated brief with ZERO model calls. Window-free (LESSON 3);
// renders only counts (rule 5 — no raw content). The rich model-synthesized briefing stays the separate
// on-request Copilot path. (System-health "issues" are intentionally NOT a brief stat — that would conflate
// infra health with work items and duplicate the System Health section rendered directly below.)

describe("buildDailyBrief — deterministic store-assembled brief (no model, UI-safe counts only)", () => {
  it("build_daily_brief_from_seeded_counts: non-zero counts → summary + meta reflect them", () => {
    // spec(§11) — a populated brief from real (seeded) counts. Headline picks the most-actionable non-zero
    // (approvals > triage > recent); meta lists ALL non-zero counts in a fixed order, zero-dropped.
    const b = buildDailyBrief({ recentChanges: 12, toTriage: 5, pendingApprovals: 0 });
    expect(b.stats).toEqual({ recentChanges: 12, toTriage: 5, pendingApprovals: 0 });
    expect(b.summary).toContain("5 items"); // headline = toTriage (approvals zero)
    expect(b.meta).toBe("12 recent changes · 5 to triage");

    const b2 = buildDailyBrief({ recentChanges: 3, toTriage: 0, pendingApprovals: 2 });
    expect(b2.summary).toContain("2 approvals"); // headline = pending approvals (highest priority)
    expect(b2.meta).toBe("3 recent changes · 2 pending approvals");
  });

  it("singular_vs_plural_wording: counts of 1 read as singular", () => {
    // spec(§11) — honest wording (no "1 items"); deterministic across the count set.
    const b = buildDailyBrief({ recentChanges: 1, toTriage: 1, pendingApprovals: 1 });
    expect(b.meta).toBe("1 recent change · 1 to triage · 1 pending approval");
    expect(b.summary).toContain("1 approval is waiting");
  });

  it("build_daily_brief_all_zero_is_honest_empty: all-zero → honest 'caught up', empty meta (no mockup)", () => {
    // spec(§11 / §9.4 empty-until-data honesty) — an empty read-model shows an honest zero brief, never a
    // mockup and never a crash.
    const b = buildDailyBrief({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });
    expect(b.summary).toBe("You're all caught up — nothing new to review yet.");
    expect(b.meta).toBe("");
    expect(b.stats).toEqual({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });
  });

  it("brief_is_pure_and_ui_safe: input is only counts; output is {summary, meta, stats} strings/counts; deterministic", () => {
    // spec(desktop rule 5) — composed purely from numeric counts (no raw-content field can leak); pure +
    // deterministic (same input ⇒ same output).
    const input: DailyBriefStats = { recentChanges: 2, toTriage: 0, pendingApprovals: 0 };
    const b = buildDailyBrief(input);
    expect(Object.keys(b).sort()).toEqual(["meta", "stats", "summary"]);
    expect(typeof b.summary).toBe("string");
    expect(typeof b.meta).toBe("string");
    expect(buildDailyBrief(input)).toEqual(b); // deterministic
  });
});
