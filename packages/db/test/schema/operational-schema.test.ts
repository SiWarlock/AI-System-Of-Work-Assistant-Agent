// Unit 2.1 — operational-store DUAL-DIALECT schema snapshot + cross-dialect parity.
// spec(§4)
//
// Phase-2 mirrors the operational domains (9 domain files → 10 tables) authored in
// `drizzle-orm/sqlite-core` (the V1 default, §13) into PARALLEL `drizzle-orm/pg-core`
// definitions so the both-dialect repository contract suite (REQ-D-003) can run the
// SAME repositories against SQLite (better-sqlite3) and Postgres (PGlite / pg). This
// guard freezes the operational schema's column-name surface and pins the three
// invariants the §4 boundary depends on:
//
//   (a) PORTABILITY — every table's column-name set is IDENTICAL across sqlite-core
//       and pg-core. A column added to one dialect but not the other is portability
//       drift and fails here the same round.
//   (b) APPENDIX-A PARITY — the 6 DIRECTLY-PERSISTED frozen models still carry
//       EXACTLY their contract's top-level field-name set, recomputed from
//       `@sow/contracts` (`fieldSet(emitJsonSchema(<Schema>, <ID>))`), NOT copied —
//       reusing the Unit-1.14 approach so a field add/remove/rename on EITHER the
//       model or EITHER dialect's table fails this guard.
//   (c) NO-SECRET / NO-RAW-CONTENT — neither dialect carries a plaintext-secret- or
//       raw-content-shaped column (REQ-S-003 / §16).
//
// The per-table sorted column-name sets are frozen in the checked-in
// `src/schema/__snapshots__/operational-schema.snap` (JSON: tableName → sorted
// column names); the snapshot is the drift oracle that both dialects must match.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableColumns, type Table } from "drizzle-orm";
import {
  emitJsonSchema,
  fieldSet,
  ApprovalSchema,
  APPROVAL_SCHEMA_ID,
  AuditRecordSchema,
  AUDIT_RECORD_SCHEMA_ID,
  GclProjectionSchema,
  GCL_PROJECTION_SCHEMA_ID,
  ProviderProfileSchema,
  PROVIDER_PROFILE_SCHEMA_ID,
  WorkflowRunRefSchema,
  WORKFLOW_RUN_REF_SCHEMA_ID,
  WorkspaceSchema,
  WORKSPACE_SCHEMA_ID,
} from "@sow/contracts";

import * as sqliteSchema from "../../src/schema";
import * as pgSchema from "../../src/schema/pg";

type EmittableSchema = Parameters<typeof emitJsonSchema>[0];

const columnNames = (table: Table): string[] => Object.keys(getTableColumns(table)).sort();
const frozenFieldSet = (schema: EmittableSchema, id: string): string[] =>
  fieldSet(emitJsonSchema(schema, id));

// The closed operational table set — one logical export name per table. 9 domain
// files contribute 10 tables (event-log → eventLog + workflowRunRefs).
const tableNames = [
  "workspaceConfig",
  "eventLog",
  "workflowRunRefs",
  "auditRecords",
  "approvals",
  "outbox",
  "connectorCursors",
  "providerProfiles",
  "readModels",
  "gclProjections",
] as const;
type TableName = (typeof tableNames)[number];

// Explicit per-dialect maps (object literals → fully typed, no index-signature
// `undefined`): the pg map proves every sqlite table has a pg-core mirror by name.
const sqliteTables = {
  workspaceConfig: sqliteSchema.workspaceConfig,
  eventLog: sqliteSchema.eventLog,
  workflowRunRefs: sqliteSchema.workflowRunRefs,
  auditRecords: sqliteSchema.auditRecords,
  approvals: sqliteSchema.approvals,
  outbox: sqliteSchema.outbox,
  connectorCursors: sqliteSchema.connectorCursors,
  providerProfiles: sqliteSchema.providerProfiles,
  readModels: sqliteSchema.readModels,
  gclProjections: sqliteSchema.gclProjections,
} satisfies Record<TableName, Table>;

const pgTables = {
  workspaceConfig: pgSchema.workspaceConfig,
  eventLog: pgSchema.eventLog,
  workflowRunRefs: pgSchema.workflowRunRefs,
  auditRecords: pgSchema.auditRecords,
  approvals: pgSchema.approvals,
  outbox: pgSchema.outbox,
  connectorCursors: pgSchema.connectorCursors,
  providerProfiles: pgSchema.providerProfiles,
  readModels: pgSchema.readModels,
  gclProjections: pgSchema.gclProjections,
} satisfies Record<TableName, Table>;

