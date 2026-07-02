// @sow/workflows — FOUNDATION: operational ports (Phase 7 §9 durability spine).
//
// This module is the shared port surface every 7.1–7.5 slice imports. It is
// PURE + workflow-safe: it imports NOTHING from @temporalio, NOTHING from
// node:crypto, and calls NO Date.now()/Math.random(). Two kinds of thing live
// here:
//   (1) TYPE-ONLY re-exports of the P2 operational-store repositories from
//       @sow/db — the workflows package talks to persistence through these
//       contracts, never through a concrete adapter. Lease/schedule/run/health
//       state persists via P2, NEVER in Temporal history.
//   (2) The gateway-owned persistence ports the durability foundation needs that
//       @sow/db does not yet expose (their concrete tables are Phase 10 —
//       flagged), plus the INJECTED Clock port. Temporal WORKFLOW code and this
//       pure runtime take the clock as an injected dependency so there is no
//       Date.now() anywhere in src and the logic is deterministic +
//       Vitest-unit-testable with no Temporal server.
//
// §9 taxonomy note: WorkflowRunRef.trigger + WorkflowRunRef.state are OPEN
// strings upstream (@sow/contracts froze the FIELD-NAME set in Phase 1 but
// deliberately left the value taxonomies to §9). We pin the closed trigger set
// here as a @sow/workflows-LOCAL constant. The general WorkflowRunState set is
// left to 7.4.

// --- (1) TYPE-ONLY re-exports of the P2 operational-store repositories ---
// These are the @sow/db repository CONTRACTS (interfaces + their DTOs + the
// typed DbError/DbResult error surface). Re-exported type-only so downstream
// slices import them from ONE place (`@sow/workflows/ports/operational`) and the
// import stays erasable under verbatimModuleSyntax.
export type {
  WorkflowRunRefRepository,
  OutboxRepository,
  EventLogRepository,
  AuditRepository,
  ConnectorCursorRepository,
  ReadModelRepository,
  // DTOs the repos read/write:
  OutboxEntry,
  EventLogRecord,
  ConnectorCursorRecord,
  ReadModelRecord,
  // the closed, enumerable error surface every repo method returns:
  DbError,
  DbErrorCode,
  DbResult,
} from "@sow/db";

// --- (2a) The injected Clock port ---

/**
 * The single injected time source for the pure runtime + orchestration + (later)
 * workflow code. `now()` returns an ISO-8601 timestamp (the wall-clock reading
 * persisted to bookkeeping / health items). `monotonicMs()` is an OPTIONAL
 * monotonic reading (milliseconds) for LIFE-5 elapsed-time reasoning that must be
 * immune to wall-clock jumps (NTP steps, DST) — schedule catch-up compares the
 * monotonic delta, never a subtraction of two wall clocks.
 *
 * No implementation here calls Date.now(); the concrete wall clock is supplied by
 * an activity or the worker binding at the edge, and tests inject a FakeClock.
 */
export interface Clock {
  now(): string;
  monotonicMs?(): number;
  /**
   * OPTIONAL per-process/boot nonce identifying the monotonic EPOCH. A monotonic
   * reading is only comparable to another from the SAME epoch — across a process
   * restart or reboot the monotonic clock resets, so a durably-persisted reading
   * from a prior epoch must NEVER be compared to a fresh one (that is the LIFE-5
   * cross-restart starve/double-fire trap). `computeElapsed` uses the monotonic
   * delta only when this epoch matches the bookkeeping's stored epoch; otherwise it
   * falls back to the wall reading. The worker binding sets a fresh epoch per
   * process; tests inject a fixed one.
   */
  monotonicEpoch?(): string;
}

// --- (2b) Gateway-owned persistence ports (concrete tables are Phase 10) ---

// arch_gap (Phase 10): the concrete SQLite/Postgres tables backing these three
// stores are NOT in @sow/db yet — the durability foundation owns the port
// contracts here so 7.1–7.5 can be built + unit-tested against in-memory fakes
// now; the P2 adapters land in Phase 10.

