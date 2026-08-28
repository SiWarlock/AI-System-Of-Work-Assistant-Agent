// Postgres mirror of the source-disposition store (task 15.5, §4/§19.2/§9).
// IDENTICAL column-name set to the SQLite table (forbidden-#2 — one contract, both dialects).
// See the SQLite `schema/source-disposition.ts` header for the parked-source-of-record + rule-7
// server-side-operational-only + CAS exactly-once notes. `sourceEnvelope` is one jsonb column.
import { json, pgTable, text } from "drizzle-orm/pg-core";
import type { SourceDispositionRow } from "../../repositories/interfaces";

export const sourceDisposition = pgTable("source_disposition", {
  sourceId: text().$type<SourceDispositionRow["sourceId"]>().primaryKey(),
  sourceEnvelope: json().$type<SourceDispositionRow["sourceEnvelope"]>().notNull(),
  idempotencyKey: text().$type<SourceDispositionRow["idempotencyKey"]>().notNull(),
  state: text().$type<SourceDispositionRow["state"]>().notNull(),
  dispositionKey: text().$type<SourceDispositionRow["dispositionKey"]>(),
  auditRef: text().$type<SourceDispositionRow["auditRef"]>(),
  /** Task 7.19 — the WS-8 scoping column, denormalized from `sourceEnvelope.workspaceId`
   *  at park time so a retention sweep can enumerate ONE workspace without reading
   *  foreign rows. NULLABLE: pre-column rows are EXCLUDED from a scoped query rather
   *  than guessed (see ../source-disposition.ts for the full rationale). */
  workspaceId: text(),
  parkedAt: text().$type<SourceDispositionRow["parkedAt"]>().notNull(),
  dispositionedAt: text().$type<SourceDispositionRow["dispositionedAt"]>(),
});
