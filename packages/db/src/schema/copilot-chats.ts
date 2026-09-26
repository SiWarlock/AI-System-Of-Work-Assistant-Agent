// Operational-store schema — the Copilot's SAVED CHATS (Linear slice 5b.4a, owner decisions 2026-09-25).
//
// PERSISTS: the owner's Copilot chats, one list per workspace — so a chat survives a restart and the Copilot can be
// given the chat's earlier turns ("file it in Core?" → "yes"). The owner chose the worker's local operational store
// over vault notes: a Copilot answer is NOT knowledge, so it must never become a note that retrieval later reads.
//
// ⛔ Rule 1: a chat is a CONVERSATION LOG, never a semantic fact and never a retrieval source. The only intended
// readers are the chat procedures and the ask path (which feeds the same chat's turns back as conversation) —
// neither exists until slice 5b.4b; until then nothing reads or writes these tables.
// ⛔ Rule 4 / WS-8: every row carries its workspace, and every repository method is keyed by (workspaceId, chatId).
// ⛔ Rule 7: `question` and `answer` ARE raw content (the owner's words and the Copilot's gated answer). They are
// never logged, never in a health/diagnostics read, and never leave the worker except to the same workspace's chat.
//
// REGISTERED in the schema barrel (`./index.ts`, and the pg mirror in `./pg/index.ts`) with migration
// `migrations/{sqlite,pg}/0019_copilot_chats.sql` in the SAME change (the schema↔migration coverage detector).
// DIALECT/portability: text/integer columns only; mirrored field-for-field into `./pg/copilot-chats.ts`.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One chat. `title` is set from the chat's first question, once. */
export const copilotChats = sqliteTable("copilot_chats", {
  chatId: text().primaryKey(),
  workspaceId: text().notNull(),
  title: text().notNull(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});

/** One turn: the owner's question and the Copilot's answer as it passed the UI-safe gate (JSON). */
export const copilotChatTurns = sqliteTable("copilot_chat_turns", {
  // `${chatId}:${seq}` — one row per (chat, seq), so two racing appends conflict instead of both landing.
  turnId: text().primaryKey(),
  chatId: text().notNull(),
  workspaceId: text().notNull(),
  seq: integer().notNull(),
  question: text().notNull(),
  answer: text().notNull(),
  createdAt: text().notNull(),
});
