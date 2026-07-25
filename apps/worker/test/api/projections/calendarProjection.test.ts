// Task 9.9a (§11 Calendar surface, Flow 3 / REQ-F-009 + §10 read-model + §5/WS-8) — the write-time
// calendar-availability PRODUCER core + the `toUiSafeScheduleEntry` drop-seam. RED first.
//
// The producer maps GCL-sanitized busy windows → `UiSafeScheduleEntry[]` and upserts the GLOBAL
// (workspaceId = null) `schedule` read-model row `query.calendar` serves. It applies BOTH ui-safe.ts-
// deferred cross-field invariants AT WRITE (`start <= end`; `busy === false ⇒ conflictExplanation`
// absent — the producer only ever emits busy=true, so the free clause holds by construction), carries
// ZERO source/workspace/timing attribution (WS-8), keeps `conflictExplanation` GENERIC-only (from the
// window's `genericReason`, single-line-bounded — never a raw title/attendee/body), and on an
// UNREACHABLE availability read returns a typed err with ZERO write (REQ-F-009 no-silent-free — never
// overwrites the row with a free-looking schedule). Ships DORMANT (no caller — the
// buildProofSpineActivities binding is a DEFERRED follow-up, empty-until-wired).
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { UiSafeScheduleEntry } from "@sow/contracts";
import type { ReadModelRepository, ReadModelRecord, DbResult, DbError } from "@sow/db";
import {
  createCalendarProjectionPort,
  type CalendarProjectionDeps,
} from "../../../src/api/projections/calendarProjection";
import { toUiSafeScheduleEntry, type ScheduleWindowSource } from "../../../src/api/projections/uiSafe";
import { READ_MODEL_KEYS } from "../../../src/api/adapters/readModel";

const NOW = "2026-07-25T12:00:00.000Z";
const notFound: DbError = { code: "not_found", message: "absent" } as DbError;

/** A fake read-model repo capturing every `put` (empty on read — the dormant producer's first refresh). */
function fakeRepo(): { repo: ReadModelRepository; puts: ReadModelRecord[] } {
  const puts: ReadModelRecord[] = [];
  const repo: ReadModelRepository = {
    get: (): DbResult<ReadModelRecord> => Promise.resolve({ ok: false, error: notFound }),
    put: (record: ReadModelRecord): DbResult<ReadModelRecord> => {
      puts.push(record);
      return Promise.resolve({ ok: true, value: record });
    },
    clear: (): DbResult<void> => Promise.resolve({ ok: true, value: undefined }),
  };
  return { repo, puts };
}

const availabilityOk =
  (busyWindows: ScheduleWindowSource[]): CalendarProjectionDeps["availability"] =>
  () =>
    Promise.resolve({ ok: true, value: { busyWindows } });

const availabilityUnreachable: CalendarProjectionDeps["availability"] = () =>
  Promise.resolve({ ok: false, error: { code: "calendar_unreachable", message: "connector down" } });

/** Read the entries the producer wrote out of the single captured put. */
function writtenEntries(puts: ReadModelRecord[]): readonly UiSafeScheduleEntry[] {
  expect(puts.length).toBe(1);
  return (puts[0]!.data as { entries: readonly UiSafeScheduleEntry[] }).entries;
}

const ENTRY_KEYS = new Set(["start", "end", "busy", "conflictExplanation"]);

