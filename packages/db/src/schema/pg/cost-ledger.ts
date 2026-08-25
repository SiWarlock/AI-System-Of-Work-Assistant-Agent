// Operational-store schema — PG-CORE MIRROR of the CROSS-RUN COST/BUDGET LEDGER
// (task 19.11, §16). PARALLEL dialect of `../cost-ledger.ts` — see that module's
// header for the full rationale (why the barrel export + migration are withheld this
// slice) and for the safety-rule-7 column note.
//
// IDENTICAL column names + portable types to the SQLite table, per this package's
// both-dialect convention (task 24.39/24.43's coverage detector, once wired, expects
// the two barrels to agree exactly).
import { pgTable, real, text } from "drizzle-orm/pg-core";

export const costLedger = pgTable("cost_ledger", {
  jobId: text().primaryKey(),
  workspaceId: text().notNull(),
  capability: text(),
  costUsd: real().notNull(),
  runtimeSeconds: real().notNull(),
  maxCostUsd: real(),
  maxRuntimeSeconds: real(),
  recordedAt: text().notNull(),
});
