// @sow/worker — the OPERATIONAL-TRUTH store adapters (Phase-10 wiring).
//
// The worker-layer bridges that map the REAL @sow/db operational-store
// repositories (HealthItemRepository · ScheduleBookkeepingRepository ·
// InstanceLeaseRepository) onto the pure @sow/workflows persistence ports
// (HealthItemStore · ScheduleStore · InstanceLeaseStore). Mirror of the
// `createReceiptStoreAdapter` bridge in backends.ts: @sow/db MUST NOT import
// @sow/workflows, so the port-shaped adapter lives HERE at the composition root.
//
// This discharges the Phase-10 carry-forward the in-memory HealthItemStore left
// (backends.ts §3): the §9 durability spine's health / schedule / lease truth now
// PERSISTS to the migrated sqlite operational store instead of process memory.
//
// FAIL-CLOSED CONTRACT (§16 + operational-truth invariant). The three ports return
// bare Promises (not Result), so a genuine @sow/db `DbError` fault (unavailable /
// conflict / constraint_violation / serialization_failure / unknown) is surfaced by
// REJECTING the promise — never by returning a plausible-but-wrong answer. A benign
// `not_found` MISS is the ONE code folded to the port's absence sentinel
// (`undefined`), because a lookup miss is not a fault. The callers already fold a
// rejection into a typed activity error (e.g. materializeHealthItem's persist_failed),
// so a real fault stops the spine rather than silently corrupting operational truth.
//
// §16: contention on the lease CAS is a boolean verdict (ok(false)), NEVER a throw —
// only a real store fault rejects.
import { isErr } from "@sow/contracts";
import type { HealthItem } from "@sow/contracts";
import type {
  HealthItemRepository,
  ScheduleBookkeepingRepository,
  InstanceLeaseRepository,
  ScheduleBookkeepingRecord,
  LeaseRecordRow,
  DbError,
} from "@sow/db";
import type {
  HealthItemStore,
  ScheduleStore,
  InstanceLeaseStore,
  ScheduleBookkeeping,
  LeaseRecord,
} from "@sow/workflows/ports/operational";

// ---------------------------------------------------------------------------
// fail-closed fault surfacing
// ---------------------------------------------------------------------------

/**
 * True for the ONE benign code a lookup may legitimately return: a MISS. Every
 * other `DbError` code is a genuine fault the fail-closed contract rejects on.
 */
function isMiss(error: DbError): boolean {
  return error.code === "not_found";
}

/**
 * Surface a genuine @sow/db fault as a rejected promise (the port has no typed error
 * channel). The message keeps the enumerable `DbError.code` so a caller's redacted
 * log line carries the fault class; the opaque driver `cause` is NOT attached (it may
 * carry raw content — safety rule 7). Never called for a `not_found` miss.
 */
function faultRejection(op: string, error: DbError): Error {
  return new Error(`operational-store ${op} failed (${error.code}): ${error.message}`);
}

// ---------------------------------------------------------------------------
// (a) HealthItemStore — @sow/db HealthItemRepository → @sow/workflows port
// ---------------------------------------------------------------------------

/**
 * Split the materializer's dedupe identity out of a HealthItem's `id`.
 *
 * The §9 materializer (activities/healthItem.ts `healthItemDedupeKey`) sets
 * `item.id === "${failureClass}|${subjectRef}"` — the dedupe key IS the id. The
 * @sow/db `put` wants the dedupe key AND the bare `subjectRef` separately (it stores
 * subjectRef as a dedupe column). We recover subjectRef by stripping the
 * `"${failureClass}|"` prefix — a `subjectRef` that itself contains `|` (e.g. a
 * structured workflowId) is preserved because we split ONLY the first delimiter after
 * the known failureClass, not every `|`.
 *
 * dedupeKey is always `item.id` verbatim (the store keys the upsert on it). If the id
 * does NOT carry the expected `"${failureClass}|"` prefix (a caller that minted a
 * non-materializer id), subjectRef falls back to the whole id — the upsert stays
 * correct (dedupe key is still item.id); only the stored subjectRef column is coarser.
 */
