// drizzle-kit config — SQLite dialect (Phase-2 task 2.6, §4 / §13 Migrations).
//
// Generates the LOCAL-mode (SQLite, §13) migration set from the sqlite-core
// schema barrel into `migrations/sqlite/`. The pg dialect has its own parallel
// config (`drizzle.config.pg.ts`) writing `migrations/pg/`; the two emit the
// SAME logical migration set against each dialect's schema mirror (the runner in
// `src/migrate/runner.ts` applies whichever folder matches the live engine).
//
// Generate:  pnpm drizzle-kit generate --config=drizzle.config.sqlite.ts --name=<tag>
//
// drizzle is FORWARD-ONLY: there is no generated down-migration. The rollback
// path is restore-from-the-pre-migration-backup, enforced by `applyMigrations`
// (§4 failure mode). No `dbCredentials` here — `generate` is offline (it reads
// the schema source, not a live DB); applying is done by the runtime runner.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations/sqlite",
});
