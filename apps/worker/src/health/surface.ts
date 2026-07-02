// @sow/worker — Task 10.3: the System Health SURFACE (OBS-1 / OBS-2 / §10.3).
//
// A failure → typed HealthItem MATERIALIZER at the worker layer. It is the single
// place a cross-subsystem failure becomes an operator-visible, persistent,
// audit-linked, deduped, lifecycle-carrying System-Health item. It builds ON the
// pure @sow/workflows §9 materializer (materializeHealthItem / resolveHealthItem /
// acknowledgeHealthItem / healthItemDedupeKey / projectSystemHealth) — it does NOT
// fork that lifecycle logic — and layers the OBS-2 DEDUPE BOOKKEEPING the frozen
// @sow/contracts `HealthItem` seam model cannot carry (occurrenceCount / lastSeen /
// subjectRef are persistence-only columns, per @sow/db health-items schema).
//
// OBS-2 guarantees this surface owns:
//   (a) DISTINCT item per (failureClass, subjectRef) — one item per OBS-2
//       FailureClass instance, discriminated, never one generic item.
//   (b) AUDIT-LINKED (every item carries auditRef) + PERSISTENT (stored via the
//       injected HealthSurfaceStore, which the integrator binds to the real @sow/db
//       HealthItemRepository — survives restart).
//   (c) IDEMPOTENT dedupe by (failureClass, subjectRef): a recurring same-class
//       same-subject failure does NOT spawn a duplicate — it bumps occurrenceCount
//       + refreshes lastSeen on the ONE existing open|acknowledged item and
//       PRESERVES openedAt + lifecycle state (an acknowledged item stays
//       acknowledged; it does not silently reopen).
//   (d) lifecycle open → acknowledged | resolved (resolved TERMINAL) with
//       AUTO-RESOLVE when the underlying condition clears (resolve) so health
//       reflects TRUTH not a stale alarm; a fresh failure after resolution
//       REOPENS a new open item (fresh openedAt, occurrenceCount restarts at 1).
//   (e) acknowledge / resolve state survives a simulated restart because it is
//       PERSISTED via the store, never held in surface memory.
//
// Also exposes the OBS-1 read-model projection (connector/run/queue/outbox depth,
// blocked write-throughs, active health-item count + a per-class active rollup)
// the §10 API / §11 UI render — a PURE fold over the injected inputs + the store.
//
// §16 error convention: NEVER throws across the boundary — every method returns a
// typed Result<T, HealthSurfaceError> whose `code` is an ENUMERABLE closed set. A
// store rejection or a schema-invalid candidate becomes a typed err, not a throw.
//
// WIRING (integrator step, NOT this module): `createHealthSurface(repo)` REPLACES
// `createInMemoryHealthItemStore()` in the composition root — the integrator binds
// `repo` to a HealthSurfaceStore adapter over the @sow/db HealthItemRepository
// (which already tracks occurrenceCount/lastSeen/subjectRef in the health_items
// table). This module stays effect-injected + unit-testable with a fake store.

import { ok, err } from "@sow/contracts";
import type { AuditId, FailureClass, HealthItem, Result } from "@sow/contracts";
import {
  healthItemDedupeKey,
  materializeHealthItem,
  acknowledgeHealthItem,
  resolveHealthItem,
  projectSystemHealth,
  type HealthItemStore,
  type RunStatusRow,
  type SystemHealthProjection,
} from "@sow/workflows";

// --- the persistent, dedupe-bookkeeping-carrying record + store port ---------

/**
 * A materialized System-Health item AS STORED by the surface: the frozen
 * @sow/contracts `HealthItem` (the API/UI seam model) PLUS the OBS-2 dedupe
 * bookkeeping the model deliberately omits. `dedupeKey` is the §10.3 identity
 * (`failureClass|subjectRef`); `subjectRef` is retained for inspection/grouping;
 * `lastSeen` is refreshed on every dedupe hit; `occurrenceCount` counts recurrences
 * since `openedAt`. `openedAt` mirrors `item.openedAt` for convenience.
 */
export interface SurfacedHealthItem {
  readonly dedupeKey: string;
  readonly subjectRef: string;
  readonly item: HealthItem;
  readonly openedAt: string;
  readonly lastSeen: string;
  readonly occurrenceCount: number;
}

