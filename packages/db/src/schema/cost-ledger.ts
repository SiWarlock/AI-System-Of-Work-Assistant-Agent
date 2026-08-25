// Operational-store schema — durable CROSS-RUN COST/BUDGET LEDGER (task 19.11, §16).
//
// PERSISTS: one row per completed run's recorded spend, keyed by `jobId` (the
// idempotency key — FIRST-WRITE-WINS, never overwritten; see
// `../repositories/costLedger.ts`'s `record()` docblock for the exact conflict
// semantics). The seam this plugs: `apps/worker/src/composition/budget-ledger.ts`'s
// `BudgetLedgerPort.record()` is record-only/synchronous with no read side, so a
// per-run budget gate has no way to see a PRIOR run's spend for the same workspace —
// this table + `spentFor()` is what a future cross-run enforcement gate would read.
//
// This is a DB-OWNED OPERATIONAL ROLLUP, NOT a frozen Appendix-A contract model — it
// is NOT covered by the column-parity/operational-schema snapshot guards (those cover
// the original frozen seam models only; mirrors `task.ts`'s header note for the same
// reason).
//
// SAFETY (rule 7 / REQ-S-003): every column is a redaction-safe id, a numeric bound,
// or an ISO-8601 timestamp — NEVER raw content, a prompt, or a secret.
//
// STANDALONE (mirrors `gbrain-sync-outbox.ts`, task 19.1): this table is deliberately
// NOT registered in the schema barrel (`./index.ts`) and has NO migration file yet.
// `packages/db/migrations` and the adapter wiring in `src/adapters/{sqlite,postgres}`
// are OUT OF TERRITORY for this slice (a separate, concurrently-worked package). Were
// this table added to the barrel without a migration, it would trip the schema↔
// migration coverage detector (`packages/db/test/migrate/schema-migration-coverage.
// test.ts`, task 24.39/24.43) the exact way task 13.15's `task` table did before that
// detector existed — so the barrel export is withheld on purpose. Whoever lands the
// migration must ADD `export * from "./cost-ledger"` to `./index.ts` (and the pg
// mirror to `./pg/index.ts`) in the SAME change as the migration file, never before.
//
// DIALECT/portability: SQLite single-source — ONLY text/scalar columns, no pg-only
// types. Mirrored field-for-field into `./pg/cost-ledger.ts`.
import { real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const costLedger = sqliteTable("cost_ledger", {
  // The idempotency key — one job is one run. FIRST-WRITE-WINS (see repository).
  jobId: text().primaryKey(),
  workspaceId: text().notNull(),
  // Optional — a run not attributable to one capability (nullable ⇒ unset, REQ-F-017).
  capability: text(),
  costUsd: real().notNull(),
  runtimeSeconds: real().notNull(),
  // Optional configured caps in effect when this run was recorded (nullable ⇒ none).
  maxCostUsd: real(),
  maxRuntimeSeconds: real(),
  recordedAt: text().notNull(),
});
