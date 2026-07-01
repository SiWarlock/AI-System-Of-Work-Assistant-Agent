// Operational-store schema — PG-CORE MIRROR of the connector-cursors domain (Unit
// 2.1, §4/§8). PARALLEL dialect of `../connector-cursors.ts`: per-connector ×
// per-workspace sync cursors for the §8 Connector Gateway + reachability/backoff
// bookkeeping (REQ-I-005 / LIFE-4). IDENTICAL column names + portable types (text),
// composite PK over (connectorId, workspaceId) — adds NO column, parity holds — for
// the both-dialect repository contract suite (REQ-D-003).
//
// REQ-S-003: no secret column — connector OAuth tokens live in Keychain.
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const connectorCursors = pgTable(
  "connector_cursors",
  {
    connectorId: text().notNull(),
    workspaceId: text().notNull(),
    // Opaque connector cursor / watermark (vendor-specific; stored as text).
    cursor: text(),
    // Reachability/health for System Health (OBS-2): healthy | degraded.
    status: text().notNull(),
    lastSyncAt: text(),
    // Bounded exponential backoff bookkeeping (LIFE-4).
    nextSyncAt: text(),
    updatedAt: text().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.connectorId, t.workspaceId] }),
  }),
);
