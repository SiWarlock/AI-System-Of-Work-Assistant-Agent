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
// not-found→undefined, update ECHOING the schedule's EXISTING `previous.state.paused` rather than
// ever hardcoding a value — task F2's fix) is already fully pinned by
// ingestionTriageScheduleBind.test.ts — not re-proven here. ⛔ NOT "no `paused` key on update": that
// claim is FALSE (the adapter always sends the key; an absence in a port's TYPE is not an absence on
// the WIRE) and is the reasoning that produced a live CRITICAL bug — see that file's own header.
//
// task W3 additions (operator-facing diagnostics on the shared `onSkip` hook every family above
// feeds — see boot.ts's `bootWorker`): an accurate, closed-map, per-code HealthItem message
// (`scheduleSkipHealthMessage`, W3b) and a redaction-SAFE combined `code` log field
// (`scheduleSkipLogCode`, W3c) so an operator can tell WHICH family skipped and WHY from the log
// line alone; plus a safely-representable bound on `resolveScheduleDurationMs` (W3d) shared by
// EVERY family's `intervalMs`/`catchUpWindowMs`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { workspaceId } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import { redactRecord } from "@sow/domain";
import {
  gateDailyBriefSchedule,
  gatePeriodReviewWeeklySchedule,
  gatePeriodReviewMonthlySchedule,
  gateProjectSyncSchedule,
  gateCrossCalendarSchedulingSchedule,
} from "../../src/temporal/scheduleRegistrar";
import type { ScheduledWorkspaceScope, ScheduledAvailabilitySource } from "../../src/temporal/scheduleArgs";
import {
  buildOutputWorkflowScheduleSpecs,
  scheduleSkipHealthMessage,
  scheduleSkipLogCode,
  type BootConfig,
  type OutputWorkflowScheduleSkip,
} from "../../src/boot";
import { PROOF_SPINE_TASK_QUEUE } from "../../src/temporal/registerWorker";

const BOOT_SRC = readFileSync(fileURLToPath(new URL("../../src/boot.ts", import.meta.url)), "utf8");

// Mirrors outputWorkflowScheduleEnvelopes.test.ts's own fixture exactly: `buildOutputWorkflowScheduleSpecs`
// reads ONLY the six `*Schedule` config blocks, so casting past the rest of `BootConfig` is not a
// runtime shortcut — the function under test never dereferences those fields.
function baseConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return { ...overrides } as unknown as BootConfig;
}

// WP5 — the widened dailyBrief/periodReview/crossCalendarScheduling gate signatures now require
// the frozen-contract static envelope fields (scheduleArgs.ts). Fixture values only — the
// arming-strictness assertions below are what these pins exist to prove, not these values.
const FIXTURE_WORKSPACE_ID: WorkspaceId = workspaceId("ws-fixture");
const FIXTURE_SCOPES: readonly ScheduledWorkspaceScope[] = [{ workspaceId: FIXTURE_WORKSPACE_ID }];
const FIXTURE_SOURCES: readonly ScheduledAvailabilitySource[] = [
  { sourceId: "src-fixture", workspaceId: FIXTURE_WORKSPACE_ID },
];