function splitDedupeIdentity(item: HealthItem): {
  readonly dedupeKey: string;
  readonly subjectRef: string;
} {
  const dedupeKey = item.id;
  const prefix = `${item.failureClass}|`;
  const subjectRef = dedupeKey.startsWith(prefix)
    ? dedupeKey.slice(prefix.length)
    : dedupeKey;
  return { dedupeKey, subjectRef };
}

/**
 * Adapt the @sow/db {@link HealthItemRepository} onto the @sow/workflows
 * {@link HealthItemStore} port the §9 materializer persists through. The health sink
 * now writes to the migrated sqlite `health_items` table (a committed meeting-closeout
 * that hits a failure path surfaces a PERSISTED, deduped item — not a process-memory
 * one). `now` supplies the §10.3 `lastSeen` observation timestamp the port's bare
 * `put(item)` does not carry (the composition root injects the real wall clock).
 *
 *   • `put` — derive the (dedupeKey, subjectRef) §10.3 identity from `item.id`, supply
 *     `lastSeen = now()`; the repo does the dedupe UPSERT (first sight INSERT, repeat
 *     bumps occurrenceCount + refreshes lastSeen, preserves openedAt). A real DbError
 *     REJECTS (never a silent dropped failure item).
 *   • `getByDedupeKey` — `not_found` → `undefined` (an unseen key is a miss, not a
 *     fault); any other DbError REJECTS; `ok` unwraps the rehydrated HealthItem.
 *   • `list` — unwrap `ok`; a real DbError REJECTS (an empty list would be a silent
 *     wrong answer that hides an unavailable store).
 */
export function createHealthItemStoreAdapter(
  repo: HealthItemRepository,
  now: () => string,
): HealthItemStore {
  return {
    async getByDedupeKey(dedupeKey: string): Promise<HealthItem | undefined> {
      const r = await repo.getByDedupeKey(dedupeKey);
      if (isErr(r)) {
        if (isMiss(r.error)) return undefined;
        throw faultRejection("healthItem.getByDedupeKey", r.error);
      }
      return r.value;
    },
    async put(item: HealthItem): Promise<void> {
      const { dedupeKey, subjectRef } = splitDedupeIdentity(item);
      const r = await repo.put(item, dedupeKey, subjectRef, now());
      if (isErr(r)) throw faultRejection("healthItem.put", r.error);
    },
    async list(): Promise<HealthItem[]> {
      const r = await repo.list();
      if (isErr(r)) throw faultRejection("healthItem.list", r.error);
      return r.value;
    },
  };
}

// ---------------------------------------------------------------------------
// (b) ScheduleStore — @sow/db ScheduleBookkeepingRepository → @sow/workflows port
// ---------------------------------------------------------------------------

/**
 * The @sow/db {@link ScheduleBookkeepingRecord} and the @sow/workflows
 * {@link ScheduleBookkeeping} port DTO are structurally identical (scheduleId +
 * lastRunWall + optional monotonic reading + epoch). Copy field-for-field rather than
 * cast so a future field divergence is a compile error here, not a silent mismatch.
 */
function recordToBookkeeping(r: ScheduleBookkeepingRecord): ScheduleBookkeeping {
  return {
    scheduleId: r.scheduleId,
    lastRunWall: r.lastRunWall,
    ...(r.lastRunMonotonicMs !== undefined ? { lastRunMonotonicMs: r.lastRunMonotonicMs } : {}),
    ...(r.lastRunMonotonicEpoch !== undefined
      ? { lastRunMonotonicEpoch: r.lastRunMonotonicEpoch }
      : {}),
  };
}

function bookkeepingToRecord(b: ScheduleBookkeeping): ScheduleBookkeepingRecord {
  return {
    scheduleId: b.scheduleId,
    lastRunWall: b.lastRunWall,
    ...(b.lastRunMonotonicMs !== undefined ? { lastRunMonotonicMs: b.lastRunMonotonicMs } : {}),
    ...(b.lastRunMonotonicEpoch !== undefined
      ? { lastRunMonotonicEpoch: b.lastRunMonotonicEpoch }
      : {}),
  };
}

