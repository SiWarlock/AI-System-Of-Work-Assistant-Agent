// task D2b — the FOUR sibling config fields on every `*Schedule` block
// (`intervalMs`/`catchUpWindowMs`/`scopes`/`sources`) get the SAME fail-closed armed-path
// validation task F3 already gave `globalWorkspaceId`/`organizerWorkspaceId`
// (outputWorkflowScheduleEnvelopes.test.ts's own "task F3" describe block). Before this slice,
// only the workspace-id override was guarded — a typo in any of the other three reached a
// DURABLE Temporal schedule unfiltered:
//   - `intervalMs: NaN | -1 | "abc"` reached `spec.intervals[0].every` (the real tick cadence);
//   - `catchUpWindowMs` (dailyBrief/periodReview only) reached the LIFE-2 collapse window the
//     same way;
//   - `scopes: "not-an-array"` / `sources: "nope"` reached the durable schedule's `action.args`
//     envelope verbatim.
// This suite proves, per family, that a malformed value on ANY of these fields SKIPS that family
// (typed onSkip, never a boot crash — §16), that a well-formed value still builds normally, that
// a malformed field on one family never touches an armed sibling (per-family isolation, mirroring
// F3), and that a DISARMED family carrying garbage in every one of these fields is still
// byte-equivalent (zero schedules, zero onSkip calls, never throws) — the validation runs ONLY on
// the armed path, exactly like `resolveScheduleWorkspaceId`.
import { describe, it, expect } from "vitest";
import { workspaceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import {
  buildOutputWorkflowScheduleSpecs,
  type BootConfig,
  type OutputWorkflowScheduleSkip,
} from "../../src/boot";
import { PROOF_SPINE_TASK_QUEUE } from "../../src/temporal/registerWorker";

// Mirrors outputWorkflowScheduleEnvelopes.test.ts's own fixture helper exactly — this function
// reads ONLY the six `*Schedule` config blocks, so the cast-past-the-rest convention is safe here
// too (see that file's own comment for why).
function baseConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return { ...overrides } as unknown as BootConfig;
}

const FIXTURE_WORKSPACE_ID: WorkspaceId = workspaceId("ws-fixture");

describe("D2b — intervalMs fail-closed validation (all six families)", () => {
  const MALFORMED_INTERVAL_MS = [NaN, -1, 0, "abc"] as const;

  it("ingestionTriageSchedule: a malformed intervalMs skips the family, never throws, registers zero", () => {
    for (const malformed of MALFORMED_INTERVAL_MS) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({
        ingestionTriageSchedule: { enabled: true, intervalMs: malformed as unknown as number },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
      }).not.toThrow();
      expect(specs).toEqual([]);
      expect(skips).toEqual([{ family: "ingestionTriage", code: "invalid_interval_ms" }]);
    }
  });

  it("projectSyncSchedule: a malformed intervalMs skips the family, never throws, registers zero", () => {
    for (const malformed of MALFORMED_INTERVAL_MS) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({
        projectSyncSchedule: { enabled: true, intervalMs: malformed as unknown as number },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
      }).not.toThrow();
      expect(specs).toEqual([]);
      expect(skips).toEqual([{ family: "projectSync", code: "invalid_interval_ms" }]);
    }
  });

  it("dailyBriefSchedule: a malformed intervalMs skips dailyBrief; an armed sibling (projectSync) still registers", () => {
    for (const malformed of MALFORMED_INTERVAL_MS) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({
        dailyBriefSchedule: { enabled: true, intervalMs: malformed as unknown as number },
        projectSyncSchedule: { enabled: true },
      });
      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
      expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
      expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_interval_ms" }]);
    }
  });

  it("crossCalendarSchedulingSchedule: a malformed intervalMs skips the family", () => {
    for (const malformed of MALFORMED_INTERVAL_MS) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({
        crossCalendarSchedulingSchedule: { enabled: true, intervalMs: malformed as unknown as number },
      });
      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
      expect(specs).toEqual([]);
      expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "invalid_interval_ms" }]);
    }
  });

  it("periodReviewSchedule: a malformed weeklyIntervalMs skips ONLY the weekly cadence — monthly (independent AND-lock) still registers", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, weeklyIntervalMs: NaN },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["period-review-monthly"]);
    expect(skips).toEqual([{ family: "periodReviewWeekly", code: "invalid_interval_ms" }]);
  });

  it("periodReviewSchedule: a malformed monthlyIntervalMs skips ONLY the monthly cadence — weekly still registers", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, monthlyIntervalMs: -1 },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["period-review-weekly"]);
    expect(skips).toEqual([{ family: "periodReviewMonthly", code: "invalid_interval_ms" }]);
  });
});

