// Operational-store schema — schedule-bookkeeping domain (Phase-10 / LIFE-5).
// PERSISTS the durable per-schedule last-run bookkeeping (the concrete table
// behind the Phase-7 in-memory `ScheduleStore` fake). One row per schedule.
//
// Columns: scheduleId (PK), lastRunWall (ISO wall-clock reading), plus the OPTIONAL
// clock-jump-safe monotonic pair lastRunMonotonicMs? + lastRunMonotonicEpoch?. The
// catch-up loop compares the monotonic delta ONLY when the current epoch equals the
// stored one (a prior-process/boot reading is ignored — the LIFE-5 cross-restart
// starve/double-fire trap); the wall reading is the display + first-run fallback.
//
// CLASSIFICATION: OPERATIONAL TRUTH — MUTABLE (advances each run via upsert), NOT
// rebuildable (a lost row re-fires or starves a schedule — the catch-up loses its
// base reading). NOT parity-checked (no Appendix-A schedule model).
//
// REQ-S-003 / §16: no secret column; all fields are timestamps / a schedule id.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const scheduleBookkeeping = sqliteTable("schedule_bookkeeping", {
  scheduleId: text().primaryKey(),
  lastRunWall: text().notNull(),
  // OPTIONAL monotonic reading (ms) — absent for the first run or a wall-only clock.
  lastRunMonotonicMs: integer(),
  // The monotonic EPOCH the reading was taken under — a delta is valid only when the
  // current epoch matches this (else the stored ms is from a prior boot; ignore it).
  lastRunMonotonicEpoch: text(),
});
