// The Copilot's SAVED CHATS — dual-dialect operational-store driver (Linear slice 5b.4a, owner decisions 2026-09-25:
// chats are saved in the local store so they survive a restart, as one list of chats per workspace).
//
// STANDALONE like `costLedger.ts`: each dialect gets a small factory over an injected drizzle handle, built from the
// canonical schema pair (`../schema/copilot-chats`, `../schema/pg/copilot-chats`). ⚠ NOT BOUND YET: slice 5b.4b binds
// it in the worker over the SAME migrated handle its other repositories use (migration `0019_copilot_chats`).
//
// ⛔ WS-8 (rule 4): EVERY method is keyed by (workspaceId, chatId). A chat id that exists under another workspace is
// refused on append (`conflict`, nothing written) and is `not_found` for every read and delete from this workspace.
// ⛔ Rule 1: a conversation log — never a retrieval source, never a semantic fact. ⛔ Rule 7: `question`/`answer`
// are raw content; this module never logs them, and no error message carries them (driver messages name columns only).
//
// ERROR CONVENTION (§16): NOTHING throws across the boundary; every method returns a typed `DbResult`.
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ok, err } from "@sow/contracts";
import { copilotChats as sqliteChats, copilotChatTurns as sqliteTurns } from "../schema/copilot-chats";
import { copilotChats as pgChats, copilotChatTurns as pgTurns } from "../schema/pg/copilot-chats";
import { toDbError as toSqliteDbError, notFound as notFoundSqlite, conflict as conflictSqlite } from "../adapters/sqlite/errors";
import { toDbError as toPostgresDbError, notFound as notFoundPostgres } from "../adapters/postgres/errors";
import type { DbError, DbResult } from "./interfaces";

/** The most turns one chat keeps; past it the OLDEST are dropped (the newest turns are the ones a chat continues from). */
export const COPILOT_CHAT_MAX_TURNS = 500;

export interface CopilotChatRow {
  readonly chatId: string;
  readonly workspaceId: string;
  /** Set from the chat's first question, once. */
  readonly title: string;
  /** ISO-8601. */
  readonly createdAt: string;
  /** ISO-8601 — the time of the chat's newest turn. */
  readonly updatedAt: string;
}

export interface CopilotChatTurnRow {
  readonly chatId: string;
  /** 1, 2, 3, … within the chat. */
  readonly seq: number;
  /** The owner's question. RAW content (rule 7). */
  readonly question: string;
  /** The Copilot's answer as it passed the UI-safe gate, as JSON. RAW content (rule 7). */
  readonly answer: string;
  readonly createdAt: string;
}

export interface AppendCopilotChatTurn {
  readonly workspaceId: string;
  readonly chatId: string;
  /** Used only when this turn CREATES the chat. */
  readonly title: string;
  readonly question: string;
  readonly answer: string;
  /** ISO-8601. */
  readonly at: string;
}

export interface CopilotChatRepository {
  /**
   * Append one turn, creating the chat on its first turn. ⛔ A chat id that exists under ANOTHER workspace ⇒
   * `conflict`, nothing written. Keeps at most `maxTurns` turns (oldest dropped). Returns the new turn's `seq`.
   */
  appendTurn(t: AppendCopilotChatTurn): DbResult<{ readonly seq: number }>;
  /** One workspace's chats, most recently used first, at most `limit`. */
  listChats(workspaceId: string, limit: number): DbResult<readonly CopilotChatRow[]>;
  /** One chat of this workspace — `not_found` if absent HERE (including when it exists under another workspace). */
  getChat(workspaceId: string, chatId: string): DbResult<CopilotChatRow>;
  /** A chat's turns, oldest first — only the `newest` N when given. `not_found` if the chat is absent HERE. */
  getTurns(workspaceId: string, chatId: string, newest?: number): DbResult<readonly CopilotChatTurnRow[]>;
  /** Delete a chat and all its turns — `not_found` if absent HERE. */
  deleteChat(workspaceId: string, chatId: string): DbResult<void>;
}

export interface CopilotChatRepositoryOptions {
  /** Turns kept per chat. Default {@link COPILOT_CHAT_MAX_TURNS}. */
  readonly maxTurns?: number;
}

