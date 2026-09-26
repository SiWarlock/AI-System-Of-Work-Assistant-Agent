// The UI-safe projection of the Copilot's SAVED chats (Linear slice 5b.4c; owner decisions 2026-09-25: saved in the
// local store, a list of chats per workspace). ⛔ NAMED fields only — never a spread — so a stored row's other columns
// (its workspace, its turn ids) cannot ride out. ⛔ Task 9.25: a restored turn keeps its WHOLE gated answer, the egress
// notice included, so the panel can say again which cloud processor made it.
import { describe, it, expect } from "vitest";
import {
  UiSafeCopilotChatListSchema,
  UiSafeCopilotChatSchema,
  UI_SAFE_ALLOWLIST,
  MAX_COPILOT_CHATS,
  MAX_RESTORED_CHAT_TURNS,
} from "@sow/contracts";
import { toUiSafeCopilotChatList, toUiSafeCopilotChat } from "../../src/api/projections/uiSafe";

const NL = String.fromCharCode(10);
const T = "2026-09-25T10:00:00.000Z";
const answer = { answer: ["It loops."], citations: [{ citationId: "gbrain:n1", title: "Note" }], egressProcessor: "claude" };

describe("toUiSafeCopilotChatList", () => {
  it("copies the id, a one-line title and the time — never the workspace", () => {
    const out = toUiSafeCopilotChatList([{ chatId: "c1", workspaceId: "employer-work", title: `What is${NL}it?`, createdAt: T, updatedAt: T } as never]);
    expect(out).toEqual({ chats: [{ chatId: "c1", title: "What is it?", updatedAt: T }] });
    expect(JSON.stringify(out)).not.toContain("employer-work");
    expect(UiSafeCopilotChatListSchema.safeParse(out).success).toBe(true);
    for (const k of Object.keys(out.chats[0] ?? {})) expect(UI_SAFE_ALLOWLIST.copilotChatSummary as readonly string[]).toContain(k);
  });

  it(`drops a row that breaks the contract, and keeps at most ${String(MAX_COPILOT_CHATS)}`, () => {
    const rows = [
      { chatId: "x".repeat(65), title: "long id", updatedAt: T },
      { chatId: "c1", title: "bad time", updatedAt: "yesterday" },
      ...Array.from({ length: 60 }, (_, i) => ({ chatId: `c${String(i)}`, title: `t${String(i)}`, updatedAt: T })),
    ];
    const out = toUiSafeCopilotChatList(rows as never);
    expect(out.chats).toHaveLength(MAX_COPILOT_CHATS);
    expect(out.chats[0]?.chatId).toBe("c0");
    expect(UiSafeCopilotChatListSchema.safeParse(out).success).toBe(true);
  });

  it("a blank title reads 'Chat'", () => {
    expect(toUiSafeCopilotChatList([{ chatId: "c", title: "   ", updatedAt: T }] as never).chats[0]?.title).toBe("Chat");
  });
});

describe("toUiSafeCopilotChat", () => {
  const turn = (q: string, a: unknown = answer) => ({ question: q, answer: JSON.stringify(a), chatId: "c1", seq: 1, createdAt: T });

  it("⛔ 9.25: restores each turn with its WHOLE gated answer — the egress notice too", () => {
    const out = toUiSafeCopilotChat({ chatId: "c1", title: "Login", turns: [turn("What is it?")], truncated: false });
    expect(out).toEqual({ chatId: "c1", title: "Login", turns: [{ question: "What is it?", answer }], truncated: false });
    expect(out.turns[0]?.answer.egressProcessor).toBe("claude");
    expect(UiSafeCopilotChatSchema.safeParse(out).success).toBe(true);
  });

  it("drops a turn whose stored answer is not a valid gated answer, or whose question breaks the bound", () => {
    const out = toUiSafeCopilotChat({
      chatId: "c1",
      title: "t",
      turns: [turn("ok"), { ...turn("broken"), answer: "{not json" }, turn("extra key", { ...answer, payload: "SECRET" }), turn("x".repeat(4001)), turn("")],
      truncated: false,
    });
    expect(out.turns.map((t) => t.question)).toEqual(["ok"]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it(`keeps the newest ${String(MAX_RESTORED_CHAT_TURNS)} turns and says so`, () => {
    const turns = Array.from({ length: MAX_RESTORED_CHAT_TURNS + 3 }, (_, i) => turn(`q${String(i)}`));
    const out = toUiSafeCopilotChat({ chatId: "c1", title: "t", turns, truncated: false });
    expect(out.turns).toHaveLength(MAX_RESTORED_CHAT_TURNS);
    expect(out.turns[0]?.question).toBe("q3");
    expect(out.truncated).toBe(true);
    expect(UiSafeCopilotChatSchema.safeParse(out).success).toBe(true);
  });
});
