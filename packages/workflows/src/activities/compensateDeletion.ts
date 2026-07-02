// @sow/workflows — slice 7.14 ACTIVITIES: the POST-COMMIT cross-store deletion steps
// + their compensation/retry (inv-3 steps 2-4 / inv-4 idempotent replay / inv-5
// compensating). These implement {@link PurgeGbrainPort} (step 2 — GBrain
// purge/re-index), {@link TombstoneEventStorePort} (step 3 — event-store tombstone,
// history PRESERVED), and {@link ReconcileRefsPort} (step 4 — read-model + external-ref
// reconciliation).
//
// These are ACTIVITIES, NOT workflow code — they run worker-side and dispatch behind
// INJECTED clients (the @sow/knowledge GBrain purge/re-index path, the @sow/db
// event-log tombstone append, the read-model rebuild + external-ref reconciler), so
// they are Vitest-unit-testable with fakes and never touch a real store in the module.
//
// SAFETY (the exact bug-class prior verify passes caught — a guard that reads a field
// that is NOT what actually flows to the side effect):
//   • Each step is KEYED by the SAME per-step idempotency key the buildPlan activity
//     derived (purgeKey / eventTombstoneKey / reconcileKey), so a crash-replay is a
//     no-op: NO resurrected GBrain entry, NO double event-tombstone, convergent
//     reconciliation (inv-4).
//   • The event-store step APPENDS a NEW tombstone record — it NEVER hard-deletes
//     prior events (history preserved, the operational-truth immutability rule).
//   • The reconciler RETURNS its dangling refs so the driver surfaces them (never left
//     silently — inv-5); it does not swallow a dangling ref behind a success.
//   • NONE of these steps rolls the durable Markdown tombstone back — a post-commit
//     failure is a compensating/retry signal, not a rollback.
//
// §16: every method returns a typed Result — never throws across the activity
// boundary.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type {
  PurgeGbrainPort,
  PurgeGbrainError,
  TombstoneEventStorePort,
  EventTombstoneError,
  ReconcileRefsPort,
  ReconcileError,
  ReconcileOutcome,
} from "../workflows/deletionSaga";

// ---------------------------------------------------------------------------
// (2) PurgeGbrainPort activity — inv-3 step 2 (idempotent purge/re-index)
// ---------------------------------------------------------------------------

/** The idempotent GBrain purge outcome (a fresh purge vs. an already-purged no-op). */
export interface GbrainPurgeAck {
  readonly kind: "purged" | "already_purged";
  readonly revisionId: string;
}

/**
 * The injected GBrain purge/re-index client (the @sow/knowledge purge+reindex
 * dispatcher at the worker-wiring seam). IDEMPOTENT by (revisionId, purgeKey): a
 * re-drive over an already-purged subject returns `already_purged` — never a second
 * purge, so no resurrected index entry. Returns a typed Result, never throws.
 */
export interface GbrainPurgeClient {
  purge(
    revisionId: string,
    purgeKey: string,
  ): Promise<Result<GbrainPurgeAck, PurgeGbrainError>>;
}

/** Injected deps for the purge activity: the GBrain purge client. */
export interface PurgeGbrainActivityDeps {
  readonly client: GbrainPurgeClient;
}

/**
 * Build a {@link PurgeGbrainPort} over the injected client (inv-3 step 2 / inv-4). It
 * requires a non-empty revisionId (i.e. the Markdown tombstone already landed) — an
 * empty one fails closed without calling the client (a purge NEVER runs before the
 * commit point). It is idempotent and NEVER rolls the tombstone back. Never throws.
 */