describe("§9.9a calendar read-model producer (Flow 3 / REQ-F-009 / WS-8)", () => {
  it("producer_maps_busy_windows_to_uisafe_entries — GCL busy windows → valid UiSafeScheduleEntry[] on the GLOBAL schedule row", async () => {
    const { repo, puts } = fakeRepo();
    const port = createCalendarProjectionPort({
      availability: availabilityOk([
        { sourceId: "cal-a", start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", genericReason: "busy" },
        { sourceId: "cal-b", start: "2026-07-25T14:00:00.000Z", end: "2026-07-25T15:30:00.000Z" },
      ]),
      readModels: repo,
      now: () => NOW,
    });
    const r = await port.refresh();
    expect(isOk(r)).toBe(true);
    expect(puts[0]!.readModelKey).toBe(READ_MODEL_KEYS.schedule);
    expect(puts[0]!.workspaceId).toBeUndefined(); // GLOBAL merged view — workspaceId OMITTED (WS-8; no workspace input)
    expect(puts[0]!.rebuiltAt).toBe(NOW);
    expect(writtenEntries(puts)).toEqual([
      { start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", busy: true, conflictExplanation: "busy" },
      { start: "2026-07-25T14:00:00.000Z", end: "2026-07-25T15:30:00.000Z", busy: true },
    ]);
  });

  it("conflict_explanation_generic_only_no_raw — conflictExplanation comes ONLY from the window's genericReason; a raw field never rides through", async () => {
    // toUiSafeScheduleEntry copies ONLY start/end (→ busy:true) + genericReason (→ conflictExplanation).
    // A hostile window carrying raw event detail on a non-allowlisted key never reaches the entry.
    const hostile = {
      sourceId: "cal-a",
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T10:00:00.000Z",
      genericReason: "busy",
      title: "1:1 with CEO re: layoffs", // raw — must NOT ride through
      attendees: ["ceo@corp.example"],
    } as unknown as ScheduleWindowSource;
    const entry = toUiSafeScheduleEntry(hostile);
    expect(entry).not.toBeNull();
    expect(new Set(Object.keys(entry!))).toEqual(ENTRY_KEYS);
    expect(entry!.conflictExplanation).toBe("busy");
  });

  it("no_workspace_or_timing_attribution_leak — windows from ≥2 workspaces emit entries with ZERO source/workspace attribution", async () => {
    const { repo, puts } = fakeRepo();
    const port = createCalendarProjectionPort({
      availability: availabilityOk([
        { sourceId: "employer-cal", start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", genericReason: "busy" },
        { sourceId: "personal-cal", start: "2026-07-25T11:00:00.000Z", end: "2026-07-25T12:00:00.000Z", genericReason: "tentative" },
      ]),
      readModels: repo,
      now: () => NOW,
    });
    await port.refresh();
    for (const entry of writtenEntries(puts)) {
      // Structurally no sourceId / workspaceId — the entry shape can't carry attribution.
      const keys = new Set(Object.keys(entry));
      expect(keys.has("sourceId")).toBe(false);
      expect(keys.has("workspaceId")).toBe(false);
      for (const k of keys) expect(ENTRY_KEYS.has(k)).toBe(true);
    }
  });

  it("busy_false_no_explanation_and_start_le_end — the two deferred cross-field invariants hold AT WRITE (malformed start>end DROPPED; every entry busy=true)", async () => {
    const { repo, puts } = fakeRepo();
    const port = createCalendarProjectionPort({
      availability: availabilityOk([
        { sourceId: "cal-a", start: "2026-07-25T10:00:00.000Z", end: "2026-07-25T09:00:00.000Z", genericReason: "inverted" }, // start>end → DROP
        { sourceId: "cal-a", start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", genericReason: "busy" }, // ok
      ]),
      readModels: repo,
      now: () => NOW,
    });
    await port.refresh();
    const entries = writtenEntries(puts);
    expect(entries.length).toBe(1); // the inverted window dropped
    for (const e of entries) {
      expect(Date.parse(e.start)).toBeLessThanOrEqual(Date.parse(e.end)); // (a) start<=end
      expect(e.busy).toBe(true);
      if (e.busy === false) expect(e.conflictExplanation).toBeUndefined(); // (b) free ⇒ no explanation (vacuous here, asserted)
    }
    // The drop-seam pins (a) directly: an inverted window yields null.
    expect(toUiSafeScheduleEntry({ start: "2026-07-25T10:00:00.000Z", end: "2026-07-25T09:00:00.000Z" })).toBeNull();
  });

  it("unreachable_source_never_shows_free — an UNREACHABLE availability read → typed err + ZERO write (never a free-looking schedule)", async () => {
    const { repo, puts } = fakeRepo();
    const port = createCalendarProjectionPort({
      availability: availabilityUnreachable,
      readModels: repo,
      now: () => NOW,
    });
    const r = await port.refresh();
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("calendar_unreachable");
    expect(puts.length).toBe(0); // REQ-F-009: never overwrite the row with an empty/free schedule from an unread source
  });

  it("multiline_generic_reason_collapsed_single_line — a multi-line genericReason is collapsed at write (L5 projector obligation)", () => {
    const entry = toUiSafeScheduleEntry({
      start: "2026-07-25T09:00:00.000Z",
      end: "2026-07-25T10:00:00.000Z",
      genericReason: "busy\nSECRET: raw event body\nmore",
    });
    expect(entry).not.toBeNull();
    expect(entry!.conflictExplanation).toBeDefined();
    expect(entry!.conflictExplanation).not.toContain("\n"); // single-line bound
  });

  it("whitespace_only_generic_reason_omits_conflict_explanation — collapses to \"\" ⇒ conflictExplanation OMITTED (never an empty string failing uiSafeSummaryLine.min(1))", () => {
    const entry = toUiSafeScheduleEntry({ start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z", genericReason: "   \t  " });
    expect(entry).not.toBeNull();
    expect(entry!.conflictExplanation).toBeUndefined();
    expect("conflictExplanation" in entry!).toBe(false);
  });

  it("non_iso_bound_dropped_at_write — a date-only / non-ISO window fails the read schema ⇒ DROPPED at write (never stored to whole-degrade the calendar at read)", () => {
    expect(toUiSafeScheduleEntry({ start: "2026-07-25", end: "2026-07-26" })).toBeNull(); // date-only fails .datetime()
    expect(toUiSafeScheduleEntry({ start: "2026/07/25 09:00", end: "2026/07/25 10:00" })).toBeNull(); // non-ISO
    expect(toUiSafeScheduleEntry({ start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T10:00:00.000Z" })).not.toBeNull(); // full-ISO kept
  });

  it("empty_busy_windows_writes_empty_schedule — a REACHABLE source with no busy windows WRITES {entries:[]} (distinct from the unreachable err+no-write path)", async () => {
    const { repo, puts } = fakeRepo();
    const port = createCalendarProjectionPort({ availability: availabilityOk([]), readModels: repo, now: () => NOW });
    const r = await port.refresh();
    expect(isOk(r)).toBe(true);
    expect(puts.length).toBe(1); // a write DID happen (reachable-but-free) — unlike the unreachable no-write
    expect(writtenEntries(puts)).toEqual([]);
  });

  it("zero_duration_window_allowed — start === end satisfies start<=end, kept at write", () => {
    const entry = toUiSafeScheduleEntry({ start: "2026-07-25T09:00:00.000Z", end: "2026-07-25T09:00:00.000Z", genericReason: "busy" });
    expect(entry).not.toBeNull();
    expect(entry!.start).toBe(entry!.end);
  });
});