/**
 * Adapt the @sow/db {@link ScheduleBookkeepingRepository} onto the @sow/workflows
 * {@link ScheduleStore} port (LIFE-5 catch-up truth).
 *
 *   • `getBookkeeping` — `not_found` → `undefined` (a never-run schedule has no row —
 *     the first-run fallback, not a fault); any other DbError REJECTS; `ok` unwraps.
 *   • `put` — advance the last-run readings; a real DbError REJECTS (a silently dropped
 *     write would re-fire or starve the schedule).
 */
export function createScheduleStoreAdapter(repo: ScheduleBookkeepingRepository): ScheduleStore {
  return {
    async getBookkeeping(scheduleId: string): Promise<ScheduleBookkeeping | undefined> {
      const r = await repo.getBookkeeping(scheduleId);
      if (isErr(r)) {
        if (isMiss(r.error)) return undefined;
        throw faultRejection("schedule.getBookkeeping", r.error);
      }
      return recordToBookkeeping(r.value);
    },
    async put(bookkeeping: ScheduleBookkeeping): Promise<void> {
      const r = await repo.put(bookkeepingToRecord(bookkeeping));
      if (isErr(r)) throw faultRejection("schedule.put", r.error);
    },
  };
}

// ---------------------------------------------------------------------------
// (c) InstanceLeaseStore — @sow/db InstanceLeaseRepository → @sow/workflows port
// ---------------------------------------------------------------------------

/**
 * The @sow/db {@link LeaseRecordRow} and the @sow/workflows {@link LeaseRecord} port
 * DTO are structurally identical (taskQueue + ownerId + acquiredAt + expiresAt +
 * generation). Copy field-for-field so a future divergence is a compile error.
 */
function rowToLease(r: LeaseRecordRow): LeaseRecord {
  return {
    taskQueue: r.taskQueue,
    ownerId: r.ownerId,
    acquiredAt: r.acquiredAt,
    expiresAt: r.expiresAt,
    generation: r.generation,
  };
}

function leaseToRow(l: LeaseRecord): LeaseRecordRow {
  return {
    taskQueue: l.taskQueue,
    ownerId: l.ownerId,
    acquiredAt: l.acquiredAt,
    expiresAt: l.expiresAt,
    generation: l.generation,
  };
}

/**
 * Adapt the @sow/db {@link InstanceLeaseRepository} onto the @sow/workflows
 * {@link InstanceLeaseStore} port (LIFE-1 single-active-instance lease).
 *
 *   • `get` — `not_found` → `undefined` (an empty slot — first-acquire path, not a
 *     fault); any other DbError REJECTS; `ok` unwraps the lease row.
 *   • `compareAndSet` — CONTENTION is a boolean verdict: the repo returns
 *     `ok(false)` when another instance won the race (NEVER a throw — §16), and this
 *     adapter passes that boolean straight through. Only a genuine store DbError
 *     REJECTS (fail-closed: a swallowed fault answered `true` would let TWO instances
 *     believe they hold the lease — the exactly-once spine's worst failure).
 */
export function createInstanceLeaseStoreAdapter(repo: InstanceLeaseRepository): InstanceLeaseStore {
  return {
    async get(taskQueue: string): Promise<LeaseRecord | undefined> {
      const r = await repo.get(taskQueue);
      if (isErr(r)) {
        if (isMiss(r.error)) return undefined;
        throw faultRejection("instanceLease.get", r.error);
      }
      return rowToLease(r.value);
    },
    async compareAndSet(
      expected: LeaseRecord | undefined,
      next: LeaseRecord,
    ): Promise<boolean> {
      const r = await repo.compareAndSet(
        expected === undefined ? undefined : leaseToRow(expected),
        leaseToRow(next),
      );
      // A store FAULT fails closed by REJECTING — never a coerced `false` (a false
      // would be read as "another instance won", silently starving this one) and never
      // a `true` (which would double-grant the lease). Contention itself is ok(false).
      if (isErr(r)) throw faultRejection("instanceLease.compareAndSet", r.error);
      return r.value;
    },
  };
}
