// Operational-store schema — per-workspace connector-instance config registry (task 14.2, §4/§8).
//
// PERSISTS: ConnectorInstanceRow — the OPERATIONAL connector config (mutable) the Phase-16
// connector composition + Phase-23 arming later consume. It is a db-owned DTO (Q1: stays a
// db record, contracts primitives only), NOT a frozen Appendix-A model, so it is NOT in the
// column-parity/operational-schema snapshot guards.
//
// SAFETY rule 7: `tokenRef` is an OPAQUE Keychain REFERENCE (a key identifier) — NEVER the
// credential bytes. No secret column exists by construction; SecretsPort/Keychain resolve the
// reference at arming (Phase 17/23), never this record.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header) — ONLY
// text/integer, NO pg-only types. All columns are flat scalars (no arrays/nested) here.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ConnectorInstanceRow } from "../repositories/interfaces";

export const connectorInstance = sqliteTable("connector_instance", {
  // Synthetic instance id — the registry PRIMARY KEY.
  instanceId: text().$type<ConnectorInstanceRow["instanceId"]>().primaryKey(),
  connectorId: text().notNull(),
  // The BOUND workspace (WS-2/WS-8 anchor) — server-resolved, never caller-set; immutable.
  workspaceId: text().$type<ConnectorInstanceRow["workspaceId"]>().notNull(),
  // Opaque Keychain REFERENCE — never the secret bytes (rule 7).
  tokenRef: text().notNull(),
  state: text().$type<ConnectorInstanceRow["state"]>().notNull(),
  cadence: text().notNull(),
});
