// @vitest-environment jsdom
//
// Linear slice 3+4, step 5 — ⛔ WS-8 at the App: the worker serves an approval's details only for the workspace it
// is ASKED about, and it cannot see the screen's scope. So the App must ask with the ACTIVE scope's onboarded
// workspace id. This drives the REAL App over a mocked live handle and records every workspace the send surface
// (details, the unsent list and Send now) is asked about.
//
// The workspace ids here DIFFER from their scope names ("wk-life-3" is the personal-life scope). With equal
// values, a mutant that asked with the raw scope string passed every test (step-5 review, 2026-09-22).
//
// ⚠ What this does NOT pin: "never the CARD's workspace". On this screen a card's workspace can only EQUAL the
// active one where a request is possible — Details is offered only for a same-workspace card (pinned in
// approvals-page.test.tsx), and the unsent list is filtered to the active workspace (pinned below). A mutant that
// read the card's workspace would therefore send the same value and cannot be caught here; those two layers are
// what make it equivalent.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import type { StartLiveHandle } from "../renderer/lib/live";
import type { Store, UiSafeStoreState } from "../renderer/store";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";

type UiSafeStore = Store<UiSafeStoreState>;
type UnsentAnswer = { ok: true; approvals: UiSafeApproval[] } | { ok: false };

const LIFE = "wk-life-3";
const EMP = "wk-emp-7";

const { asked, storeRef, ctl, sendState } = vi.hoisted(() => ({
  asked: [] as { call: string; workspaceId: string }[],
  storeRef: { current: null as unknown },
  ctl: { unsent: null as null | ((workspaceId: string) => Promise<unknown>) },
  sendState: { value: "writes_off" as string },
}));

const lifeCard: UiSafeApproval = {
  id: "life-card",
  actionRef: "act-life",
  status: "pending",
  channel: "mac",
  subjectKind: "external_action",
  targetSystem: "linear",
  workspaceId: LIFE,
} as UiSafeApproval;

vi.mock("../renderer/lib/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/lib/live")>();
  const projections = await import("../renderer/store/projections");
  const handle = {
    stop: () => {},
    drillDown: async () => ({ ok: false }),
    auditDrill: async () => ({ ok: false }),
    hydrateScope: async () => {},
    askCopilot: async () => ({ ok: false }),
    decideApproval: async (approvalId: string) => ({
      ok: true,
      applied: true,
      approval: { id: approvalId, actionRef: "act-life", status: "approved", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "wk-life-3" },
    }),
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
      return ctl.unsent !== null ? ctl.unsent(workspaceId) : { ok: true, approvals: [] };
    },
    sendNow: async (workspaceId: string, approvalId: string) => {
      asked.push({ call: "sendNow", workspaceId });
      return { ok: true, result: { approvalId, sendState: sendState.value } };
    },
    // Linear slice 5a — the New Linear issue form.
    linearTeams: async (workspaceId: string) => {
      asked.push({ call: "linearTeams", workspaceId });
      return { ok: true, list: { status: "ready", teams: [{ id: "t-core", name: "Core" }], truncated: false } };
    },
    proposeLinearIssue: async (workspaceId: string) => {
      asked.push({ call: "proposeLinearIssue", workspaceId });
      return {
        ok: true,
        result: {
          outcome: "created",
          approval: { id: "proposed-card", actionRef: "act-new", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "wk-life-3" },
        },
      };
    },
  } as unknown as StartLiveHandle;
  return {
    ...actual,
    startLive: vi.fn(async (store: UiSafeStore) => {
      storeRef.current = store;
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: "wk-emp-7", scope: "employer-work", name: "Work", type: "employer_work", preset: "Simple" }));
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: "wk-life-3", scope: "personal-life", name: "Life", type: "personal_life", preset: "Simple" }));
      store.dispatch((s) =>
        projections.hydrateApprovals(s, [
          { id: "emp-card", actionRef: "act-emp", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "wk-emp-7" },
          { id: "life-card", actionRef: "act-life", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "wk-life-3" },
        ]),
      );
      store.dispatch((s) => projections.setScope(s, "personal-life"));
      store.dispatch((s) => projections.navigate(s, { surface: "approvals" }));
      return handle;
    }),
  };
});

