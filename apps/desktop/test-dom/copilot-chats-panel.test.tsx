// @vitest-environment jsdom
//
// Linear slice 5b.4d — the Copilot panel's SAVED chats (owner decisions 2026-09-25: chats are saved in the local store,
// as a LIST of chats per workspace). Three safety properties are pinned here:
//   ⛔ Rule 4: the panel shows ONLY the active workspace's chat. A turn answered in workspace A is gone when the scope
//     switches to B, and an A answer that arrives AFTER the switch is never shown under B. (Before this slice the
//     transcript survived a switch — measured by the 5b.4 grounding, 2026-09-25.)
//   ⛔ Task 9.25: a RESTORED turn goes through `admitReply` like a live one, so its egress notice comes back with it.
//   • A new chat (not saved yet) opens empty, without an error; a failed load says so. Send waits while a chat loads.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, type RenderResult } from "@testing-library/react";
import { Copilot, createChatSessionStore, type CopilotProps, type CopilotChatControls, type ChatSessionStore } from "../renderer/surfaces/copilot/Copilot";
import type { AskResult } from "../renderer/lib/copilot-ask";
import type { CopilotChatResult } from "../renderer/lib/copilot-chats";

afterEach(cleanup);

const EMP = "wk-emp-7";
const LIFE = "wk-life-3";
const answer = (text: string, egress?: string) => ({ answer: [text], citations: [], ...(egress !== undefined ? { egressProcessor: egress } : {}) });

/** One session store per test — App keeps ONE for the whole app session, shared by every workspace's controls. */
let sessions: ChatSessionStore = createChatSessionStore();
beforeEach(() => {
  sessions = createChatSessionStore();
});
function controls(over: Partial<CopilotChatControls> = {}): CopilotChatControls {
  return {
    sessions,
    chatId: "chat-1",
    onLoadChat: vi.fn(async (): Promise<CopilotChatResult> => ({ ok: false, notFound: true })),
    onListChats: vi.fn(async () => ({ ok: true as const, chats: [] })),
    onOpenChat: vi.fn(),
    onNewChat: vi.fn(),
    onDeleteChat: vi.fn(async () => ({ ok: true as const, outcome: "deleted" as const })),
    ...over,
  };
}
function panel(p: Partial<CopilotProps> = {}): CopilotProps {
  return { workspaceScoped: true, onCollapse: () => {}, workspaceKey: EMP, ...p };
}
/** Render and let the chat's restore settle (Send waits while a chat loads). */
async function mount(p: CopilotProps): Promise<RenderResult> {
  let view: RenderResult | undefined;
  await act(async () => {
    view = render(<Copilot {...p} />);
  });
  return view as RenderResult;
}
async function ask(text: string): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
  });
}

describe("⛔ rule 4 — the panel shows only the ACTIVE workspace's chat", () => {
  it("an answered turn in one workspace is gone after a switch to another", async () => {
    const onAsk = vi.fn(async (): Promise<AskResult> => ({ ok: true, answer: answer("EMPLOYER ANSWER") }));
    const view = await mount(panel({ onAsk, chats: controls() }));
    await ask("employer question");
    expect(screen.getByText("EMPLOYER ANSWER")).toBeTruthy();
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk, workspaceKey: LIFE, chats: controls({ chatId: "chat-life" }) })} />);
    });
    expect(screen.queryByText("EMPLOYER ANSWER")).toBeNull();
    expect(screen.queryByText("employer question")).toBeNull();
  });

  it("an answer that arrives AFTER the switch is never shown under the new workspace", async () => {
    let resolve: (r: AskResult) => void = () => {};
    const onAsk = vi.fn(() => new Promise<AskResult>((r) => (resolve = r)));
    const view = await mount(panel({ onAsk, chats: controls() }));
    await ask("employer question");
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk, workspaceKey: LIFE, chats: controls({ chatId: "chat-life" }) })} />);
    });
    await act(async () => resolve({ ok: true, answer: answer("LATE EMPLOYER ANSWER") }));
    expect(screen.queryByText("LATE EMPLOYER ANSWER")).toBeNull();
    expect(screen.queryByText(/thinking/i)).toBeNull(); // the new view is not stuck pending
  });

  it("the draft does not carry over to another workspace", async () => {
    const view = await mount(panel({ onAsk: vi.fn(), chats: controls() }));
    fireEvent.change(screen.getByRole("textbox", { name: /ask copilot/i }), { target: { value: "half-typed employer text" } });
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), workspaceKey: LIFE, chats: controls({ chatId: "chat-life" }) })} />);
    });
    expect((screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement).value).toBe("");
  });
});

