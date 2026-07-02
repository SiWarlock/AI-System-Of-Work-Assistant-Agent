// Operational-store schema — instance-leases domain (Phase-10 / LIFE-1).
// PERSISTS the single-active-instance lease (the concrete table behind the Phase-7
// in-memory `InstanceLeaseStore` fake). One row per Temporal task queue.
//
// Columns: taskQueue (PK), ownerId (the worker instance currently holding it),
// acquiredAt + expiresAt (the ISO fence past which the lease is stale/reclaimable),
// generation (the monotonically-increasing FENCING TOKEN — bumped on a fresh
// acquire, preserved on a same-owner renew). Every fenced side effect carries the
// generation it was issued under; a target rejects an operation whose generation is
// below the latest committed one, so a sleep-paused prior holder that wakes after
// its TTL expired (and a new holder acquired) cannot process concurrently. TTL
// expiry alone does not close that window — the fencing token does.
//
// The acquire/renew is an ATOMIC compare-and-set on the WHOLE record (the pure
// `decideLeaseCas`/`leaseRecordsEqual` shared across both dialects); contention is
// a boolean verdict, never a throw (§16 fail-closed).
//
// CLASSIFICATION: OPERATIONAL TRUTH — MUTABLE (acquire/renew via CAS), NOT
// rebuildable (a lost lease lets two workers process concurrently — the
// exactly-once spine breaks). NOT parity-checked (no Appendix-A lease model).
//
// REQ-S-003 / §16: no secret column; fields are a queue name, an owner id,
// timestamps, and an integer fencing token.
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const instanceLeases = sqliteTable("instance_leases", {
  taskQueue: text().primaryKey(),
  ownerId: text().notNull(),
  acquiredAt: text().notNull(),
  expiresAt: text().notNull(),
  // Monotonically-increasing fencing token (LIFE-1) — closes the sleep-paused
  // prior-holder window that TTL expiry alone cannot.
  generation: integer().notNull(),
});
