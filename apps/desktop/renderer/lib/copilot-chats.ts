import type { CreateTRPCClient } from "@trpc/client";
import type { AppRouter } from "@sow/worker";
import {
  UiSafeCopilotChatDeleteResultSchema,
  UiSafeCopilotChatListSchema,
  UiSafeCopilotChatSchema,
  type CopilotChatDeleteOutcome,
  type UiSafeCopilotChat,
  type UiSafeCopilotChatSummary,
} from "@sow/contracts/api/ui-safe";

// Linear slice 5b.4d — the renderer callers for the Copilot's SAVED chats (`copilotChats.*`). Owner decisions
// 2026-09-25: chats are saved in the local store, as a list of chats per workspace. The renderer only REQUESTS, always
// with the ACTIVE workspace's id; the worker keys every read by (workspaceId, chatId) (WS-8). Worker output is candidate
// data here too (desktop L46): an error, a thrown transport and a contract-breaking ok value all fold to { ok: false }.

export type CopilotChatListResult = { readonly ok: true; readonly chats: readonly UiSafeCopilotChatSummary[] } | { readonly ok: false };
/** `notFound` — the chat is simply not saved in this workspace (a new chat, or a deleted one), not a failure. */
export type CopilotChatResult = { readonly ok: true; readonly chat: UiSafeCopilotChat } | { readonly ok: false; readonly notFound: boolean };
export type DeleteCopilotChatResult = { readonly ok: true; readonly outcome: CopilotChatDeleteOutcome } | { readonly ok: false };

export function createCopilotChatList(client: CreateTRPCClient<AppRouter>): (workspaceId: string) => Promise<CopilotChatListResult> {
  return async (workspaceId) => {
    try {
      const res = await client.copilotChats.list.query({ workspaceId });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeCopilotChatListSchema.safeParse(res.value);
      return parsed.success ? { ok: true, chats: parsed.data.chats } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}

export function createCopilotChat(client: CreateTRPCClient<AppRouter>): (workspaceId: string, chatId: string) => Promise<CopilotChatResult> {
  return async (workspaceId, chatId) => {
    try {
      const res = await client.copilotChats.get.query({ workspaceId, chatId });
      if (res.ok !== true) return { ok: false, notFound: res.error.cause?.code === "COPILOT_CHAT_NOT_FOUND" };
      const parsed = UiSafeCopilotChatSchema.safeParse(res.value);
      return parsed.success ? { ok: true, chat: parsed.data } : { ok: false, notFound: false };
    } catch {
      return { ok: false, notFound: false };
    }
  };
}

export function createDeleteCopilotChat(
  client: CreateTRPCClient<AppRouter>,
): (workspaceId: string, chatId: string) => Promise<DeleteCopilotChatResult> {
  return async (workspaceId, chatId) => {
    try {
      const res = await client.copilotChats.remove.mutate({ workspaceId, chatId });
      if (res.ok !== true) return { ok: false };
      const parsed = UiSafeCopilotChatDeleteResultSchema.safeParse(res.value);
      return parsed.success ? { ok: true, outcome: parsed.data.outcome } : { ok: false };
    } catch {
      return { ok: false };
    }
  };
}