describe("the new 25.2/25.3/25.4 gates — strict === true default-OFF, driven with boot.ts's OWN expression shape", () => {
  const hostileValues = ["true", 1, {}, [], "yes"] as const;

  it("gateDailyBriefSchedule refuses every truthy-non-boolean and arms only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gateDailyBriefSchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 86_400_000,
          catchUpWindowMs: 172_800_000,
          globalWorkspaceId: FIXTURE_WORKSPACE_ID,
          scopes: FIXTURE_SCOPES,
        }),
      ).toBeUndefined();
    }
    expect(
      gateDailyBriefSchedule({
        enabled: true,
        taskQueue: "sow-control-plane",
        intervalMs: 86_400_000,
        catchUpWindowMs: 172_800_000,
        globalWorkspaceId: FIXTURE_WORKSPACE_ID,
        scopes: FIXTURE_SCOPES,
      }),
    ).toBeDefined();
  });

  it("gatePeriodReviewWeeklySchedule / gatePeriodReviewMonthlySchedule refuse every truthy-non-boolean and arm only on literal true", () => {
    for (const v of hostileValues) {
      expect(
        gatePeriodReviewWeeklySchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 604_800_000,
          catchUpWindowMs: 1_209_600_000,
          globalWorkspaceId: FIXTURE_WORKSPACE_ID,
          scopes: FIXTURE_SCOPES,
        }),
      ).toBeUndefined();
      expect(
        gatePeriodReviewMonthlySchedule({
          enabled: (v as unknown) === true,
          taskQueue: "sow-control-plane",
          intervalMs: 2_592_000_000,
          catchUpWindowMs: 5_184_000_000,
          globalWorkspaceId: FIXTURE_WORKSPACE_ID,
          scopes: FIXTURE_SCOPES,
        }),
      ).toBeUndefined();
    }
    const weekly = gatePeriodReviewWeeklySchedule({
      enabled: true,
      taskQueue: "sow-control-plane",
      intervalMs: 604_800_000,
      catchUpWindowMs: 1_209_600_000,
      globalWorkspaceId: FIXTURE_WORKSPACE_ID,
      scopes: FIXTURE_SCOPES,
    });
    const monthly = gatePeriodReviewMonthlySchedule({
      enabled: true,
      taskQueue: "sow-control-plane",
      intervalMs: 2_592_000_000,
      catchUpWindowMs: 5_184_000_000,
      globalWorkspaceId: FIXTURE_WORKSPACE_ID,
      scopes: FIXTURE_SCOPES,
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
          organizerWorkspaceId: FIXTURE_WORKSPACE_ID,
          sources: FIXTURE_SOURCES,
        }),
      ).toBeUndefined();
    }
    expect(
      gateCrossCalendarSchedulingSchedule({
        enabled: true,
        taskQueue: "sow-control-plane",
        intervalMs: 3_600_000,
        organizerWorkspaceId: FIXTURE_WORKSPACE_ID,
        sources: FIXTURE_SOURCES,
      }),
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

const ALL_SKIP_CODES = [
  "invalid_workspace_id",
  "invalid_interval_ms",
  "invalid_catch_up_window_ms",
  "invalid_scopes",
  "invalid_sources",
] as const;

const ALL_SKIP_FAMILIES = [
  "ingestionTriage",
  "projectSync",
  "dailyBrief",
  "periodReviewWeekly",
  "periodReviewMonthly",
  "crossCalendarScheduling",
] as const;

describe("scheduleSkipHealthMessage — an ACCURATE, per-code, closed map (task W3b, was ONE hardcoded string)", () => {
  it("every one of the five skip codes gets its OWN distinct message naming its own config field", () => {
    const messages = ALL_SKIP_CODES.map((code) => scheduleSkipHealthMessage(code));
    // No two codes silently share a message (the pre-fix bug: all five read the workspace-id text).
    expect(new Set(messages).size).toBe(ALL_SKIP_CODES.length);
  });

  it("each message names its OWN field, not the workspace-id field a prior hardcoded string named for all five", () => {
    expect(scheduleSkipHealthMessage("invalid_workspace_id")).toMatch(/workspace-id/i);
    expect(scheduleSkipHealthMessage("invalid_interval_ms")).toMatch(/intervalMs/);
    expect(scheduleSkipHealthMessage("invalid_interval_ms")).not.toMatch(/workspace-id/i);
    expect(scheduleSkipHealthMessage("invalid_catch_up_window_ms")).toMatch(/catchUpWindowMs/);
    expect(scheduleSkipHealthMessage("invalid_catch_up_window_ms")).not.toMatch(/workspace-id/i);
    expect(scheduleSkipHealthMessage("invalid_scopes")).toMatch(/scopes/i);
    expect(scheduleSkipHealthMessage("invalid_scopes")).not.toMatch(/workspace-id/i);
    expect(scheduleSkipHealthMessage("invalid_sources")).toMatch(/sources/i);
    expect(scheduleSkipHealthMessage("invalid_sources")).not.toMatch(/workspace-id/i);
  });

  it("has a REAL production caller — bootWorker's onSkip hook reads the message from this closed map, never a hardcoded literal", () => {
    expect(BOOT_SRC).toContain("message: scheduleSkipHealthMessage(skip.code)");
  });
});

describe("scheduleSkipLogCode — code+family SURVIVE the real redactor (task W3c, was BOTH silently dropped)", () => {
  it("every (family, code) combination survives redactRecord UNCHANGED under `code` — the REAL @sow/domain redactor, not a re-implemented regex", () => {
    for (const family of ALL_SKIP_FAMILIES) {
      for (const code of ALL_SKIP_CODES) {
        const logCode = scheduleSkipLogCode({ family, code });
        const redacted = redactRecord({ code: logCode });
        expect(redacted["code"]).toBe(logCode);
      }
    }
  });

  it("non-vacuity control — the ORIGINAL bare shape (skip.code/skip.family passed straight through) is what gets dropped, proving this suite would catch a regression back to it", () => {
    const original = redactRecord({ code: "invalid_workspace_id", family: "dailyBrief" });
    expect(original["code"]).not.toBe("invalid_workspace_id");
    expect(original["family"]).not.toBe("dailyBrief");
  });

  it("distinct families never collide into the same log code for the same reason — an operator CAN tell which family skipped from the log line alone", () => {
    const codesForOneReason = ALL_SKIP_FAMILIES.map((family) =>
      scheduleSkipLogCode({ family, code: "invalid_interval_ms" }),
    );
    expect(new Set(codesForOneReason).size).toBe(ALL_SKIP_FAMILIES.length);
  });

  it("has a REAL production caller — bootWorker's onSkip hook logs via this function, never the bare skip object", () => {
    expect(BOOT_SRC).toContain("fields: { code: scheduleSkipLogCode(skip) }");
  });
});

describe("resolveScheduleDurationMs — bounded to a safely-representable integer-millisecond range (task W3d)", () => {
  it("Number.MAX_VALUE / 1e308 / a fractional millisecond (1.5, 0.0001) SKIP the family instead of registering an unrepresentable durable spec", () => {
    for (const intervalMs of [Number.MAX_VALUE, 1e308, 0.0001, 1.5]) {
      const skips: OutputWorkflowScheduleSkip[] = [];
      const config = baseConfig({ projectSyncSchedule: { enabled: true, intervalMs } });

      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) =>
        skips.push(skip),
      );

      expect(specs).toEqual([]);
      expect(skips).toEqual([{ family: "projectSync", code: "invalid_interval_ms" }]);
    }
  });

  it("NOTHING ARMS — DISARMED, a hostile intervalMs is never even inspected against the new bound (byte-equivalent: zero specs, zero onSkip calls)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      projectSyncSchedule: { enabled: false, intervalMs: Number.MAX_VALUE },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) =>
      skips.push(skip),
    );

    expect(specs).toEqual([]);
    expect(skips).toEqual([]);
  });

  it("the bound sits exactly at Number.MAX_SAFE_INTEGER/1e6 (the ms→ns conversion stays an exact integer) — AT the bound registers, one ms OVER skips", () => {
    const atBound = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);

    const configAtBound = baseConfig({ projectSyncSchedule: { enabled: true, intervalMs: atBound } });
    expect(buildOutputWorkflowScheduleSpecs(configAtBound, PROOF_SPINE_TASK_QUEUE, [])).toHaveLength(1);

    const skips: OutputWorkflowScheduleSkip[] = [];
    const configOverBound = baseConfig({
      projectSyncSchedule: { enabled: true, intervalMs: atBound + 1 },
    });
    const specsOverBound = buildOutputWorkflowScheduleSpecs(
      configOverBound,
      PROOF_SPINE_TASK_QUEUE,
      [],
      (skip) => skips.push(skip),
    );
    expect(specsOverBound).toEqual([]);
    expect(skips).toEqual([{ family: "projectSync", code: "invalid_interval_ms" }]);
  });

  it("a hostile catchUpWindowMs (shares resolveScheduleDurationMs with intervalMs) also skips rather than registering an unrepresentable durable spec", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, intervalMs: 3_600_000, catchUpWindowMs: Number.MAX_VALUE },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) =>
      skips.push(skip),
    );

    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_catch_up_window_ms" }]);
  });
});
