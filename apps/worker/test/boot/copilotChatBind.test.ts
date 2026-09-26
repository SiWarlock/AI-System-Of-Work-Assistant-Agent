// bootWorker binds the Copilot's SAVED chats (Linear slice 5b.4b; owner decisions 2026-09-25: chats are saved in the
// local store, so they survive a restart). Two halves:
//   • boot's own source hands the ask a chat memory over the backends' chat store (the idiom of the other boot binding
//     tests — a full boot needs a live port);
//   • the backends' chat store is REAL: built over the SAME migrated connection, so migration 0019's tables exist and
//     a turn round-trips through it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isOk } from "@sow/contracts";
import { assembleBackends } from "../../src/composition/backends";
import { createCopilotChatMemory } from "../../src/composition/copilotChatMemory";

const BOOT = readFileSync(join(__dirname, "..", "..", "src", "boot.ts"), "utf8");

describe("bootWorker's Copilot chat memory binding", () => {
  it("the Copilot deps get a chat memory over the backends' own chat store and clock", () => {
    const start = BOOT.indexOf("const copilot = buildCopilotDeps({");
    expect(start).toBeGreaterThan(-1); // positive control
    const call = BOOT.slice(start, BOOT.indexOf("\n  });", start));
    expect(call).toContain("chats: createCopilotChatMemory(backends.copilotChats, backends.now),");
  });

  it("the saved-chats port (list / open / delete, slice 5b.4c) is built over the same store and handed to the API", () => {
    const start = BOOT.indexOf("const copilotChats: CopilotChatsPort = createCopilotChatsPort({");
    expect(start).toBeGreaterThan(-1); // positive control
    const call = BOOT.slice(start, BOOT.indexOf("\n  });", start));
    expect(call).toContain("chats: backends.copilotChats,");
    expect(call).toContain("workspaceConfig: backends.repos.workspaceConfig,");
    expect(BOOT).toMatch(/linearIssue,\s*\n\s*copilotChats,\s*\n\s*now: backends\.now,/);
  });

  it("the backends' chat store runs on the MIGRATED database: a saved turn reads back, in its own workspace only", async () => {
    const backends = await assembleBackends({ dbPath: ":memory:" });
    try {
      const mem = createCopilotChatMemory(backends.copilotChats, backends.now);
      await mem.save({ workspaceId: "employer-work", chatId: "chat-1", question: "What is the login bug?", answer: { answer: ["It loops."], citations: [] } });
      const turns = await mem.recent("employer-work", "chat-1", 10);
      expect(turns.map((t) => t.question)).toEqual(["What is the login bug?"]);
      expect(await mem.recent("personal-life", "chat-1", 10)).toEqual([]);
      const listed = await backends.copilotChats.listChats("employer-work", 10);
      expect(isOk(listed) && listed.value.map((c) => c.title)).toEqual(["What is the login bug?"]);
    } finally {
      backends.close();
    }
  });
});