const turnIdOf = (chatId: string, seq: number): string => `${chatId}:${String(seq)}`;
const toTurnRow = (r: { chatId: string; seq: number; question: string; answer: string; createdAt: string }): CopilotChatTurnRow => ({
  chatId: r.chatId,
  seq: r.seq,
  question: r.question,
  answer: r.answer,
  createdAt: r.createdAt,
});
const toChatRow = (r: CopilotChatRow): CopilotChatRow => ({
  chatId: r.chatId,
  workspaceId: r.workspaceId,
  title: r.title,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
/** A request for the newest N (N ≥ 1) — anything else means "all". */
const newestCount = (n: number | undefined): number | undefined => (n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined);

// ── SQLite driver ─────────────────────────────────────────────────────────────

export function createSqliteCopilotChatRepository(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle's own generic param; every adapter in this package types it this way.
  db: BetterSQLite3Database<any>,
  opts: CopilotChatRepositoryOptions = {},
): CopilotChatRepository {
  const maxTurns = opts.maxTurns ?? COPILOT_CHAT_MAX_TURNS;
  const c = sqliteChats;
  const t = sqliteTurns;
  const chatHere = (ws: string, chatId: string): CopilotChatRow | undefined =>
    db.select().from(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, ws))).get();

  return {
    async appendTurn(turn): DbResult<{ readonly seq: number }> {
      try {
        // One synchronous transaction: better-sqlite3 runs it without interleaving, so seq cannot race here.
        const out = db.transaction((tx) => {
          const existing = tx.select().from(c).where(eq(c.chatId, turn.chatId)).get();
          if (existing !== undefined && existing.workspaceId !== turn.workspaceId) return undefined; // ⛔ WS-8
          if (existing === undefined) {
            tx.insert(c).values({ chatId: turn.chatId, workspaceId: turn.workspaceId, title: turn.title, createdAt: turn.at, updatedAt: turn.at }).run();
          } else {
            tx.update(c).set({ updatedAt: turn.at }).where(eq(c.chatId, turn.chatId)).run();
          }
          const top = tx.select({ max: sql<number | null>`MAX(${t.seq})` }).from(t).where(eq(t.chatId, turn.chatId)).get();
          const seq = (top?.max ?? 0) + 1;
          tx.insert(t)
            .values({ turnId: turnIdOf(turn.chatId, seq), chatId: turn.chatId, workspaceId: turn.workspaceId, seq, question: turn.question, answer: turn.answer, createdAt: turn.at })
            .run();
          tx.delete(t).where(and(eq(t.chatId, turn.chatId), lte(t.seq, seq - maxTurns))).run();
          return seq;
        });
        return out === undefined ? err(conflictSqlite("copilot chat belongs to another workspace")) : ok({ seq: out });
      } catch (cause) {
        return err(toSqliteDbError(cause, "copilot_chats append failed"));
      }
    },
    async listChats(workspaceId, limit): DbResult<readonly CopilotChatRow[]> {
      try {
        const rows = db.select().from(c).where(eq(c.workspaceId, workspaceId)).orderBy(desc(c.updatedAt), desc(c.chatId)).limit(Math.max(0, limit)).all();
        return ok(rows.map(toChatRow));
      } catch (cause) {
        return err(toSqliteDbError(cause, "copilot_chats list failed"));
      }
    },
    async getChat(workspaceId, chatId): DbResult<CopilotChatRow> {
      try {
        const row = chatHere(workspaceId, chatId);
        return row === undefined ? err(notFoundSqlite("copilot chat")) : ok(toChatRow(row));
      } catch (cause) {
        return err(toSqliteDbError(cause, "copilot_chats get failed"));
      }
    },
    async getTurns(workspaceId, chatId, newest): DbResult<readonly CopilotChatTurnRow[]> {
      try {
        if (chatHere(workspaceId, chatId) === undefined) return err(notFoundSqlite("copilot chat"));
        const where = and(eq(t.chatId, chatId), eq(t.workspaceId, workspaceId));
        const n = newestCount(newest);
        const rows =
          n === undefined
            ? db.select().from(t).where(where).orderBy(asc(t.seq)).all()
            : db.select().from(t).where(where).orderBy(desc(t.seq)).limit(n).all().reverse();
        return ok(rows.map(toTurnRow));
      } catch (cause) {
        return err(toSqliteDbError(cause, "copilot_chats turns failed"));
      }
    },
    async deleteChat(workspaceId, chatId): DbResult<void> {
      try {
        const gone = db.transaction((tx) => {
          const here = tx.select().from(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, workspaceId))).get();
          if (here === undefined) return false;
          tx.delete(t).where(and(eq(t.chatId, chatId), eq(t.workspaceId, workspaceId))).run();
          tx.delete(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, workspaceId))).run();
          return true;
        });
        return gone ? ok(undefined) : err(notFoundSqlite("copilot chat"));
      } catch (cause) {
        return err(toSqliteDbError(cause, "copilot_chats delete failed"));
      }
    },
  };
}