/**
 * The persistent store port the surface materializes through. SAME method shape
 * as the @sow/workflows `HealthItemStore` port (getByDedupeKey / put / list) so the
 * integrator can bind it to the real @sow/db `HealthItemRepository` adapter — but
 * it carries the richer `SurfacedHealthItem` (with dedupe bookkeeping) rather than
 * the bare frozen `HealthItem`. No throw across the boundary is REQUIRED, but a
 * rejection is tolerated: the surface maps it to a typed err (§16).
 */
export interface HealthSurfaceStore {
  getByDedupeKey(dedupeKey: string): Promise<SurfacedHealthItem | undefined>;
  put(record: SurfacedHealthItem): Promise<void>;
  list(): Promise<SurfacedHealthItem[]>;
}

// --- inputs -----------------------------------------------------------------

/**
 * A single cross-subsystem failure occurrence to materialize. `now` is the injected
 * ISO-8601 clock reading (no Date.now() here — deterministic + unit-testable).
 * `severity` is optional (defaults to the §9 materializer default).
 */
export interface HealthFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
  readonly now: string;
}

/** The dedupe identity of an item to acknowledge (no message/clock needed). */
export interface HealthItemRef {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
}

// --- typed, enumerable error surface (§16) ----------------------------------

/** Closed, enumerable failure taxonomy for the surface (never thrown). */
export type HealthSurfaceErrorCode =
  | "invalid_item" // the built candidate failed the frozen HealthItemSchema
  | "persist_failed"; // the injected store rejected a read/write