describe("restore — a saved chat comes back when the panel opens (9.25)", () => {
  it("⛔ restores the chat's turns, and a restored employer answer shows its egress notice", async () => {
    const onLoadChat = vi.fn(async (): Promise<CopilotChatResult> => ({
      ok: true,
      chat: { chatId: "chat-1", title: "Login", truncated: false, turns: [{ question: "What is the login bug?", answer: answer("It loops.", "claude") }] },
    }));
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: controls({ onLoadChat }) })} />);
    });
    expect(onLoadChat).toHaveBeenCalledWith("chat-1");
    expect(screen.getByText("What is the login bug?")).toBeTruthy();
    expect(screen.getByText("It loops.")).toBeTruthy();
    expect(document.querySelector(".sow-copilot-egress-notice")?.textContent).toContain("claude");
  });

  it("Send waits while a chat loads (the input stays enabled, so focus is kept), then works", async () => {
    let finish: (r: CopilotChatResult) => void = () => {};
    const onLoadChat = vi.fn(() => new Promise<CopilotChatResult>((r) => (finish = r)));
    const onAsk = vi.fn(async (): Promise<AskResult> => ({ ok: true, answer: answer("A") }));
    await act(async () => {
      render(<Copilot {...panel({ onAsk, chats: controls({ onLoadChat }) })} />);
    });
    const input = screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input); // review of 5b.4d: a disabled input dropped focus to <body>
    expect(screen.getByText(/loading this chat/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: "too early" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAsk).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ ok: false, notFound: true }));
    expect((screen.getByRole("button", { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a new chat (not saved yet) opens empty, with no error", async () => {
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: controls() })} />);
    });
    expect(screen.getByText(/ask a question/i)).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });

  it("a failed load says so", async () => {
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: controls({ onLoadChat: async () => ({ ok: false, notFound: false }) }) })} />);
    });
    expect(screen.getByText(/could not load this chat/i)).toBeTruthy();
  });
});

describe("the chat list — open, start and delete chats", () => {
  const CHATS = [
    { chatId: "chat-1", title: "Login loop", updatedAt: "2026-09-25T10:00:00.000Z" },
    { chatId: "chat-2", title: "Vendor review", updatedAt: "2026-09-24T10:00:00.000Z" },
  ];

  it("lists the workspace's chats; picking one opens it; New chat starts one", async () => {
    const c = controls({ onListChats: vi.fn(async () => ({ ok: true as const, chats: CHATS })) });
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: c })} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    expect(c.onListChats).toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Vendor review" }));
    });
    expect(c.onOpenChat).toHaveBeenCalledWith("chat-2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /new chat/i }));
    });
    expect(c.onNewChat).toHaveBeenCalled();
  });

  it("deleting a chat refreshes the list; deleting the OPEN chat starts a new one", async () => {
    let chats = CHATS;
    const c = controls({
      onListChats: vi.fn(async () => ({ ok: true as const, chats })),
      onDeleteChat: vi.fn(async (id: string) => ((chats = chats.filter((x) => x.chatId !== id)), { ok: true as const, outcome: "deleted" as const })),
    });
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: c })} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Vendor review" }));
    });
    expect(c.onDeleteChat).toHaveBeenCalledWith("chat-2");
    expect(screen.queryByRole("button", { name: "Vendor review" })).toBeNull();
    expect(c.onNewChat).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Login loop" }));
    });
    expect(c.onNewChat).toHaveBeenCalled(); // chat-1 was the open chat
  });
});