// table ↔ frozen Appendix-A model — the closed parity set (6 directly-persisted
// models; the other 4 tables are composite/operational, not 1:1 mirrors).
type ParityCase = readonly [name: TableName, schema: EmittableSchema, id: string];
const parityCases: readonly ParityCase[] = [
  ["workspaceConfig", WorkspaceSchema, WORKSPACE_SCHEMA_ID],
  ["approvals", ApprovalSchema, APPROVAL_SCHEMA_ID],
  ["auditRecords", AuditRecordSchema, AUDIT_RECORD_SCHEMA_ID],
  ["providerProfiles", ProviderProfileSchema, PROVIDER_PROFILE_SCHEMA_ID],
  ["workflowRunRefs", WorkflowRunRefSchema, WORKFLOW_RUN_REF_SCHEMA_ID],
  ["gclProjections", GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID],
];

const snapshotUrl = new URL(
  "../../src/schema/__snapshots__/operational-schema.snap",
  import.meta.url,
);
const snapshot = JSON.parse(readFileSync(snapshotUrl, "utf8")) as Record<string, string[]>;

describe("Unit 2.1 — operational schema dual-dialect snapshot (spec §4)", () => {
  // (a) PORTABILITY: sqlite-core and pg-core agree on every table's column-name set.
  for (const name of tableNames) {
    it(`${name}: sqlite-core and pg-core column-name sets are identical`, () => {
      expect(columnNames(pgTables[name])).toEqual(columnNames(sqliteTables[name]));
    });
  }

  // The frozen snapshot is the drift oracle: both dialects must match it exactly.
  for (const name of tableNames) {
    it(`${name}: both dialects match the frozen snapshot`, () => {
      const frozen = snapshot[name];
      expect(frozen, `snapshot missing table ${name}`).toBeDefined();
      expect(frozen?.length, `snapshot ${name} must be non-empty`).toBeGreaterThan(0);
      expect(columnNames(sqliteTables[name])).toEqual(frozen);
      expect(columnNames(pgTables[name])).toEqual(frozen);
    });
  }

  // The snapshot covers EXACTLY the closed table set — no stale/extra/missing entry.
  it("snapshot freezes exactly the closed operational table set", () => {
    expect(Object.keys(snapshot).sort()).toEqual([...tableNames].sort());
  });
});

describe("Unit 2.1 — Appendix-A field parity (both dialects) (spec §4)", () => {
  // (b) Each directly-persisted table's columns equal the recomputed frozen field set.
  for (const [name, schema, id] of parityCases) {
    it(`${name}: both dialects equal the frozen model field set`, () => {
      const frozen = frozenFieldSet(schema, id);
      expect(columnNames(sqliteTables[name])).toEqual(frozen);
      expect(columnNames(pgTables[name])).toEqual(frozen);
    });
  }

  // Guards against a vacuous pass from an empty recomputed field set (emit regression).
  it("each parity model contributes a non-empty frozen field set", () => {
    for (const [name, schema, id] of parityCases) {
      expect(frozenFieldSet(schema, id).length, name).toBeGreaterThan(0);
    }
  });
});

describe("Unit 2.1 — no plaintext-secret / raw-content column (both dialects) (spec §4)", () => {
  // (c) REQ-S-003 / §16: neither dialect may carry a secret- or raw-content-shaped
  // column (secrets are Keychain references; audit before/after are SUMMARIES).
  const forbidden = new Set([
    "apikey",
    "apikeyplaintext",
    "secret",
    "secretvalue",
    "token",
    "tokenvalue",
    "password",
    "credentials",
    "privatekey",
    "rawcontent",
    "rawbefore",
    "rawafter",
  ]);

  for (const dialect of ["sqlite-core", "pg-core"] as const) {
    const tables = dialect === "sqlite-core" ? sqliteTables : pgTables;
    it(`${dialect}: no table carries a plaintext-secret- or raw-content-shaped column`, () => {
      for (const name of tableNames) {
        for (const col of columnNames(tables[name])) {
          expect(forbidden.has(col.toLowerCase()), `${dialect} ${name}.${col}`).toBe(false);
        }
      }
    });
  }
});
