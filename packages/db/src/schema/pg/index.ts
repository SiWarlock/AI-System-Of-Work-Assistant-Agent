// Operational-store schema barrel — PG-CORE MIRROR (Unit 2.1, §4). Re-exports every
// pg-core domain table so the worker's Postgres Drizzle client (PGlite / pg) and the
// dual-dialect snapshot guard can import the full pg schema from one place. PARALLEL
// to the sqlite-core barrel (`../index.ts`); the two barrels carry the IDENTICAL
// column-name surface per table (frozen by `operational-schema.test.ts`).
//
// NOTE: this is a SCHEMA sub-barrel (`src/schema/pg/index.ts`), authored by this
// unit — distinct from the PACKAGE barrel (`src/index.ts`), which the Synthesis stage
// wires and this unit does NOT touch.
export * from "./workspace-config";
export * from "./event-log";
export * from "./audit";
export * from "./approvals";
export * from "./outboxes";
export * from "./connector-cursors";
export * from "./provider-state";
export * from "./read-models";
export * from "./gcl-projections";
