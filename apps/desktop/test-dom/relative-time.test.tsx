// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { relativeTime } from "../renderer/lib/relative-time";

// 25.6 — the single-sourced relative-time formatter Today (workflow-run cards) and Projects
// (updatedAt) both need. Pure/DOM-free (Date + Math only); lives in test-dom only because this
// track's territory excludes apps/desktop/test/ this session — the jsdom environment is
// otherwise irrelevant to these assertions.

describe("relativeTime — display-only formatter", () => {
  it("just_now_under_one_minute", () => {
    expect(relativeTime(new Date(Date.now() - 10_000).toISOString())).toBe("just now");
  });

  it("minutes_under_an_hour", () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m");
  });

  it("hours_under_a_day", () => {
    expect(relativeTime(new Date(Date.now() - 3 * 60 * 60_000).toISOString())).toBe("3h");
  });

  it("days_at_or_over_24_hours", () => {
    expect(relativeTime(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString())).toBe("2d");
  });

  it("unparseable_iso_is_defensively_empty_never_NaN", () => {
    expect(relativeTime("not-a-date")).toBe("");
  });
});