describe("D2b — catchUpWindowMs fail-closed validation (dailyBrief + periodReview only)", () => {
  it("dailyBriefSchedule: a malformed catchUpWindowMs (valid intervalMs) skips the family", () => {
    for (const malformed of [NaN, -1, "abc"] as const) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({
        dailyBriefSchedule: {
          enabled: true,
          intervalMs: 86_400_000,
          catchUpWindowMs: malformed as unknown as number,
        },
      });
      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
      expect(specs).toEqual([]);
      expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_catch_up_window_ms" }]);
    }
  });

  it("periodReviewSchedule: a malformed shared catchUpWindowMs (both intervals valid) skips BOTH cadences", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, catchUpWindowMs: NaN },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([
      { family: "periodReviewWeekly", code: "invalid_catch_up_window_ms" },
      { family: "periodReviewMonthly", code: "invalid_catch_up_window_ms" },
    ]);
  });
});

describe("D2b — scopes fail-closed validation (dailyBrief + periodReview only)", () => {
  it("dailyBriefSchedule: a non-array scopes value skips the family", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, scopes: "not-an-array" as unknown as never },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_scopes" }]);
  });

  it("dailyBriefSchedule: an array holding one malformed entry (bad workspaceId) invalidates the WHOLE scopes override", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: {
        enabled: true,
        scopes: [{ workspaceId: FIXTURE_WORKSPACE_ID }, { workspaceId: "Not A Slug!" as unknown as WorkspaceId }],
      },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_scopes" }]);
  });

  it("dailyBriefSchedule: an entry missing workspaceId invalidates the scopes override", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, scopes: [{ brainId: "b1" }] as unknown as never },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_scopes" }]);
  });

  it("periodReviewSchedule: a malformed shared scopes override skips BOTH cadences", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, scopes: "nope" as unknown as never },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([
      { family: "periodReviewWeekly", code: "invalid_scopes" },
      { family: "periodReviewMonthly", code: "invalid_scopes" },
    ]);
  });

  it("dailyBriefSchedule: a well-formed scopes override builds normally, never calls onSkip", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, scopes: [{ workspaceId: FIXTURE_WORKSPACE_ID, brainId: "brain-1" }] },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toHaveLength(1);
    expect(skips).toEqual([]);
    expect((specs[0]!.action.args[0] as { scopes: unknown }).scopes).toEqual([
      { workspaceId: FIXTURE_WORKSPACE_ID, brainId: "brain-1" },
    ]);
  });
});

describe("D2b — sources fail-closed validation (crossCalendarScheduling only)", () => {
  it("a non-array sources value skips the family", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: { enabled: true, sources: "nope" as unknown as never },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "invalid_sources" }]);
  });

  it("an array holding an entry missing sourceId invalidates the WHOLE sources override", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: {
        enabled: true,
        sources: [{ workspaceId: FIXTURE_WORKSPACE_ID }] as unknown as never,
      },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "invalid_sources" }]);
  });

  it("an array holding an entry with a malformed workspaceId invalidates the sources override", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: {
        enabled: true,
        sources: [{ sourceId: "cal-1", workspaceId: "../../etc" }] as unknown as never,
      },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "invalid_sources" }]);
  });

  it("a well-formed sources override builds normally, never calls onSkip", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: {
        enabled: true,
        sources: [{ sourceId: "cal-1", workspaceId: FIXTURE_WORKSPACE_ID }],
      },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toHaveLength(1);
    expect(skips).toEqual([]);
  });
});