// ── Postgres driver ────────────────────────────────────────────────────────────

/** Mirrors the SQLite driver exactly. Two racing appends to one chat collide on the turn id and one gets `conflict`. */
export function createPostgresCopilotChatRepository(
  db: PgDatabase<PgQueryResultHKT>,
  opts: CopilotChatRepositoryOptions = {},
): CopilotChatRepository {
  const maxTurns = opts.maxTurns ?? COPILOT_CHAT_MAX_TURNS;
  const c = pgChats;
  const t = pgTurns;
  const chatHere = async (ws: string, chatId: string): Promise<CopilotChatRow | undefined> =>
    (await db.select().from(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, ws))).limit(1))[0];

  return {
    async appendTurn(turn): DbResult<{ readonly seq: number }> {
      try {
        const out = await db.transaction(async (tx) => {
          const existing = (await tx.select().from(c).where(eq(c.chatId, turn.chatId)).limit(1))[0];
          if (existing !== undefined && existing.workspaceId !== turn.workspaceId) return undefined; // ⛔ WS-8
          if (existing === undefined) {
            await tx.insert(c).values({ chatId: turn.chatId, workspaceId: turn.workspaceId, title: turn.title, createdAt: turn.at, updatedAt: turn.at });
          } else {
            await tx.update(c).set({ updatedAt: turn.at }).where(eq(c.chatId, turn.chatId));
          }
          const top = (await tx.select({ max: sql<number | null>`MAX(${t.seq})` }).from(t).where(eq(t.chatId, turn.chatId)))[0];
          const seq = Number(top?.max ?? 0) + 1;
          await tx
            .insert(t)
            .values({ turnId: turnIdOf(turn.chatId, seq), chatId: turn.chatId, workspaceId: turn.workspaceId, seq, question: turn.question, answer: turn.answer, createdAt: turn.at });
          await tx.delete(t).where(and(eq(t.chatId, turn.chatId), lte(t.seq, seq - maxTurns)));
          return seq;
        });
        return out === undefined ? err({ code: "conflict", message: "copilot chat belongs to another workspace" }) : ok({ seq: out });
      } catch (cause) {
        return err(toPostgresDbError(cause, "copilot_chats append failed"));
      }
    },
    async listChats(workspaceId, limit): DbResult<readonly CopilotChatRow[]> {
      try {
        const rows = await db.select().from(c).where(eq(c.workspaceId, workspaceId)).orderBy(desc(c.updatedAt), desc(c.chatId)).limit(Math.max(0, limit));
        return ok(rows.map(toChatRow));
      } catch (cause) {
        return err(toPostgresDbError(cause, "copilot_chats list failed"));
      }
    },
    async getChat(workspaceId, chatId): DbResult<CopilotChatRow> {
      try {
        const row = await chatHere(workspaceId, chatId);
        return row === undefined ? err(notFoundPostgres("copilot chat")) : ok(toChatRow(row));
      } catch (cause) {
        return err(toPostgresDbError(cause, "copilot_chats get failed"));
      }
    },
    async getTurns(workspaceId, chatId, newest): DbResult<readonly CopilotChatTurnRow[]> {
      try {
        if ((await chatHere(workspaceId, chatId)) === undefined) return err(notFoundPostgres("copilot chat"));
        const where = and(eq(t.chatId, chatId), eq(t.workspaceId, workspaceId));
        const n = newestCount(newest);
        const rows =
          n === undefined
            ? await db.select().from(t).where(where).orderBy(asc(t.seq))
            : (await db.select().from(t).where(where).orderBy(desc(t.seq)).limit(n)).reverse();
        return ok(rows.map(toTurnRow));
      } catch (cause) {
        return err(toPostgresDbError(cause, "copilot_chats turns failed"));
      }
    },
    async deleteChat(workspaceId, chatId): DbResult<void> {
      try {
        const gone = await db.transaction(async (tx) => {
          const here = (await tx.select().from(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, workspaceId))).limit(1))[0];
          if (here === undefined) return false;
          await tx.delete(t).where(and(eq(t.chatId, chatId), eq(t.workspaceId, workspaceId)));
          await tx.delete(c).where(and(eq(c.chatId, chatId), eq(c.workspaceId, workspaceId)));
          return true;
        });
        return gone ? ok(undefined) : err(notFoundPostgres("copilot chat"));
      } catch (cause) {
        return err(toPostgresDbError(cause, "copilot_chats delete failed"));
      }
    },
  };
}

export type { DbError, DbResult };
