// Test-only create-tables helper (task 2.3). Materializes every operational-store
// domain table into a `better-sqlite3` connection by GENERATING the DDL from the
// Drizzle schema itself (via `getTableConfig`) — never a hand-maintained DDL
// string that could silently drift from the schema source. The real
// backup-before-migrate runner + drizzle-kit migration files are task 2.6 (out of
// scope here); this helper exists ONLY so the SQLite adapter's CRUD/round-trip
// tests can run against `new Database(':memory:')` with no external server.
import type DatabaseConstructor from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../src/schema/index";

type SqliteConnection = InstanceType<typeof DatabaseConstructor>;

// Explicit table list (deterministic order; the schema barrel re-exports each of
// these operational-store tables — Unit 1.14 / §4).
const TABLES: readonly SQLiteTable[] = [
  schema.workspaceConfig,
  schema.eventLog,
  schema.workflowRunRefs,
  schema.auditRecords,
  schema.approvals,
  schema.outbox,
  schema.pendingKnowledgeMutations,
  schema.knowledgeRevisions,
  schema.parityReports,
  schema.connectorCursors,
  schema.providerProfiles,
  schema.readModels,
  schema.gclProjections,
  schema.writeReceipts,
  // Phase-10 durability tables (LIFE-1 / LIFE-5 / OBS-2).
  schema.healthItems,
  schema.scheduleBookkeeping,
  schema.instanceLeases,
  // §4/§6 — the durable typed-Project registry (task 14.6).
  schema.projectRegistry,
  // §4/§8 — the per-workspace connector-instance config registry (task 14.2).
  schema.connectorInstance,
  // §4/§5/§6 — the cross-workspace-link store (sanctioned WS-8 cross-read input, task 14.7).
  schema.crossWorkspaceLink,
  // §4/§19.2 — the seen-content-hash dedupe store (Flow-4 / REQ-F-010, WS-8-scoped, task 15.4).
  schema.seenContentHash,
  // §4/§19.2/§9 — the source-disposition store (parked-source-of-record + re-enter, ING-4, task 15.5).
  schema.sourceDisposition,
];

/** Emit `CREATE TABLE` for one Drizzle table, mirroring its column + PK config. */
function buildCreateTable(table: SQLiteTable): string {
  const cfg = getTableConfig(table);
  const defs: string[] = cfg.columns.map((col) => {
    let def = `"${col.name}" ${col.getSQLType()}`;
    if (col.notNull) def += " NOT NULL";
    if (col.primary) def += " PRIMARY KEY";
    if (col.isUnique) def += " UNIQUE";
    return def;
  });
  for (const pk of cfg.primaryKeys) {
    const cols = pk.columns.map((c) => `"${c.name}"`).join(", ");
    defs.push(`PRIMARY KEY (${cols})`);
  }
  // Table-level UNIQUE constraints (WW-1 cross-process no-double-write guard:
  // workflow_run_refs.idempotencyKey + write_receipts.idempotencyKey).
  for (const uq of cfg.uniqueConstraints) {
    const cols = uq.columns.map((c) => `"${c.name}"`).join(", ");
    defs.push(`UNIQUE (${cols})`);
  }
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${defs.join(",\n  ")}\n);`;
}

/** Create every operational-store table in the given in-memory SQLite connection. */
export function createSqliteSchema(sqlite: SqliteConnection): void {
  for (const table of TABLES) {
    sqlite.exec(buildCreateTable(table));
  }
}
