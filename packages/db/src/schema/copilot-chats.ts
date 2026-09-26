// Operational-store schema — the Copilot's SAVED CHATS (Linear slice 5b.4a, owner decisions 2026-09-25).
//
// PERSISTS: the owner's Copilot chats, one list per workspace — so a chat survives a restart and the Copilot can be
// given the chat's earlier turns ("file it in Core?" → "yes"). The owner chose the worker's local operational store
// over vault notes: a Copilot answer is NOT knowledge, so it must never become a note that retrieval later reads.
//
// ⛔ Rule 1: a chat is a CONVERSATION LOG, never a semantic fact and never a retrieval source. Its only readers are
// the ask path (which feeds the same chat's turns back to the model as conversation, slice 5b.4b) and the saved-chats
// procedures that list, open and delete chats (slice 5b.4c).
// ⛔ Rule 4 / WS-8: every row carries its workspace, and every repository method is keyed by (workspaceId, chatId).
// ⛔ Rule 7: `question` and `answer` ARE raw content (the owner's words and the Copilot's gated answer). They are
// never logged and never in a health/diagnostics read. They leave the worker (a) to the renderer, for the same
// workspace's chat; (b) to the model provider as that chat's history, inside the same ask and after the same egress
// veto (rule 5) as the question itself; and (c) the owner's previous QUESTION only, to retrieval on a follow-up — which,
// like the question itself, runs BEFORE the veto (critic 2026-09-25; the pre-veto retrieval is a separate, tracked
// rule-5 finding, and gbrain may embed a query with a cloud embedder).
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
