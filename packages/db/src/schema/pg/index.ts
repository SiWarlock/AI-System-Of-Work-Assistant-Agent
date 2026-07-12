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
// §13.10a — the pending-KMP store (the semantic-write sibling of the outbox).
export * from "./pending-kmp";
// §6 / §16 — the durable KnowledgeWriter idempotent-replay index (task 11.1).
export * from "./knowledge-revisions";
export * from "./connector-cursors";
export * from "./provider-state";
export * from "./read-models";
export * from "./gcl-projections";
export * from "./write-receipts";
// Phase-10 durability tables (LIFE-1 / LIFE-5 / OBS-2).
export * from "./health-items";
export * from "./schedule-bookkeeping";
export * from "./instance-leases";
