// Operational-store schema — event-log domain (Unit 1.14, §4/§9/§16).
//
// Two tables, both CONTROL-PLANE OPERATIONAL TRUTH (not rebuildable):
//
// 1. `eventLog` — the APPEND-ONLY control-plane event journal (workflow status /
//    approval update / system health / read-model change events; the EventName
//    catalog seeds the §10 push stream, but the journal also carries internal
//    control events, so `eventName` is stored as open text, not a closed enum).
//    Append-only: never updated/deleted in place. NOT parity-checked — no single
//    Appendix-A model maps 1:1 to a generic event envelope (the Unit-1.14 parity
//    set deliberately narrowed to the five persisted models + Workspace; the
//    plan's earlier "SourceEnvelope events" parity note was dropped at this
//    unit's scope — FLAGGED).
//
// 2. `workflowRunRefs` — PERSISTS WorkflowRunRef (frozen Appendix-A model). The
//    control-plane handle tying a workflow execution to its idempotencyKey +
//    audit trail so replay reuses the run (REQ-D-002, §9). MUTABLE `state`
//    (operational truth; §4 stores only the run REFERENCE — Temporal owns the
//    full workflow history, §4 boundaries). Co-located here (not a dedicated
//    file) because the Unit-1.14 file list gives WorkflowRunRef no own domain
//    file, and the control-plane event journal is its closest operational-truth
//    home — FLAGGED for §4 to assign a permanent domain.
//
// PARITY (workflowRunRefs ↔ WorkflowRunRef): column-name set MUST equal the
// frozen top-level field-name set: { workflowId, trigger, state, idempotencyKey,
// auditRefs }. `auditRefs` (AuditId[]) → one json column NAMED by the field.
//
// REQ-S-003: no secret column. §16: the event `payload` carries SUMMARY/metadata
// only and is redacted before any log sink (this is a store, not a log sink).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { WorkflowRunRef } from "@sow/contracts";

// --- append-only control-plane event journal (NOT parity-checked) ---
export const eventLog = sqliteTable("event_log", {
  // arch_gap: event-id grammar unspecified upstream — opaque non-empty string PK.
  eventId: text().primaryKey(),
  // Open text (EventName catalog ∪ internal control events) — see header.
  eventName: text().notNull(),
  // Nullable: some control-plane events are global (not workspace-scoped).
  workspaceId: text(),
  // Correlation / workflow linkage for tracing (§16 structured logging).
  correlationId: text(),
  workflowId: text(),
  // SUMMARY/metadata payload (redaction-friendly, §16) — never raw content.
  payload: text({ mode: "json" }),
  occurredAt: text().notNull(),
  recordedAt: text().notNull(),
});

// --- workflow-run registry (PARITY ↔ WorkflowRunRef) ---
export const workflowRunRefs = sqliteTable("workflow_run_refs", {
  workflowId: text().$type<WorkflowRunRef["workflowId"]>().primaryKey(),
  trigger: text().notNull(),
  state: text().notNull(),
  idempotencyKey: text().notNull(),
  auditRefs: text({ mode: "json" }).$type<WorkflowRunRef["auditRefs"]>().notNull(),
});
