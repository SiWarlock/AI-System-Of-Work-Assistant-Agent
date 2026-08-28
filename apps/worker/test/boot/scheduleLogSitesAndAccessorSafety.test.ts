// task M3 — the schedule log sites: the redaction fix (scheduleSkipLogCode / task W3c) landed on
// ONLY the `schedule.envelope_invalid` builder-side skip. A final audit found the SAME redaction
// gap on three sibling log sites inside `bootWorker`'s registrar-ensure loop, plus two separate
// defects surfaced alongside them:
//
//   M3a — `schedule.ensure_failed` / `schedule.ensured` / `schedule.client_unavailable` all sent a
//   bare `scheduleId` field (not on @sow/domain's field-name allowlist ⇒ dropped whole) and/or a
//   lower_snake `code` value (fails the `code` field's STRUCTURED_CODE vocabulary ⇒ dropped raw) —
//   an operator watching these lines could not tell WHICH schedule succeeded, failed, or why.
//   `scheduleEnsureFailedLogCode` / `scheduleEnsuredLogCode` fold scheduleId+reason into ONE
//   UPPER_SNAKE `code`, exactly like `scheduleSkipLogCode` already does for family+code.
//
//   M3b — `resolveScheduleDurationMs` validated an owner-supplied `configured` value but returned
//   the FALLBACK unvalidated. The dailyBrief/periodReview `catchUpWindowMs` fallback is DERIVED as
//   `2 * <that family's own resolved intervalMs>`, so an intervalMs past half the representable
//   bound doubles to a fallback PAST the bound the function's own doc declares — silently, with no
//   owner override in sight. Fixed by validating whichever value (`configured` or `fallback`) the
//   function is about to return.
//
//   M3c — `buildOutputWorkflowScheduleSpecs` reads each family's config block via plain property
//   access (`config.dailyBriefSchedule?.enabled`, etc.) — a hostile/proxied config object with a
//   throwing accessor previously escaped this function entirely (§16), aborting every family queued
//   after the one that threw. Each family's block is now wrapped in its own try/catch, converting an
//   unexpected throw into a typed `config_access_threw` skip for THAT family only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { redactRecord } from "@sow/domain";
import {
  buildOutputWorkflowScheduleSpecs,
  scheduleEnsureFailedLogCode,
  scheduleEnsuredLogCode,
  scheduleSkipHealthMessage,
  scheduleSkipLogCode,
  type BootConfig,
  type OutputWorkflowScheduleSkip,
} from "../../src/boot";
import {
  INGESTION_TRIAGE_SCHEDULE_ID,
  PROJECT_SYNC_SCHEDULE_ID,
  DAILY_BRIEF_SCHEDULE_ID,
  PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
  PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
  CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
  type ScheduleRegistrarErrorCode,
} from "../../src/temporal/scheduleRegistrar";
import { PROOF_SPINE_TASK_QUEUE } from "../../src/temporal/registerWorker";
import type { DailyBriefScheduleArgs } from "../../src/temporal/scheduleArgs";

const BOOT_SRC = readFileSync(fileURLToPath(new URL("../../src/boot.ts", import.meta.url)), "utf8");

// Mirrors every sibling schedule test file's own fixture helper exactly — `buildOutputWorkflowScheduleSpecs`
// reads ONLY the six `*Schedule` config blocks, so casting past the rest of `BootConfig` is safe.
function baseConfig(overrides: Partial<BootConfig> = {}): BootConfig {
  return { ...overrides } as unknown as BootConfig;
}

const ALL_SCHEDULE_IDS = [
  INGESTION_TRIAGE_SCHEDULE_ID,
  PROJECT_SYNC_SCHEDULE_ID,
  DAILY_BRIEF_SCHEDULE_ID,
  PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
  PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
  CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
] as const;

// The registrar's error-code union has exactly ONE member today (scheduleRegistrar.ts). Used as-is
// rather than re-declared, so this suite fails to compile (not silently passes) if that ever widens.
const ONLY_ERROR_CODE: ScheduleRegistrarErrorCode = "schedule_client_fault";

