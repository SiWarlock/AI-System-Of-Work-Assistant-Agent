// Calendar surface (§9.9, Flow 3 / REQ-F-009) — the routable availability page that mounts inside the
// AppShell. A dumb render of the GLOBAL `query.calendar → UiSafeSchedule` read-model (the worker scopes +
// merges availability across sources; the renderer knows only what it asked for).
//
// Invariants:
//   - WS-8 / Flow-3 display boundary: renders ONLY the four UI-safe fields (start / end / busy /
//     conflictExplanation). `UiSafeScheduleEntry` carries NO workspaceId (per-entry OR top-level) — a
//     conflict from another workspace surfaces as `busy: true` + a GENERIC explanation, never WHICH
//     workspace is busy WHEN (that timing attribution is itself a cross-workspace leak). The generic
//     `conflictExplanation` is shown VERBATIM — never re-derived/enriched; the surface must not reach
//     past the contract.
//   - REQ-F-009 no-silent-free: an unreachable/degraded source surfaces empty (honest empty-state), never
//     a fabricated "free" window — the producer emits empty/degraded, this surface just renders it.
//   - Empty-until-wired: the producer serves `[]` until its adapter binds, so the honest empty-state
//     ("No calendar connected") is the normal state today; it populates automatically once wired.
//   - Availability DISPLAY only — a scheduling PROPOSAL (shared/invite/external event) is the
//     cross-calendar workflow → Approval Inbox, NOT this surface.
// NEVER import electron, node, or @sow/worker from a renderer file.

import { type ReactElement } from "react";
import type { UiSafeScheduleEntry } from "@sow/contracts/api/ui-safe";

export interface CalendarProps {
  /** The global availability windows (empty-until-wired → the honest empty-state). */
  readonly entries: readonly UiSafeScheduleEntry[];
}

/** One busy/free window — the time span, a busy/free badge, and the OPTIONAL generic conflict text. */
function ScheduleRow({ entry }: { readonly entry: UiSafeScheduleEntry }): ReactElement {
  return (
    <li className="sow-calendar-row" role="listitem" data-busy={entry.busy ? "true" : "false"}>
      <span className="sow-calendar-window">
        <time dateTime={entry.start}>{entry.start}</time>
        <span className="sow-calendar-dash" aria-hidden="true">
          {" – "}
        </span>
        <time dateTime={entry.end}>{entry.end}</time>
      </span>
      <span
        className={
          entry.busy ? "sow-calendar-badge sow-calendar-badge--busy" : "sow-calendar-badge sow-calendar-badge--free"
        }
      >
        {entry.busy ? "Busy" : "Free"}
      </span>
      {entry.conflictExplanation !== undefined ? (
        <span className="sow-calendar-conflict">{entry.conflictExplanation}</span>
      ) : null}
    </li>
  );
}

export function Calendar({ entries }: CalendarProps): ReactElement {
  const empty = entries.length === 0;
  return (
    <main className="sow-content" aria-label="Calendar">
      <div className="sow-page-head">
        <div>
          <h1>Calendar</h1>
          {entries.length > 0 ? (
            <div className="sow-subtitle">
              {entries.length} {entries.length === 1 ? "window" : "windows"}
            </div>
          ) : null}
        </div>
      </div>

      {empty ? (
        // Honest empty-state — no calendar source wired yet; NEVER a fabricated free/busy row (REQ-F-009).
        <div className="sow-empty" role="status">
          No calendar connected
        </div>
      ) : (
        <ul className="sow-calendar-list" role="list" aria-label="Availability windows">
          {entries.map((e, i) => (
            <ScheduleRow key={`${e.start}~${e.end}~${i}`} entry={e} />
          ))}
        </ul>
      )}
    </main>
  );
}