// Review of 5b.4d (2026-09-25) — the panel renders each chat's SESSION from App's store (keyed by workspace + chat), so
// nothing is reset after a switch, and an answer in flight is never lost or shown anywhere else.
describe("review of 5b.4d — sessions, not per-view state", () => {
  it("⛔ 9.25 — a restored answer WITHOUT an egress notice shows none (no over-disclosure)", async () => {
    const onLoadChat = vi.fn(async (): Promise<CopilotChatResult> => ({
      ok: true,
      chat: { chatId: "chat-1", title: "t", truncated: false, turns: [{ question: "q", answer: answer("A personal answer.") }] },
    }));
    await mount(panel({ onAsk: vi.fn(), chats: controls({ onLoadChat }) }));
    expect(screen.getByText("A personal answer.")).toBeTruthy();
    expect(document.querySelector(".sow-copilot-egress-notice")).toBeNull();
  });

  it("⛔ rule 4 — the open chat list belongs to its workspace: it is gone after a switch, titles and all", async () => {
    const c = controls({ onListChats: vi.fn(async () => ({ ok: true as const, chats: [{ chatId: "e1", title: "EMPLOYER TITLE", updatedAt: "2026-09-25T10:00:00.000Z" }] })) });
    const view = await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    expect(screen.getByText("EMPLOYER TITLE")).toBeTruthy();
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), workspaceKey: LIFE, chats: { ...c, chatId: "chat-life" } })} />);
    });
    expect(screen.queryByText("EMPLOYER TITLE")).toBeNull();
  });

  it("an answer in flight survives a switch AWAY and BACK: 'Thinking…' returns, a second ask waits, the answer shows once", async () => {
    let resolve: (r: AskResult) => void = () => {};
    const onAsk = vi.fn(() => new Promise<AskResult>((r) => (resolve = r)));
    const emp = controls();
    const view = await mount(panel({ onAsk, chats: emp }));
    await ask("slow question");
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk, workspaceKey: LIFE, chats: { ...emp, chatId: "chat-life" } })} />);
    });
    expect(screen.queryByText(/thinking/i)).toBeNull();
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk, chats: emp })} />);
    });
    expect(screen.getByText(/thinking/i)).toBeTruthy();
    await ask("second question");
    const input = screen.getByRole("textbox", { name: /ask copilot/i });
    fireEvent.change(input, { target: { value: "second by Enter" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onAsk).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ ok: true, answer: answer("SLOW ANSWER") }));
    expect(screen.getAllByText("SLOW ANSWER")).toHaveLength(1);
  });

  it("an answer in flight survives the panel COLLAPSING: it shows when the panel is opened again", async () => {
    let resolve: (r: AskResult) => void = () => {};
    const onAsk = vi.fn(() => new Promise<AskResult>((r) => (resolve = r)));
    const c = controls();
    const view = await mount(panel({ onAsk, chats: c }));
    await ask("slow question");
    view.unmount();
    await act(async () => resolve({ ok: true, answer: answer("ANSWER WHILE CLOSED") }));
    await mount(panel({ onAsk, chats: c }));
    expect(screen.getByText("ANSWER WHILE CLOSED")).toBeTruthy();
  });

  it("a failed ask in a saved chat is an explicit failure turn (9.24), never silent", async () => {
    await mount(panel({ onAsk: vi.fn(async (): Promise<AskResult> => ({ ok: false })), chats: controls() }));
    await ask("will fail");
    expect(screen.getByText(/couldn.t answer that/i)).toBeTruthy();
  });

  it("a chat with an answer in flight cannot be deleted (the worker would save the answer and bring it back)", async () => {
    const c = controls({ onListChats: vi.fn(async () => ({ ok: true as const, chats: [{ chatId: "chat-1", title: "Busy chat", updatedAt: "2026-09-25T10:00:00.000Z" }] })) });
    await mount(panel({ onAsk: vi.fn(() => new Promise<AskResult>(() => {})), chats: c }));
    await ask("in flight");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    expect((screen.getByRole("button", { name: "Delete chat: Busy chat" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed delete says so; a late delete after a switch touches nothing under the new workspace", async () => {
    let resolveDelete: (r: { ok: false }) => void = () => {};
    const c = controls({
      onListChats: vi.fn(async () => ({ ok: true as const, chats: [{ chatId: "x", title: "Other chat", updatedAt: "2026-09-25T10:00:00.000Z" }] })),
      onDeleteChat: vi.fn(() => new Promise<{ ok: false }>((r) => (resolveDelete = r))),
    });
    const view = await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Other chat" }));
    });
    await act(async () => resolveDelete({ ok: false }));
    expect(screen.getByRole("alert").textContent).toMatch(/could not delete/i);
    // Now a slow delete that lands after a switch.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Other chat" }));
    });
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), workspaceKey: LIFE, chats: { ...c, chatId: "chat-life" } })} />);
    });
    const listCalls = (c.onListChats as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => (resolveDelete as unknown as (r: unknown) => void)({ ok: true, outcome: "deleted" }));
    expect((c.onListChats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCalls); // no refresh of the old list
    expect(screen.queryByText(/loading chats/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closing the list while an answer is on its way keeps it closed; an open list is refreshed when the answer lands", async () => {
    let resolve: (r: AskResult) => void = () => {};
    const c = controls({ onListChats: vi.fn(async () => ({ ok: true as const, chats: [] })) });
    await mount(panel({ onAsk: vi.fn(() => new Promise<AskResult>((r) => (resolve = r))), chats: c }));
    await ask("q");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => resolve({ ok: true, answer: answer("A") }));
    expect(screen.queryByRole("region", { name: /saved chats/i })).toBeNull();
  });

  it("New chat and opening a chat put the focus in the ask box", async () => {
    const c = controls({ onListChats: vi.fn(async () => ({ ok: true as const, chats: [] })) });
    await mount(panel({ onAsk: vi.fn(), chats: c }));
    const toggle = screen.getByRole("button", { name: /^chats$/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(screen.getByRole("region", { name: /saved chats/i }).id);
    expect(screen.getByText(/saved on this mac, for this workspace only/i)).toBeTruthy();
    const newChat = screen.getByRole("button", { name: /new chat/i });
    newChat.focus();
    await act(async () => {
      fireEvent.click(newChat);
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /ask copilot/i }));
  });

  it("a restored chat that holds older turns says so; a failed restore offers Try again and Send waits", async () => {
    await mount(
      panel({
        onAsk: vi.fn(),
        chats: controls({ onLoadChat: async () => ({ ok: true, chat: { chatId: "chat-1", title: "t", truncated: true, turns: [{ question: "q", answer: answer("a") }] } }) }),
      }),
    );
    expect(screen.getByText(/older messages in this chat are not shown/i)).toBeTruthy();
    cleanup();
    sessions = createChatSessionStore();
    let tries = 0;
    await mount(panel({ onAsk: vi.fn(), chats: controls({ onLoadChat: async () => (tries++ === 0 ? { ok: false, notFound: false } : { ok: false, notFound: true }) }) }));
    expect(screen.getByText(/could not load this chat/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });
    expect(screen.queryByText(/could not load this chat/i)).toBeNull();
    expect(tries).toBe(2);
  });
});

