// Operational-store schema barrel (Unit 1.14, §4). Re-exports every domain
// table so the worker's Drizzle client (Phase-2) and the column-parity
// drift-guard can import the full schema from one place. SQLite single-source
// (the pg-core mirror + migrations + both-dialect contract suite are §4 /
// Phase-2 / worker, REQ-D-003 — out of scope here).
//
// NOTE: this is the SCHEMA barrel (`src/schema/index.ts`), authored by this
// unit — distinct from the PACKAGE barrel (`src/index.ts`), which the Synthesis
// stage wires and this unit does NOT touch.
export * from "./workspace-config";
export * from "./event-log";
export * from "./audit";
export * from "./approvals";
export * from "./outboxes";
// §13.10a — the pending-KMP store (the semantic-write sibling of the outbox).
export * from "./pending-kmp";
// §6 / §16 — the durable KnowledgeWriter idempotent-replay index (task 11.1).
export * from "./knowledge-revisions";
// §6 / §12 / §16 — the serve-time ParityReport store (serving-coverage source, task 11.1).
export * from "./parity-reports";
export * from "./connector-cursors";
export * from "./provider-state";
export * from "./read-models";
export * from "./gcl-projections";
export * from "./write-receipts";
// Phase-10 durability tables (LIFE-1 / LIFE-5 / OBS-2).
export * from "./health-items";
export * from "./schedule-bookkeeping";
export * from "./instance-leases";
