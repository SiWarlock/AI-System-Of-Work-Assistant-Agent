// Operational-store schema — the seen-content-hash dedupe store (task 15.4, §4/§19.2).
//
// PERSISTS: SeenContentHashRow — the durable Flow-4 (REQ-F-010) dedupe record the ingestion path
// checks/records so re-seen content is skipped exactly-once ACROSS RESTART (replacing an in-memory
// dedupe that loses state on restart). It is a db-owned DTO (contracts primitives only), NOT a
// frozen Appendix-A model, so it is NOT in the column-parity / operational-schema snapshot guards.
//
// SAFETY (workspace isolation, WS-8): the dedupe key is the COMPOSITE (workspaceId, contentHash) —
// a `contentHash` seen in workspace A does NOT dedupe the same hash in workspace B (never
// cross-workspace). FIRST-WRITE-WINS: the composite PK + `INSERT ... ON CONFLICT DO NOTHING` makes
// `record` idempotent (a re-record is a no-op that preserves the original `seenAt`). REQ-S-003: no
// secret column (the contentHash is a dedupe key, never raw content).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header). text columns only;
// composite PK over EXISTING columns adds no surrogate id.
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { SeenContentHashRow } from "../repositories/interfaces";

export const seenContentHash = sqliteTable(
  "seen_content_hash",
  {
    // The WS-8 dedupe scope — a hash is "seen" only within its own workspace.
    workspaceId: text().$type<SeenContentHashRow["workspaceId"]>().notNull(),
    // The content-versioned dedupe identity.
    contentHash: text().$type<SeenContentHashRow["contentHash"]>().notNull(),
    // When the content was FIRST seen (first-write-wins preserves this; a re-record is a no-op).
    seenAt: text().$type<SeenContentHashRow["seenAt"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.contentHash] }),
  }),
);
