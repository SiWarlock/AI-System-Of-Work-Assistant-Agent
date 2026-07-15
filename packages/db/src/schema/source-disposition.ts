// Operational-store schema — the source-disposition store (task 15.5, §4/§19.2/§9).
//
// PERSISTS: SourceDispositionRow — the durable PARKED-SOURCE-OF-RECORD (resolves the ING-4 dead-end):
// a SourceEnvelope that parked in `queued_for_review` (low-confidence routing) is stored here with
// its full envelope + the original idempotencyKey, so the owner's triage can read it back
// (parkedReader), re-scope it (owner override), and RE-ENTER the pipeline REUSING the idempotencyKey
// (replay-safe). It is a db-owned DTO, NOT a frozen Appendix-A model.
//
// SAFETY: `sourceEnvelope` holds RAW candidate content at rest (incl. the 15.2 body) — it is
// SERVER-SIDE OPERATIONAL ONLY. The UI render path is the separate UI-safe `ingestionInboxProjection`
// (the SOLE render surface, rule 7); the stored raw envelope is NEVER rendered and NEVER logged (the
// disposition audit carries summaries only). Exactly-once disposition is CAS on `dispositionKey`
// (first-write-wins; the channel-free key converges Mac+Telegram, inv-A/inv-B). WS-8: the parked row
// is PRE-workspace (keyed by sourceId); the rescope's owner override is registry-validated.
//
// DIALECT/portability: SQLite single-source. `sourceEnvelope` is ONE json column; the rest are flat
// text (nullable dispositionKey/auditRef/dispositionedAt — set only once dispositioned).
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { SourceDispositionRow } from "../repositories/interfaces";

export const sourceDisposition = sqliteTable("source_disposition", {
  // The parked source identity — PK (a source parks once).
  sourceId: text().$type<SourceDispositionRow["sourceId"]>().primaryKey(),
  // The full parked SourceEnvelope (raw candidate at rest; server-side operational only, rule 7).
  sourceEnvelope: text({ mode: "json" }).$type<SourceDispositionRow["sourceEnvelope"]>().notNull(),
  // The original submit idempotencyKey — REUSED on re-enter so the downstream commit replays (inv-D).
  idempotencyKey: text().$type<SourceDispositionRow["idempotencyKey"]>().notNull(),
  state: text().$type<SourceDispositionRow["state"]>().notNull(),
  // The channel-free disposition key — set on the owner's record (CAS first-write-wins; inv-A/inv-B).
  dispositionKey: text().$type<SourceDispositionRow["dispositionKey"]>(),
  auditRef: text().$type<SourceDispositionRow["auditRef"]>(),
  parkedAt: text().$type<SourceDispositionRow["parkedAt"]>().notNull(),
  dispositionedAt: text().$type<SourceDispositionRow["dispositionedAt"]>(),
});
