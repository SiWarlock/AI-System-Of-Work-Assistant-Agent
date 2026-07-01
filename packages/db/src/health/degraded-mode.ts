// Unit 2.8 — DB-unavailable DEGRADED mode (§4 failure mode + §16 OBS-2 /
// error-handling convention).
//
// When the operational DB is unavailable the store layer MUST NOT throw an
// opaque error across the boundary (§16: "nothing fails silently"). This module
// is the typed degraded-mode core that the worker's storage layer wraps a
// DB-connection failure through. On a failure it:
//   (a) surfaces a DISTINCT, persistent, audit-linked System Health item for the
//       DB-unavailable class (§16 OBS-2), deduped by failure class so repeated
//       unavailability does NOT crash-loop or spawn duplicate items;
//   (b) QUEUES the failed operation where possible (a typed pending-queue result)
//       rather than dropping it; and
//   (c) returns a typed `Result<…, DbError>` on EVERY path — never a throw.
// Recovery drains the queue (FIFO) and resolves the health item.
//
// PURE-ish: imports only type-level shapes from `@sow/contracts` + the (no-driver)
// `DbError` contract from the repository interfaces — no Drizzle / no driver, so
// this stays import-direction clean. State (current item + pending queue) lives in
// the instance; the actual audit append + supervisor wiring happen in the worker.
import { auditId, err, HealthItemSchema, ok } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem, Result } from "@sow/contracts";
import type { DbError } from "../repositories/interfaces";

// arch_gap: §16's OBS-2 `failureClass` enum has NO dedicated `db_unavailable`
// member — the closest analog is `worker_down` (the worker's operational
// persistence being unreachable IS the worker being unable to function; cf.
// connector_unreachable which is reserved for the §8 Connector Gateway, and the
// Keychain/Temporal degraded modes which have their own distinct surfaces). The
// DB-unavailable item is kept distinct from those by its `subjectRef` + message,
// not by a separate failure class. Flagged: a `db_unavailable` OBS-2 class would
// be the precise fit.
export const DB_UNAVAILABLE_FAILURE_CLASS: FailureClass = "worker_down";

/** Stable subject the dedupe identity (failureClass, subjectRef) keys on (§10.3). */
export const DB_UNAVAILABLE_SUBJECT = "operational-db" as const;

/** Open severity string (HealthItem.severity is an open string, not an enum). */
export const DB_UNAVAILABLE_SEVERITY = "error" as const;

/** Typed availability the worker supervisor / System Health surface can poll. */
export type DbAvailability = "available" | "degraded";

/** A store operation handed to the wrapper when a DB connection fails. */
export interface PendingOperation<T = unknown> {
  /** Caller-stable id (idempotency / dedupe across re-drives). */
  readonly opId: string;
  /** Domain operation name, e.g. `outbox.enqueue` (diagnostics only). */
  readonly kind: string;
  /**
   * Whether this op can be safely deferred. Writes (enqueue/append/upsert) are
   * queueable; reads that need data NOW are not — queued where POSSIBLE, never
   * silently faked. The caller (which knows the op semantics) sets this.
   */
  readonly queueable: boolean;
  readonly payload: T;
}

/** A persisted entry in the degraded-mode pending queue. */
export interface QueuedEntry<T = unknown> {
  readonly opId: string;
  readonly kind: string;
  readonly payload: T;
  readonly enqueuedAt: string;
}

/** Typed pending-queue result — queued, or explicitly not (with the reason). */
export type QueueOutcome<T> =
  | { readonly queued: true; readonly entry: QueuedEntry<T> }
  | { readonly queued: false; readonly reason: "not_queueable" };

/** The wrapper's typed outcome: degraded + the health item + the queue result. */
export interface DegradedTransition<T> {
  readonly availability: "degraded";
  readonly healthItem: HealthItem;
  readonly queue: QueueOutcome<T>;
}

/** Recovery result: the store is available again, queue drained, item resolved. */
export interface DrainResult {
  readonly availability: "available";
  readonly drained: readonly QueuedEntry<unknown>[];
  readonly resolvedHealthItem: HealthItem;
}

/**
 * Injected, side-effecting dependencies (clock + id minting). Injectable so the
 * emitted HealthItem is deterministic under test; defaults wire real ones.
 */
export interface DegradedModeDeps {
  readonly now: () => string;
  readonly newHealthItemId: () => string;
  readonly newAuditRef: () => AuditId | string;
}

/** Real defaults: wall clock + counter-suffixed ids (unique per controller). */
export function defaultDegradedModeDeps(): DegradedModeDeps {
  let n = 0;
  return {
    now: () => new Date().toISOString(),
    newHealthItemId: () => `health-db-unavailable-${(n += 1)}`,
    newAuditRef: () => auditId(`audit-db-unavailable-${n}`),
  };
}

