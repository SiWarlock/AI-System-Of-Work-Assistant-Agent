// spec(§4 / Linear slice 5b.4a) — CopilotChatRepository: the Copilot's SAVED chats (owner decisions 2026-09-25:
// saved in the local store, one list of chats per workspace). ONE parameterized contract suite run identically against
// SQLite (real better-sqlite3) and Postgres (real PGlite, in-process) — the standalone-repository shape of
// `costLedger.test.ts`. DDL is generated from the Drizzle schema (never a hand-kept string); the migrated path is
// proven separately by `test/migrate/schema-migration-coverage.test.ts`.
//
// ⛔ WS-8 (rule 4) is the load-bearing property: every read and write is keyed by (workspaceId, chatId). A chat id that
// exists under another workspace is never read, extended or deleted from this one.
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { getTableConfig as getSqliteTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { getTableConfig as getPgTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import {
  createPostgresCopilotChatRepository,
  createSqliteCopilotChatRepository,
  COPILOT_CHAT_MAX_TURNS,
  type AppendCopilotChatTurn,
  type CopilotChatRepository,
} from "../src/repositories/copilotChats";
import { copilotChats as sqliteChats, copilotChatTurns as sqliteTurns } from "../src/schema/copilot-chats";
import { copilotChats as pgChats, copilotChatTurns as pgTurns } from "../src/schema/pg/copilot-chats";

function buildCreateTable(table: SQLiteTable | PgTable, isPg: boolean): string {
  const cfg = isPg ? getPgTableConfig(table as PgTable) : getSqliteTableConfig(table as SQLiteTable);
  const defs: string[] = cfg.columns.map((col) => {
    let def = `"${col.name}" ${col.getSQLType()}`;
    if (col.notNull) def += " NOT NULL";
    if (col.primary) def += " PRIMARY KEY";
    return def;
  });
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${defs.join(",\n  ")}\n);`;
}

const DROP = `DROP TABLE "copilot_chat_turns"; DROP TABLE "copilot_chats";`;

interface Handle {
  readonly make: (opts?: { maxTurns?: number }) => CopilotChatRepository;
  readonly exec: (sql: string) => void | Promise<void>;
  readonly dropTables: () => void | Promise<void>;
  readonly teardown: () => Promise<void>;
}
interface AdapterCase {
  readonly name: string;
  readonly setup: () => Promise<Handle>;
}

const sqliteCase: AdapterCase = {
  name: "sqlite",
  setup: async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(buildCreateTable(sqliteChats, false));
    sqlite.exec(buildCreateTable(sqliteTurns, false));
    const db = drizzleSqlite(sqlite);
    return {
      make: (opts) => createSqliteCopilotChatRepository(db, opts),
      exec: (sql) => void sqlite.exec(sql),
      dropTables: () => void sqlite.exec(DROP),
      teardown: async () => void sqlite.close(),
    };
  },
};
const pgCase: AdapterCase = {
  name: "postgres-pglite",
  setup: async () => {
    const client = new PGlite();
    await client.exec(buildCreateTable(pgChats, true));
    await client.exec(buildCreateTable(pgTurns, true));
    const db = drizzlePglite(client);
    return {
      make: (opts) => createPostgresCopilotChatRepository(db, opts),
      exec: async (sql) => void (await client.exec(sql)),
      dropTables: async () => void (await client.exec(DROP)),
      teardown: async () => void (await client.close()),
    };
  },
};

const EMP = "employer-work";
const LIFE = "personal-life";
const turn = (over: Partial<AppendCopilotChatTurn> = {}): AppendCopilotChatTurn => ({
  workspaceId: EMP,
  chatId: "chat-a",
  title: "Login loop",
  question: "What is the login bug?",
  answer: JSON.stringify({ answer: ["It loops."], citations: [] }),
  at: "2026-09-25T10:00:00.000Z",
  ...over,
});

describe.each([sqliteCase, pgCase])("CopilotChatRepository contract :: $name", (adapter) => {
  let h: Handle;
  afterEach(async () => {
    await h.teardown();
  });

  it("appends turns in order, creates the chat on its first turn, and reads them oldest first", async () => {
    h = await adapter.setup();
    const repo = h.make();
    const a = await repo.appendTurn(turn());
    const b = await repo.appendTurn(turn({ question: "Who owns it?", at: "2026-09-25T10:01:00.000Z" }));
    expect([isOk(a) && a.value.seq, isOk(b) && b.value.seq]).toEqual([1, 2]);
    const turns = await repo.getTurns(EMP, "chat-a");
    expect(isOk(turns) && turns.value.map((t) => [t.seq, t.question])).toEqual([
      [1, "What is the login bug?"],
      [2, "Who owns it?"],
    ]);
    expect(isOk(turns) && turns.value[0]?.answer).toBe(JSON.stringify({ answer: ["It loops."], citations: [] }));
    const chat = await repo.getChat(EMP, "chat-a");
    expect(isOk(chat) && chat.value).toEqual({
      chatId: "chat-a",
      workspaceId: EMP,
      title: "Login loop",
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:01:00.000Z",
    });
  });

  it("the title is set once, from the first turn — a later turn never renames the chat", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await repo.appendTurn(turn());
    await repo.appendTurn(turn({ title: "Something else" }));
    const chat = await repo.getChat(EMP, "chat-a");
    expect(isOk(chat) && chat.value.title).toBe("Login loop");
  });

  it("⛔ WS-8: a chat id that exists under ANOTHER workspace is refused (conflict) and nothing is written", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await repo.appendTurn(turn());
    const r = await repo.appendTurn(turn({ workspaceId: LIFE, question: "personal question" }));
    expect(isErr(r) && r.error.code).toBe("conflict");
    const emp = await repo.getTurns(EMP, "chat-a");
    expect(isOk(emp) && emp.value.map((t) => t.question)).toEqual(["What is the login bug?"]);
  });

  it("⛔ WS-8: another workspace can neither read, list nor delete the chat", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await repo.appendTurn(turn());
    const got = await repo.getTurns(LIFE, "chat-a");
    expect(isErr(got) && got.error.code).toBe("not_found");
    const chat = await repo.getChat(LIFE, "chat-a");
    expect(isErr(chat) && chat.error.code).toBe("not_found");
    const listed = await repo.listChats(LIFE, 50);
    expect(isOk(listed) && listed.value).toEqual([]);
    const del = await repo.deleteChat(LIFE, "chat-a");
    expect(isErr(del) && del.error.code).toBe("not_found");
    const still = await repo.getTurns(EMP, "chat-a");
    expect(isOk(still) && still.value).toHaveLength(1);
  });

  it("lists one workspace's chats, most recently used first, bounded by the limit", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await repo.appendTurn(turn({ chatId: "old", title: "Old", at: "2026-09-25T09:00:00.000Z" }));
    await repo.appendTurn(turn({ chatId: "new", title: "New", at: "2026-09-25T11:00:00.000Z" }));
    await repo.appendTurn(turn({ chatId: "mid", title: "Mid", at: "2026-09-25T10:00:00.000Z" }));
    await repo.appendTurn(turn({ chatId: "other", workspaceId: LIFE, title: "Other", at: "2026-09-25T12:00:00.000Z" }));
    const all = await repo.listChats(EMP, 50);
    expect(isOk(all) && all.value.map((c) => c.chatId)).toEqual(["new", "mid", "old"]);
    const two = await repo.listChats(EMP, 2);
    expect(isOk(two) && two.value.map((c) => c.chatId)).toEqual(["new", "mid"]);
    // A new turn moves a chat to the top.
    await repo.appendTurn(turn({ chatId: "old", at: "2026-09-25T13:00:00.000Z" }));
    const again = await repo.listChats(EMP, 1);
    expect(isOk(again) && again.value.map((c) => c.chatId)).toEqual(["old"]);
  });

  it("reads only the NEWEST turns when asked, still oldest first", async () => {
    h = await adapter.setup();
    const repo = h.make();
    for (let i = 1; i <= 5; i++) await repo.appendTurn(turn({ question: `q${i}` }));
    const last2 = await repo.getTurns(EMP, "chat-a", 2);
    expect(isOk(last2) && last2.value.map((t) => t.question)).toEqual(["q4", "q5"]);
  });

  it("keeps at most maxTurns per chat — the OLDEST turns are dropped, never the newest", async () => {
    h = await adapter.setup();
    const repo = h.make({ maxTurns: 3 });
    for (let i = 1; i <= 5; i++) await repo.appendTurn(turn({ question: `q${i}` }));
    const all = await repo.getTurns(EMP, "chat-a");
    expect(isOk(all) && all.value.map((t) => [t.seq, t.question])).toEqual([
      [3, "q3"],
      [4, "q4"],
      [5, "q5"],
    ]);
    expect(COPILOT_CHAT_MAX_TURNS).toBe(500);
  });

  it("deletes a chat and all of its turns", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await repo.appendTurn(turn());
    await repo.appendTurn(turn({ chatId: "keep" }));
    expect(isOk(await repo.deleteChat(EMP, "chat-a"))).toBe(true);
    const gone = await repo.getTurns(EMP, "chat-a");
    expect(isErr(gone) && gone.error.code).toBe("not_found");
    const listed = await repo.listChats(EMP, 50);
    expect(isOk(listed) && listed.value.map((c) => c.chatId)).toEqual(["keep"]);
    // The chat id is free again — a new chat under it starts at seq 1 with a fresh title.
    const again = await repo.appendTurn(turn({ title: "Fresh" }));
    expect(isOk(again) && again.value.seq).toBe(1);
    const second = await repo.deleteChat(EMP, "chat-a");
    expect(isOk(second)).toBe(true);
    const twice = await repo.deleteChat(EMP, "chat-a");
    expect(isErr(twice) && twice.error.code).toBe("not_found");
  });

  it("a newest count below 1, or not a number, reads NO turns — never all of them (review 2026-09-25)", async () => {
    h = await adapter.setup();
    const repo = h.make();
    for (let i = 1; i <= 4; i++) await repo.appendTurn(turn({ question: `q${String(i)}` }));
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = await repo.getTurns(EMP, "chat-a", n);
      expect(isOk(r) && r.value.length, String(n)).toBe(0);
    }
    const frac = await repo.getTurns(EMP, "chat-a", 2.7);
    expect(isOk(frac) && frac.value.map((t) => t.question)).toEqual(["q3", "q4"]);
  });

  it("⛔ rule 7: a failed write's error never carries the question or the answer (review 2026-09-25, measured on pg)", async () => {
    h = await adapter.setup();
    const repo = h.make();
    // Seize the turn id "c1:1" under another chat, so appending chat c1's first turn collides on its INSERT — the
    // query whose parameters hold the question and the answer (drizzle's pg errors print them).
    await h.exec(`INSERT INTO "copilot_chat_turns" ("turnId","chatId","workspaceId","seq","question","answer","createdAt") VALUES ('c1:1','zz','${EMP}',1,'q','a','t')`);
    const r = await repo.appendTurn(turn({ chatId: "c1", question: "SECRET_QUESTION_TEXT", answer: "SECRET_ANSWER_TEXT", title: "SECRET_TITLE" }));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("conflict");
      expect(JSON.stringify({ message: r.error.message, cause: String(r.error.cause ?? "") })).not.toContain("SECRET_");
    }
  });

  it("an unknown chat is not_found — never an empty chat invented", async () => {
    h = await adapter.setup();
    const repo = h.make();
    const r = await repo.getTurns(EMP, "nope");
    expect(isErr(r) && r.error.code).toBe("not_found");
  });

  it("a store fault is a typed error, never a throw", async () => {
    h = await adapter.setup();
    const repo = h.make();
    await h.dropTables();
    expect(isErr(await repo.appendTurn(turn()))).toBe(true);
    expect(isErr(await repo.listChats(EMP, 5))).toBe(true);
    expect(isErr(await repo.getTurns(EMP, "chat-a"))).toBe(true);
    expect(isErr(await repo.deleteChat(EMP, "chat-a"))).toBe(true);
  });
});
