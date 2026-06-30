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
export * from "./connector-cursors";
export * from "./provider-state";
export * from "./read-models";
export * from "./gcl-projections";
