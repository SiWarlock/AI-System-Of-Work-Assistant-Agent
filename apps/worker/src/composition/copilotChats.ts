// @sow/worker — the real saved-chats port: list, open and delete a workspace's Copilot chats (Linear slice 5b.4c).
//
// Owner decisions (2026-09-25): chats are saved in the local store (slice 5b.4a), as a LIST per workspace. ⛔ WS-8:
// the workspace must be a registered one, and every repository call is keyed by (workspaceId, chatId), so another
// workspace's chat is simply not there — never listed, opened or deleted. Every output goes through the UI-safe
// projectors (named fields only). Never throws: a store fault is a typed `unavailable`.
import { ok, err, failure, isOk, MAX_COPILOT_CHATS, MAX_RESTORED_CHAT_TURNS } from "@sow/contracts";
import type { FailureVariant, Result, WorkspaceId } from "@sow/contracts";
import type { WorkspaceConfigRepository } from "@sow/db";
import type { CopilotChatRepository } from "@sow/db/repositories/copilotChats";
import type { CopilotChatsPort } from "../api/procedures/copilotChats";
import { toUiSafeCopilotChat, toUiSafeCopilotChatList } from "../api/projections/uiSafe";

export interface CopilotChatsPortDeps {
  readonly chats: CopilotChatRepository;
  readonly workspaceConfig: WorkspaceConfigRepository;
}

const UNKNOWN_WORKSPACE: Result<never, FailureVariant> = err(
  failure("validation_rejected", "unknown workspace", { cause: { code: "WORKSPACE_NOT_FOUND" } }),
);
const NOT_FOUND: Result<never, FailureVariant> = err(
  failure("validation_rejected", "no such chat in this workspace", { cause: { code: "COPILOT_CHAT_NOT_FOUND" } }),
);
const UNAVAILABLE: Result<never, FailureVariant> = err(
  failure("degraded_unavailable", "copilot chats could not be read", { cause: { code: "COPILOT_CHATS_UNAVAILABLE" } }),
);

async function known(deps: CopilotChatsPortDeps, workspaceId: string): Promise<boolean> {
  try {
    return isOk(await deps.workspaceConfig.get(workspaceId as WorkspaceId));
  } catch {
    return false;
  }
}

export function createCopilotChatsPort(deps: CopilotChatsPortDeps): CopilotChatsPort {
  return {
    async list({ workspaceId }) {
      if (!(await known(deps, workspaceId))) return UNKNOWN_WORKSPACE;
      try {
        const rows = await deps.chats.listChats(workspaceId, MAX_COPILOT_CHATS);
        return isOk(rows) ? ok(toUiSafeCopilotChatList(rows.value)) : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
    async get({ workspaceId, chatId }) {
      if (!(await known(deps, workspaceId))) return UNKNOWN_WORKSPACE;
      try {
        const chat = await deps.chats.getChat(workspaceId, chatId);
        if (!isOk(chat)) return chat.error.code === "not_found" ? NOT_FOUND : UNAVAILABLE;
        // One more than shown, so the projection can say the chat holds older turns.
        const turns = await deps.chats.getTurns(workspaceId, chatId, MAX_RESTORED_CHAT_TURNS + 1);
        if (!isOk(turns)) return turns.error.code === "not_found" ? NOT_FOUND : UNAVAILABLE;
        return ok(toUiSafeCopilotChat({ chatId: chat.value.chatId, title: chat.value.title, turns: turns.value, truncated: false }));
      } catch {
        return UNAVAILABLE;
      }
    },
    async remove({ workspaceId, chatId }) {
      if (!(await known(deps, workspaceId))) return UNKNOWN_WORKSPACE;
      try {
        const gone = await deps.chats.deleteChat(workspaceId, chatId);
        if (isOk(gone)) return ok({ outcome: "deleted" });
        return gone.error.code === "not_found" ? ok({ outcome: "not_found" }) : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
