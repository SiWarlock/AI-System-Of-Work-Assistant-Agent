// @vitest-environment jsdom
//
// Linear slice 5b.4d — the Copilot panel's SAVED chats (owner decisions 2026-09-25: chats are saved in the local store,
// as a LIST of chats per workspace). Three safety properties are pinned here:
//   ⛔ Rule 4: the panel shows ONLY the active workspace's chat. A turn answered in workspace A is gone when the scope
//     switches to B, and an A answer that arrives AFTER the switch is never shown under B. (Before this slice the
//     transcript survived a switch — measured by the 5b.4 grounding, 2026-09-25.)
//   ⛔ Task 9.25: a RESTORED turn goes through `admitReply` like a live one, so its egress notice comes back with it.
//   • A new chat (not saved yet) opens empty, without an error; a failed load says so.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act, type RenderResult } from "@testing-library/react";
import { Copilot, type CopilotProps, type CopilotChatControls } from "../renderer/surfaces/copilot/Copilot";
import type { AskResult } from "../renderer/lib/copilot-ask";
import type { CopilotChatResult } from "../renderer/lib/copilot-chats";

afterEach(cleanup);

const EMP = "wk-emp-7";
const LIFE = "wk-life-3";
const answer = (text: string, egress?: string) => ({ answer: [text], citations: [], ...(egress !== undefined ? { egressProcessor: egress } : {}) });

function controls(over: Partial<CopilotChatControls> = {}): CopilotChatControls {
  return {
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
/** Render and let the chat's restore settle (the composer waits while a chat loads). */
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

  it("the composer waits while a chat loads, so a restore can never overwrite a turn asked meanwhile", async () => {
    let finish: (r: CopilotChatResult) => void = () => {};
    const onLoadChat = vi.fn(() => new Promise<CopilotChatResult>((r) => (finish = r)));
    await act(async () => {
      render(<Copilot {...panel({ onAsk: vi.fn(), chats: controls({ onLoadChat }) })} />);
    });
    expect((screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/loading this chat/i)).toBeTruthy();
    await act(async () => finish({ ok: false, notFound: true }));
    expect((screen.getByRole("textbox", { name: /ask copilot/i }) as HTMLTextAreaElement).disabled).toBe(false);
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