/**
 * A single-active-instance lease record (LIFE-1). One row per Temporal task
 * queue; `ownerId` identifies the worker instance currently holding the lease;
 * `expiresAt` is the ISO fence past which the lease is stale + reclaimable.
 */
export interface LeaseRecord {
  taskQueue: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
  /**
   * Monotonically-increasing FENCING TOKEN (LIFE-1). Bumped on every fresh acquire
   * (a new holder), preserved on a renew by the same owner. Every fenced side
   * effect carries the generation it was issued under, and a target rejects an
   * operation whose generation is below the latest committed one — so a
   * sleep-paused prior holder that wakes after its lease TTL expired (and a new
   * holder acquired) cannot process concurrently with the new holder. TTL expiry
   * alone does not close this window; the fencing token does.
   */
  generation: number;
}

/**
 * The single-active-instance lease store (LIFE-1). `compareAndSet` is the atomic
 * lease-acquire/renew primitive: it commits `next` IFF the currently-stored
 * record equals `expected` (an absent lease is expressed by `expected: undefined`
 * — first acquire), returning `true` on success and `false` when another instance
 * won the race. No throw across the boundary (§16): contention is a `false`, not
 * an error.
 */
export interface InstanceLeaseStore {
  get(taskQueue: string): Promise<LeaseRecord | undefined>;
  compareAndSet(
    expected: LeaseRecord | undefined,
    next: LeaseRecord,
  ): Promise<boolean>;
}

/**
 * Durable per-schedule bookkeeping (LIFE-5): the last run's wall-clock reading
 * plus its OPTIONAL monotonic reading. Catch-up decisions compare the monotonic
 * delta when present (clock-jump-safe) and fall back to the wall reading only for
 * display; a missing monotonic reading is expected for the very first run.
 */
export interface ScheduleBookkeeping {
  scheduleId: string;
  lastRunWall: string;
  lastRunMonotonicMs?: number;
  /**
   * The monotonic EPOCH (Clock.monotonicEpoch) captured at the last run. A
   * monotonic delta is valid ONLY when the current epoch equals this — otherwise
   * the stored `lastRunMonotonicMs` is from a prior process/boot and must be
   * ignored (computeElapsed falls back to the wall reading). Absent for the first
   * run or a wall-only clock.
   */
  lastRunMonotonicEpoch?: string;
}

/** The durable-schedule bookkeeping store (LIFE-5). */
export interface ScheduleStore {
  getBookkeeping(scheduleId: string): Promise<ScheduleBookkeeping | undefined>;
  put(bookkeeping: ScheduleBookkeeping): Promise<void>;
}

// HealthItem is a frozen @sow/contracts seam model — import (type-only) rather
// than re-declare. The store keys on a caller-supplied dedupe key so repeated
// failures of the SAME class do NOT spawn duplicate items (§10.3 dedupe).
import type { HealthItem } from "@sow/contracts";
export type { HealthItem };

/**
 * The System-Health item store (OBS-1/OBS-2). `getByDedupeKey` drives dedupe (one
 * DISTINCT item per (failureClass, subjectRef)); `put` upserts the item's
 * lifecycle (open → acknowledged → resolved); `list` surfaces the dashboard set.
 */
export interface HealthItemStore {
  getByDedupeKey(dedupeKey: string): Promise<HealthItem | undefined>;
  put(item: HealthItem): Promise<void>;
  list(): Promise<HealthItem[]>;
}

// --- (2c) The closed §9 WorkflowRunRef.trigger taxonomy (LOCAL constant) ---

/**
 * The closed set of §9 workflow triggers. WorkflowRunRef.trigger is an OPEN
 * string in @sow/contracts (frozen field-name set, value taxonomy deferred to
 * §9); this @sow/workflows-local constant pins the closed set. A general
 * WorkflowRunState set may be added by 7.4 — deliberately NOT declared here.
 */
export const WORKFLOW_TRIGGERS = [
  "schedule",
  "connector_event",
  "owner_action",
  "hermes_automation",
] as const;

/** The closed §9 workflow-trigger type (element of {@link WORKFLOW_TRIGGERS}). */
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];
