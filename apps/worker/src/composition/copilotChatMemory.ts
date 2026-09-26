// @sow/worker — the Copilot's CHAT MEMORY over the saved-chats store (Linear slice 5b.4b).
//
// Owner decisions 2026-09-25: chats are SAVED in the worker's local operational store (they survive a restart), and
// the ask gives the model the same chat's earlier turns (rule-6 exception 2 — see `copilotChatHistory.ts`). This is
// the adapter from the ask's `CopilotChatMemory` port onto the @sow/db repository (slice 5b.4a).
//
// ⛔ Rule 4: every call is keyed by the ask's own (workspaceId, chatId); the repository refuses a chat id that exists
// under another workspace (a read is empty, a save is refused). ⛔ Rule 7: question/answer are raw content — never
// logged here, and a store fault is swallowed without its message (the repository already returns a fixed message and
// no cause). Never throws: an unreadable chat is no history; a failed save never fails an answered ask.
import { isOk } from "@sow/contracts";
import type { CopilotChatRepository } from "@sow/db/repositories/copilotChats";
import type { CopilotChatMemory } from "../api/procedures/copilot";
import { chatTitleOf, encodeSavedAnswer } from "../api/procedures/copilotChatHistory";

/** Build the ask's chat memory over the saved-chats repository. `now` is the boot clock (ISO-8601). */
export function createCopilotChatMemory(repo: CopilotChatRepository, now: () => string): CopilotChatMemory {
  return {
    async recent(workspaceId, chatId, max) {
      try {
        const turns = await repo.getTurns(workspaceId, chatId, max);
        return isOk(turns) ? turns.value.map((t) => ({ question: t.question, answer: t.answer })) : [];
      } catch {
        return [];
      }
    },
    async save(turn) {
      try {
        await repo.appendTurn({
          workspaceId: turn.workspaceId,
          chatId: turn.chatId,
          title: chatTitleOf(turn.question),
          question: turn.question,
          answer: encodeSavedAnswer(turn.answer), // ⛔ 9.25: with its explicit disclosure
          at: now(),
        });
      } catch {
        // A failed save never fails the ask: the owner already has the answer.
      }
    },
  };
}
