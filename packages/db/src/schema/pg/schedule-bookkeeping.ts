// Operational-store schema — PG-CORE MIRROR of the schedule-bookkeeping domain
// (Phase-10 / LIFE-5). PARALLEL dialect of `../schedule-bookkeeping.ts`: durable
// per-schedule last-run bookkeeping (wall + optional clock-jump-safe monotonic
// pair). IDENTICAL column-name surface + portable types (text; integer for the
// monotonic ms) — adds NO column, parity holds — for the both-dialect repository
// contract suite (REQ-D-003).
//
// REQ-S-003 / §16: no secret column; all fields are timestamps / a schedule id.
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const scheduleBookkeeping = pgTable("schedule_bookkeeping", {
  scheduleId: text().primaryKey(),
  lastRunWall: text().notNull(),
  lastRunMonotonicMs: integer(),
  lastRunMonotonicEpoch: text(),
});