describe("M3a — scheduleEnsureFailedLogCode / scheduleEnsuredLogCode SURVIVE the real redactor (was BOTH silently dropped)", () => {
  it("every known scheduleId x the registrar's own error code survives redactRecord unchanged under `code`", () => {
    for (const scheduleId of ALL_SCHEDULE_IDS) {
      const logCode = scheduleEnsureFailedLogCode(scheduleId, ONLY_ERROR_CODE);
      const redacted = redactRecord({ code: logCode });
      expect(redacted["code"]).toBe(logCode);
    }
  });

  it("every known scheduleId x both ensure actions survives redactRecord unchanged under `code`", () => {
    for (const scheduleId of ALL_SCHEDULE_IDS) {
      for (const action of ["created", "updated"] as const) {
        const logCode = scheduleEnsuredLogCode(scheduleId, action);
        const redacted = redactRecord({ code: logCode });
        expect(redacted["code"]).toBe(logCode);
      }
    }
  });

  it("distinct scheduleIds never collide into the same code — an operator CAN tell which schedule from the log line alone", () => {
    const failedCodes = ALL_SCHEDULE_IDS.map((id) => scheduleEnsureFailedLogCode(id, ONLY_ERROR_CODE));
    expect(new Set(failedCodes).size).toBe(ALL_SCHEDULE_IDS.length);
    const ensuredCodes = ALL_SCHEDULE_IDS.map((id) => scheduleEnsuredLogCode(id, "created"));
    expect(new Set(ensuredCodes).size).toBe(ALL_SCHEDULE_IDS.length);
    // created vs updated also stay distinct for the SAME schedule.
    expect(scheduleEnsuredLogCode(DAILY_BRIEF_SCHEDULE_ID, "created")).not.toBe(
      scheduleEnsuredLogCode(DAILY_BRIEF_SCHEDULE_ID, "updated"),
    );
  });

  it("an id outside the closed six falls back to a fixed safe token, never echoing the raw id — and still survives the redactor", () => {
    const hostileId = "../../etc/some-injected-id";
    const logCode = scheduleEnsureFailedLogCode(hostileId, ONLY_ERROR_CODE);
    expect(logCode).not.toContain(hostileId);
    expect(logCode.startsWith("UNKNOWN_SCHEDULE_")).toBe(true);
    expect(redactRecord({ code: logCode })["code"]).toBe(logCode);
  });

  it("non-vacuity control — the ORIGINAL bare shape (registrar's lower_snake code + a separate scheduleId field) is what gets dropped, proving this suite would catch a regression back to it", () => {
    const original = redactRecord({ code: ONLY_ERROR_CODE, scheduleId: DAILY_BRIEF_SCHEDULE_ID });
    expect(original["code"]).not.toBe(ONLY_ERROR_CODE);
    expect(original["scheduleId"]).not.toBe(DAILY_BRIEF_SCHEDULE_ID);
  });

  it("the fourth site's fix is a case change only — lower_snake `client_build_failed` also fails the redactor; UPPER_SNAKE survives", () => {
    expect(redactRecord({ code: "client_build_failed" })["code"]).not.toBe("client_build_failed");
    expect(redactRecord({ code: "CLIENT_BUILD_FAILED" })["code"]).toBe("CLIENT_BUILD_FAILED");
  });

  it("has REAL production callers — all three previously-broken log sites use the fixed shape, never the bare original", () => {
    expect(BOOT_SRC).toContain(
      "fields: { code: scheduleEnsureFailedLogCode(spec.scheduleId, outcome.error.code) }",
    );
    expect(BOOT_SRC).toContain(
      "fields: { code: scheduleEnsuredLogCode(spec.scheduleId, outcome.value.action) }",
    );
    expect(BOOT_SRC).toContain('fields: { code: "CLIENT_BUILD_FAILED" }');
    // The bare original shapes are gone from the registrar-ensure loop.
    expect(BOOT_SRC).not.toContain("code: outcome.error.code, scheduleId: spec.scheduleId");
    expect(BOOT_SRC).not.toContain("action: outcome.value.action, scheduleId: spec.scheduleId");
  });

  // R4 finding 4 — the vault-watcher's `vault.watch.temporal_client_unavailable` site and the
  // registrar-ensure loop's `schedule.client_unavailable` site are TWO NEIGHBOURING catch-arm log
  // sites emitting the identical fixed, owner-data-free `CLIENT_BUILD_FAILED` literal on a client-
  // build fault. A prior M3a follow-up fixed the casing at the registrar site but missed the
  // vault-watcher one, leaving them disagreeing on redactor survival (lower_snake ⇒
  // `[REDACTED:raw]`, dropping the diagnostic for no reason — see the M3a positive control above).
  // Anchors EACH site's own call individually (not just "the literal exists somewhere in the file",
  // which the assertion above can't distinguish from "only one of the two sites is fixed") — a
  // regression at EITHER site alone fails this test.
  it("BOTH neighbouring client-build-fault sites (vault-watcher + schedule registrar) use the SAME UPPER_SNAKE code — neither regressed to lower_snake", () => {
    expect(BOOT_SRC).toContain(
      'backends.logger.warn("vault.watch.temporal_client_unavailable", { fields: { code: "CLIENT_BUILD_FAILED" } });',
    );
    expect(BOOT_SRC).toContain('backends.logger.warn("schedule.client_unavailable", {');
    // No site anywhere in boot.ts still emits the lower_snake variant that fails the redactor.
    expect(BOOT_SRC).not.toContain('code: "client_build_failed"');
  });
});

