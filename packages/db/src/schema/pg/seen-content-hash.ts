// Postgres mirror of the seen-content-hash dedupe store (task 15.4, §4/§19.2).
// IDENTICAL column-name set to the SQLite table (forbidden-#2 — one contract, both dialects).
// See the SQLite `schema/seen-content-hash.ts` header for the WS-8 composite-key + first-write-wins
// (ON CONFLICT DO NOTHING) notes. Composite PK over (workspaceId, contentHash); no surrogate id.
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { SeenContentHashRow } from "../../repositories/interfaces";

export const seenContentHash = pgTable(
  "seen_content_hash",
  {
    workspaceId: text().$type<SeenContentHashRow["workspaceId"]>().notNull(),
    contentHash: text().$type<SeenContentHashRow["contentHash"]>().notNull(),
    seenAt: text().$type<SeenContentHashRow["seenAt"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.contentHash] }),
  }),
);
