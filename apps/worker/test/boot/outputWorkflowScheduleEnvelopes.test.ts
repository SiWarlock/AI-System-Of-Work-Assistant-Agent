// WP5 — the static schedule envelopes at boot: `buildOutputWorkflowScheduleSpecs` (the pure
// collector all six `gate*Schedule` families feed) and `loadRegisteredWorkspaceScopes` (the
// WS-2 workspace-registry read the dailyBrief/periodReview families default `scopes` off of).
//
// This suite proves the THREE invariants the WP5 brief names:
//   1. with NO schedule config, the collected spec list is EMPTY (the byte-equivalent default).
//   2. with a family armed via strict `enabled: true`, that family's spec appears AND its
//      `action.args[0]` carries the expected static envelope built from config (+ the
//      registry-derived default `scopes` when the config doesn't override it).
//   3. a truthy-but-not-`true` `enabled` value (`"true"`, `1`) does NOT arm that family — this
//      extends `outputWorkflowSchedulesBind.test.ts`'s own per-gate pins to the FULL collected
//      list, rather than replacing them.
//
// `loadRegisteredWorkspaceScopes` is pinned separately: registry-hit, absent-registry (a benign
// `not_found` miss), a genuine store fault, and a malformed/mixed-validity payload — every leg
// fails CLOSED to `[]` (or drops only the bad entries), never throws, never invents an id.
//
// The single most important pin in this file is `outputWorkflowScheduleSpecs_is_empty_by_default`
// — see its own comment for the MUTATION-PROOF transcript (recorded in the WP5 verification
// report, not re-run automatically here: flipping a gate to arm unconditionally is a temporary,
// manually-reverted source edit, not a permanent part of this suite).
import { describe, it, expect } from "vitest";
import { isErr, ok, err, workspaceId } from "@sow/contracts";
import type { WorkspaceId, Result } from "@sow/contracts";
import type { ReadModelRepository, ReadModelRecord, DbError } from "@sow/db";
import {
  buildOutputWorkflowScheduleSpecs,
  loadRegisteredWorkspaceScopes,
  DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID,
  type BootConfig,
  type OutputWorkflowScheduleSkip,
} from "../../src/boot";
import { PROOF_SPINE_TASK_QUEUE } from "../../src/temporal/registerWorker";
import type { DailyBriefScheduleArgs, PeriodReviewScheduleArgs, CrossCalendarSchedulingScheduleArgs } from "../../src/temporal/scheduleArgs";

// A minimal BootConfig fixture. `buildOutputWorkflowScheduleSpecs` reads ONLY the six
// `*Schedule` config blocks — every other BootConfig field (incl. its required `sessionToken`/
// `allowlist`/`triageDispatch`/`dispatchApproval`) is irrelevant to the function under test, so
// this fixture supplies just the schedule overrides and casts past the rest (`as unknown as`,
// not a runtime shortcut — the pure function never dereferences those fields).
function baseConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return { ...overrides } as unknown as BootConfig;
}

