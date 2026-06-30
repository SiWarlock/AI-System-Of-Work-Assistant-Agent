// Unit 1.14 — operational-store column-name PARITY drift-guard (the key Phase-1
// deliverable) + a definition smoke test.
//
// PARITY (REQ-D-002, §4): every Drizzle table that persists a frozen Appendix-A
// model must carry EXACTLY the model's top-level field-name set — no more, no
// fewer. The frozen field set is recomputed here from the contract itself
// (`fieldSet(emitJsonSchema(<Schema>, <SCHEMA_ID>))`), NOT copied, so a field
// add/remove/rename on either side (model OR table) fails this guard the same
// round. Nested objects (Workspace.egressPolicy / .providerMatrix,
// AuditRecord.timestamps, GclProjection.sanitizedPayload/sourceRefs, etc.) are
// each stored as ONE json/text column NAMED by the top-level field, so top-level
// parity holds without flattening.
//
// The table's column-name set is read via drizzle's `getTableColumns`, whose KEYS
// are the JS property names used in the table definition (verified: these are the
// camelCase model field names, independent of any SQL column-name override).
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

import { workspaceConfig } from "../../src/schema/workspace-config";
import { approvals } from "../../src/schema/approvals";
import { auditRecords } from "../../src/schema/audit";
import { providerProfiles } from "../../src/schema/provider-state";
import { workflowRunRefs } from "../../src/schema/event-log";
import { gclProjections } from "../../src/schema/gcl-projections";
import * as schemaBarrel from "../../src/schema";

// Compile-time smoke: the pure repository-interface surface is importable and
// every interface is nameable (no drizzle leakage — this is a type-only import).
// `tsc --noEmit` over the `test` glob is what actually exercises this.
import type {
  WorkspaceConfigRepository,
  EventLogRepository,
  WorkflowRunRefRepository,
  AuditRepository,
  ApprovalRepository,
  OutboxRepository,
  ConnectorCursorRepository,
  ProviderStateRepository,
  ReadModelRepository,
  GclProjectionRepository,
} from "../../src/repositories/interfaces";

type _RepoSurface = [
  WorkspaceConfigRepository,
  EventLogRepository,
  WorkflowRunRefRepository,
  AuditRepository,
  ApprovalRepository,
  OutboxRepository,
  ConnectorCursorRepository,
  ProviderStateRepository,
  ReadModelRepository,
  GclProjectionRepository,
];

type EmittableSchema = Parameters<typeof emitJsonSchema>[0];
type ParityCase = readonly [name: string, table: Table, schema: EmittableSchema, id: string];

const columnNames = (table: Table): string[] => Object.keys(getTableColumns(table)).sort();
const frozenFieldSet = (schema: EmittableSchema, id: string): string[] =>
  fieldSet(emitJsonSchema(schema, id));

// table ↔ frozen Appendix-A model — the closed parity set named by Unit 1.14.
const parityCases: readonly ParityCase[] = [
  ["workspace-config ↔ Workspace", workspaceConfig, WorkspaceSchema, WORKSPACE_SCHEMA_ID],
  ["approvals ↔ Approval", approvals, ApprovalSchema, APPROVAL_SCHEMA_ID],
  ["audit ↔ AuditRecord", auditRecords, AuditRecordSchema, AUDIT_RECORD_SCHEMA_ID],
  ["provider-state ↔ ProviderProfile", providerProfiles, ProviderProfileSchema, PROVIDER_PROFILE_SCHEMA_ID],
  ["event-log ↔ WorkflowRunRef", workflowRunRefs, WorkflowRunRefSchema, WORKFLOW_RUN_REF_SCHEMA_ID],
  ["gcl-projections ↔ GclProjection", gclProjections, GclProjectionSchema, GCL_PROJECTION_SCHEMA_ID],
];

describe("Unit 1.14 — operational-store column-name parity drift-guard", () => {
  for (const [name, table, schema, id] of parityCases) {
    it(`${name}: table columns equal the frozen model field set`, () => {
      expect(columnNames(table)).toEqual(frozenFieldSet(schema, id));
    });
  }

  // Defends against a parity test that silently passes because the recomputed
  // field set is empty (e.g. an emit/fieldSet regression upstream).
  it("each parity model contributes a non-empty frozen field set", () => {
    for (const [name, , schema, id] of parityCases) {
      expect(frozenFieldSet(schema, id).length, name).toBeGreaterThan(0);
    }
  });
});

describe("Unit 1.14 — operational-store schema definition smoke", () => {
  // Every operational-store domain table is defined and carries ≥1 column.
  const allTables: readonly [string, Table][] = [
    ["workspaceConfig", schemaBarrel.workspaceConfig],
    ["eventLog", schemaBarrel.eventLog],
    ["workflowRunRefs", schemaBarrel.workflowRunRefs],
    ["auditRecords", schemaBarrel.auditRecords],
    ["approvals", schemaBarrel.approvals],
    ["outbox", schemaBarrel.outbox],
    ["connectorCursors", schemaBarrel.connectorCursors],
    ["providerProfiles", schemaBarrel.providerProfiles],
    ["readModels", schemaBarrel.readModels],
    ["gclProjections", schemaBarrel.gclProjections],
  ];

  for (const [name, table] of allTables) {
    it(`${name} is a defined drizzle table with at least one column`, () => {
      expect(table, name).toBeDefined();
      expect(columnNames(table).length, name).toBeGreaterThan(0);
    });
  }

  // REQ-S-003 / §16: no operational table may carry a plaintext-secret-shaped
  // column (secrets are Keychain references) and no audit-style raw-content key.
  it("no table carries a plaintext-secret- or raw-content-shaped column", () => {
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
      // raw-content-shaped (audit before/after are SUMMARIES; §16)
      "rawcontent",
      "rawbefore",
      "rawafter",
    ]);
    for (const [name, table] of allTables) {
      for (const col of columnNames(table)) {
        expect(forbidden.has(col.toLowerCase()), `${name}.${col}`).toBe(false);
      }
    }
  });
});
