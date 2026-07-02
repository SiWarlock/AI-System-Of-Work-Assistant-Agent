// FOUNDATION — in-memory test doubles + builders shared by every 7.1–7.5 slice.
//
// These fakes satisfy the real port interfaces (the @sow/db repository contracts
// and the gateway-owned ports in src/ports/operational.ts) so unit tests exercise
// the PURE runtime/orchestration + activities with NO Temporal server and NO real
// DB. They return the EXACT @sow/db typed Result shapes (`Result<T, DbError>`)
// wherever the repo interface demands them, and they are deterministic: the fake
// clock has a MUTABLE time the test advances by hand — no Date.now().
import { ok, err, auditId, workflowId } from "@sow/contracts";
import type { AuditId, Result, WorkflowRunRef, HealthItem } from "@sow/contracts";
import type {
  WorkflowRunRefRepository,
  DbError,
  DbResult,
  Clock,
  InstanceLeaseStore,
  LeaseRecord,
  ScheduleStore,
  ScheduleBookkeeping,
  HealthItemStore,
} from "../../src/ports/operational";

// --- builders --------------------------------------------------------------

/**
 * Build a valid WorkflowRunRef for tests. Every field has a sane default; pass a
 * partial to override. IDs are minted through the real branded-id constructors so
 * the value carries the correct brand (never a bare-string cast).
 */
export function makeWorkflowRunRef(
  partial: Partial<WorkflowRunRef> = {},
): WorkflowRunRef {
  return {
    workflowId: workflowId("wf-1"),
    trigger: "schedule",
    state: "running",
    idempotencyKey: "idem-1",
    auditRefs: [],
    ...partial,
  };
}

/**
 * Build a valid open HealthItem for tests. Defaults produce a schema-valid
 * OPEN item (no resolvedAt); pass a partial to override (e.g. a resolved item
 * must set BOTH `state: "resolved"` and `resolvedAt`).
 */
export function makeHealthItem(partial: Partial<HealthItem> = {}): HealthItem {
  return {
    id: "health-1",
    failureClass: "worker_down",
    severity: "error",
    message: "worker unreachable",
    auditRef: auditId("audit-1"),
    openedAt: "2026-07-01T00:00:00.000Z",
    state: "open",
    ...partial,
  };
}

// --- FakeClock -------------------------------------------------------------

/**
 * Deterministic injected clock. `now` is a mutable ISO string; `monotonicMs` a
 * mutable number. Advance either explicitly — the runtime never reads a real
 * clock, so tests fully control time (including simulating a wall-clock jump by
 * moving `now` backward while `monotonicMs` keeps rising).
 */
export class FakeClock implements Clock {
  private nowIso: string;
  private mono: number;
  private epoch: string;

  constructor(init: { now?: string; monotonicMs?: number; monotonicEpoch?: string } = {}) {
    this.nowIso = init.now ?? "2026-07-01T00:00:00.000Z";
    this.mono = init.monotonicMs ?? 0;
    // A fixed per-"process" epoch; a test simulates a RESTART by minting a new
    // FakeClock (or calling setMonotonicEpoch) so a persisted monotonic reading
    // from the old epoch is no longer comparable (LIFE-5 cross-restart guard).
    this.epoch = init.monotonicEpoch ?? "boot-1";
  }

  now(): string {
    return this.nowIso;
  }

  monotonicMs(): number {
    return this.mono;
  }

  monotonicEpoch(): string {
    return this.epoch;
  }

  /** Overwrite the wall reading (may move backward to simulate a clock jump). */
  setNow(iso: string): void {
    this.nowIso = iso;
  }

  /** Overwrite the monotonic reading. */
  setMonotonicMs(ms: number): void {
    this.mono = ms;
  }

  /** Advance the monotonic reading by a positive delta. */
  advanceMonotonicMs(deltaMs: number): void {
    this.mono += deltaMs;
  }

  /** Simulate a process/boot restart: the monotonic epoch changes, so any
   * previously-persisted monotonic reading is no longer comparable. */
  setMonotonicEpoch(epoch: string): void {
    this.epoch = epoch;
  }
}

// --- InMemoryWorkflowRunRepo (WorkflowRunRefRepository) --------------------

const notFound = (message: string): DbError => ({ code: "not_found", message });
const conflict = (message: string): DbError => ({ code: "conflict", message });

/**
 * In-memory WorkflowRunRefRepository. `create` rejects a duplicate workflowId
 * (conflict); `getByIdempotencyKey` drives replay reuse; `updateState` /
 * `appendAuditRef` mutate the stored ref and return the updated value. Every
 * method resolves to the exact `Result<T, DbError>` shape (never throws).
 */
export class InMemoryWorkflowRunRepo implements WorkflowRunRefRepository {
  private readonly byId = new Map<string, WorkflowRunRef>();

  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef> {
    if (this.byId.has(ref.workflowId)) {
      return Promise.resolve(
        err(conflict(`workflow run already exists: ${ref.workflowId}`)),
      );
    }
    // UNIQUE-CONSTRAINT on idempotencyKey (LIFE-3 / §9 idempotency backstop): two
    // concurrent submissions carrying the SAME idempotencyKey but different
    // workflowIds must NOT both create a run. The first insert wins; the second is
    // a typed `conflict` the caller reconciles by re-reading by idempotencyKey.
    // Mirrors the unique index the @sow/db workflow-run table must carry (Phase 10).
    for (const existing of this.byId.values()) {
      if (existing.idempotencyKey === ref.idempotencyKey) {
        return Promise.resolve(
          err(conflict(`workflow run already exists for idempotency key: ${ref.idempotencyKey}`)),
        );
      }
    }
    this.byId.set(ref.workflowId, ref);
    return Promise.resolve(ok(ref));
  }

