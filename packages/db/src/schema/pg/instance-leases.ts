// Operational-store schema — PG-CORE MIRROR of the instance-leases domain
// (Phase-10 / LIFE-1). PARALLEL dialect of `../instance-leases.ts`: the
// single-active-instance lease + fencing token (one row per Temporal task queue).
// IDENTICAL column-name surface + portable types (text; integer for the fencing
// generation) — adds NO column, parity holds — for the both-dialect repository
// contract suite (REQ-D-003).
//
// The acquire/renew is an atomic compare-and-set on the whole record (the pure
// `decideLeaseCas`/`leaseRecordsEqual` shared across both dialects); contention is
// a boolean verdict, never a throw (§16 fail-closed).
//
// REQ-S-003 / §16: no secret column; fields are a queue name, an owner id,
// timestamps, and an integer fencing token.
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const instanceLeases = pgTable("instance_leases", {
  taskQueue: text().primaryKey(),
  ownerId: text().notNull(),
  acquiredAt: text().notNull(),
  expiresAt: text().notNull(),
  generation: integer().notNull(),
});
