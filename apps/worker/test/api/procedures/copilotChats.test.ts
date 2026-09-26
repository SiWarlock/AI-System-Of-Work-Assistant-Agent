// The saved-chats ROUTER (Linear slice 5b.4c): authenticated, the input validated at the boundary, and every output
// re-checked against its UI-safe contract (a producer bug becomes a typed error, never a leak).
import { describe, it, expect, vi } from "vitest";
import { ok, err, failure, isOk, isErr } from "@sow/contracts";
import type { UiSafeCopilotChat, UiSafeCopilotChatList } from "@sow/contracts";
import { buildCopilotChatsRouter, UNAVAILABLE_COPILOT_CHATS_PORT, type CopilotChatsPort } from "../../../src/api/procedures/copilotChats";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";

const AUTHED: ApiContext = { auth: ok<AuthedContext>({ authenticated: true }) };
const UNAUTHED: ApiContext = { auth: err(failure("validation_rejected", "unauthenticated", { cause: { code: "UNAUTHORIZED" } })) };
const WS = "employer-work";
const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const LIST: UiSafeCopilotChatList = { chats: [{ chatId: ID, title: "Login", updatedAt: "2026-09-25T10:00:00.000Z" }] };
const CHAT: UiSafeCopilotChat = { chatId: ID, title: "Login", turns: [{ question: "q", answer: { answer: ["a"], citations: [] } }], truncated: false };

function fakePort(over: Partial<CopilotChatsPort> = {}) {
  return {
    list: vi.fn(async () => ok(LIST)),
    get: vi.fn(async () => ok(CHAT)),
    remove: vi.fn(async () => ok({ outcome: "deleted" as const })),
    ...over,
  };
}
const caller = (port: CopilotChatsPort, ctx: ApiContext = AUTHED) =>
  createCallerFactory(router({ copilotChats: buildCopilotChatsRouter({ copilotChats: port }) }))(ctx);

describe("buildCopilotChatsRouter", () => {
  it("lists, opens and deletes through the port", async () => {
    const port = fakePort();
    const c = caller(port);
    expect(await c.copilotChats.list({ workspaceId: WS })).toEqual(ok(LIST));
    expect(await c.copilotChats.get({ workspaceId: WS, chatId: ID })).toEqual(ok(CHAT));
    expect(await c.copilotChats.remove({ workspaceId: WS, chatId: ID })).toEqual(ok({ outcome: "deleted" }));
    expect(port.get).toHaveBeenCalledWith({ workspaceId: WS, chatId: ID });
  });

  it("⛔ an unauthenticated caller reaches nothing", async () => {
    const port = fakePort();
    const c = caller(port, UNAUTHED);
    expect(isErr(await c.copilotChats.list({ workspaceId: WS }))).toBe(true);
    expect(isErr(await c.copilotChats.remove({ workspaceId: WS, chatId: ID }))).toBe(true);
    expect(port.list).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
  });

  it("a malformed input is refused before the port — a chat id is opaque: letters, digits, '-' and '_', at most 64", async () => {
    const port = fakePort();
    const c = caller(port);
    for (const bad of [{}, { workspaceId: "" }, { workspaceId: 7 }, { workspaceId: WS, chatId: "has space" }, { workspaceId: WS, chatId: "x".repeat(65) }, { workspaceId: WS }]) {
      const r = await c.copilotChats.get(bad as never);
      expect(isErr(r) && r.error.cause?.code, JSON.stringify(bad)).toBe("COPILOT_CHATS_INPUT");
    }
    expect(port.get).not.toHaveBeenCalled();
  });

  it("⛔ an output that breaks its contract is a typed error, never served", async () => {
    const leaky = fakePort({ get: vi.fn(async () => ok({ ...CHAT, workspaceId: WS } as unknown as UiSafeCopilotChat)) });
    const r = await caller(leaky).copilotChats.get({ workspaceId: WS, chatId: ID });
    expect(isErr(r) && r.error.cause?.code).toBe("COPILOT_CHATS_UNSERVABLE");
  });

  it("the unbound port fails closed", async () => {
    const r = await caller(UNAVAILABLE_COPILOT_CHATS_PORT).copilotChats.list({ workspaceId: WS });
    expect(isOk(r)).toBe(false);
  });
});
