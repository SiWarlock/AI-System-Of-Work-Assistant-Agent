// @vitest-environment jsdom
//
// Linear slice 5b.4d — ⛔ the Copilot's saved chats at the App (owner decisions 2026-09-25: chats are saved in the
// local store, a list per workspace). This drives the REAL App over a mocked live handle and records every ask.
//   • The ask names the ACTIVE workspace's real id and that workspace's CURRENT chat; each workspace keeps its own.
//   • ⛔ Rule 4 — the leak the 5b.4 grounding MEASURED (2026-09-25): an employer answer stayed on screen after a switch
//     to a personal workspace. It must not.
// The workspace ids DIFFER from their scope names (a mutant that sent the raw scope string must fail — see
// app-approval-scope.test.tsx's header).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { StartLiveHandle } from "../renderer/lib/live";
import type { Store, UiSafeStoreState } from "../renderer/store";

type UiSafeStore = Store<UiSafeStoreState>;
const LIFE = "wk-life-3";
const EMP = "wk-emp-7";

const { asks, storeRef, loads } = vi.hoisted(() => ({
  asks: [] as { workspaceId: string; question: string; chatId: string | undefined }[],
  loads: [] as { workspaceId: string; chatId: string }[],
  storeRef: { current: null as unknown },
}));

vi.mock("../renderer/lib/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../renderer/lib/live")>();
  const projections = await import("../renderer/store/projections");
  const handle = {
    stop: () => {},
    hydrateScope: async () => {},
    askCopilot: async (workspaceId: string, question: string, chatId?: string) => {
      asks.push({ workspaceId, question, chatId });
      return { ok: true, answer: { answer: [`ANSWER TO ${question}`], citations: [] } };
    },
    copilotChat: async (workspaceId: string, chatId: string) => (loads.push({ workspaceId, chatId }), { ok: false, notFound: true }),
    copilotChatList: async () => ({ ok: true, chats: [] }),
    deleteCopilotChat: async () => ({ ok: false }),
    unsentApprovals: async () => ({ ok: true, approvals: [] }),
  } as unknown as StartLiveHandle;
  return {
    ...actual,
    startLive: vi.fn(async (store: UiSafeStore) => {
      storeRef.current = store;
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: EMP, scope: "employer-work", name: "Work", type: "employer_work", preset: "Simple" }));
      store.dispatch((s) => projections.recordOnboardedWorkspace(s, { workspaceId: LIFE, scope: "personal-life", name: "Life", type: "personal_life", preset: "Simple" }));
      store.dispatch((s) => projections.setScope(s, "employer-work"));
      return handle;
    }),
  };
});

import { App } from "../renderer/App";
import { setScope } from "../renderer/store/projections";

const tick = (): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const store = (): UiSafeStore => storeRef.current as UiSafeStore;
async function switchTo(scope: "employer-work" | "personal-life"): Promise<void> {
  await act(async () => {
    store().dispatch((s) => setScope(s, scope));
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function ask(text: string): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  asks.length = 0;
  loads.length = 0;
  (window as unknown as { sow?: unknown }).sow = {
    app: { getVersion: async () => "0.0.0" },
    session: { getToken: async () => "tok" },
    worker: { getConnection: async () => null },
    vault: { open: async () => ({ ok: true }), reveal: async () => ({ ok: true }) },
    lifecycle: { firstRunStatus: async () => ({ ok: true as const, value: "complete" }), markOnboarded: async () => ({ ok: true, value: true }) },
  };
});
afterEach(cleanup);

async function openCopilot(): Promise<void> {
  render(<App />);
  await tick();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /expand copilot sidebar/i }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("App — the Copilot's saved chats", () => {
  it("⛔ the ask names the ACTIVE workspace's id and its current chat; each workspace keeps its own chat", async () => {
    await openCopilot();
    await ask("first");
    await ask("second");
    await switchTo("personal-life");
    await ask("personal");
    await switchTo("employer-work");
    await ask("third");
    expect(asks.map((a) => [a.workspaceId, a.question])).toEqual([
      [EMP, "first"],
      [EMP, "second"],
      [LIFE, "personal"],
      [EMP, "third"],
    ]);
    const [first, second, personal, third] = asks.map((a) => a.chatId);
    expect(typeof first).toBe("string");
    expect(second).toBe(first);
    expect(third).toBe(first); // switching back returns to the same chat
    expect(personal).not.toBe(first);
    // Each view restores ITS OWN chat, under its own workspace.
    expect(loads.some((l) => l.workspaceId === LIFE && l.chatId === personal)).toBe(true);
    expect(loads.every((l) => (l.chatId === first ? l.workspaceId === EMP : true))).toBe(true);
  });

  it("⛔ rule 4 (the measured leak): an employer answer is not on screen after a switch to a personal workspace", async () => {
    await openCopilot();
    await ask("employer question");
    expect(screen.getByText("ANSWER TO employer question")).toBeTruthy();
    await switchTo("personal-life");
    expect(screen.queryByText("ANSWER TO employer question")).toBeNull();
    expect(screen.queryByText("employer question")).toBeNull();
  });

  it("New chat: the next ask in the workspace uses a NEW chat", async () => {
    await openCopilot();
    await ask("before");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("ANSWER TO before")).toBeNull();
    await ask("after");
    expect(asks[1]?.chatId).not.toBe(asks[0]?.chatId);
    expect(asks.every((a) => a.workspaceId === EMP)).toBe(true);
  });
});