export function createPurgeGbrainActivity(
  deps: PurgeGbrainActivityDeps,
): PurgeGbrainPort {
  return {
    async purge(
      revisionId: string,
      purgeKey: string,
    ): Promise<Result<void, PurgeGbrainError>> {
      // inv-3: the purge runs strictly AFTER the commit point. No revisionId ⇒ no
      // committed tombstone ⇒ fail closed (the client is not called). We fold this to
      // `purge_failed` so the driver compensates rather than treating the missing
      // commit as a clean purge.
      if (revisionId.trim().length === 0) {
        return err({
          code: "purge_failed",
          message: "gbrain purge requires a committed tombstone revisionId (runs only AFTER the commit point)",
        });
      }
      const result = await deps.client.purge(revisionId, purgeKey);
      if (!result.ok) {
        // A purge failure is surfaced typed — it NEVER rolls the tombstone back.
        return err(result.error);
      }
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// (3) TombstoneEventStorePort activity — inv-3 step 3 (history PRESERVED)
// ---------------------------------------------------------------------------

/** The idempotent event-tombstone outcome (a fresh append vs. an already-present no-op). */
export interface EventTombstoneAck {
  readonly kind: "appended" | "already_tombstoned";
  readonly subjectRef: string;
}

/**
 * The injected event-store tombstone client (the @sow/db append-only event-log
 * tombstone-append at the worker-wiring seam). It APPENDS a NEW tombstone record —
 * NEVER hard-deletes prior events (history preserved). APPEND-ONCE by
 * eventTombstoneKey: a re-drive that finds the tombstone present returns
 * `already_tombstoned` — never a second tombstone. Returns a typed Result, never throws.
 */
export interface EventTombstoneClient {
  appendTombstone(
    subjectRef: string,
    eventTombstoneKey: string,
  ): Promise<Result<EventTombstoneAck, EventTombstoneError>>;
}

/** Injected deps for the event-tombstone activity: the event-store tombstone client. */
export interface TombstoneEventStoreActivityDeps {
  readonly client: EventTombstoneClient;
}

/**
 * Build a {@link TombstoneEventStorePort} over the injected client (inv-3 step 3 /
 * inv-4). It appends a NEW tombstone record (history preserved, NOT a hard-delete),
 * append-once by eventTombstoneKey, and NEVER rolls the Markdown tombstone back. Never
 * throws.
 */
export function createTombstoneEventStoreActivity(
  deps: TombstoneEventStoreActivityDeps,
): TombstoneEventStorePort {
  return {
    async tombstone(
      subjectRef: string,
      eventTombstoneKey: string,
    ): Promise<Result<void, EventTombstoneError>> {
      const result = await deps.client.appendTombstone(subjectRef, eventTombstoneKey);
      if (!result.ok) {
        return err(result.error);
      }
      // A fresh append AND an already-tombstoned no-op are both success — history is
      // preserved either way (inv-4: append-once).
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// (4) ReconcileRefsPort activity — inv-3 step 4 / inv-5 (dangling refs surfaced)
// ---------------------------------------------------------------------------

/**
 * The injected read-model + external-ref reconciler (the @sow/db read-model rebuild +
 * the connector/external-ref reconciler at the worker-wiring seam). IDEMPOTENT by
 * reconcileKey. It RETURNS any dangling external refs it could not reconcile — it does
 * NOT swallow them (inv-5: a dangling ref is reconciled-or-surfaced, never silent).
 * Returns a typed Result, never throws.
 */
export interface RefReconciler {
  reconcile(
    subjectRef: string,
    reconcileKey: string,
  ): Promise<Result<ReconcileOutcome, ReconcileError>>;
}

/** Injected deps for the reconcile activity: the ref reconciler. */
export interface ReconcileRefsActivityDeps {
  readonly reconciler: RefReconciler;
}

/**
 * Build a {@link ReconcileRefsPort} over the injected reconciler (inv-3 step 4 /
 * inv-5). It rebuilds the affected read-model rows and reconciles external refs,
 * idempotent by reconcileKey, and PASSES THROUGH the reconciler's dangling-ref list so
 * the driver surfaces it (never left silently). A hard reconcile failure is a typed
 * err the driver compensates on — it NEVER rolls the tombstone back. Never throws.
 */
export function createReconcileRefsActivity(
  deps: ReconcileRefsActivityDeps,
): ReconcileRefsPort {
  return {
    async reconcile(
      subjectRef: string,
      reconcileKey: string,
    ): Promise<Result<ReconcileOutcome, ReconcileError>> {
      const result = await deps.reconciler.reconcile(subjectRef, reconcileKey);
      if (!result.ok) {
        return err(result.error);
      }
      // Pass the dangling-ref list straight through — the driver folds a non-empty set
      // to `compensating` and surfaces it (inv-5). Never swallowed here.
      return ok(result.value);
    },
  };
}
