// @vitest-environment jsdom
//
// Linear slice 3+4, step 5 — ⛔ WS-8 at the App: the worker serves an approval's details only for the workspace it
// is ASKED about, and it cannot see the screen's scope. So the App must ask with the ACTIVE scope's workspace —
// never the card's own (every card carries one). This drives the REAL App over a mocked live handle and records
// every workspace the send surface is asked about.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { StartLiveHandle } from "../renderer/lib/live";
import type { Store, UiSafeStoreState } from "../renderer/store";

type UiSafeStore = Store<UiSafeStoreState>;

const { asked, storeRef } = vi.hoisted(() => ({ asked: [] as { call: string; workspaceId: string }[], storeRef: { current: null as unknown } }));

vi.mock("../renderer/lib/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/lib/live")>();
  const projections = await import("../renderer/store/projections");
  const handle = {
    stop: () => {},
    drillDown: async () => ({ ok: false }),
    auditDrill: async () => ({ ok: false }),
    hydrateScope: async () => {},
    askCopilot: async () => ({ ok: false }),
    decideApproval: async () => ({ ok: false, reason: "unavailable" }),
    disposeTriage: async () => ({ ok: false }),
    onboardWorkspace: async () => ({ ok: false }),
    previewPreset: async () => ({ ok: false }),
    registerConnector: async () => ({ ok: false }),
    setConnectorState: async () => ({ ok: false }),
    setConnectorCadence: async () => ({ ok: false }),
    createCrossWorkspaceLink: async () => ({ ok: false }),
    approveCrossWorkspaceLink: async () => ({ ok: false }),
    revokeCrossWorkspaceLink: async () => ({ ok: false }),
    egressStatus: async () => ({ ok: false }),
    revokeEgressAck: async () => ({ ok: false }),
    approvalDetail: async (workspaceId: string, approvalId: string) => {
      asked.push({ call: "detail", workspaceId });
      return { ok: true, detail: { approvalId, sendState: "awaiting_approval", title: "Personal task" } };
    },
    unsentApprovals: async (workspaceId: string) => {
      asked.push({ call: "unsent", workspaceId });
      return { ok: true, approvals: [] };
    },
    sendNow: async (workspaceId: string, approvalId: string) => {
      asked.push({ call: "sendNow", workspaceId });
      return { ok: true, result: { approvalId, sendState: "sent" } };
    },
  } as unknown as StartLiveHandle;
  return {
    ...actual,
    startLive: vi.fn(async (store: UiSafeStore) => {
      storeRef.current = store;
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: "employer-work", scope: "employer-work", name: "Work", type: "employer_work", preset: "Simple" }));
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: "personal-life", scope: "personal-life", name: "Life", type: "personal_life", preset: "Simple" }));
      store.dispatch((s) =>
        projections.hydrateApprovals(s, [
          { id: "emp-card", actionRef: "act-emp", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "employer-work" },
          { id: "life-card", actionRef: "act-life", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "personal-life" },
        ]),
      );
      store.dispatch((s) => projections.setScope(s, "personal-life"));
      store.dispatch((s) => projections.navigate(s, { surface: "approvals" }));
      return handle;
    }),
  };
});

import { App } from "../renderer/App";
import { setScope } from "../renderer/store/projections";

afterEach(cleanup);

describe("App — the send surface is asked about the ACTIVE scope's workspace, never a card's", () => {
  it("⛔ in personal-life, only personal-life is ever asked about; switching scope follows it", async () => {
    (window as unknown as { sow?: unknown }).sow = {
      app: { getVersion: async () => "0.0.0" },
      session: { getToken: async () => "tok" },
      worker: { getConnection: async () => null },
      vault: { open: async () => ({ ok: true }), reveal: async () => ({ ok: true }) },
      lifecycle: { firstRunStatus: async () => ({ ok: true as const, value: "complete" }), markOnboarded: async () => ({ ok: true, value: true }) },
    };
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The employer card is not offered Details here; the personal card is.
    expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Personal task")).toBeTruthy();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.workspaceId === "personal-life")).toBe(true);

    // Switch to the employer scope: from now on the surface is asked about employer-work.
    asked.length = 0;
    await act(async () => {
      (storeRef.current as UiSafeStore).dispatch((s) => setScope(s, "employer-work"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(asked.some((a) => a.call === "unsent" && a.workspaceId === "employer-work")).toBe(true);
    expect(asked.every((a) => a.workspaceId === "employer-work")).toBe(true);
  });
});