  get(id: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    return Promise.resolve(
      found === undefined ? err(notFound(`no workflow run: ${id}`)) : ok(found),
    );
  }

  getByIdempotencyKey(
    idempotencyKey: WorkflowRunRef["idempotencyKey"],
  ): DbResult<WorkflowRunRef> {
    for (const ref of this.byId.values()) {
      if (ref.idempotencyKey === idempotencyKey) return Promise.resolve(ok(ref));
    }
    return Promise.resolve(
      err(notFound(`no workflow run for idempotency key: ${idempotencyKey}`)),
    );
  }

  updateState(
    id: WorkflowRunRef["workflowId"],
    state: WorkflowRunRef["state"],
  ): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    if (found === undefined) {
      return Promise.resolve(err(notFound(`no workflow run: ${id}`)));
    }
    const next: WorkflowRunRef = { ...found, state };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }

  appendAuditRef(
    id: WorkflowRunRef["workflowId"],
    auditRef: WorkflowRunRef["auditRefs"][number],
  ): DbResult<WorkflowRunRef> {
    const found = this.byId.get(id);
    if (found === undefined) {
      return Promise.resolve(err(notFound(`no workflow run: ${id}`)));
    }
    const next: WorkflowRunRef = {
      ...found,
      auditRefs: [...found.auditRefs, auditRef],
    };
    this.byId.set(id, next);
    return Promise.resolve(ok(next));
  }
}

// --- InMemoryInstanceLeaseStore (InstanceLeaseStore) -----------------------

/** Compare two lease records for value equality (dedupe/CAS identity). */
function leaseEquals(
  a: LeaseRecord | undefined,
  b: LeaseRecord | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.taskQueue === b.taskQueue &&
    a.ownerId === b.ownerId &&
    a.acquiredAt === b.acquiredAt &&
    a.expiresAt === b.expiresAt &&
    a.generation === b.generation
  );
}

/**
 * In-memory single-active-instance lease store. `compareAndSet` is atomic by
 * construction: the JS event loop runs the synchronous check-and-set to
 * completion with no interleaving, so the stored value is compared to `expected`
 * and swapped for `next` in one uninterrupted step (returns `false` on mismatch —
 * another instance won the race).
 */
export class InMemoryInstanceLeaseStore implements InstanceLeaseStore {
  private readonly byQueue = new Map<string, LeaseRecord>();

  get(taskQueue: string): Promise<LeaseRecord | undefined> {
    return Promise.resolve(this.byQueue.get(taskQueue));
  }

  compareAndSet(
    expected: LeaseRecord | undefined,
    next: LeaseRecord,
  ): Promise<boolean> {
    // Synchronous check-and-set — no await between the read and the write, so no
    // interleaving is possible (models an atomic CAS at the port boundary).
    const current = this.byQueue.get(next.taskQueue);
    if (!leaseEquals(current, expected)) return Promise.resolve(false);
    this.byQueue.set(next.taskQueue, next);
    return Promise.resolve(true);
  }
}

// --- InMemoryScheduleStore (ScheduleStore) ---------------------------------

/** In-memory durable-schedule bookkeeping store (LIFE-5). */
export class InMemoryScheduleStore implements ScheduleStore {
  private readonly byId = new Map<string, ScheduleBookkeeping>();

  getBookkeeping(
    scheduleId: string,
  ): Promise<ScheduleBookkeeping | undefined> {
    return Promise.resolve(this.byId.get(scheduleId));
  }

  put(bookkeeping: ScheduleBookkeeping): Promise<void> {
    this.byId.set(bookkeeping.scheduleId, bookkeeping);
    return Promise.resolve();
  }
}

// --- InMemoryHealthItemStore (HealthItemStore) -----------------------------

/**
 * In-memory System-Health item store. `getByDedupeKey` returns the item stored
 * under that key (drives dedupe); `put` upserts by the caller-supplied dedupe key
 * (see {@link healthDedupeKey}); `list` returns all current items in insertion
 * order.
 */
export class InMemoryHealthItemStore implements HealthItemStore {
  private readonly byKey = new Map<string, HealthItem>();

  getByDedupeKey(dedupeKey: string): Promise<HealthItem | undefined> {
    return Promise.resolve(this.byKey.get(dedupeKey));
  }

  put(item: HealthItem): Promise<void> {
    this.byKey.set(healthDedupeKey(item), item);
    return Promise.resolve();
  }

  list(): Promise<HealthItem[]> {
    return Promise.resolve([...this.byKey.values()]);
  }
}

/**
 * The dedupe key this fake stores a HealthItem under. The §10.3 dedupe identity
 * is (failureClass, subjectRef); the frozen HealthItem carries no subjectRef, so
 * the fake keys on `id` (each foundation test controls the id, and a re-put of
 * the same id upserts rather than duplicating — the property the store models).
 */
export function healthDedupeKey(item: HealthItem): string {
  return item.id;
}

// Re-export the id constructors used above so tests that build custom refs can
// mint correctly-branded ids without re-importing @sow/contracts directly.
export { auditId, workflowId };
export type { AuditId, Result };
