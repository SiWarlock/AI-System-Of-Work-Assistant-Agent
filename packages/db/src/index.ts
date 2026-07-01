// @sow/db — operational-store surface barrel.
//
// PACKAGE barrel (distinct from the SCHEMA barrels at `src/schema/index.ts`
// and `src/schema/pg/index.ts`). Exposes the full operational store:
// SQLite + Postgres schema, both repository-adapter factories, the
// operational-truth invariants, the migration lifecycle + version-compat,
// the degraded-mode wrapper, and the backup/restore API.
//
// COLLISION NOTE: the SQLite schema (`./schema/index`) and the pg-core
// schema (`./schema/pg/index`) declare the SAME table identifiers
// (`eventLog`, `workflowRunRefs`, `approvals`, …) for the same logical
// tables across the two dialects. A flat `export *` of both would mask.
// The SQLite schema stays FLAT (backward-compat with the prior barrel)
// and is ALSO offered namespaced as `sqliteSchema`; the pg schema is
// offered ONLY namespaced as `pgSchema`. The two adapter factories
// (`createSqliteRepositories` / `createPostgresRepositories`) and their
// repository interfaces have distinct names — flat `export *` is safe.
// `export *` is safe under verbatimModuleSyntax.

// --- schema: SQLite flat (canonical, backward-compat) + both namespaced ---
export * from "./schema/index";
export * as sqliteSchema from "./schema/index";
export * as pgSchema from "./schema/pg/index";

// --- repository interface contracts ---
export * from "./repositories/interfaces";

// --- repository-adapter factories (dialect-specific, non-colliding names) ---
export * from "./adapters/sqlite/index";
export * from "./adapters/postgres/index";

// --- operational-truth invariants ---
export * from "./invariants/operational-truth";

// --- migration lifecycle + version compatibility ---
export * from "./migrate/runner";
export * from "./migrate/version-compat";
export * from "./migrate/sqlite-engine";

// --- degraded-mode wrapper ---
export * from "./health/degraded-mode";

// --- backup / restore API ---
export * from "./backup/periodic-backup";
export * from "./backup/restore";
