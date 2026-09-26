// Linear slice 5b.4d — the renderer callers for the Copilot's SAVED chats (`copilotChats.*`; owner decisions
// 2026-09-25: saved in the local store, a list of chats per workspace). Worker output is candidate data here too
// (desktop L46): an error, a thrown transport, and an ok value that fails its UI-safe contract all fold to { ok: false }.
import { describe, it, expect } from "vitest";
import { createCopilotChatList, createCopilotChat, createDeleteCopilotChat } from "../../renderer/lib/copilot-chats";

const LIST = { chats: [{ chatId: "c1", title: "Login", updatedAt: "2026-09-25T10:00:00.000Z" }] };
const CHAT = { chatId: "c1", title: "Login", turns: [{ question: "q", answer: { answer: ["a"], citations: [], egressProcessor: "claude" } }], truncated: false };

function client(impl: { list?: unknown; get?: unknown; remove?: unknown }, seen: unknown[] = []): never {
  const call = (v: unknown) => (input: unknown) => (seen.push(input), v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    copilotChats: {
      list: { query: call(impl.list) },
      get: { query: call(impl.get) },
      remove: { mutate: call(impl.remove) },
    },
  } as never;
}

describe("createCopilotChatList", () => {
  it("returns the list for the workspace it was asked about", async () => {
    const seen: unknown[] = [];
    const r = await createCopilotChatList(client({ list: { ok: true, value: LIST } }, seen))("ws-1");
    expect(r).toEqual({ ok: true, chats: LIST.chats });
    expect(seen).toEqual([{ workspaceId: "ws-1" }]);
  });
  it("folds an error, a throw and a contract-breaking value to {ok:false}", async () => {
    for (const list of [{ ok: false, error: { kind: "x" } }, new Error("net"), { ok: true, value: { chats: [{ ...LIST.chats[0], workspaceId: "w" }] } }]) {
      expect(await createCopilotChatList(client({ list }))("ws-1")).toEqual({ ok: false });
    }
  });
});

describe("createCopilotChat", () => {
  it("⛔ 9.25: returns the chat with each answer WHOLE — its egress notice included", async () => {
    const r = await createCopilotChat(client({ get: { ok: true, value: CHAT } }))("ws-1", "c1");
    expect(r.ok && r.chat.turns[0]?.answer.egressProcessor).toBe("claude");
  });
  it("says when the chat is simply not there (a new chat), apart from a failure", async () => {
    const notFound = { ok: false, error: { kind: "validation_rejected", message: "x", cause: { code: "COPILOT_CHAT_NOT_FOUND" } } };
    expect(await createCopilotChat(client({ get: notFound }))("ws-1", "c1")).toEqual({ ok: false, notFound: true });
    expect(await createCopilotChat(client({ get: { ok: false, error: { kind: "degraded_unavailable" } } }))("ws-1", "c1")).toEqual({ ok: false, notFound: false });
    expect(await createCopilotChat(client({ get: new Error("net") }))("ws-1", "c1")).toEqual({ ok: false, notFound: false });
    expect(await createCopilotChat(client({ get: { ok: true, value: { ...CHAT, extra: 1 } } }))("ws-1", "c1")).toEqual({ ok: false, notFound: false });
  });
});

describe("createDeleteCopilotChat", () => {
  it("returns the closed outcome; anything else folds to {ok:false}", async () => {
    const seen: unknown[] = [];
    expect(await createDeleteCopilotChat(client({ remove: { ok: true, value: { outcome: "deleted" } } }, seen))("ws-1", "c1")).toEqual({ ok: true, outcome: "deleted" });
    expect(seen).toEqual([{ workspaceId: "ws-1", chatId: "c1" }]);
    expect(await createDeleteCopilotChat(client({ remove: { ok: true, value: { outcome: "archived" } } }))("ws-1", "c1")).toEqual({ ok: false });
    expect(await createDeleteCopilotChat(client({ remove: new Error("net") }))("ws-1", "c1")).toEqual({ ok: false });
  });
});
