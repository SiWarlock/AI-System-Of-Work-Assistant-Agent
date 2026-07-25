// Task 9.9a (§11 Calendar surface, Flow 3 / REQ-F-009 + §10 read-model + §5/WS-8) — the write-time
// calendar-availability PRODUCER core. Projects GCL-sanitized busy windows → `UiSafeScheduleEntry[]`
// and upserts the GLOBAL (`workspaceId = null`) `schedule` read-model row that `query.calendar` serves,
// so the §9.9 availability surface populates. Deterministic over injected deps; never throws (§16).
//
// SAFETY POSTURE:
//   • WS-8 / no-attribution (Flow 3): the drop-seam `toUiSafeScheduleEntry` copies ONLY start/end +
//     a GENERIC single-line reason — `sourceId` (WHICH calendar) and any raw event field are NEVER
//     read, so the stored blob at rest reveals nothing about WHICH workspace is busy WHEN.
//   • REQ-F-009 no-silent-free: an UNREACHABLE / partial availability read returns a typed err with
//     ZERO write — the producer NEVER overwrites the row with an empty/free-looking schedule from an
//     unread source (a stale row is safer than a fabricated "free" one).
//   • Deferred invariants AT WRITE: `toUiSafeScheduleEntry` drops an inverted/unparseable window
//     (`start <= end`); the producer only ever emits `busy: true` (so `busy === false ⇒
//     conflictExplanation` absent holds by construction). The read-side `sanitizeCalendar` re-gates both.
//
// Ships DORMANT: the always-on wiring — invoking `refresh` from a scheduled/triggered activity + binding
// the real availability adapter at `buildProofSpineActivities` (`backends.ts`) — is DEFERRED
// (empty-until-wired, the 9.7 `ingestionInboxProjection` precedent). `query.calendar` returns an empty
// schedule until this producer is bound. Mirrors `ingestionInboxProjection.ts` (factory + injected deps).
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, UiSafeScheduleEntry } from "@sow/contracts";
import type { ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS } from "../adapters/readModel";
import { toUiSafeScheduleEntry, type ScheduleWindowSource } from "./uiSafe";

/**
 * Write-side entry cap — mirrors the read cap (`queries.ts` `sanitizeCalendar` `.slice(0,200)`) and the
 * frozen `UiSafeScheduleSchema.max(200)`. Bounds the stored blob (and the per-query `safeParse` count)
 * so a pathological source can't write an unbounded schedule; a week view is generous at 200.
 */
const SCHEDULE_ENTRIES_CAP = 200;

/**
 * The sanitized availability the producer reads (REQ-F-009). `busyWindows` is the union of SANITIZED
 * busy intervals across all bound sources (each already through the GCL Visibility Gate). Mirrors the
 * @sow/workflows `GatheredAvailability` shape, but the producer depends on this NARROW local type so it
 * never couples to the scheduling driver — the deferred availability adapter maps the workflows shape
 * onto this (dropping `sourceId` is the projector's job, not the adapter's).
 */
export interface GatheredCalendarAvailability {
  readonly busyWindows: readonly ScheduleWindowSource[];
}

/** A typed availability-read failure (REQ-F-009: an unreachable source is NEVER assumed free). */
export interface CalendarAvailabilityError {
  readonly code: "calendar_unreachable";
  readonly message: string;
  readonly cause?: unknown;
}

/** Deps for the producer: the injected availability read + the read-model repo + a clock (deterministic). */
export interface CalendarProjectionDeps {
  /** Read the sanitized busy/free availability. An unreachable/partial read is a typed err (no silent-free). */
  readonly availability: () => Promise<Result<GatheredCalendarAvailability, CalendarAvailabilityError>>;
  readonly readModels: ReadModelRepository;
  /** ISO-8601 now — injected so the producer stays deterministic/testable (the `rebuiltAt` stamp). */
  readonly now: () => string;
}

/** A typed producer failure (never thrown — §16). */
export interface CalendarProjectionError {
  readonly code: "calendar_unreachable" | "calendar_schedule_write_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/** The write-time calendar-schedule producer port. */
export interface CalendarProjectionPort {
  /**
   * Read the sanitized availability, project busy windows → UI-safe entries (drop-rules + `start<=end`
   * AT WRITE), and upsert the GLOBAL schedule read-model row. An UNREACHABLE availability read →
   * `calendar_unreachable` err with ZERO write (REQ-F-009 no-silent-free). Never throws.
   */
  readonly refresh: () => Promise<Result<void, CalendarProjectionError>>;
}

const fail = (
  code: CalendarProjectionError["code"],
  message: string,
  cause?: unknown,
): CalendarProjectionError => ({ code, message, cause });

/**
 * Build the write-time calendar-schedule producer over the injected availability read + read-model repo
 * + clock. Keys the row GLOBAL (`READ_MODEL_KEYS.schedule`, `workspaceId = null` — UiSafeSchedule is
 * workspaceId-free by design), fail-closes an unreachable availability read to a typed err with no write
 * (REQ-F-009), and never throws (§16).
 */
export function createCalendarProjectionPort(deps: CalendarProjectionDeps): CalendarProjectionPort {
  return {
    async refresh(): Promise<Result<void, CalendarProjectionError>> {
      try {
        const gathered = await deps.availability();
        if (isErr(gathered)) {
          // REQ-F-009 no-silent-free: an unread source is NEVER written as an empty/free schedule.
          // Return typed + write NOTHING (leave the prior/absent row) rather than fabricate "free".
          return err(fail("calendar_unreachable", "availability source unreachable", gathered.error));
        }
        // Drop-rules + `start <= end` AT WRITE: an inverted/unparseable window projects to null (dropped);
        // `sourceId` / raw detail are never copied (WS-8); every emitted entry is `busy: true`.
        const entries: UiSafeScheduleEntry[] = [];
        for (const window of gathered.value.busyWindows) {
          const entry = toUiSafeScheduleEntry(window);
          if (entry !== null) entries.push(entry);
        }
        const put = await deps.readModels.put({
          // GLOBAL row: `workspaceId` is OMITTED (undefined) — the read side `get(schedule, null)` matches
          // an absent workspaceId (the dashboard/global_surface convention; UiSafeSchedule is workspaceId-free).
          readModelKey: READ_MODEL_KEYS.schedule,
          data: { entries: entries.slice(0, SCHEDULE_ENTRIES_CAP) },
          rebuiltAt: deps.now(),
        });
        return isOk(put) ? ok(undefined) : err(fail("calendar_schedule_write_failed", "schedule put failed", put.error));
      } catch (cause) {
        return err(fail("calendar_schedule_write_failed", "unexpected refresh fault", cause));
      }
    },
  };
}
