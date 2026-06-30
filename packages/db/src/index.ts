// @sow/db — operational-store schema + repository interface contracts.
//
// PACKAGE barrel (distinct from the SCHEMA barrel at `src/schema/index.ts`).
// Re-exports every Drizzle schema table (via the schema barrel) and the typed
// repository interface contracts (REQ-D-002). PURE at the interface layer: the
// repository contracts pull only type-level shapes from `@sow/contracts` and no
// concrete driver — the SQLite/Postgres implementations + the both-dialect
// contract suite are §4 / Phase-2 / worker (REQ-D-003), out of scope here.
// `export *` is safe under verbatimModuleSyntax.

// --- schema tables (full operational-store schema) ---
export * from "./schema/index";

// --- repository interface contracts ---
export * from "./repositories/interfaces";
