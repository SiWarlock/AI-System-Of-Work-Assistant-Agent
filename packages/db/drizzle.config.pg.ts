// drizzle-kit config — Postgres dialect (Phase-2 task 2.6, §4 / §13 Migrations).
//
// Generates the HOSTED-compatible (standard Postgres, §13) migration set from the
// pg-core schema mirror (`src/schema/pg/index.ts`) into `migrations/pg/`. Parallel
// to `drizzle.config.sqlite.ts`; the same logical migration set is emitted per
// dialect so a single runner (`src/migrate/runner.ts`) applies whichever folder
// matches the live engine (SQLite local default; pg hosted-compatible).
//
// Generate:  pnpm drizzle-kit generate --config=drizzle.config.pg.ts --name=<tag>
//
// drizzle is FORWARD-ONLY: no generated down-migration. Rollback = restore from
// the mandatory pre-migration backup (`applyMigrations`, §4). No `dbCredentials`
// here — `generate` reads the schema source offline; the runtime runner applies.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/pg/index.ts",
  out: "./migrations/pg",
});
