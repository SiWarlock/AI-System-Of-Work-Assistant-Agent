// The store-backed Copilot chat memory (Linear slice 5b.4b) — the worker's adapter from the ask's `CopilotChatMemory`
// port onto the @sow/db chat repository (slice 5b.4a). Owner decision 2026-09-25: chats are SAVED in the local store.
// It never throws: a store fault reads as "no history" and a failed save never fails an answer the owner already has.
import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ok, err, isOk } from "@sow/contracts";
import type { UiSafeCopilotAnswer } from "@sow/contracts";
import { createSqliteCopilotChatRepository, type CopilotChatRepository } from "@sow/db/repositories/copilotChats";
import { createCopilotChatMemory } from "../../src/composition/copilotChatMemory";
import { encodeSavedAnswer } from "../../src/api/procedures/copilotChatHistory";

const WS = "employer-work";
const answer: UiSafeCopilotAnswer = { answer: ["It loops."], citations: [{ citationId: "gbrain:n1", title: "Note" }], egressProcessor: "claude" };

function realRepo(): CopilotChatRepository {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE "copilot_chats" ("chatId" text PRIMARY KEY NOT NULL, "workspaceId" text NOT NULL, "title" text NOT NULL, "createdAt" text NOT NULL, "updatedAt" text NOT NULL);`);
  sqlite.exec(`CREATE TABLE "copilot_chat_turns" ("turnId" text PRIMARY KEY NOT NULL, "chatId" text NOT NULL, "workspaceId" text NOT NULL, "seq" integer NOT NULL, "question" text NOT NULL, "answer" text NOT NULL, "createdAt" text NOT NULL);`);
  return createSqliteCopilotChatRepository(drizzle(sqlite));
}

describe("createCopilotChatMemory — the ask's chat memory over the saved-chats store", () => {
  it("saves an answered turn (the whole gated answer, a title from the question) and reads it back as the next turn's history", async () => {
    const repo = realRepo();
    const mem = createCopilotChatMemory(repo, () => "2026-09-25T10:00:00.000Z");
    expect(await mem.recent(WS, "chat-1", 10)).toEqual([]); // a new chat has no history
    await mem.save({ workspaceId: WS, chatId: "chat-1", question: `What is${String.fromCharCode(10)}the login bug?`, answer });
    const turns = await mem.recent(WS, "chat-1", 10);
    // ⛔ 9.25: saved with an EXPLICIT disclosure beside the answer, so a restore never reads a missing notice as "none".
    expect(turns).toEqual([{ question: `What is${String.fromCharCode(10)}the login bug?`, answer: encodeSavedAnswer(answer) }]);
    expect(JSON.parse(turns[0]?.answer ?? "{}").disclosure).toEqual({ kind: "processor", value: "claude" });
    const chat = await repo.getChat(WS, "chat-1");
    expect(isOk(chat) && [chat.value.title, chat.value.createdAt]).toEqual(["What is the login bug?", "2026-09-25T10:00:00.000Z"]);
  });

  it("⛔ rule 4: another workspace reads nothing, and cannot add to the chat", async () => {
    const repo = realRepo();
    const mem = createCopilotChatMemory(repo, () => "2026-09-25T10:00:00.000Z");
    await mem.save({ workspaceId: WS, chatId: "chat-1", question: "employer q", answer });
    expect(await mem.recent("personal-life", "chat-1", 10)).toEqual([]);
    await mem.save({ workspaceId: "personal-life", chatId: "chat-1", question: "personal q", answer });
    expect((await mem.recent(WS, "chat-1", 10)).map((t) => t.question)).toEqual(["employer q"]);
  });

  it("asks the store for only the newest `max` turns", async () => {
    const getTurns = vi.fn(async () => ok([]));
    const mem = createCopilotChatMemory({ getTurns } as unknown as CopilotChatRepository, () => "t");
    await mem.recent(WS, "chat-1", 10);
    expect(getTurns).toHaveBeenCalledWith(WS, "chat-1", 10);
  });

  it("never throws: a store fault reads as no history, and a failed save is swallowed", async () => {
    const broken = {
      getTurns: async () => err({ code: "unavailable", message: "down" }),
      appendTurn: async () => err({ code: "unavailable", message: "down" }),
    } as unknown as CopilotChatRepository;
    const throwing = {
      getTurns: async () => {
        throw new Error("boom");
      },
      appendTurn: async () => {
        throw new Error("boom");
      },
    } as unknown as CopilotChatRepository;
    for (const repo of [broken, throwing]) {
      const mem = createCopilotChatMemory(repo, () => "t");
      expect(await mem.recent(WS, "c", 10)).toEqual([]);
      await expect(mem.save({ workspaceId: WS, chatId: "c", question: "q", answer })).resolves.toBeUndefined();
    }
  });
});
