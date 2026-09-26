// The Copilot's SAVED CHATS port (Linear slice 5b.4c; owner decisions 2026-09-25: chats are saved in the local store,
// as a list of chats per workspace). Over the REAL 5b.4a repository. ⛔ WS-8: every call is for ONE known workspace,
// and a chat of another workspace is never listed, opened or deleted from it.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Workspace, WorkspaceId, UiSafeCopilotAnswer, Result, FailureVariant } from "@sow/contracts";
import type { WorkspaceConfigRepository, DbError } from "@sow/db";
import { createSqliteCopilotChatRepository, type CopilotChatRepository } from "@sow/db/repositories/copilotChats";
import { createCopilotChatsPort } from "../../src/composition/copilotChats";
import { createCopilotChatMemory } from "../../src/composition/copilotChatMemory";

const EMP = "employer-work";
const LIFE = "personal-life";
const answer: UiSafeCopilotAnswer = { answer: ["It loops."], citations: [], egressProcessor: "claude" };

function repo(): CopilotChatRepository {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE "copilot_chats" ("chatId" text PRIMARY KEY NOT NULL, "workspaceId" text NOT NULL, "title" text NOT NULL, "createdAt" text NOT NULL, "updatedAt" text NOT NULL);`);
  sqlite.exec(`CREATE TABLE "copilot_chat_turns" ("turnId" text PRIMARY KEY NOT NULL, "chatId" text NOT NULL, "workspaceId" text NOT NULL, "seq" integer NOT NULL, "question" text NOT NULL, "answer" text NOT NULL, "createdAt" text NOT NULL);`);
  return createSqliteCopilotChatRepository(drizzle(sqlite));
}
function workspaces(known: readonly string[] = [EMP, LIFE]): WorkspaceConfigRepository {
  const nf = { code: "not_found", message: "nf" } as DbError;
  return { get: async (id: WorkspaceId) => (known.includes(String(id)) ? ok({ id } as unknown as Workspace) : err(nf)) } as unknown as WorkspaceConfigRepository;
}
async function seeded() {
  const r = repo();
  const mem = createCopilotChatMemory(r, () => "2026-09-25T10:00:00.000Z");
  await mem.save({ workspaceId: EMP, chatId: "chat-emp", question: "What is the login bug?", answer });
  await mem.save({ workspaceId: EMP, chatId: "chat-emp", question: "Who owns it?", answer });
  await mem.save({ workspaceId: LIFE, chatId: "chat-life", question: "Dinner plans?", answer });
  return createCopilotChatsPort({ chats: r, workspaceConfig: workspaces() });
}

describe("createCopilotChatsPort — list, open and delete a workspace's saved chats", () => {
  it("lists ONE workspace's chats", async () => {
    const p = await seeded();
    const emp = await p.list({ workspaceId: EMP });
    expect(isOk(emp) && emp.value.chats.map((c) => [c.chatId, c.title])).toEqual([["chat-emp", "What is the login bug?"]]);
    const life = await p.list({ workspaceId: LIFE });
    expect(isOk(life) && life.value.chats.map((c) => c.chatId)).toEqual(["chat-life"]);
  });

  it("⛔ 9.25: opens a chat with its turns — each with its whole answer, the egress notice included", async () => {
    const p = await seeded();
    const got = await p.get({ workspaceId: EMP, chatId: "chat-emp" });
    expect(isOk(got) && got.value.turns.map((t) => t.question)).toEqual(["What is the login bug?", "Who owns it?"]);
    expect(isOk(got) && got.value.turns[0]?.answer.egressProcessor).toBe("claude");
    expect(isOk(got) && got.value.truncated).toBe(false);
  });

  it("⛔ WS-8: another workspace's chat is never opened or deleted — it is simply not there", async () => {
    const p = await seeded();
    const got = await p.get({ workspaceId: LIFE, chatId: "chat-emp" });
    expect(isErr(got) && got.error.cause?.code).toBe("COPILOT_CHAT_NOT_FOUND");
    expect(await p.remove({ workspaceId: LIFE, chatId: "chat-emp" })).toEqual(ok({ outcome: "not_found" }));
    const still = await p.get({ workspaceId: EMP, chatId: "chat-emp" });
    expect(isOk(still)).toBe(true);
  });

  it("deletes a chat; a second delete is not_found", async () => {
    const p = await seeded();
    expect(await p.remove({ workspaceId: EMP, chatId: "chat-emp" })).toEqual(ok({ outcome: "deleted" }));
    expect(await p.remove({ workspaceId: EMP, chatId: "chat-emp" })).toEqual(ok({ outcome: "not_found" }));
    const listed = await p.list({ workspaceId: EMP });
    expect(isOk(listed) && listed.value.chats).toEqual([]);
  });

  it("an unknown workspace is refused before any read", async () => {
    const p = createCopilotChatsPort({ chats: repo(), workspaceConfig: workspaces([EMP]) });
    const results: readonly Result<unknown, FailureVariant>[] = [await p.list({ workspaceId: "nope" }), await p.get({ workspaceId: "nope", chatId: "c" }), await p.remove({ workspaceId: "nope", chatId: "c" })];
    for (const r of results) {
      expect(isErr(r) && r.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("a store fault is a typed 'unavailable', never a throw", async () => {
    const broken = {
      listChats: async () => err({ code: "unavailable", message: "down" }),
      getChat: async () => err({ code: "unavailable", message: "down" }),
      deleteChat: async () => {
        throw new Error("boom");
      },
    } as unknown as CopilotChatRepository;
    const p = createCopilotChatsPort({ chats: broken, workspaceConfig: workspaces() });
    const results: readonly Result<unknown, FailureVariant>[] = [await p.list({ workspaceId: EMP }), await p.get({ workspaceId: EMP, chatId: "c" }), await p.remove({ workspaceId: EMP, chatId: "c" })];
    for (const r of results) {
      expect(isErr(r) && r.error.cause?.code).toBe("COPILOT_CHATS_UNAVAILABLE");
    }
  });
});