import { App } from "../renderer/App";
import { setScope, hydrateApprovals, navigate } from "../renderer/store/projections";

const tick = (): Promise<void> => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});
const store = (): UiSafeStore => storeRef.current as UiSafeStore;
/** An unsent answer the test resolves by hand, so it can choose the ORDER answers arrive in. */
function deferred(): { promise: Promise<UnsentAnswer>; resolve: (v: UnsentAnswer) => void } {
  let resolve: (v: UnsentAnswer) => void = () => {};
  const promise = new Promise<UnsentAnswer>((r) => (resolve = r));
  return { promise, resolve };
}
function approved(id: string, workspaceId: string): UiSafeApproval {
  return { ...lifeCard, id, status: "approved", workspaceId } as UiSafeApproval;
}
const notSent = (): HTMLElement | null => screen.queryByText("Not sent")?.parentElement ?? null;

beforeEach(() => {
  asked.length = 0;
  ctl.unsent = null;
  sendState.value = "writes_off";
  (window as unknown as { sow?: unknown }).sow = {
    app: { getVersion: async () => "0.0.0" },
    session: { getToken: async () => "tok" },
    worker: { getConnection: async () => null },
    vault: { open: async () => ({ ok: true }), reveal: async () => ({ ok: true }) },
    lifecycle: { firstRunStatus: async () => ({ ok: true as const, value: "complete" }), markOnboarded: async () => ({ ok: true, value: true }) },
  };
});
afterEach(cleanup);

