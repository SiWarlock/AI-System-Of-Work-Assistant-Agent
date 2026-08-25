// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { UiSafeRecentChange } from "@sow/contracts/api/ui-safe";
import { Today, type TodayProps } from "../renderer/surfaces/today/Today";
import { buildDailyBrief } from "../renderer/lib/daily-brief";
import type { AuditDrillResult } from "../renderer/lib/audit-drill";

// 9.41 leg C — Recent Activity's per-row audit-drill affordance. A deliberate per-row activation
// (never eager on mount) requests query.auditDrill via `onAuditDrill(changeId)` and renders the
// resolved {event, occurredAt} inline; denial/fault/malformed all render the SAME non-committal
// state (no probe-oracle over the audit store — leg B mints distinct codes server-side, this
// renderer never sees them). Mirrors egress.tsx's PostureCell shape + monotonic per-row seq guard.

afterEach(cleanup);

const brief = buildDailyBrief({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });

const base: Omit<TodayProps, "recentChanges" | "onAuditDrill"> = {
  scope: "employer-work",
  cards: [],
  health: [],
  global: [],
  workspaceMeta: new Map(),
  brief,
  tasks: [],
  workflowRuns: [],
  onDrillDown: () => {},
};

function change(over: Partial<UiSafeRecentChange> = {}): UiSafeRecentChange {
  return {
    changeId: "chg-1",
    kind: "sync",
    summary: "Something changed",
    occurredAt: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

describe("Recent activity — audit-drill affordance (9.41 leg C)", () => {
  it("no_drill_request_fires_on_mount", () => {
    // spec(§16 / arc posture) — a deliberate act, never an eager per-row hydrate.
    const onAuditDrill = vi.fn().mockResolvedValue({ ok: true, summary: { event: "x", occurredAt: change().occurredAt } });
    render(
      <Today
        {...base}
        recentChanges={[change({ changeId: "c1" }), change({ changeId: "c2" })]}
        onAuditDrill={onAuditDrill}
      />,
    );
    expect(onAuditDrill).not.toHaveBeenCalled();
  });

  it("activating_a_row_renders_its_resolved_summary", async () => {
    const onAuditDrill = vi
      .fn<(changeId: string) => Promise<AuditDrillResult>>()
      .mockResolvedValue({ ok: true, summary: { event: "Note created", occurredAt: "2026-07-20T10:05:00.000Z" } });
    render(
      <Today
        {...base}
        recentChanges={[change({ changeId: "c1", summary: "First row" }), change({ changeId: "c2", summary: "Second row" })]}
        onAuditDrill={onAuditDrill}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view audit details for first row/i }));
    expect(await screen.findByText(/Note created/)).toBeTruthy();
    expect(onAuditDrill).toHaveBeenCalledWith("c1");
    // Row 2 is unaffected: its own control is untouched, and no resolved detail leaks onto it.
    expect(screen.getByRole("button", { name: /view audit details for second row/i })).toBeTruthy();
    const row2 = screen.getByText("Second row").closest(".sow-activity-row");
    expect(row2?.querySelector(".sow-activity-drill-detail")).toBeNull();
  });

  it("a_failed_drill_renders_the_same_non_committal_state_as_a_denied_one", async () => {
    // spec(no probe-oracle) — a typed denial and a transport fault must be indistinguishable here.
    const denied = vi.fn().mockResolvedValue({ ok: false });
    const first = render(<Today {...base} recentChanges={[change()]} onAuditDrill={denied} />);
    fireEvent.click(screen.getByRole("button", { name: /view audit details/i }));
    await screen.findByText(/details unavailable/i);
    const deniedHtml = first.container.querySelector(".sow-activity-row")?.innerHTML;
    first.unmount();

    const faulted = vi.fn().mockRejectedValue(new Error("network down"));
    const second = render(<Today {...base} recentChanges={[change()]} onAuditDrill={faulted} />);
    fireEvent.click(screen.getByRole("button", { name: /view audit details/i }));
    await screen.findByText(/details unavailable/i);
    const faultedHtml = second.container.querySelector(".sow-activity-row")?.innerHTML;

    expect(faultedHtml).toBe(deniedHtml);
  });

  it("a_superseded_resolution_never_paints_after_a_scope_change", async () => {
    // desktop L66 — this pin's safety rests on TWO legs, named rather than left silent:
    // (1) inherited: `deriveChangeId` (apps/worker/src/api/projections/recentChanges.ts:62-65) hashes
    //     workspaceId INTO changeId, so workspace A's key can never match a row rendered for B;
    // (2) this component's OWN cleanup effect (mirrors egress.tsx's unmount-invalidation) bumps every
    //     CURRENT changeId's seq the moment the `changes` array is replaced, so even a changeId that
    //     later REAPPEARS (switching back to A) can't have a pre-switch stale resolution silently
    //     "resolve" it without a fresh activation.
    // This test proves the OUTCOME live.ts's hydrateScope's clear-then-replace makes real: a slow
    // in-flight resolution for the PREVIOUS scope must never paint after the feed has been replaced.
    let resolveDrill!: (v: AuditDrillResult) => void;
    const onAuditDrill = vi
      .fn<(changeId: string) => Promise<AuditDrillResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<AuditDrillResult>((resolve) => {
            resolveDrill = resolve;
          }),
      );

    const changesA = [change({ changeId: "chg-wsA-1", summary: "Workspace A change" })];
    const changesB = [change({ changeId: "chg-wsB-1", summary: "Workspace B change" })];

    const { rerender } = render(<Today {...base} recentChanges={changesA} onAuditDrill={onAuditDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /view audit details for workspace a change/i }));
    await screen.findByText(/checking/i); // now pending for chg-wsA-1

    // Simulate a scope switch — hydrateScope (live.ts) clears `recentChanges` then replaces it wholesale.
    rerender(<Today {...base} recentChanges={changesB} onAuditDrill={onAuditDrill} />);

    // The stale A-scoped resolution arrives AFTER the switch.
    resolveDrill({ ok: true, summary: { event: "Should never appear", occurredAt: "2026-07-20T10:00:00.000Z" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText("Should never appear")).toBeNull();
    expect(screen.getByText("Workspace B change")).toBeTruthy();
  });

  it("a_row_still_loading_when_the_scope_changes_is_not_stuck_forever", async () => {
    // Security review, 9.41-C: the seq bump alone drops a WRONG paint but does not by itself unstick
    // a row that never received a counted resolution — the cleanup effect must also reset it back to
    // re-activatable, or switching away mid-flight and back permanently strands that row on
    // "Checking details…" with no way to retry.
    let resolveFirst!: (v: AuditDrillResult) => void;
    const onAuditDrill = vi
      .fn<(changeId: string) => Promise<AuditDrillResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<AuditDrillResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, summary: { event: "Fresh activation", occurredAt: "2026-07-20T10:00:00.000Z" } });

    const changesA = [change({ changeId: "chg-wsA-1", summary: "Workspace A change" })];
    const changesB = [change({ changeId: "chg-wsB-1", summary: "Workspace B change" })];

    const { rerender } = render(<Today {...base} recentChanges={changesA} onAuditDrill={onAuditDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /view audit details for workspace a change/i }));
    await screen.findByText(/checking/i); // pending on the FIRST visit to A

    rerender(<Today {...base} recentChanges={changesB} onAuditDrill={onAuditDrill} />); // switch away
    rerender(<Today {...base} recentChanges={changesA} onAuditDrill={onAuditDrill} />); // switch back to A

    // Re-activatable, not stuck — a fresh "Details" button, not "Checking details…".
    const button = screen.getByRole("button", { name: /view audit details for workspace a change/i });
    fireEvent.click(button);
    expect(await screen.findByText(/Fresh activation/)).toBeTruthy();

    // The abandoned first request resolving late must still not paint over the fresh one.
    resolveFirst({ ok: true, summary: { event: "Stale must not appear", occurredAt: "2026-07-20T10:00:00.000Z" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/must not appear/i)).toBeNull();
    expect(screen.getByText(/Fresh activation/)).toBeTruthy();
  });

  it("a_drill_completes_across_an_innocuous_re_render", async () => {
    // The cleanup effect must key on a DERIVED STRING (`changeIds`), never the `changes` ARRAY
    // REFERENCE — an invalidator that fires on every re-render is indistinguishable, across the rest
    // of this suite, from one that fires only on a real replace (L80's "swap the gate for a constant
    // — does anything go red?", aimed at an invalidator instead of a gate). Force a re-render with a
    // FRESH array instance carrying the SAME changeId set (an innocuous prop change elsewhere in
    // Today, not a scope switch) and confirm an in-flight drill still completes.
    let resolveDrill!: (v: AuditDrillResult) => void;
    const onAuditDrill = vi
      .fn<(changeId: string) => Promise<AuditDrillResult>>()
      .mockImplementationOnce(
        () =>
          new Promise<AuditDrillResult>((resolve) => {
            resolveDrill = resolve;
          }),
      );

    const { rerender } = render(<Today {...base} recentChanges={[change({ changeId: "c1" })]} onAuditDrill={onAuditDrill} />);
    fireEvent.click(screen.getByRole("button", { name: /view audit details/i }));
    await screen.findByText(/checking/i);

    // A NEW array instance, identical content — mirrors a sibling prop causing an unrelated re-render.
    rerender(<Today {...base} recentChanges={[change({ changeId: "c1" })]} onAuditDrill={onAuditDrill} />);

    resolveDrill({ ok: true, summary: { event: "Completed despite re-render", occurredAt: "2026-07-20T10:00:00.000Z" } });
    expect(await screen.findByText(/Completed despite re-render/)).toBeTruthy();
  });

  it("the_drilled_row_exposes_exactly_the_allowed_keys", async () => {
    // spec(rule 7 / arc invariant) — an EXACT inventory, not a name-filter (desktop L54/L90): no
    // auditRef/actor/refs/payloadHash/workspaceId in any attribute or text node. `fixedTime` is a
    // REAL current instant (not a fixed historical one) so `relativeTime` deterministically reads
    // "just now" both places, rather than a time-dependent "Nd" that would make this test flaky.
    const fixedTime = new Date().toISOString();
    const onAuditDrill = vi.fn().mockResolvedValue({ ok: true, summary: { event: "Note updated", occurredAt: fixedTime } });
    render(
      <Today
        {...base}
        recentChanges={[{ changeId: "c9", kind: "sync", summary: "Row summary", occurredAt: fixedTime }]}
        onAuditDrill={onAuditDrill}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /view audit details for row summary/i }));
    await screen.findByText(/Note updated/);

    const row = screen.getByText("Row summary").closest(".sow-activity-row");
    expect(row).not.toBeNull();

    const attrNames = Array.from(row!.attributes)
      .map((a) => a.name)
      .sort();
    expect(attrNames).toEqual(["class", "data-change-id", "role"]);
    expect(row!.getAttribute("data-change-id")).toBe("c9");

    const childText = Array.from(row!.children).map((el) => [el.className, el.textContent]);
    expect(childText).toEqual([
      ["sow-activity-kind", "sync"],
      ["sow-activity-summary", "Row summary"],
      ["sow-activity-when", "just now"],
      ["sow-activity-drill-detail", "Note updated · just now"],
    ]);

    for (const forbidden of ["auditRef", "payloadHash", "workspaceId", "actor", "\"refs\""]) {
      expect(row!.innerHTML).not.toContain(forbidden);
    }
  });

  it("the_affordance_is_keyboard_operable_and_named", () => {
    // spec(a11y) — a real <button> (never a click-handled <div>) with an accessible name that
    // distinguishes rows; native button semantics give keyboard operability for free.
    render(
      <Today
        {...base}
        recentChanges={[change({ changeId: "c1", summary: "Alpha row" }), change({ changeId: "c2", summary: "Beta row" })]}
        onAuditDrill={vi.fn()}
      />,
    );
    const alpha = screen.getByRole("button", { name: /view audit details for alpha row/i });
    const beta = screen.getByRole("button", { name: /view audit details for beta row/i });
    expect(alpha.tagName).toBe("BUTTON");
    expect(beta.tagName).toBe("BUTTON");
    expect(alpha).not.toBe(beta);
  });
});
