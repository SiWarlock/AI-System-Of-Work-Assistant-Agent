// Operational-store schema — PG-CORE MIRROR of the event-log domain (Unit 2.1,
// §4/§9/§16). PARALLEL dialect of `../event-log.ts`: two tables (`eventLog` append-
// only control-plane journal + `workflowRunRefs` ↔ WorkflowRunRef), IDENTICAL column
// names + portable types (text; payload/auditRefs as one `json` column each) for the
// both-dialect repository contract suite (REQ-D-003).
//
// REQ-S-003: no secret column. §16: `payload` carries SUMMARY/metadata only.
import { json, pgTable, text } from "drizzle-orm/pg-core";
import type { WorkflowRunRef } from "@sow/contracts";

// --- append-only control-plane event journal (NOT parity-checked) ---
export const eventLog = pgTable("event_log", {
  // arch_gap: event-id grammar unspecified upstream — opaque non-empty string PK.
  eventId: text().primaryKey(),
  // Open text (EventName catalog ∪ internal control events) — see sqlite header.
  eventName: text().notNull(),
  // Nullable: some control-plane events are global (not workspace-scoped).
  workspaceId: text(),
  // Correlation / workflow linkage for tracing (§16 structured logging).
  correlationId: text(),
  workflowId: text(),
  // SUMMARY/metadata payload (redaction-friendly, §16) — never raw content.
  payload: json(),
  occurredAt: text().notNull(),
  recordedAt: text().notNull(),
});

// --- workflow-run registry (PARITY ↔ WorkflowRunRef) ---
export const workflowRunRefs = pgTable("workflow_run_refs", {
  workflowId: text().$type<WorkflowRunRef["workflowId"]>().primaryKey(),
  trigger: text().notNull(),
  state: text().notNull(),
  idempotencyKey: text().notNull(),
  auditRefs: json().$type<WorkflowRunRef["auditRefs"]>().notNull(),
});