describe("D2b — per-family isolation across MULTIPLE simultaneously-armed families", () => {
  it("a malformed field on ONE armed family never blocks well-formed armed siblings — only the bad family is skipped", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      ingestionTriageSchedule: { enabled: true }, // well-formed (default interval)
      dailyBriefSchedule: { enabled: true, intervalMs: "abc" as unknown as number }, // malformed
      crossCalendarSchedulingSchedule: { enabled: true, sources: "nope" as unknown as never }, // malformed
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId).sort()).toEqual(["ingestion-triage"]);
    expect(skips).toEqual(
      expect.arrayContaining([
        { family: "dailyBrief", code: "invalid_interval_ms" },
        { family: "crossCalendarScheduling", code: "invalid_sources" },
      ]),
    );
    expect(skips).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ⛔ THE DISARMED-PATH INVARIANT — mirrors F3's own "never validates on the disarmed path"
// discipline exactly. A garbage `intervalMs`/`scopes`/`sources` on a family whose `enabled` is
// NOT the strict literal `true` must NEVER be inspected at all: no skip fires, no schedule is
// built, and `bootWorker` never throws. This is the byte-equivalent-default guarantee D2b's
// resolver helpers must preserve — validation runs ONLY on the armed path.
//
// MUTATION-PROVEN (2026-08-27): temporarily changed `resolveScheduleDurationMs`'s guard from
// `if (enabled !== true || configured === undefined) return { ok: true, value: fallback };` to
// `if (configured === undefined) return { ok: true, value: fallback };` (dropping the `enabled`
// half of the short-circuit) — re-ran this exact test file. RESULT: RED — the DISARMED-with-
// malformed-intervalMs assertions below failed (`skips` held `{family:"ingestionTriage",
// code:"invalid_interval_ms"}` etc. instead of `[]`, because the mutated resolver now validates
// `"abc"`/`NaN` even though `enabled` is `false`). Reverted the edit and re-ran to confirm GREEN
// again (all tests in this file passing, `tsc --noEmit` clean). Transcript in this task's
// structured report `verification` field.
// ---------------------------------------------------------------------------
describe("D2b — a DISARMED family never validates its config, byte-equivalent to before this slice", () => {
  it("every family, DISARMED, carrying a malformed intervalMs/catchUpWindowMs/scopes/sources SIMULTANEOUSLY never throws, registers ZERO, and calls onSkip ZERO times", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      ingestionTriageSchedule: { enabled: false, intervalMs: "abc" as unknown as number },
      projectSyncSchedule: { enabled: false, intervalMs: NaN },
      dailyBriefSchedule: {
        enabled: false,
        intervalMs: -1,
        catchUpWindowMs: NaN,
        scopes: "not-an-array" as unknown as never,
      },
      periodReviewSchedule: {
        enabled: false,
        weeklyIntervalMs: "abc" as unknown as number,
        monthlyIntervalMs: NaN,
        catchUpWindowMs: -1,
        scopes: "nope" as unknown as never,
      },
      crossCalendarSchedulingSchedule: {
        enabled: false,
        intervalMs: NaN,
        sources: "nope" as unknown as never,
      },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    }).not.toThrow();

    expect(specs).toEqual([]);
    expect(skips).toEqual([]);
  });

  it("a truthy-but-not-true enabled value (mirrors L28/§2) with a malformed intervalMs also never validates — the field guard rides the SAME strict arming check, not a looser one", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      ingestionTriageSchedule: { enabled: "true" as unknown as boolean, intervalMs: "abc" as unknown as number },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⛔ AT LEAST ONE SKIP, MUTATION-PROVEN (2026-08-27): temporarily changed
// `resolveScheduleDurationMs`'s validity check from
// `if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0)` to
// `if (typeof configured !== "number" || configured <= 0)` (dropping the `Number.isFinite` leg) —
// re-ran this exact test. RESULT: RED — `ingestionTriage_NaN_intervalMs_is_skipped` failed:
// `NaN <= 0` evaluates to `false` (every comparison against `NaN` is `false`), so the mutated
// guard let `NaN` through as "valid" (`typeof NaN === "number"` is `true`), `resolveScheduleDurationMs`
// returned `{ ok: true, value: NaN }`, a schedule spec WAS built (`specs` non-empty, `skips` empty)
// instead of the expected skip. Reverted the edit and re-ran to confirm GREEN again (all tests in
// this file passing, `tsc --noEmit` clean). Transcript in this task's structured report
// `verification` field.
// ---------------------------------------------------------------------------
describe("D2b — ingestionTriage_NaN_intervalMs_is_skipped (mutation-proof anchor)", () => {
  it("ingestionTriage_NaN_intervalMs_is_skipped", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({ ingestionTriageSchedule: { enabled: true, intervalMs: NaN } });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "ingestionTriage", code: "invalid_interval_ms" }]);
  });
});

describe("D2b — all six families well-formed simultaneously: zero skips, everyone registers (no over-strict false-positive)", () => {
  it("a fully well-formed multi-family armed config builds every spec and calls onSkip zero times", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      ingestionTriageSchedule: { enabled: true, intervalMs: 3_600_000 },
      projectSyncSchedule: { enabled: true, intervalMs: 3_600_000 },
      dailyBriefSchedule: {
        enabled: true,
        intervalMs: 86_400_000,
        catchUpWindowMs: 172_800_000,
        globalWorkspaceId: "ws-daily",
        scopes: [{ workspaceId: FIXTURE_WORKSPACE_ID }],
      },
      periodReviewSchedule: {
        enabled: true,
        weeklyIntervalMs: 604_800_000,
        monthlyIntervalMs: 2_592_000_000,
        catchUpWindowMs: 1_209_600_000,
        globalWorkspaceId: "ws-review",
        scopes: [{ workspaceId: FIXTURE_WORKSPACE_ID }],
      },
      crossCalendarSchedulingSchedule: {
        enabled: true,
        intervalMs: 3_600_000,
        organizerWorkspaceId: "ws-organizer",
        sources: [{ sourceId: "cal-1", workspaceId: FIXTURE_WORKSPACE_ID }],
      },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));

    expect(skips).toEqual([]);
    expect(specs.map((s) => s.scheduleId).sort()).toEqual([
      "cross-calendar-scheduling",
      "daily-brief",
      "ingestion-triage",
      "period-review-monthly",
      "period-review-weekly",
      "project-sync",
    ]);
  });
});
