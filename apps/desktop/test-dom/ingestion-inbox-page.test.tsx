// @vitest-environment jsdom
// Task 9.7-C — the routable desktop Ingestion Inbox surface (cycle 3 of the §9.7 arc): renders
// UiSafeIngestionItem cards + an empty-state, cold-loads via query.ingestionInbox for the active
// workspace scope (empty under Global, WS-8), and mounts on the AppShell route + nav. Renderer-only;
// consumes the already-shipped UiSafeIngestionItem contract (9.7-A). Second-tier jsdom render harness
// (apps/desktop LESSONS §4). Empty-until-producer: query returns [] until the deferred producer wiring.
import { useState, type ReactElement } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { IngestionInbox } from "../renderer/surfaces/ingestion-inbox";
import { AppShell, type AppShellProps } from "../renderer/chrome/AppShell";
import { hydrateIngestionInbox } from "../renderer/lib/live";
import { createTriageDisposition, type TriageDisposition } from "../renderer/lib/triage-disposition";
import { createUiSafeStore } from "../renderer/store";
import { setScope } from "../renderer/store/projections";
import type { WorkspaceScope } from "../renderer/store/scope";
import type { UiSafeIngestionItem } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

/** A store already in a given scope (hydrate is called for the CURRENT scope; the guard requires it). */
function storeInScope(scope: WorkspaceScope): ReturnType<typeof createUiSafeStore> {
  const store = createUiSafeStore();
  store.dispatch((s) => setScope(s, scope));
  return store;
}

function item(sourceId: string, over: Partial<UiSafeIngestionItem> = {}): UiSafeIngestionItem {
  return { sourceId, type: "youtube_video", sensitivity: "personal", summary: `Parked: ${sourceId}`, ...over };
}

type IngestClient = Parameters<typeof hydrateIngestionInbox>[0];

/** A minimal fake tRPC client: query.ingestionInbox.query resolves to `result` (structural cast). */
function fakeClient(result: unknown): IngestClient {
  return { query: { ingestionInbox: { query: async () => result } } } as unknown as IngestClient;
}

describe("IngestionInbox surface — render (§9.7)", () => {
  it("renders one card per item showing sourceId / type / sensitivity / summary", () => {
    render(<IngestionInbox items={[item("s1"), item("s2")]} />);
    const cards = document.querySelectorAll("[data-source-id]");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Parked: s1")).toBeTruthy();
    expect(screen.getByText("Parked: s2")).toBeTruthy();
    const card1 = document.querySelector('[data-source-id="s1"]') as HTMLElement;
    expect(within(card1).getByText(/youtube_video/i)).toBeTruthy();
    expect(within(card1).getByText(/personal/i)).toBeTruthy();
  });

  it("an empty list shows the distinct empty-state (not a blank page, not a spinner)", () => {
    render(<IngestionInbox items={[]} />);
    expect(screen.getByText(/no items awaiting triage/i)).toBeTruthy();
    expect(document.querySelectorAll("[data-source-id]")).toHaveLength(0);
  });

  it("reads NOTHING past the 4 UI-safe fields — a stray raw field on an item is never rendered", () => {
    // Defense-in-depth self-check: even if a malformed item carried a raw ref, the surface must not
    // surface it (it only reads sourceId/type/sensitivity/summary).
    const tainted = { ...item("s1"), origin: "https://youtu.be/leak", contentHash: "sha256:leak" } as UiSafeIngestionItem;
    render(<IngestionInbox items={[tainted]} />);
    expect(screen.queryByText(/youtu\.be/i)).toBeNull();
    expect(screen.queryByText(/sha256:leak/i)).toBeNull();
  });
});

describe("hydrateIngestionInbox — cold-load (§9.7, workspace-scoped)", () => {
  it("populates the store for a workspace scope (query returns 2 items ⇒ store holds 2)", async () => {
    const store = storeInScope("personal-business");
    await hydrateIngestionInbox(fakeClient({ ok: true, value: [item("s1"), item("s2")] }), store, "personal-business");
    expect(store.getSnapshot().ingestion.map((i) => i.sourceId)).toEqual(["s1", "s2"]);
  });

  it("a query err resolves to an empty, NON-crashing state (never throws / white-screens)", async () => {
    const store = storeInScope("personal-business");
    await hydrateIngestionInbox(
      fakeClient({ ok: false, error: { kind: "degraded_unavailable", message: "down", retryable: true } }),
      store,
      "personal-business",
    );
    expect(store.getSnapshot().ingestion).toEqual([]);
  });

  it("a thrown query is caught — best-effort, store stays empty (non-crashing)", async () => {
    const store = storeInScope("personal-business");
    const throwingClient = {
      query: { ingestionInbox: { query: async () => { throw new Error("boom"); } } },
    } as unknown as IngestClient;
    await hydrateIngestionInbox(throwingClient, store, "personal-business");
    expect(store.getSnapshot().ingestion).toEqual([]);
  });

  it("re-validates each row — a poisoned (multi-line summary) row is DROPPED, never folded", async () => {
    const store = storeInScope("personal-business");
    const poisoned = { sourceId: "bad", type: "x", sensitivity: "y", summary: "line one\nleak" };
    await hydrateIngestionInbox(fakeClient({ ok: true, value: [item("s1"), poisoned] }), store, "personal-business");
    expect(store.getSnapshot().ingestion.map((i) => i.sourceId)).toEqual(["s1"]);
  });

  it("under Global scope shows nothing (WS-8 — ingestion never aggregates globally), even if a stale row was present", async () => {
    // Seed a workspace's items, then switch to Global + hydrate — must clear to empty (no cross-scope blend).
    const store = storeInScope("personal-business");
    await hydrateIngestionInbox(fakeClient({ ok: true, value: [item("s1")] }), store, "personal-business");
    expect(store.getSnapshot().ingestion).toHaveLength(1);
    store.dispatch((s) => setScope(s, "global"));
    await hydrateIngestionInbox(fakeClient({ ok: true, value: [item("s1")] }), store, "global");
    expect(store.getSnapshot().ingestion).toEqual([]);
  });
});

