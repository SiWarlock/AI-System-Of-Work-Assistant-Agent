// Task 19.4 (reconcile-TRIGGER arc) — the trigger SOURCE over the existing burst-collapsing scheduler
// (piece E, ./reconcileScheduler.ts). `gateReconcile` (boot.ts:1097) is already invoked at boot.ts:2379,
// but `config.reconcile` is unset in the shipped default so no machinery is ever constructed — nothing
// here flips that. This module builds the MISSING piece: a `createReconcileTrigger(wiring)` a post-KW-
// commit hook or a vault-watcher tick can call on every event, that ENQUEUEs + drives an eventual FLUSH.
//
// BURST-COLLAPSE requires more than "enqueue then flush on every call": if `notify()` awaited
// `scheduler.flush()` directly on each call, a SYNCHRONOUS burst of notify() calls would each drain the
// (by-then near-empty) queue before the PREVIOUS flush's dispatch resolves — fragmenting one burst into N
// separate reconciles instead of collapsing it to one (the scheduler's own snapshot-and-delete-before-await
// only pays off if the trigger doesn't itself fragment the burst). Instead `notify()` enqueues
// SYNCHRONOUSLY (so every event in a tight synchronous burst lands in the SAME queue) and defers the
// actual `scheduler.flush()` call to a microtask — the FIRST notify() in a burst schedules that microtask;
// every subsequent notify() in the SAME burst sees one already scheduled and just enqueues, relying on the
// scheduled flush to pick up everything queued by the time it runs. `collapseToMaxRevision` (inside
// `scheduler.flush`) then picks the single newest trigger — exactly one `runReconcile` call per burst.
//
// DORMANT + reachability-waivered (mirrors reconcileScheduler.ts): no production caller — boot wires the
// real hook call sites (post-KW-commit / vault-watcher) behind `config.reconcile`, which stays unset.
import type { PendingTrigger, ReconcileTriggerOrigin, ReconcilerDbProjection } from "@sow/knowledge";
import type { GbrainReadAdapter } from "@sow/knowledge";
import { buildReconcilerDbProjection } from "./reconcilerDbProjection";
import type { ReconcileScheduler } from "./reconcileScheduler";

export interface ReconcileTriggerWiring {
  readonly scheduler: ReconcileScheduler;
}

export interface ReconcileTrigger {
  /**
   * Fire one trigger event for `workspaceId` (a post-commit or vault-watcher event). Enqueues immediately
   * (synchronous — participates in the SAME burst as any other `notify()` call in this microtask turn) and
   * returns a promise that resolves once the (possibly-shared, coalesced) flush for this burst completes.
   */
  readonly notify: (
    workspaceId: string,
    origin: ReconcileTriggerOrigin,
    revisionId: string,
  ) => Promise<void>;
}

export function createReconcileTrigger(wiring: ReconcileTriggerWiring): ReconcileTrigger {
  const seqByWorkspace = new Map<string, number>();
  const scheduledFlush = new Map<string, Promise<void>>();

  function nextSeq(workspaceId: string): number {
    const n = (seqByWorkspace.get(workspaceId) ?? 0) + 1;
    seqByWorkspace.set(workspaceId, n);
    return n;
  }

  return {
    notify(workspaceId: string, origin: ReconcileTriggerOrigin, revisionId: string): Promise<void> {
      const trigger: PendingTrigger = { origin, revisionId, seq: nextSeq(workspaceId) };
      wiring.scheduler.enqueue(workspaceId, trigger);

      const existing = scheduledFlush.get(workspaceId);
      if (existing !== undefined) return existing; // already coalescing this burst — ride the same flush

      const scheduled = Promise.resolve().then(() => {
        scheduledFlush.delete(workspaceId);
        return wiring.scheduler.flush(workspaceId);
      });
      scheduledFlush.set(workspaceId, scheduled);
      return scheduled;
    },
  };
}

/**
 * Build a `getDbProjection` reader that degrades to the byte-equivalent shipped default (`complete: false`,
 * empty facts) when `makeDbAdapter()` returns `undefined` — the exact shape boot.ts:2386's currently-
 * hardcoded `makeDbAdapter: () => undefined` produces. When bound, delegates to
 * {@link buildReconcilerDbProjection} (piece B) over the real adapter. `makeDbAdapter` is a THUNK so no
 * transport is constructed unless a trigger actually fires (never at wiring time).
 */
export function buildDegradableDbProjectionReader(
  makeDbAdapter: () => GbrainReadAdapter | undefined,
): (workspaceId: string) => Promise<ReconcilerDbProjection> {
  return async (workspaceId: string): Promise<ReconcilerDbProjection> => {
    const adapter = makeDbAdapter();
    if (adapter === undefined) {
      return { workspaceId, gbrainSchemaVersion: 0, facts: [], complete: false };
    }
    return buildReconcilerDbProjection(adapter);
  };
}
