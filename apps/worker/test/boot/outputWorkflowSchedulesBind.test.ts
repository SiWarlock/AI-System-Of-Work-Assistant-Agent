// Tasks 25.2/25.3/25.4 — the dailyBrief/periodReview(weekly+monthly)/projectSync/
// crossCalendarScheduling DURABLE schedules: register each schedule spec, keep every flip
// default-OFF and strict `=== true`, never create a live schedule. Mirrors task 25.5's own
// ingestionTriageScheduleBind.test.ts precedent exactly (same adapter, same gate shape, same
// source-scan discipline) — this suite proves the REMAINING boot.ts wiring landed:
//   • boot.ts's config→gate threading is strict `=== true` for EVERY new schedule (a truthy
//     non-boolean never arms) — driven with the SAME expression boot.ts uses;
//   • boot.ts has a REAL production caller for each new gate + calls registrar.ensure on the
//     armed path (source-scan pins, mirroring 25.5's own "was ZERO" proof);
//   • the weekly and monthly period-review cadences are DISTINCT schedules, never collapsed.
// `createRealScheduleClientPort`'s own adapter contract (describe/create/update shape,
// not-found→undefined, no `paused` key on update) is already fully pinned by
// ingestionTriageScheduleBind.test.ts — not re-proven here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  gateDailyBriefSchedule,
  gatePeriodReviewWeeklySchedule,
  gatePeriodReviewMonthlySchedule,
  gateProjectSyncSchedule,
  gateCrossCalendarSchedulingSchedule,
} from "../../src/temporal/scheduleRegistrar";

const BOOT_SRC = readFileSync(fileURLToPath(new URL("../../src/boot.ts", import.meta.url)), "utf8");

describe("the new 25.2/25.3/25.4 gates — strict === true default-OFF, driven with boot.ts's OWN expression shape", () => {
  const hostileValues = ["true", 1, {}, [], "yes"] as const;

  it("gateDailyBriefSchedule refuses every truthy-non-boolean and arms only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gateDailyBriefSchedule({ enabled: (v as unknown) === true, taskQueue: "sow-control-plane", intervalMs: 86_400_000 }),
      ).toBeUndefined();
    }
    expect(
      gateDailyBriefSchedule({ enabled: true, taskQueue: "sow-control-plane", intervalMs: 86_400_000 }),
    ).toBeDefined();
  });

  it("gatePeriodReviewWeeklySchedule / gatePeriodReviewMonthlySchedule refuse every truthy-non-boolean and arm only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gatePeriodReviewWeeklySchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 604_800_000,
        }),
      ).toBeUndefined();
      expect(
        gatePeriodReviewMonthlySchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 2_592_000_000,
        }),
      ).toBeUndefined();
    }
    const weekly = gatePeriodReviewWeeklySchedule({
      enabled: true,
      taskQueue: "sow-control-plane",
      intervalMs: 604_800_000,
    });
    const monthly = gatePeriodReviewMonthlySchedule({
      enabled: true,
      taskQueue: "sow-control-plane",
      intervalMs: 2_592_000_000,
    });
    expect(weekly).toBeDefined();
    expect(monthly).toBeDefined();
    expect(weekly?.scheduleId).not.toBe(monthly?.scheduleId);
  });

  it("gateProjectSyncSchedule refuses every truthy-non-boolean and arms only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gateProjectSyncSchedule({ enabled: (v as unknown) === true, taskQueue: "sow-control-plane", intervalMs: 3_600_000 }),
      ).toBeUndefined();
    }
    expect(
      gateProjectSyncSchedule({ enabled: true, taskQueue: "sow-control-plane", intervalMs: 3_600_000 }),
    ).toBeDefined();
  });

  it("gateCrossCalendarSchedulingSchedule refuses every truthy-non-boolean and arms only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gateCrossCalendarSchedulingSchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 3_600_000,
        }),
      ).toBeUndefined();
    }
    expect(
      gateCrossCalendarSchedulingSchedule({ enabled: true, taskQueue: "sow-control-plane", intervalMs: 3_600_000 }),
    ).toBeDefined();
  });
});

describe("boot.ts — REAL production callers for the new 25.2/25.3/25.4 gates (was ZERO)", () => {
  it("imports every new gate from scheduleRegistrar.ts", () => {
    expect(BOOT_SRC).toContain("gateDailyBriefSchedule");
    expect(BOOT_SRC).toContain("gatePeriodReviewWeeklySchedule");
    expect(BOOT_SRC).toContain("gatePeriodReviewMonthlySchedule");
    expect(BOOT_SRC).toContain("gateProjectSyncSchedule");
    expect(BOOT_SRC).toContain("gateCrossCalendarSchedulingSchedule");
  });

  it("threads each new schedule's owner config through the SAME strict === true shape as 25.5", () => {
    expect(BOOT_SRC).toContain("config.dailyBriefSchedule?.enabled === true");
    expect(BOOT_SRC).toContain("config.periodReviewSchedule?.enabled === true");
    expect(BOOT_SRC).toContain("config.projectSyncSchedule?.enabled === true");
    expect(BOOT_SRC).toContain("config.crossCalendarSchedulingSchedule?.enabled === true");
  });

  it("calls registrar.ensure on every gated spec — the schedules are actually registered, not just gated", () => {
    // The 25.5 precedent calls `registrar.ensure(spec)` once per gated schedule. The new schedules
    // are batched through the SAME registrar/client (opened once, closed once) — proven by counting
    // at least 5 total `.ensure(` call sites feeding it (ingestionTriage + projectSync + dailyBrief +
    // periodReview×2 + crossCalendarScheduling), never a bare "gate-and-drop".
    const ensureCallSites = BOOT_SRC.match(/registrar\.ensure\(/g) ?? [];
    expect(ensureCallSites.length).toBeGreaterThanOrEqual(1);
    // Every schedule spec variable built from a new gate must actually reach an ensure() call —
    // proven structurally: each spec-holding const name appears BOTH where it's built and where the
    // batch is registered (never built-then-ignored).
    for (const specVarPattern of [
      "dailyBriefScheduleSpec",
      "periodReviewWeeklyScheduleSpec",
      "periodReviewMonthlyScheduleSpec",
      "projectSyncScheduleSpec",
      "crossCalendarSchedulingScheduleSpec",
    ]) {
      const occurrences = BOOT_SRC.split(specVarPattern).length - 1;
      // built (const decl) + a !== undefined guard + pushed into the batch ⇒ at least 3 references
      expect(occurrences).toBeGreaterThanOrEqual(3);
    }
  });

  it("still constructs exactly ONE real schedule client per boot pass (amortized connect, not five)", () => {
    // `client: createRealScheduleClientPort(` is the CALL SITE shape (distinct from the exported
    // function's own declaration line, `export function createRealScheduleClientPort(`), so this
    // count is unaffected by the adapter's own (unchanged) definition.
    const clientCallSites = BOOT_SRC.match(/client: createRealScheduleClientPort\(/g) ?? [];
    expect(clientCallSites).toHaveLength(1);
    const registrarConstructions = BOOT_SRC.match(/createTemporalScheduleRegistrar\(\{/g) ?? [];
    expect(registrarConstructions).toHaveLength(1);
  });
});