describe("AppShell — Ingestion Inbox route mount (§9.7 / §9.5 nav)", () => {
  const base: Omit<AppShellProps, "children"> = {
    connection: "live",
    scope: "global",
    onScopeChange: () => {},
    route: { surface: "today" },
    onNavigate: () => {},
  };

  it("clicking the Inbox nav navigates to {surface:'ingestion'} (scope-preserving)", () => {
    const onNavigate = vi.fn();
    const onScopeChange = vi.fn();
    render(
      <AppShell {...base} onNavigate={onNavigate} onScopeChange={onScopeChange}>
        <div>content</div>
      </AppShell>,
    );
    fireEvent.click(screen.getByText("Inbox"));
    expect(onNavigate).toHaveBeenCalledWith({ surface: "ingestion" });
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("marks the Inbox nav active (aria-current) when the ingestion surface is routed", () => {
    render(
      <AppShell {...base} route={{ surface: "ingestion" }}>
        <div>content</div>
      </AppShell>,
    );
    const inbox = screen.getByText("Inbox").closest(".sow-nav-item");
    expect(inbox?.getAttribute("aria-current")).toBe("page");
  });
});

// ── Disposition ACTION UI (§9.7 triage-resolution) ───────────────────────────
type DisposeClient = Parameters<typeof createTriageDisposition>[0];

/** A fake tRPC client whose command.disposeTriage.mutate resolves to `result` (structural cast). */
function disposeClient(result: unknown): DisposeClient {
  return { command: { disposeTriage: { mutate: async () => result } } } as unknown as DisposeClient;
}

/**
 * Mirrors App.tsx's onDispose wiring: the REAL caller over a fake client + the REAL drain
 * (remove the disposed item on ok). Lets the action tests exercise the full renderer path
 * (surface → caller → mutation → fold → drain), not a stubbed handler.
 */
function InboxHarness({
  client,
  initial,
}: {
  readonly client: DisposeClient;
  readonly initial: readonly UiSafeIngestionItem[];
}): ReactElement {
  const [items, setItems] = useState<readonly UiSafeIngestionItem[]>(initial);
  const dispose = createTriageDisposition(client);
  const onDispose = async (sourceId: string, disposition: TriageDisposition): Promise<boolean> => {
    const r = await dispose(sourceId, disposition);
    if (!r.ok) return false;
    setItems((prev) => prev.filter((it) => it.sourceId !== sourceId));
    return true;
  };
  return <IngestionInbox items={items} onDispose={onDispose} />;
}

describe("IngestionInbox — triage-resolution ACTION UI (§9.7)", () => {
  it("disposition_click_invokes_handler — clicking a card action calls onDispose(sourceId, disposition)", () => {
    // spec(§11) action wiring — the card surfaces per-disposition buttons that call the handler.
    const onDispose = vi.fn(async () => true);
    render(<IngestionInbox items={[item("s1")]} onDispose={onDispose} />);
    const card = document.querySelector('[data-source-id="s1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(onDispose).toHaveBeenCalledWith("s1", "accept");
  });

  it("action buttons are DISABLED when there is no live worker (onDispose absent) — honest, not a dead control", () => {
    // spec(§11) mirror Approvals: no worker ⇒ disabled buttons, never a silently no-op control.
    render(<IngestionInbox items={[item("s1")]} />);
    const card = document.querySelector('[data-source-id="s1"]') as HTMLElement;
    const buttons = within(card).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("ok_removes_item — an ok disposition DRAINS the item from the rendered list (no re-query)", async () => {
    // spec(§11) drain-on-ok: disposeTriage returns no post-state record, so ok ⇒ remove.
    render(
      <InboxHarness
        client={disposeClient({ ok: true, value: { idempotencyKey: "s1:accept" } })}
        initial={[item("s1"), item("s2")]}
      />,
    );
    const card = document.querySelector('[data-source-id="s1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(document.querySelector('[data-source-id="s1"]')).toBeNull());
    expect(document.querySelector('[data-source-id="s2"]')).toBeTruthy(); // the other item is untouched
  });

  it("err_retains_item — a failed disposition KEEPS the item + shows a non-blocking error affordance (fail-closed)", async () => {
    // spec(§16) fail-closed: a failed disposition loses nothing; the item stays with an error affordance.
    render(
      <InboxHarness
        client={disposeClient({ ok: false, error: { kind: "degraded_unavailable", message: "down", retryable: true } })}
        initial={[item("s1")]}
      />,
    );
    const card = document.querySelector('[data-source-id="s1"]') as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.querySelector('[data-source-id="s1"]')).toBeTruthy(); // item REMAINS (nothing dropped)
  });
});