describe("M3b — resolveScheduleDurationMs validates the DERIVED catchUpWindowMs fallback, not just an explicit override (was silently unvalidated)", () => {
  // Mirrors resolveScheduleDurationMs's own bound exactly (outputWorkflowSchedulesBind.test.ts's
  // own `atBound` fixture uses the identical expression).
  const MAX = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);
  const AT_BOUND_HALF = Math.floor(MAX / 2); // doubled === MAX exactly (2 * 4_503_599_627 = MAX)
  const OVER_BOUND_HALF = AT_BOUND_HALF + 1; // doubled === MAX + 2 (over by the smallest margin)

  it("dailyBriefSchedule: intervalMs whose DOUBLED fallback lands EXACTLY at the bound still registers (no catchUpWindowMs override)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({ dailyBriefSchedule: { enabled: true, intervalMs: AT_BOUND_HALF } });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(skips).toEqual([]);
    expect(specs).toHaveLength(1);
    const envelope = specs[0]!.action.args[0] as DailyBriefScheduleArgs;
    expect(envelope.catchUpWindowMs).toBe(2 * AT_BOUND_HALF);
    expect(envelope.catchUpWindowMs).toBe(MAX);
  });

  it("dailyBriefSchedule: intervalMs one past that point doubles PAST the bound — SKIPS instead of registering an unrepresentable durable catch-up window (task M3b, was silently registered)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({ dailyBriefSchedule: { enabled: true, intervalMs: OVER_BOUND_HALF } });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_catch_up_window_ms" }]);
  });

  it("periodReviewSchedule weekly cadence: the SAME derived-fallback bound applies to weeklyIntervalMs's OWN catch-up window, isolated from the (unaffected) monthly cadence", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, weeklyIntervalMs: OVER_BOUND_HALF },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["period-review-monthly"]);
    expect(skips).toEqual([{ family: "periodReviewWeekly", code: "invalid_catch_up_window_ms" }]);
  });

  it("periodReviewSchedule monthly cadence: the SAME bound applies to monthlyIntervalMs's OWN catch-up window", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: { enabled: true, monthlyIntervalMs: OVER_BOUND_HALF },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["period-review-weekly"]);
    expect(skips).toEqual([{ family: "periodReviewMonthly", code: "invalid_catch_up_window_ms" }]);
  });

  it("an EXPLICIT catchUpWindowMs override is unaffected by this fix — still validated exactly as before (regression guard)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, intervalMs: 3_600_000, catchUpWindowMs: NaN },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "invalid_catch_up_window_ms" }]);
  });

  it("a DISARMED family's hostile catchUpWindowMs-driving intervalMs is still never inspected (the disarmed-path invariant survives this fix)", () => {
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: false, intervalMs: OVER_BOUND_HALF },
    });
    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs).toEqual([]);
    expect(skips).toEqual([]);
  });

  // ⛔ MUTATION-PROVEN (this task): temporarily reverted `resolveScheduleDurationMs` to the PRE-M3b
  // shape —
  //   if (enabled !== true || configured === undefined) return { ok: true, value: fallback };
  //   if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured <= 0 ||
  //       configured > MAX_REPRESENTABLE_SCHEDULE_DURATION_MS) { return { ok: false }; }
  //   return { ok: true, value: configured };
  // — re-ran ONLY this file. RESULT: RED — "intervalMs one past that point doubles PAST the bound"
  // failed (`specs` held 1 spec with `catchUpWindowMs: 9007199256`, `skips` was `[]`, instead of the
  // expected skip) — the exact silent-registration bug M3b closes. The "still registers" / "explicit
  // override" / "disarmed" pins stayed GREEN under the mutation (they don't exercise the derived-
  // fallback path), confirming this ONE test is what actually pins the fix. Reverted the edit and
  // re-ran to confirm GREEN again (all tests in this file passing, `tsc --noEmit` clean). Full
  // command transcript in this task's structured report `verification` field.
});

