// @vitest-environment jsdom
//
// Task 14.1 (desktop leg) — the `hydrateScope` re-point fail-closed test (THE WS-8 boundary the
// onboarded-id ripple introduces; safety rule 4). Dropping the static placeholder ids means a
// SELECTED workspace scope now resolves its query id from the onboarded store slice. This pins the
// CONSUMING site's isolation property: a NON-onboarded (or unknown) workspace scope reads EMPTY and
// does NOT fall through to the Global cross-workspace reads — a leak there would be an isolation
// breach. The selector tests pin `resolveOnboardedWorkspaceId → null`; this pins that the reader
// behaves fail-closed on that null (empty, never Global).
//
// Lives in the jsdom tier (not the node tier) because its subject `live.ts` is window-coupled glue
// (`startLive` reads `window.sow`) — apps/desktop LESSONS §3. The test itself is pure logic.
import { describe, it, expect, vi } from "vitest";
import { hydrateScope } from "../renderer/lib/live";
import { createUiSafeStore } from "../renderer/store";
import { setScope, recordOnboardedWorkspace, hydrateCards } from "../renderer/store/projections";
import { uiSafeCard } from "../test/renderer/fixtures";

// A tRPC-shaped mock counting every read path hydrateScope can take. The GLOBAL reads
// (dashboard + global) return data — so a fall-through to Global would be VISIBLE (populated
// cards) and the spies would fire. The WORKSPACE read (workspace/recentChanges/projectList)
// also returns data. A fail-closed non-onboarded scope must invoke NONE of them.
function mockClient(): {
  client: unknown;
  dashboard: ReturnType<typeof vi.fn>;
  global: ReturnType<typeof vi.fn>;
  workspace: ReturnType<typeof vi.fn>;
} {
  const dashboard = vi.fn(async () => ({ ok: true, value: [uiSafeCard("global-card")] }));
  const global = vi.fn(async () => ({ ok: true, value: [] }));
  const workspace = vi.fn(async () => ({ ok: true, value: [uiSafeCard("ws-card")] }));
  const recentChanges = vi.fn(async () => ({ ok: true, value: [] }));
  const projectList = vi.fn(async () => ({ ok: true, value: [] }));
  const ingestionInbox = vi.fn(async () => ({ ok: true, value: [] }));
  return {
    client: {
      query: {
        dashboard: { query: dashboard },
        global: { query: global },
        workspace: { query: workspace },
        recentChanges: { query: recentChanges },
        projectList: { query: projectList },
        ingestionInbox: { query: ingestionInbox },
      },
    },
    dashboard,
    global,
    workspace,
  };
}

describe("hydrateScope — onboarded-id re-point (WS-8 fail-closed)", () => {
  it("a SELECTED but NON-onboarded bucket reads EMPTY — no Global fall-through (isolation, rule 4)", async () => {
    const store = createUiSafeStore();
    // Seed pre-existing cards to prove hydrateScope CLEARS them and does NOT repopulate from Global
    // for a non-onboarded scope (non-vacuous: not "empty because unseeded").
    store.dispatch((s) => hydrateCards(s, [uiSafeCard("prior")]));
    store.dispatch((s) => setScope(s, "personal-life")); // NOT onboarded
    expect(store.getSnapshot().cards.size).toBe(1);

    const m = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hydrateScope(m.client as any, store, "personal-life");

    // Load-bearing: NO Global reads (no cross-workspace fall-through) + NO workspace read (no id)
    // → cards cleared to empty (never the Global data).
    expect(m.dashboard).not.toHaveBeenCalled();
    expect(m.global).not.toHaveBeenCalled();
    expect(m.workspace).not.toHaveBeenCalled();
    expect(store.getSnapshot().cards.size).toBe(0);
  });

  it("positive control — an ONBOARDED bucket reads its WORKSPACE (real id), never Global", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) =>
      recordOnboardedWorkspace(s, {
        workspaceId: "ws_pl_real",
        scope: "personal-life",
        name: "Life",
        type: "personal_life",
        preset: "simple",
      }),
    );
    store.dispatch((s) => setScope(s, "personal-life"));

    const m = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hydrateScope(m.client as any, store, "personal-life");

    expect(m.workspace).toHaveBeenCalledWith({ workspaceId: "ws_pl_real" });
    expect(m.dashboard).not.toHaveBeenCalled();
    expect(m.global).not.toHaveBeenCalled();
  });

  it("positive control — Global reads the cross-workspace surfaces, never a workspace query", async () => {
    const store = createUiSafeStore();
    store.dispatch((s) => setScope(s, "global"));

    const m = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hydrateScope(m.client as any, store, "global");

    expect(m.dashboard).toHaveBeenCalled();
    expect(m.global).toHaveBeenCalled();
    expect(m.workspace).not.toHaveBeenCalled();
  });
});