/**
 * In-memory DB-unavailable degraded-mode controller. One per store; the worker
 * routes a caught DB-connection failure through `onDbConnectionFailure`, polls
 * `availability()`/`currentHealthItem()`, and calls `recover()` on reconnect.
 */
export class DegradedModeController {
  private readonly deps: DegradedModeDeps;
  private state: DbAvailability = "available";
  private item: HealthItem | null = null;
  private readonly queue: QueuedEntry<unknown>[] = [];

  constructor(deps: Partial<DegradedModeDeps> = {}) {
    this.deps = { ...defaultDegradedModeDeps(), ...deps };
  }

  /** Typed availability probe (supervisor + System Health surface poll this). */
  availability(): DbAvailability {
    return this.state;
  }

  /** The active DB-unavailable System Health item, or null when available. */
  currentHealthItem(): HealthItem | null {
    return this.item;
  }

  /** Current pending-queue depth / contents (read-only). */
  pending(): readonly QueuedEntry<unknown>[] {
    return this.queue;
  }

  /**
   * Enter (or remain in) degraded mode and return the audit-linked HealthItem.
   * Idempotent + deduped: a second call while already degraded REUSES the
   * existing item (no duplicate, no crash-loop on repeated unavailability).
   */
  enterDegraded(_cause: unknown): Result<HealthItem, DbError> {
    if (this.item !== null) {
      this.state = "degraded";
      return ok(this.item);
    }
    const built = this.buildOpenHealthItem();
    if (!built.ok) return built;
    this.item = built.value;
    this.state = "degraded";
    return ok(this.item);
  }

  /**
   * THE WRAPPER. Map a caught DB-connection failure to the degraded HealthItem +
   * a queued (or explicitly-not-queued) outcome. Never throws; always typed.
   */
  onDbConnectionFailure<T>(
    cause: unknown,
    op: PendingOperation<T> | null = null,
  ): Result<DegradedTransition<T>, DbError> {
    const entered = this.enterDegraded(cause);
    if (!entered.ok) return entered;
    const healthItem = entered.value;

    let queue: QueueOutcome<T>;
    if (op === null || !op.queueable) {
      queue = { queued: false, reason: "not_queueable" };
    } else {
      const entry: QueuedEntry<T> = {
        opId: op.opId,
        kind: op.kind,
        payload: op.payload,
        enqueuedAt: this.deps.now(),
      };
      this.queue.push(entry as QueuedEntry<unknown>);
      queue = { queued: true, entry };
    }

    return ok({ availability: "degraded", healthItem, queue });
  }

  /**
   * Recover: the DB is reachable again. Drain the pending queue (FIFO, for the
   * caller to re-drive against the live store) and resolve the health item.
   * Returns a typed err (NOT a throw) if called while not degraded — nothing
   * fails silently.
   */
  recover(): Result<DrainResult, DbError> {
    if (this.state !== "degraded" || this.item === null) {
      return err({
        code: "not_found",
        message: "recover() called while the store is not in degraded mode",
      });
    }
    const resolved = this.resolveHealthItem(this.item);
    if (!resolved.ok) return resolved;

    const drained = this.queue.slice();
    this.queue.length = 0;
    this.item = null;
    this.state = "available";

    return ok({
      availability: "available",
      drained,
      resolvedHealthItem: resolved.value,
    });
  }

  // --- internals -----------------------------------------------------------

  /** Build + validate the open DB-unavailable HealthItem against the contract. */
  private buildOpenHealthItem(): Result<HealthItem, DbError> {
    const candidate = {
      id: this.deps.newHealthItemId(),
      failureClass: DB_UNAVAILABLE_FAILURE_CLASS,
      severity: DB_UNAVAILABLE_SEVERITY,
      message: `Operational DB unavailable (${DB_UNAVAILABLE_SUBJECT}); store is in degraded mode — operations queued where possible.`,
      auditRef: this.deps.newAuditRef(),
      openedAt: this.deps.now(),
      state: "open" as const,
    };
    return this.parseHealthItem(candidate);
  }

  /** Resolve the active item (state → resolved + resolvedAt), validated. */
  private resolveHealthItem(open: HealthItem): Result<HealthItem, DbError> {
    return this.parseHealthItem({
      ...open,
      state: "resolved" as const,
      resolvedAt: this.deps.now(),
    });
  }

  /**
   * Parse through the frozen HealthItemSchema so a malformed item becomes a typed
   * `DbError` rather than a thrown ZodError crossing the boundary.
   */
  private parseHealthItem(candidate: unknown): Result<HealthItem, DbError> {
    const parsed = HealthItemSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        code: "unknown",
        message: `failed to build a valid HealthItem for the DB-unavailable degraded mode: ${parsed.error.message}`,
        cause: parsed.error,
      });
    }
    return ok(parsed.data);
  }
}
