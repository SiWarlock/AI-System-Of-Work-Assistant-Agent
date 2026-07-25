// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { UiSafeScheduleEntry } from "@sow/contracts/api/ui-safe";
import type { Route } from "../renderer/store/route";
import { Calendar } from "../renderer/surfaces/calendar";
import { AppShell } from "../renderer/chrome/AppShell";
import { createUiSafeStore } from "../renderer/store";
import { hydrateCalendar } from "../renderer/lib/live";

// 9.9b — the Calendar renderer surface consumes the GLOBAL `query.calendar → UiSafeSchedule` read-model.
// A dumb, path-BLIND render of busy/free windows with GENERIC conflict text only (WS-8 / Flow-3 display
// boundary); hydrate re-validates through the `.strict()` schema; the nav is a routable NavLink.

afterEach(cleanup);

const ISO_A = "2026-07-06T09:00:00.000Z";
const ISO_B = "2026-07-06T10:00:00.000Z";
const ISO_C = "2026-07-06T11:00:00.000Z";

function entry(over: Partial<UiSafeScheduleEntry> = {}): UiSafeScheduleEntry {
  return { start: ISO_A, end: ISO_B, busy: true, conflictExplanation: "Busy — conflicting commitment", ...over };
}

/** A fake tRPC client exposing ONLY `query.calendar.query`, returning the given Result. */
function fakeClient(result: unknown): CreateTRPCClient<AppRouter> {
  return { query: { calendar: { query: async () => result } } } as unknown as CreateTRPCClient<AppRouter>;
}

describe("Calendar surface (§9.9 / Flow-3) — busy/free display, generic conflict only", () => {
  it("calendar_renders_entries_and_empty_state", () => {
    // spec(§11) — a card per entry (window + busy/free + generic conflict); the empty-state is DISTINCT.
    const { rerender } = render(
      <Calendar entries={[entry(), entry({ busy: false, conflictExplanation: undefined, start: ISO_B, end: ISO_C })]} />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Busy — conflicting commitment")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();

    rerender(<Calendar entries={[]} />);
    expect(screen.getByText("No calendar connected")).toBeTruthy(); // honest empty-state
    expect(screen.queryByRole("listitem")).toBeNull(); // zero fabricated rows
  });

  it("calendar_reads_nothing_past_allowlist", () => {
    // spec(WS-8 / rule 4) — even if an entry object carried stray raw fields, only start/end/busy/
    // conflictExplanation reach the DOM; no raw event detail / workspaceId is renderable.
    const poisoned = {
      ...entry(),
      rawTitle: "SECRET raw event title",
      attendees: "alice@corp, bob@corp",
      workspaceId: "ws-employer",
    } as unknown as UiSafeScheduleEntry;
    const { container } = render(<Calendar entries={[poisoned]} />);
    // innerHTML (superset of textContent) fences BOTH a value-render leak AND an attribute leak — the
    // component has no spread, so a stray field can reach neither the DOM text nor an element attribute.
    for (const raw of ["SECRET raw event title", "alice@corp", "ws-employer"]) {
      expect(container.textContent).not.toContain(raw);
      expect(container.innerHTML).not.toContain(raw);
    }
    expect(screen.getByText("Busy — conflicting commitment")).toBeTruthy(); // the allowlisted field DOES render
  });

  it("renderer_makes_no_cross_field_invariant_assumption", () => {
    // The two cross-field invariants (busy:false ⇒ no conflictExplanation; start <= end) are WORKER-enforced
    // (ui-safe.ts DEFERRED to query.calendar). The dumb renderer must NOT assume them — it renders whatever
    // fields are present (a stray generic conflict on a free window is odd but schema-bounded + not a leak),
    // and never crashes. This documents the safe dumb-render posture.
    render(<Calendar entries={[entry({ busy: false, conflictExplanation: "generic conflict on a free window" })]} />);
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("generic conflict on a free window")).toBeTruthy();
  });

  it("hydrate_calendar_cold_load", async () => {
    // ok → store populated
    const s1 = createUiSafeStore();
    await hydrateCalendar(fakeClient({ ok: true, value: { entries: [entry()] } }), s1);
    expect(s1.getSnapshot().schedule).toHaveLength(1);

    // a schema-invalid entry (extra key → .strict reject) is DROPPED; the valid one is kept
    const s2 = createUiSafeStore();
    const bad = { ...entry(), evil: "leak" };
    await hydrateCalendar(fakeClient({ ok: true, value: { entries: [bad, entry({ start: ISO_B, end: ISO_C })] } }), s2);
    expect(s2.getSnapshot().schedule).toHaveLength(1);

    // {ok:false} → empty (don't leave stale)
    const s3 = createUiSafeStore();
    await hydrateCalendar(fakeClient({ ok: true, value: { entries: [entry()] } }), s3);
    await hydrateCalendar(fakeClient({ ok: false, error: "degraded_unavailable" }), s3);
    expect(s3.getSnapshot().schedule).toHaveLength(0);

    // a thrown query is caught → empty, never a white-screen
    const s4 = createUiSafeStore();
    const throwing = {
      query: {
        calendar: {
          query: async () => {
            throw new Error("boom");
          },
        },
      },
    } as unknown as CreateTRPCClient<AppRouter>;
    await hydrateCalendar(throwing, s4);
    expect(s4.getSnapshot().schedule).toHaveLength(0);
  });

  it("appshell_calendar_nav_routes", () => {
    // spec(§9.5 routing + a11y) — the dead Calendar div is now a routable NavLink: click NAVIGATES (never
    // re-scopes); the active entry carries aria-current="page".
    const onNavigate = vi.fn();
    const onScopeChange = vi.fn();
    const base = {
      connection: "live" as const,
      scope: "global" as const,
      onScopeChange,
      onNavigate,
      copilotWorkspaceScoped: false,
      children: <div>content</div>,
    };
    const { rerender } = render(<AppShell {...base} route={{ surface: "today" } as Route} />);

    fireEvent.click(screen.getByRole("link", { name: "Calendar" }));
    expect(onNavigate).toHaveBeenCalledWith({ surface: "calendar" });
    expect(onScopeChange).not.toHaveBeenCalled(); // navigation never re-scopes

    rerender(<AppShell {...base} route={{ surface: "calendar" } as Route} />);
    expect(screen.getByRole("link", { name: "Calendar" }).getAttribute("aria-current")).toBe("page");
  });
});
