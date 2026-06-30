// Operational-store schema — connector cursors domain (Unit 1.14, §4/§8).
//
// PERSISTS: per-connector × per-workspace sync CURSORS for the §8 Connector
// Gateway (external READS — Calendar, Todoist, Linear, Asana, Granola,
// Drive/Docs, GitHub, Telegram, URL adapters), plus reachability/health signal
// and backoff bookkeeping (REQ-I-005 / LIFE-4: queue + bounded backoff, no
// silent drops, drain on reconnect).
//
// CLASSIFICATION: OPERATIONAL TRUTH — MUTABLE (the cursor advances each sync),
// effectively append/tombstone per (connector, workspace). NOT rebuildable:
// losing a cursor forces a full re-sync, so it is operational truth, not a
// read model. NOT parity-checked (no Appendix-A cursor model in the Unit-1.14
// set).
//
// REQ-S-003: no secret column — connector OAuth tokens live in Keychain via
// SecretsPort and are referenced, never stored here.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const connectorCursors = sqliteTable(
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