describe("App — the send surface is asked about the ACTIVE scope's onboarded workspace id", () => {
  it("⛔ in personal-life, only its workspace id is ever asked about; switching scope follows it", async () => {
    render(<App />);
    await tick();
    // The employer card is not offered Details here; the personal card is.
    expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Personal task")).toBeTruthy();
    expect(asked.map((a) => a.call).sort()).toEqual(["detail", "unsent"]);
    expect(asked.every((a) => a.workspaceId === LIFE)).toBe(true);

    asked.length = 0;
    await act(async () => {
      store().dispatch((s) => setScope(s, "employer-work"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(asked).toEqual([{ call: "unsent", workspaceId: EMP }]);
  });

  it("⛔ Send now asks with the active workspace id, and a row for ANOTHER workspace is never listed", async () => {
    ctl.unsent = async () => ({ ok: true, approvals: [approved("mine", LIFE), approved("foreign", EMP)] });
    render(<App />);
    await tick();
    const list = notSent() as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list.querySelector('[data-approval-id="foreign"]')).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: "Send now" }));
    await tick();
    expect(asked.filter((a) => a.call === "sendNow")).toEqual([{ call: "sendNow", workspaceId: LIFE }]);
  });

  it("⛔ an OLDER unsent answer that arrives last does not overwrite a newer one", async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    ctl.unsent = () => (queue.shift() ?? deferred()).promise;
    render(<App />);
    await tick(); // page entry: request 1, still pending
    const lifeCardEl = document.querySelector('[data-approval-id="life-card"]') as HTMLElement;
    fireEvent.click(within(lifeCardEl).getByRole("button", { name: "Approve" }));
    await tick(); // the approve refreshes: request 2
    expect(asked.filter((a) => a.call === "unsent")).toHaveLength(2);
    await act(async () => second.resolve({ ok: true, approvals: [] }));
    await act(async () => first.resolve({ ok: true, approvals: [approved("stale", LIFE)] }));
    expect(document.querySelector('[data-approval-id="stale"]')).toBeNull();
  });

  it("⛔ a late answer for the previous scope is never shown", async () => {
    const lifeAnswer = deferred();
    ctl.unsent = (ws) => (ws === LIFE ? lifeAnswer.promise : Promise.resolve({ ok: true, approvals: [] }));
    render(<App />);
    await tick(); // request for personal-life, still pending
    await act(async () => {
      store().dispatch((s) => setScope(s, "employer-work"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => lifeAnswer.resolve({ ok: true, approvals: [approved("late", LIFE)] }));
    expect(document.querySelector('[data-approval-id="late"]')).toBeNull();
  });

  it("a failed load says so instead of showing an empty list", async () => {
    ctl.unsent = async () => ({ ok: false });
    render(<App />);
    await tick();
    expect(screen.getByText("Couldn't load the Not sent list")).toBeTruthy();
  });

  it("a failed refresh AFTER an empty list still says so (critic, 2026-09-22)", async () => {
    const answers: UnsentAnswer[] = [{ ok: true, approvals: [] }, { ok: false }];
    ctl.unsent = async () => answers.shift() ?? { ok: false };
    render(<App />);
    await tick();
    expect(screen.queryByText("Couldn't load the Not sent list")).toBeNull();
    const lifeCardEl = document.querySelector('[data-approval-id="life-card"]') as HTMLElement;
    fireEvent.click(within(lifeCardEl).getByRole("button", { name: "Approve" }));
    await tick();
    expect(screen.getByText("Couldn't load the Not sent list")).toBeTruthy();
  });

  it("a failed refresh keeps the last good list on screen AND says the refresh failed", async () => {
    const answers: UnsentAnswer[] = [{ ok: true, approvals: [approved("kept", LIFE)] }, { ok: false }];
    ctl.unsent = async () => answers.shift() ?? { ok: false };
    render(<App />);
    await tick();
    const lifeCardEl = document.querySelector('[data-approval-id="life-card"]') as HTMLElement;
    fireEvent.click(within(lifeCardEl).getByRole("button", { name: "Approve" }));
    await tick();
    expect(document.querySelector('[data-approval-id="kept"]')).not.toBeNull();
    expect(screen.getByText("Couldn't load the Not sent list")).toBeTruthy();
  });

  it("⛔ a card that was SENT still reads as sent after leaving the page and coming back, before the list reloads", async () => {
    const answers: (Promise<UnsentAnswer> | UnsentAnswer)[] = [{ ok: true, approvals: [approved("x", LIFE)] }, new Promise<UnsentAnswer>(() => {})];
    ctl.unsent = async () => answers.shift() ?? { ok: false };
    sendState.value = "sent";
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await tick();
    await act(async () => {
      store().dispatch((s) => navigate(s, { surface: "today" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      store().dispatch((s) => navigate(s, { surface: "approvals" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const li = document.querySelector('[data-approval-id="x"]') as HTMLElement;
    expect(within(li).queryByText("not sent")).toBeNull();
    expect(within(li).getByText("sent")).toBeTruthy();
    expect((within(li).getByRole("button", { name: "Send now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("⛔ the Linear form reads the ACTIVE workspace's teams and proposes there; the new card joins the inbox", async () => {
    render(<App />);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "New Linear issue" }));
    await tick();
    const form = screen.getByRole("form", { name: "New Linear issue" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Fix it" } });
    fireEvent.click(within(form).getByRole("button", { name: "Propose issue" }));
    await tick();
    expect(asked.filter((a) => a.call === "linearTeams" || a.call === "proposeLinearIssue")).toEqual([
      { call: "linearTeams", workspaceId: LIFE },
      { call: "proposeLinearIssue", workspaceId: LIFE },
    ]);
    // Nothing publishes approval.update, so the App folds the returned card in itself.
    expect(document.querySelector('[data-approval-id="proposed-card"]')).not.toBeNull();
  });

  it("any approved card folded into the store (from any source) refreshes the list", async () => {
    render(<App />);
    await tick();
    asked.length = 0;
    await act(async () => {
      store().dispatch((s) => hydrateApprovals(s, [{ ...lifeCard, status: "approved" } as UiSafeApproval]));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(asked).toEqual([{ call: "unsent", workspaceId: LIFE }]);
  });
});
