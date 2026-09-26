// Operational-store schema — PG-CORE MIRROR of the Copilot's SAVED CHATS (Linear slice 5b.4a). PARALLEL dialect of
// `../copilot-chats.ts` — see that module's header for the rules (1, 4, 7) these tables carry.
//
// IDENTICAL column names + portable types to the SQLite tables (the coverage detector expects the barrels to agree).
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const copilotChats = pgTable("copilot_chats", {
  chatId: text().primaryKey(),
  workspaceId: text().notNull(),
  title: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

export const copilotChatTurns = pgTable("copilot_chat_turns", {
  turnId: text().primaryKey(),
  chatId: text().notNull(),
  workspaceId: text().notNull(),
  seq: integer().notNull(),
  question: text().notNull(),
  answer: text().notNull(),
  createdAt: text().notNull(),
});