describe("M3c — a throwing config-block property accessor SKIPS that family instead of escaping buildOutputWorkflowScheduleSpecs (§16)", () => {
  it("a throwing `enabled` getter on dailyBriefSchedule skips dailyBrief only — sibling families still register, function never throws", () => {
    const hostileBlock: Record<string, unknown> = {};
    Object.defineProperty(hostileBlock, "enabled", {
      get(): boolean {
        throw new Error("BOOM enabled getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: hostileBlock as unknown as BootConfig["dailyBriefSchedule"],
      projectSyncSchedule: { enabled: true },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    }).not.toThrow();

    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "config_access_threw" }]);
  });

  it("a throwing `intervalMs` getter on ingestionTriageSchedule skips ingestionTriage only", () => {
    const hostileBlock: Record<string, unknown> = { enabled: true };
    Object.defineProperty(hostileBlock, "intervalMs", {
      get(): number {
        throw new Error("BOOM intervalMs getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      ingestionTriageSchedule: hostileBlock as unknown as BootConfig["ingestionTriageSchedule"],
      projectSyncSchedule: { enabled: true },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    }).not.toThrow();

    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
    expect(skips).toEqual([{ family: "ingestionTriage", code: "config_access_threw" }]);
  });

  it("a throwing `workspaceId` getter on a dailyBriefSchedule.scopes ENTRY skips dailyBrief only (propagates up through resolveScheduleScopes's own iteration)", () => {
    const hostileEntry: Record<string, unknown> = {};
    Object.defineProperty(hostileEntry, "workspaceId", {
      get(): string {
        throw new Error("BOOM workspaceId getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      dailyBriefSchedule: { enabled: true, scopes: [hostileEntry] as unknown as never },
      projectSyncSchedule: { enabled: true },
    });

    let specs: ReturnType<typeof buildOutputWorkflowScheduleSpecs> = [];
    expect(() => {
      specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    }).not.toThrow();

    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
    expect(skips).toEqual([{ family: "dailyBrief", code: "config_access_threw" }]);
  });

  it("a throwing periodReviewSchedule.enabled getter skips BOTH weekly and monthly cadences, never one alone (shared config block)", () => {
    const hostileBlock: Record<string, unknown> = {};
    Object.defineProperty(hostileBlock, "enabled", {
      get(): boolean {
        throw new Error("BOOM period-review enabled getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      periodReviewSchedule: hostileBlock as unknown as BootConfig["periodReviewSchedule"],
      projectSyncSchedule: { enabled: true },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));

    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
    expect(skips).toEqual(
      expect.arrayContaining([
        { family: "periodReviewWeekly", code: "config_access_threw" },
        { family: "periodReviewMonthly", code: "config_access_threw" },
      ]),
    );
    expect(skips).toHaveLength(2);
  });

  it("a throwing crossCalendarSchedulingSchedule.enabled getter skips that family only", () => {
    const hostileBlock: Record<string, unknown> = {};
    Object.defineProperty(hostileBlock, "enabled", {
      get(): boolean {
        throw new Error("BOOM cross-calendar enabled getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      crossCalendarSchedulingSchedule: hostileBlock as unknown as BootConfig["crossCalendarSchedulingSchedule"],
      projectSyncSchedule: { enabled: true },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["project-sync"]);
    expect(skips).toEqual([{ family: "crossCalendarScheduling", code: "config_access_threw" }]);
  });

  it("a throwing projectSyncSchedule.enabled getter skips that family only", () => {
    const hostileBlock: Record<string, unknown> = {};
    Object.defineProperty(hostileBlock, "enabled", {
      get(): boolean {
        throw new Error("BOOM project-sync enabled getter");
      },
    });
    const skips: OutputWorkflowScheduleSkip[] = [];
    const config = baseConfig({
      projectSyncSchedule: hostileBlock as unknown as BootConfig["projectSyncSchedule"],
      ingestionTriageSchedule: { enabled: true },
    });

    const specs = buildOutputWorkflowScheduleSpecs(config, PROOF_SPINE_TASK_QUEUE, [], (s) => skips.push(s));
    expect(specs.map((s) => s.scheduleId)).toEqual(["ingestion-triage"]);
    expect(skips).toEqual([{ family: "projectSync", code: "config_access_threw" }]);
  });

  it("scheduleSkipHealthMessage / scheduleSkipLogCode both cover the new config_access_threw code, and the log code survives the real redactor", () => {
    expect(scheduleSkipHealthMessage("config_access_threw")).toMatch(/unexpected error/i);
    const logCode = scheduleSkipLogCode({ family: "dailyBrief", code: "config_access_threw" });
    expect(logCode).toBe("DAILY_BRIEF_CONFIG_ACCESS_THREW");
    expect(redactRecord({ code: logCode })["code"]).toBe(logCode);
  });

  // ⛔ MUTATION-PROVEN (this task): temporarily removed the dailyBrief block's `try { … } catch {
  // onSkip?.({ family: "dailyBrief", code: "config_access_threw" }); }` wrapper in boot.ts (restoring
  // the block to a bare, unwrapped sequence of statements) and re-ran ONLY this file. RESULT: RED —
  // BOTH the "throwing `enabled` getter" pin AND the "workspaceId getter on a scopes entry" pin
  // failed identically: the call now threw `Error: BOOM … getter` OUT OF
  // `buildOutputWorkflowScheduleSpecs` entirely, so `expect(() => { … }).not.toThrow()` itself
  // failed (the whole function call aborts mid-flight — `specs` is never assigned, the `onSkip`
  // callback is never invoked for `dailyBrief`, and `projectSync`'s already-built spec, though
  // pushed into the function's LOCAL array before the throw, is never returned to the caller either,
  // since the function never reaches `return specs;`). Every OTHER family's own throwing-accessor
  // pin (ingestionTriage/projectSync/periodReview/crossCalendarScheduling) is an INDEPENDENT
  // try/catch in source and stayed GREEN under this single-block mutation, confirming the isolation
  // claim: removing ONE family's wrapper breaks ONLY that family's pin. Reverted the edit and re-ran
  // to confirm GREEN again (all tests in this file passing, `tsc --noEmit` clean). Full command
  // transcript in this task's structured report `verification` field.
});