describe("buildOutputWorkflowScheduleSpecs — the collected output-workflow schedule spec set (WP5)", () => {
  it("outputWorkflowScheduleSpecs_is_empty_by_default — with NO schedule config, the collected list is EMPTY", () => {
    // ⛔ THE SINGLE MOST IMPORTANT PIN IN THIS PACKAGE. MUTATION-PROVEN manually (per the WP5
    // brief's explicit instruction): temporarily changed `gateDailyBriefSchedule`'s guard inside
    // `buildOutputWorkflowScheduleSpecs` from `config.dailyBriefSchedule?.enabled === true` to the
    // unconditional literal `true`, re-ran this exact test — RESULT: RED (`expect(specs).toEqual([])`
    // failed, the array held the dailyBrief spec) — then reverted the edit and re-ran to confirm
    // GREEN again. See `verification` in this task's structured report for the full transcript
    // (command, RED output, revert, GREEN output).
    const specs = buildOutputWorkflowScheduleSpecs(baseConfig(), PROOF_SPINE_TASK_QUEUE, []);
    expect(specs).toEqual([]);
  });

  it("a truthy-but-not-true dailyBriefSchedule.enabled ('\"true\"', 1) does NOT arm — extends outputWorkflowSchedulesBind.test.ts's per-gate pin to the full collected list", () => {
    for (const hostile of ["true", 1, {}, [], "yes"] as const) {
      const config = baseConfig({
        dailyBriefSchedule: { enabled: hostile as unknown as boolean, intervalMs: 86_400_000 },
      });
      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      expect(specs).toEqual([]);
    }
  });

  it("a truthy-but-not-true crossCalendarSchedulingSchedule.enabled does NOT arm", () => {
    for (const hostile of ["true", 1, {}, [], "yes"] as const) {
      const config = baseConfig({
        crossCalendarSchedulingSchedule: { enabled: hostile as unknown as boolean, intervalMs: 3_600_000 },
      });
      const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      expect(specs).toEqual([]);
    }
  });

  it("dailyBriefSchedule armed via strict enabled:true — the spec appears and args[0] carries the expected envelope, defaulting scopes off the registry", () => {
    const registryScopes = [{ workspaceId: workspaceId("ws-registered-1") }];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, intervalMs: 12 * 60 * 60 * 1000 },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, registryScopes);

    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.scheduleId).toBe("daily-brief");
    expect(spec.action.args).toHaveLength(1);
    const envelope = spec.action.args[0] as DailyBriefScheduleArgs;
    expect(envelope.intervalMs).toBe(12 * 60 * 60 * 1000);
    // No explicit catchUpWindowMs override ⇒ defaults to 2x the resolved interval.
    expect(envelope.catchUpWindowMs).toBe(24 * 60 * 60 * 1000);
    // No explicit globalWorkspaceId override ⇒ the reused Global/Coordination default.
    expect(envelope.globalWorkspaceId).toBe(DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID);
    // No explicit scopes override ⇒ the registry-derived default, threaded through verbatim.
    expect(envelope.scopes).toEqual(registryScopes);
  });

  it("dailyBriefSchedule's explicit catchUpWindowMs/globalWorkspaceId/scopes override the defaults entirely (never merged with the registry)", () => {
    const overrideWorkspace: WorkspaceId = workspaceId("ws-owner-override");
    const registryScopes = [{ workspaceId: workspaceId("ws-registered-1") }];
    const config = baseConfig({
      dailyBriefSchedule: {
        enabled: true,
        intervalMs: 86_400_000,
        catchUpWindowMs: 999,
        globalWorkspaceId: "ws-owner-override",
        scopes: [{ workspaceId: overrideWorkspace }],
      },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, registryScopes);

    const envelope = specs[0]!.action.args[0] as DailyBriefScheduleArgs;
    expect(envelope.catchUpWindowMs).toBe(999);
    expect(envelope.globalWorkspaceId).toBe(overrideWorkspace);
    expect(envelope.scopes).toEqual([{ workspaceId: overrideWorkspace }]);
    // The registry-derived set is NOT merged in alongside the explicit override.
    expect(envelope.scopes).not.toContainEqual({ workspaceId: workspaceId("ws-registered-1") });
  });

  it("periodReviewSchedule armed — BOTH cadences appear, each with its OWN catchUpWindowMs default off its OWN interval, sharing globalWorkspaceId/scopes", () => {
    const registryScopes = [{ workspaceId: workspaceId("ws-registered-2") }];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, registryScopes);

    expect(specs).toHaveLength(2);
    const weekly = specs.find((s) => s.scheduleId === "period-review-weekly")!;
    const monthly = specs.find((s) => s.scheduleId === "period-review-monthly")!;
    expect(weekly).toBeDefined();
    expect(monthly).toBeDefined();

    const weeklyEnvelope = weekly.action.args[0] as PeriodReviewScheduleArgs;
    const monthlyEnvelope = monthly.action.args[0] as PeriodReviewScheduleArgs;
    // Weekly's own default interval is 7 days ⇒ catchUpWindowMs defaults to 14 days.
    expect(weeklyEnvelope.intervalMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(weeklyEnvelope.catchUpWindowMs).toBe(14 * 24 * 60 * 60 * 1000);
    // Monthly's own default interval is 30 days ⇒ catchUpWindowMs defaults to 60 days — NOT the
    // weekly cadence's much-shorter window.
    expect(monthlyEnvelope.intervalMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(monthlyEnvelope.catchUpWindowMs).toBe(60 * 24 * 60 * 60 * 1000);
    // Both cadences share the SAME resolved globalWorkspaceId/scopes.
    expect(weeklyEnvelope.globalWorkspaceId).toBe(DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID);
    expect(monthlyEnvelope.globalWorkspaceId).toBe(DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID);
    expect(weeklyEnvelope.scopes).toEqual(registryScopes);
    expect(monthlyEnvelope.scopes).toEqual(registryScopes);
  });

  it("crossCalendarSchedulingSchedule armed — args[0] carries organizerWorkspaceId + sources, sources defaulting to [] (never registry-derived, never invented)", () => {
    const config = baseConfig({
      crossCalendarSchedulingSchedule: { enabled: true, intervalMs: 3_600_000 },
    });

    // A non-empty registryScopes MUST NOT leak into `sources` — the registry has no notion of a
    // connector sourceId, so this family never derives from it (see the config field's own doc).
    const specs = buildOutputWorkflowScheduleSpecs(
      config,
      PROOF_SPINE_TASK_QUEUE,
      [{ workspaceId: workspaceId("ws-registered-3") }],
    );

    expect(specs).toHaveLength(1);
    const envelope = specs[0]!.action.args[0] as CrossCalendarSchedulingScheduleArgs;
    expect(envelope.organizerWorkspaceId).toBe(DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID);
    expect(envelope.sources).toEqual([]);
  });

  it("crossCalendarSchedulingSchedule's explicit organizerWorkspaceId/sources override the defaults", () => {
    const owner: WorkspaceId = workspaceId("ws-organizer");
    const config = baseConfig({
      crossCalendarSchedulingSchedule: {
        enabled: true,
        intervalMs: 3_600_000,
        organizerWorkspaceId: "ws-organizer",
        sources: [{ sourceId: "cal-1", workspaceId: owner }],
      },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);

    const envelope = specs[0]!.action.args[0] as CrossCalendarSchedulingScheduleArgs;
    expect(envelope.organizerWorkspaceId).toBe(owner);
    expect(envelope.sources).toEqual([{ sourceId: "cal-1", workspaceId: owner }]);
  });

  it("ingestionTriage and projectSync gate calls are untouched by WP5 — still build/arm exactly as before", () => {
    const armedBoth = buildOutputWorkflowScheduleSpecs(
      baseConfig({
        ingestionTriageSchedule: { enabled: true },
        projectSyncSchedule: { enabled: true },
      }),
      PROOF_SPINE_TASK_QUEUE,
      [],
    );
    expect(armedBoth.map((s) => s.scheduleId).sort()).toEqual(["ingestion-triage", "project-sync"]);
    // Neither family's `args` gained a static envelope — WP5 deliberately excludes them.
    for (const spec of armedBoth) expect(spec.action.args).toEqual([]);

    const hostileNeither = buildOutputWorkflowScheduleSpecs(
      baseConfig({
        ingestionTriageSchedule: { enabled: "true" as unknown as boolean },
        projectSyncSchedule: { enabled: 1 as unknown as boolean },
      }),
      PROOF_SPINE_TASK_QUEUE,
      [],
    );
    expect(hostileNeither).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// task F3 — a malformed owner-configured workspace-id override never crashes the collected
// build. The prior shape evaluated `workspaceId(config.X)` as an ARGUMENT expression feeding the
// `gate*Schedule` call, so it ran BEFORE that gate's own `enabled !== true` early return — a
// DISARMED family carrying a malformed override still threw `InvalidIdError` out of
// `buildOutputWorkflowScheduleSpecs` and crashed `bootWorker()` (measured for every value below,
// across all three id-bearing families). MUTATION-PROVEN: reverting `resolveScheduleWorkspaceId`
// to the prior unconditional-ternary shape (evaluating `workspaceId(configured)` regardless of
// `enabled`) reds every "DISARMED" test below with a thrown `InvalidIdError`; reverting back to
// the fix restores GREEN. See `verification` in this task's structured report for the transcript.
// ---------------------------------------------------------------------------
describe("buildOutputWorkflowScheduleSpecs — task F3: a malformed workspace-id override never crashes the build (§16)", () => {
  const MALFORMED_WORKSPACE_IDS = ["", "   ", "Not A Slug!", "../../etc", "x".repeat(500)] as const;

  it("a DISARMED dailyBriefSchedule carrying a malformed globalWorkspaceId NEVER throws and registers ZERO schedules", () => {
    for (const malformed of MALFORMED_WORKSPACE_IDS) {
      const config = baseConfig({
        dailyBriefSchedule: { enabled: false, intervalMs: 86_400_000, globalWorkspaceId: malformed },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      }).not.toThrow();
      expect(specs).toEqual([]);
    }
  });

  it("a DISARMED periodReviewSchedule carrying a malformed globalWorkspaceId NEVER throws and registers ZERO schedules", () => {
    for (const malformed of MALFORMED_WORKSPACE_IDS) {
      const config = baseConfig({
        periodReviewSchedule: { enabled: false, globalWorkspaceId: malformed },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      }).not.toThrow();
      expect(specs).toEqual([]);
    }
  });

  it("a DISARMED crossCalendarSchedulingSchedule carrying a malformed organizerWorkspaceId NEVER throws and registers ZERO schedules", () => {
    for (const malformed of MALFORMED_WORKSPACE_IDS) {
      const config = baseConfig({
        crossCalendarSchedulingSchedule: { enabled: false, intervalMs: 3_600_000, organizerWorkspaceId: malformed },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      }).not.toThrow();
      expect(specs).toEqual([]);
    }
  });

  it("a disarmed config carrying a malformed id across ALL THREE id-bearing families simultaneously still boots cleanly with ZERO schedules", () => {
    for (const malformed of MALFORMED_WORKSPACE_IDS) {
      const config = baseConfig({
        dailyBriefSchedule: { enabled: false, intervalMs: 86_400_000, globalWorkspaceId: malformed },
        periodReviewSchedule: { enabled: false, globalWorkspaceId: malformed },
        crossCalendarSchedulingSchedule: { enabled: false, intervalMs: 3_600_000, organizerWorkspaceId: malformed },
      });
      let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
      expect(() => {
        specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, []);
      }).not.toThrow();
      expect(specs).toEqual([]);
    }
  });

  it("an ARMED dailyBriefSchedule with a malformed globalWorkspaceId folds to a fail-closed SKIP (never throws), reports it via onSkip, and a sibling ARMED family still registers normally", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, intervalMs: 86_400_000, globalWorkspaceId: "Not A Slug!" },
      projectSyncSchedule: { enabled: true },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) => skips.push(skip));
    }).not.toThrow();

    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_workspace_id" }]);
    // dailyBrief contributes NO spec; the sibling projectSync family (unaffected by dailyBrief's
    // malformed id) still registers — proving per-family isolation, not a whole-build blowup.
    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
  });

  it("an ARMED periodReviewSchedule with a malformed globalWorkspaceId skips BOTH the weekly and monthly specs (they share one resolved id)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, globalWorkspaceId: "../../etc" },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) => skips.push(skip));

    expect(specs).toEqual([]);
    expect(skips).toEqual([
      { family: "periodReviewWeekly", code: "invalid_workspace_id" },
      { family: "periodReviewMonthly", code: "invalid_workspace_id" },
    ]);
  });

  it("an ARMED crossCalendarSchedulingSchedule with a malformed organizerWorkspaceId folds to a fail-closed SKIP (never throws)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: { enabled: true, intervalMs: 3_600_000, organizerWorkspaceId: "x".repeat(500) },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) => skips.push(skip));
    }).not.toThrow();

    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "invalid_workspace_id" }]);
  });

  it("a well-formed workspace-id override on an ARMED family builds normally and never calls onSkip", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, intervalMs: 86_400_000, globalWorkspaceId: "ws-owner-override" },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (skip) => skips.push(skip));

    expect(specs).toHaveLength(1);
    expect(skips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadRegisteredWorkspaceScopes — the WS-2 registry read, fail-closed on every leg
// ---------------------------------------------------------------------------

function fakeReadModels(get: ReadModelRepository["get"]): ReadModelRepository {
  return {
    get,
    put: async (record: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> => ok(record),
    clear: async (): Promise<Result<void, DbError>> => ok(undefined),
  };
}

describe("loadRegisteredWorkspaceScopes — the WS-2 workspace-registry read (WP5)", () => {
  it("a hit projects every well-formed id to a scope (no brainId — the registry holds bare ids only)", async () => {
    const readModels = fakeReadModels(async () =>
      ok({
        readModelKey: "workspace_registry",
        workspaceId: undefined,
        data: { workspaceIds: ["ws-alpha", "ws-beta"] },
        rebuiltAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const scopes = await loadRegisteredWorkspaceScopes(readModels);

    expect(scopes).toEqual([{ workspaceId: workspaceId("ws-alpha") }, { workspaceId: workspaceId("ws-beta") }]);
  });

  it("a benign not_found miss (no registry row yet) degrades to []", async () => {
    const readModels = fakeReadModels(async () => err({ code: "not_found", message: "no registry row" }));

    const scopes = await loadRegisteredWorkspaceScopes(readModels);

    expect(scopes).toEqual([]);
  });

  it("a genuine store fault degrades to [] — never throws, never invents a scope", async () => {
    const readModels = fakeReadModels(async () => err({ code: "unavailable", message: "db down" }));

    const scopes = await loadRegisteredWorkspaceScopes(readModels);

    expect(scopes).toEqual([]);
  });

  it("a rejecting repo (thrown fault, not a typed err) degrades to [] — never throws across the boundary", async () => {
    const readModels = fakeReadModels(async () => {
      throw new Error("driver exploded");
    });

    await expect(loadRegisteredWorkspaceScopes(readModels)).resolves.toEqual([]);
  });

  it("a malformed payload (non-array workspaceIds, non-object data) degrades to []", async () => {
    for (const data of [null, "not-an-object", { workspaceIds: "not-an-array" }, {}]) {
      const readModels = fakeReadModels(async () =>
        ok({
          readModelKey: "workspace_registry",
          workspaceId: undefined,
          data,
          rebuiltAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const scopes = await loadRegisteredWorkspaceScopes(readModels);
      expect(scopes).toEqual([]);
    }
  });

  it("a mixed-validity workspaceIds array skips the malformed/empty entries and keeps the valid ones", async () => {
    const readModels = fakeReadModels(async () =>
      ok({
        readModelKey: "workspace_registry",
        workspaceId: undefined,
        data: { workspaceIds: ["ws-good", "", 42, null, "ws-also-good"] },
        rebuiltAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const scopes = await loadRegisteredWorkspaceScopes(readModels);

    expect(scopes).toEqual([{ workspaceId: workspaceId("ws-good") }, { workspaceId: workspaceId("ws-also-good") }]);
  });
});
