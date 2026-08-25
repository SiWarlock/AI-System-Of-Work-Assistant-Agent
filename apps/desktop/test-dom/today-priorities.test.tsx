// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import type { UiSafeTaskRollupItem } from "@sow/contracts/api/ui-safe";
import { Today, type TodayProps } from "../renderer/surfaces/today/Today";
import { buildDailyBrief } from "../renderer/lib/daily-brief";
import { createUiSafeStore } from "../renderer/store";
import { recordOnboardedWorkspace, setScope } from "../renderer/store/projections";
import { hydrateTaskRollup } from "../renderer/lib/live";

// 13.16 renderer — the "Top priorities" Today section: a dumb prop-render of the PRE-RANKED UiSafeTaskRollup
// (worker query.taskRollup), allowlisted fields only, absent-priority⇒NO badge (REQ-F-017), rendered VERBATIM
// (never re-sorted). WORKSPACE-scoped hydrate (mirror ingestion inbox), {items} unwrap, per-row drop-leaky.

afterEach(cleanup);

const brief = buildDailyBrief({ recentChanges: 0, toTriage: 0, pendingApprovals: 0 });

const base: Omit<TodayProps, "tasks"> = {
  scope: "employer-work",
  cards: [],
  health: [],
  global: [],
  recentChanges: [],
  workspaceMeta: new Map(),
  brief,
  workflowRuns: [],
  onDrillDown: () => {},
  onAuditDrill: () => Promise.resolve({ ok: false }),
};

function task(over: Partial<UiSafeTaskRollupItem> = {}): UiSafeTaskRollupItem {
  return { taskId: "t1", title: "Ship the thing", status: "todo", priority: "p1", ...over };
}

function fakeClient(result: unknown): CreateTRPCClient<AppRouter> {
  return { query: { taskRollup: { query: async () => result } } } as unknown as CreateTRPCClient<AppRouter>;
}

describe("Top priorities (§13.16) — pre-ranked, allowlisted, REQ-F-017", () => {
  it("renders_priority_order_verbatim", () => {
    // spec(§11) — the served order is preserved (never re-sorted): a p3 before a p0 renders in THAT order.
    render(
      <Today
        {...base}
        tasks={[
          task({ taskId: "a", title: "Alpha (served first)", priority: "p3" }),
          task({ taskId: "b", title: "Bravo (served second)", priority: "p0" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem").filter((el) => el.getAttribute("data-task-id") !== null);
    expect(rows.map((r) => r.getAttribute("data-task-id"))).toEqual(["a", "b"]); // verbatim, not p0-first
  });

  it("absent_priority_no_badge", () => {
    // spec(REQ-F-017) — an unset priority is NEVER fabricated: no priority badge renders.
    const { container } = render(<Today {...base} tasks={[task({ taskId: "np", title: "No priority task", priority: undefined })]} />);
    expect(screen.getByText("No priority task")).toBeTruthy();
    expect(container.querySelector(".sow-priority-badge")).toBeNull(); // no badge at all
  });

  it("empty_state_no_tasks", () => {
    render(<Today {...base} tasks={[]} />);
    expect(screen.getByText("No tasks")).toBeTruthy();
  });

  it("due_label_bidirectional_and_invalid", () => {
    // spec(display) — dueDate is a BIDIRECTIONAL relative label: future ⇒ "due in …", past ⇒ "overdue …";
    // an unparseable ISO is defensively empty (never a crash / "NaN").
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(); // +3h
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // -2d
    const { container, rerender } = render(<Today {...base} tasks={[task({ taskId: "f", dueDate: future })]} />);
    expect(container.querySelector(".sow-priority-due")?.textContent).toMatch(/^due in /);
    rerender(<Today {...base} tasks={[task({ taskId: "p", dueDate: past })]} />);
    expect(container.querySelector(".sow-priority-due")?.textContent).toMatch(/^overdue /);
    rerender(<Today {...base} tasks={[task({ taskId: "x", dueDate: "not-a-date" })]} />);
    expect(container.querySelector(".sow-priority-due")?.textContent).toBe("");
  });

  it("renders_only_allowlisted_fields", () => {
    // spec(WS-8 / rule 4) — a stray raw field reaches neither DOM text nor an attribute (no spread).
    const poisoned = { ...task(), rawBody: "SECRET task body", workspaceId: "ws-employer" } as unknown as UiSafeTaskRollupItem;
    const { container } = render(<Today {...base} tasks={[poisoned]} />);
    for (const raw of ["SECRET task body", "ws-employer"]) {
      expect(container.textContent).not.toContain(raw);
      expect(container.innerHTML).not.toContain(raw);
    }
    expect(screen.getByText("Ship the thing")).toBeTruthy(); // allowlisted title DOES render
  });

  it("hydrate_unwraps_items_and_drops_leaky", async () => {
    // spec(fail-closed) — query.taskRollup returns { items: [...] } (unwrap res.value.items); a schema-invalid
    // (extra-key → .strict reject) row is DROPPED; the valid one lands. Requires an onboarded workspace scope.
    const store = createUiSafeStore();
    const ow = { workspaceId: "ws-1", scope: "employer-work" as const, name: "Acme", type: "employer_work" as const, preset: "Professional" };
    store.dispatch((s) => recordOnboardedWorkspace(s, ow));
    store.dispatch((s) => setScope(s, "employer-work"));

    const leaky = { ...task({ taskId: "leaky" }), evil: "leak" };
    await hydrateTaskRollup(
      fakeClient({ ok: true, value: { items: [leaky, task({ taskId: "ok" })] } }),
      store,
      "employer-work",
    );
    const rollup = store.getSnapshot().taskRollup;
    expect(rollup).toHaveLength(1);
    expect(rollup[0]?.taskId).toBe("ok");
  });

  it("hydrate_never_throws_stale_scope_bails", async () => {
    // spec(§16 + scoped-hydrate) — a Global / non-onboarded scope clears to [] with NO query; a thrown query
    // is caught → []. Never a throw, never a stale write.
    const store = createUiSafeStore();
    // Global → resolveOnboardedWorkspaceId null → [] without a query (a client that would throw is never called).
    const throwing = {
      query: {
        taskRollup: {
          query: async () => {
            throw new Error("should not be called under global");
          },
        },
      },
    } as unknown as CreateTRPCClient<AppRouter>;
    await expect(hydrateTaskRollup(throwing, store, "global")).resolves.toBeUndefined();
    expect(store.getSnapshot().taskRollup).toEqual([]);

    // An onboarded scope whose query throws → caught → [] (best-effort, non-crashing).
    const ow = { workspaceId: "ws-1", scope: "employer-work" as const, name: "Acme", type: "employer_work" as const, preset: "Professional" };
    store.dispatch((s) => recordOnboardedWorkspace(s, ow));
    store.dispatch((s) => setScope(s, "employer-work"));
    await expect(hydrateTaskRollup(throwing, store, "employer-work")).resolves.toBeUndefined();
    expect(store.getSnapshot().taskRollup).toEqual([]);
  });
});
