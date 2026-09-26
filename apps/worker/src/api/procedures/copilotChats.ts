// @sow/worker — the Copilot's SAVED CHATS surface: list a workspace's chats, open one, delete one (Linear slice 5b.4c).
//
// Owner decisions (2026-09-25): Copilot chats are saved in the worker's local store (they survive a restart), as a
// LIST of chats per workspace. The port (composition/copilotChats.ts) reads by (workspaceId, chatId) — WS-8 — and
// refuses an unknown workspace. This router authenticates, validates the input at the boundary, and re-checks every
// output against its UI-safe contract, so a producer bug becomes a typed error, never a leak.
import { err, failure } from "@sow/contracts";
import type { FailureVariant, Result, UiSafeCopilotChat, UiSafeCopilotChatDeleteResult, UiSafeCopilotChatList } from "@sow/contracts";
import { UiSafeCopilotChatDeleteResultSchema, UiSafeCopilotChatListSchema, UiSafeCopilotChatSchema } from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";

export interface CopilotChatsListInput {
  readonly workspaceId: string;
}
export interface CopilotChatInput {
  readonly workspaceId: string;
  readonly chatId: string;
}

/** The saved-chats port. The composition root binds the real one; a test injects a fake. Never throws. */
export interface CopilotChatsPort {
  readonly list: (input: CopilotChatsListInput) => Promise<Result<UiSafeCopilotChatList, FailureVariant>>;
  readonly get: (input: CopilotChatInput) => Promise<Result<UiSafeCopilotChat, FailureVariant>>;
  readonly remove: (input: CopilotChatInput) => Promise<Result<UiSafeCopilotChatDeleteResult, FailureVariant>>;
}

const unavailable = (): Result<never, FailureVariant> =>
  err(failure("degraded_unavailable", "copilot chats not bound", { cause: { code: "COPILOT_CHATS_UNAVAILABLE" } }));

/** The port bound when nothing real is available: every call fails closed, nothing is ever faked. */
export const UNAVAILABLE_COPILOT_CHATS_PORT: CopilotChatsPort = {
  list: async () => unavailable(),
  get: async () => unavailable(),
  remove: async () => unavailable(),
};

const INPUT = (): Result<never, FailureVariant> =>
  err(failure("validation_rejected", "invalid copilot chats input", { cause: { code: "COPILOT_CHATS_INPUT" } }));
const UNSERVABLE = (): Result<never, FailureVariant> =>
  err(failure("validation_rejected", "copilot chats output failed its contract", { cause: { code: "COPILOT_CHATS_UNSERVABLE" } }));

/** Re-check an ok output against its contract. */
function checked<T>(res: Result<T, FailureVariant>, valid: (v: T) => boolean): Result<T, FailureVariant> {
  if (!res.ok) return res;
  return valid(res.value) ? res : UNSERVABLE();
}

const passthroughInput = (raw: unknown): unknown => raw;
/** The same opaque chat-id rule as the ask (`queries.ts`): letters, digits, "-" and "_", at most 64. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A workspace id: a non-empty string of at most 128, no line terminator (the same family the UI-safe gate refuses). */
const LINE_BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/;

function workspaceOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const ws = (raw as Record<string, unknown>)["workspaceId"];
  return typeof ws === "string" && ws.length > 0 && ws.length <= 128 && !LINE_BREAK.test(ws) ? ws : null;
}
function chatInput(raw: unknown): CopilotChatInput | null {
  const workspaceId = workspaceOf(raw);
  const chatId = (raw as Record<string, unknown> | null)?.["chatId"];
  return workspaceId !== null && typeof chatId === "string" && CHAT_ID.test(chatId) ? { workspaceId, chatId } : null;
}

export interface CopilotChatsRouterDeps {
  readonly copilotChats: CopilotChatsPort;
}

export function buildCopilotChatsRouter(deps: CopilotChatsRouterDeps) {
  const { copilotChats } = deps;
  return router({
    list: publicProcedure.input(passthroughInput).query(
      authedResolver<unknown, UiSafeCopilotChatList>(async (_ctx, raw) => {
        const workspaceId = workspaceOf(raw);
        if (workspaceId === null) return INPUT();
        return checked(await copilotChats.list({ workspaceId }), (v) => UiSafeCopilotChatListSchema.safeParse(v).success);
      }),
    ),
    get: publicProcedure.input(passthroughInput).query(
      authedResolver<unknown, UiSafeCopilotChat>(async (_ctx, raw) => {
        const input = chatInput(raw);
        if (input === null) return INPUT();
        return checked(await copilotChats.get(input), (v) => UiSafeCopilotChatSchema.safeParse(v).success);
      }),
    ),
    remove: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeCopilotChatDeleteResult>(async (_ctx, raw) => {
        const input = chatInput(raw);
        if (input === null) return INPUT();
        return checked(await copilotChats.remove(input), (v) => UiSafeCopilotChatDeleteResultSchema.safeParse(v).success);
      }),
    ),
  });
}

export type CopilotChatsRouter = ReturnType<typeof buildCopilotChatsRouter>;