describe("review of 5b.4d — pins for the session keys and late results", () => {
  it("⛔ rule 4 — a session is (workspace, chat): the SAME chat id under another workspace shows none of the first's turns", async () => {
    const onAsk = vi.fn(async (): Promise<AskResult> => ({ ok: true, answer: answer("FIRST WORKSPACE ANSWER") }));
    const c = controls({ chatId: "same-id" });
    const view = await mount(panel({ onAsk, chats: c }));
    await ask("first workspace question");
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk, workspaceKey: LIFE, chats: c })} />);
    });
    expect(screen.queryByText("FIRST WORKSPACE ANSWER")).toBeNull();
  });

  it("a list result that lands after the list was closed does not reopen it", async () => {
    let resolveList: (r: { ok: true; chats: [] }) => void = () => {};
    const c = controls({ onListChats: vi.fn(() => new Promise<{ ok: true; chats: [] }>((r) => (resolveList = r))) });
    await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => resolveList({ ok: true, chats: [] }));
    expect(screen.queryByRole("region", { name: /saved chats/i })).toBeNull();
  });
});

// Critic of 7e616b87 (2026-09-25, measured): a late delete acted on the state from the moment of the click, the busy
// Delete button did not update for another chat, and two focus / alert details.
describe("critic of 7e616b87 — late results act on the state when they LAND", () => {
  const listed = (ids: readonly string[]) => ({ ok: true as const, chats: ids.map((id) => ({ chatId: id, title: `Title ${id}`, updatedAt: "2026-09-25T10:00:00.000Z" })) });

  it("a late delete of the chat that WAS open does not replace a chat opened meanwhile", async () => {
    let resolveDelete: (r: unknown) => void = () => {};
    const onNewChat = vi.fn();
    const c = controls({ chatId: "x", onNewChat, onListChats: vi.fn(async () => listed(["x", "y"])), onDeleteChat: vi.fn(() => new Promise((r) => (resolveDelete = r))) as never });
    const view = await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Title x" }));
    });
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), chats: { ...c, chatId: "y" } })} />); // the owner opened y
    });
    await act(async () => resolveDelete({ ok: true, outcome: "deleted" }));
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("a late delete of a chat REOPENED meanwhile starts a new chat — never a chat stuck on 'Loading'", async () => {
    let resolveDelete: (r: unknown) => void = () => {};
    const onNewChat = vi.fn();
    const c = controls({ chatId: "y", onNewChat, onListChats: vi.fn(async () => listed(["x", "y"])), onDeleteChat: vi.fn(() => new Promise((r) => (resolveDelete = r))) as never });
    const view = await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Title x" }));
    });
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), chats: { ...c, chatId: "x" } })} />); // the owner reopened x
    });
    await act(async () => resolveDelete({ ok: true, outcome: "deleted" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("a late delete does not reopen a list the owner closed, nor move focus out of the ask box", async () => {
    let resolveDelete: (r: unknown) => void = () => {};
    const c = controls({ onListChats: vi.fn(async () => listed(["x"])), onDeleteChat: vi.fn(() => new Promise((r) => (resolveDelete = r))) as never });
    await mount(panel({ onAsk: vi.fn(), chats: c }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Title x" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i })); // close the list
    });
    const input = screen.getByRole("textbox", { name: /ask copilot/i });
    input.focus();
    await act(async () => resolveDelete({ ok: true, outcome: "deleted" }));
    expect(screen.queryByRole("region", { name: /saved chats/i })).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("another chat's Delete button is enabled again as soon as its answer fails", async () => {
    let resolveAsk: (r: AskResult) => void = () => {};
    const c = controls({ chatId: "a", onListChats: vi.fn(async () => listed(["a", "b"])) });
    const view = await mount(panel({ onAsk: vi.fn(() => new Promise<AskResult>((r) => (resolveAsk = r))), chats: c }));
    await ask("in flight in a");
    await act(async () => {
      view.rerender(<Copilot {...panel({ onAsk: vi.fn(), chats: { ...c, chatId: "b" } })} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    expect((screen.getByRole("button", { name: "Delete chat: Title a" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolveAsk({ ok: false }));
    expect((screen.getByRole("button", { name: "Delete chat: Title a" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an OPEN list is refreshed when an answer lands (a first answer adds the chat)", async () => {
    let resolve: (r: AskResult) => void = () => {};
    const onListChats = vi.fn(async () => listed([]));
    await mount(panel({ onAsk: vi.fn(() => new Promise<AskResult>((r) => (resolve = r))), chats: controls({ onListChats }) }));
    await ask("q");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    });
    const before = onListChats.mock.calls.length;
    await act(async () => resolve({ ok: true, answer: answer("A") }));
    expect(onListChats.mock.calls.length).toBe(before + 1);
  });

  it("Try again keeps focus in the panel; a failed-delete alert is not shown again when the list is reopened", async () => {
    let tries = 0;
    await mount(panel({ onAsk: vi.fn(), chats: controls({ onLoadChat: async () => (tries++ === 0 ? { ok: false, notFound: false } : { ok: false, notFound: true }) }) }));
    const retry = screen.getByRole("button", { name: /try again/i });
    retry.focus();
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /ask copilot/i }));
    cleanup();
    sessions = createChatSessionStore();
    await mount(panel({ onAsk: vi.fn(), chats: controls({ onListChats: vi.fn(async () => listed(["x"])), onDeleteChat: async () => ({ ok: false }) }) }));
    const toggle = screen.getByRole("button", { name: /^chats$/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete chat: Title x" }));
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