export interface HealthSurfaceError {
  readonly code: HealthSurfaceErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

const fail = (
  code: HealthSurfaceErrorCode,
  message: string,
  cause?: unknown,
): Result<never, HealthSurfaceError> => err({ code, message, cause });

// --- OBS-1 read-model projection surface ------------------------------------

/**
 * Inputs to the OBS-1 read-model projection the §10 API / §11 UI render. The run
 * rows + depth counters are supplied by the caller (they come from the WorkflowRun
 * registry + outbox/queue read models); the active health-item counts come from the
 * surface's own persistent store — the caller does NOT pass health items in.
 */
export interface HealthReadModelInput {
  readonly runs: readonly RunStatusRow[];
  readonly queueDepth: number;
  readonly outboxDepth: number;
  readonly blockedWriteThroughs: number;
  readonly nextScheduledRunAt?: string;
}

/**
 * The OBS-1 System-Health read model: the §9 `SystemHealthProjection` (run rollup,
 * failed runs, queue/outbox depth, blocked write-throughs, active health-item
 * count) PLUS a per-`FailureClass` active-count rollup for the OBS-1 per-class
 * surfaces (connector status, blocked write-throughs, sync lag, budget, schedule).
 */
export interface HealthReadModel extends SystemHealthProjection {
  /** Active (open|acknowledged) item count per FailureClass — resolved excluded. */
  readonly activeByClass: Readonly<Partial<Record<FailureClass, number>>>;
}

// --- the surface ------------------------------------------------------------

/** The System-Health surface — the worker-layer failure sink + read model. */
export interface HealthSurface {
  /** Materialize a failure into a persisted, deduped, audit-linked item (open|reopen|recurrence). */
  record(
    failure: HealthFailure,
  ): Promise<Result<SurfacedHealthItem, HealthSurfaceError>>;
  /** Operator ack: open → acknowledged (idempotent; no item → ok(undefined)). */
  acknowledge(
    ref: HealthItemRef,
  ): Promise<Result<SurfacedHealthItem | undefined, HealthSurfaceError>>;
  /** Auto-resolve on clear: open|acknowledged → resolved (terminal; idempotent). */
  resolve(
    ref: HealthItemRef & { readonly now: string },
  ): Promise<Result<SurfacedHealthItem | undefined, HealthSurfaceError>>;
  /** The dashboard set — every stored item. */
  list(): Promise<Result<SurfacedHealthItem[], HealthSurfaceError>>;
  /** The OBS-1 read-model projection over the injected inputs + the store. */
  readModel(
    input: HealthReadModelInput,
  ): Promise<Result<HealthReadModel, HealthSurfaceError>>;
}

/**
 * Build the System-Health surface over a persistent {@link HealthSurfaceStore}.
 *
 * The frozen-item lifecycle decisions (open on first sight, in-place update on a
 * recurrence with openedAt/state PRESERVED, reopen after a terminal resolution,
 * acknowledge/resolve idempotency + resolved-terminal invariant, schema validation)
 * are delegated to the pure @sow/workflows §9 materializer via an internal adapter
 * that presents a bare-`HealthItem` `HealthItemStore` VIEW over the enriched store.
 * The surface then layers the occurrenceCount/lastSeen bookkeeping the model cannot
 * carry. This REUSES the proven §9 logic rather than forking it.
 *
 * @returns a stateless surface — all state lives in the injected store, so
 * acknowledge/resolve survive a restart (a fresh surface over the same store sees
 * the persisted lifecycle).
 */
export function createHealthSurface(store: HealthSurfaceStore): HealthSurface {
  // Adapt the enriched store to the bare-HealthItem HealthItemStore the §9
  // materializer consumes. The adapter caches the CURRENT enriched record it read
  // (per operation) so the surface can compute the recurrence/reopen bookkeeping
  // from the SAME snapshot the materializer decided against — no double read, no
  // race between the adapter's read and the surface's.
  const buildAdapter = (): {
    readonly view: HealthItemStore;
    priorByKey: Map<string, SurfacedHealthItem | undefined>;
    capturedByKey: Map<string, HealthItem>;
  } => {
    const priorByKey = new Map<string, SurfacedHealthItem | undefined>();
    const capturedByKey = new Map<string, HealthItem>();
    const view: HealthItemStore = {
      async getByDedupeKey(dedupeKey: string): Promise<HealthItem | undefined> {
        const prior = await store.getByDedupeKey(dedupeKey);
        priorByKey.set(dedupeKey, prior);
        return prior?.item;
      },
      put(item: HealthItem): Promise<void> {
        // Capture the frozen item the materializer built; the surface enriches +
        // persists it (the adapter does NOT write to the real store directly).
        capturedByKey.set(item.id, item);
        return Promise.resolve();
      },
      async list(): Promise<HealthItem[]> {
        const rows = await store.list();
        return rows.map((r) => r.item);
      },
    };
    return { view, priorByKey, capturedByKey };
  };

  /**
   * Enrich the frozen item the materializer built into a SurfacedHealthItem and
   * persist it. The bookkeeping rule mirrors the @sow/db upsert:
   *   • no prior / prior was resolved (terminal) → FRESH lifecycle: occurrenceCount
   *     = 1, openedAt/lastSeen = the item's openedAt.
   *   • prior open|acknowledged → recurrence: occurrenceCount + 1, lastSeen refreshed
   *     to `now`, openedAt preserved (mirrors the item's preserved openedAt).
   */
  const enrichAndPersist = async (
    item: HealthItem,
    subjectRef: string,
    prior: SurfacedHealthItem | undefined,
    now: string,
  ): Promise<Result<SurfacedHealthItem, HealthSurfaceError>> => {
    const isFreshLifecycle = prior === undefined || prior.item.state === "resolved";
    const record: SurfacedHealthItem = {
      dedupeKey: item.id,
      subjectRef,
      item,
      openedAt: item.openedAt,
      lastSeen: isFreshLifecycle ? item.openedAt : now,
      occurrenceCount: isFreshLifecycle ? 1 : prior.occurrenceCount + 1,
    };
    try {
      await store.put(record);
      return ok(record);
    } catch (cause) {
      return fail("persist_failed", "failed to persist the health item", cause);
    }
  };

  return {
    async record(
      failure: HealthFailure,
    ): Promise<Result<SurfacedHealthItem, HealthSurfaceError>> {
      const dedupeKey = healthItemDedupeKey(failure.failureClass, failure.subjectRef);
      const adapter = buildAdapter();

      // Delegate the frozen-item lifecycle decision (open/reopen/recurrence, state +
      // openedAt preservation, schema validation) to the §9 materializer.
      const materialized = await materializeHealthItem(
        {
          failureClass: failure.failureClass,
          subjectRef: failure.subjectRef,
          severity: failure.severity,
          message: failure.message,
          auditRef: failure.auditRef,
          now: failure.now,
        },
        adapter.view,
      );
      if (!materialized.ok) return mapActivityError(materialized.error);

      const prior = adapter.priorByKey.get(dedupeKey);
      return enrichAndPersist(materialized.value, failure.subjectRef, prior, failure.now);
    },

    async acknowledge(
      ref: HealthItemRef,
    ): Promise<Result<SurfacedHealthItem | undefined, HealthSurfaceError>> {
      const dedupeKey = healthItemDedupeKey(ref.failureClass, ref.subjectRef);
      const adapter = buildAdapter();
      const acked = await acknowledgeHealthItem(
        { failureClass: ref.failureClass, subjectRef: ref.subjectRef },
        adapter.view,
      );
      if (!acked.ok) return mapActivityError(acked.error);
      // No item, or a terminal item the ack left untouched → nothing to re-persist.
      const prior = adapter.priorByKey.get(dedupeKey);
      if (acked.value === undefined) return ok(undefined);
      if (adapter.capturedByKey.get(acked.value.id) === undefined) {
        // Terminal (resolved) — acknowledge was a no-op; return the prior record.
        return ok(prior);
      }
      // A lifecycle transition happened: re-persist preserving bookkeeping (ack does
      // NOT bump occurrenceCount or lastSeen — it is an operator action, not a new
      // failure occurrence).
      return persistLifecycleTransition(acked.value, ref.subjectRef, prior);
    },

    async resolve(
      ref: HealthItemRef & { readonly now: string },
    ): Promise<Result<SurfacedHealthItem | undefined, HealthSurfaceError>> {
      const dedupeKey = healthItemDedupeKey(ref.failureClass, ref.subjectRef);
      const adapter = buildAdapter();
      const resolved = await resolveHealthItem(
        { failureClass: ref.failureClass, subjectRef: ref.subjectRef, now: ref.now },
        adapter.view,
      );
      if (!resolved.ok) return mapActivityError(resolved.error);
      const prior = adapter.priorByKey.get(dedupeKey);
      if (resolved.value === undefined) return ok(undefined);
      if (adapter.capturedByKey.get(resolved.value.id) === undefined) {
        // Already-resolved terminal — resolve was a no-op; return the prior record.
        return ok(prior);
      }
      return persistLifecycleTransition(resolved.value, ref.subjectRef, prior);
    },

    async list(): Promise<Result<SurfacedHealthItem[], HealthSurfaceError>> {
      try {
        return ok(await store.list());
      } catch (cause) {
        return fail("persist_failed", "failed to list health items", cause);
      }
    },

    async readModel(
      input: HealthReadModelInput,
    ): Promise<Result<HealthReadModel, HealthSurfaceError>> {
      let rows: SurfacedHealthItem[];
      try {
        rows = await store.list();
      } catch (cause) {
        return fail("persist_failed", "failed to read health items for projection", cause);
      }
      const items = rows.map((r) => r.item);
      // Delegate the run/queue/outbox/active-count fold to the pure §9 projection.
      const projection = projectSystemHealth({
        runs: input.runs,
        healthItems: items,
        queueDepth: input.queueDepth,
        outboxDepth: input.outboxDepth,
        blockedWriteThroughs: input.blockedWriteThroughs,
        ...(input.nextScheduledRunAt !== undefined
          ? { nextScheduledRunAt: input.nextScheduledRunAt }
          : {}),
      });
      // Layer the OBS-1 per-class active rollup (open|acknowledged only).
      const activeByClass: Partial<Record<FailureClass, number>> = {};
      for (const r of rows) {
        if (r.item.state === "resolved") continue;
        activeByClass[r.item.failureClass] =
          (activeByClass[r.item.failureClass] ?? 0) + 1;
      }
      return ok({ ...projection, activeByClass });
    },
  };

  /**
   * Re-persist an item whose LIFECYCLE STATE changed (acknowledge/resolve) while
   * PRESERVING its occurrenceCount + lastSeen (a state change is not a new failure
   * occurrence). A missing prior (should not happen for a real transition) falls
   * back to occurrenceCount 1 / lastSeen = openedAt — safe, never a throw.
   */
  async function persistLifecycleTransition(
    item: HealthItem,
    subjectRef: string,
    prior: SurfacedHealthItem | undefined,
  ): Promise<Result<SurfacedHealthItem, HealthSurfaceError>> {
    const record: SurfacedHealthItem = {
      dedupeKey: item.id,
      subjectRef: prior?.subjectRef ?? subjectRef,
      item,
      openedAt: prior?.openedAt ?? item.openedAt,
      lastSeen: prior?.lastSeen ?? item.openedAt,
      occurrenceCount: prior?.occurrenceCount ?? 1,
    };
    try {
      await store.put(record);
      return ok(record);
    } catch (cause) {
      return fail("persist_failed", "failed to persist the health item", cause);
    }
  }
}

// --- error mapping ----------------------------------------------------------

/**
 * Map the §9 materializer's `HealthActivityError` (code: 'invalid_item' |
 * 'persist_failed') onto the surface's own enumerable error surface. The codes are
 * intentionally the same closed set, so the map is faithful.
 */
function mapActivityError(e: {
  readonly code: "invalid_item" | "persist_failed";
  readonly message: string;
  readonly cause?: unknown;
}): Result<never, HealthSurfaceError> {
  return err({ code: e.code, message: e.message, cause: e.cause });
}
