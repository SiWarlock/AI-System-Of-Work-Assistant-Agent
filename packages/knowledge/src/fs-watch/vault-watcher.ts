// Per-vault file watcher (§6, task 4.6). Detects external working-tree changes
// (Obsidian Sync / iCloud / git pull — a SUPPORTED V1 config) and hands a settled,
// DEBOUNCED batch to the reconciler (`reconcile.ts`). Two responsibilities:
//
//   1. Debounce (bullet 6). A single logical external sync writes many files in a
//      rapid burst; a naive per-file recompute would churn the revision id N times.
//      `coalesceBurst` (pure) + `createVaultWatcher` (trailing-edge debounce) resolve
//      one burst to ONE recompute/reconcile.
//   2. Wake/restart ordering (LIFE-6, bullet 5). On wake, pending KnowledgeWriter
//      writes are applied BEFORE queued GBrain index jobs are drained, and the drain
//      re-derives current Markdown by revision id — so a queued index job can never
//      run against a stale revision. `runWakeReconcile` enforces this order and fails
//      CLOSED: if the pending-write apply fails, the index drain is not reached.
//
// The fs/timer surfaces are injected ports (a `WatchTimer`, a `clock`), so the
// debounce is driven deterministically in tests with a manual timer double — no real
// timers, no real filesystem. Nothing throws across the boundary (§16): the wake path
// returns a typed `Result`; the debouncer is fire-and-forget over an injected callback.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { RevisionId } from "../knowledge-writer/revision";

// ── fs-event model + pure debounce coalescing ───────────────────────────────

export type FsEventKind = "add" | "change" | "unlink";

export interface FsEvent {
  readonly path: string;
  readonly kind: FsEventKind;
  /** Monotonic event timestamp (ms). Injected by the watcher's clock. */
  readonly at: number;
}

export interface FsEventBatch {
  readonly events: readonly FsEvent[];
  /** Unique vault-relative paths in the batch (one recompute covers them all). */
  readonly paths: readonly string[];
  readonly startedAt: number;
  readonly settledAt: number;
}

const uniquePaths = (events: readonly FsEvent[]): string[] => [
  ...new Set(events.map((e) => e.path)),
];

function toBatch(events: readonly FsEvent[]): FsEventBatch {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return {
    events,
    paths: uniquePaths(events),
    startedAt: first.at,
    settledAt: last.at,
  };
}

/**
 * Coalesce a stream of fs-events into debounced batches: a new batch starts
 * whenever the gap from the previous event exceeds `windowMs` (rolling gap), so a
 * rapid multi-file sync (each write within the window of the last) collapses to ONE
 * batch, while a later unrelated edit opens a fresh one. PURE.
 */
export function coalesceBurst(events: readonly FsEvent[], windowMs: number): FsEventBatch[] {
  if (events.length === 0) {
    return [];
  }
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const batches: FsEventBatch[] = [];
  let group: FsEvent[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i]!;
    const prev = sorted[i - 1]!;
    if (ev.at - prev.at <= windowMs) {
      group.push(ev);
    } else {
      batches.push(toBatch(group));
      group = [ev];
    }
  }
  batches.push(toBatch(group));
  return batches;
}

// ── stateful trailing-edge debouncer ─────────────────────────────────────────

/**
 * Injected timer port so the debounce is deterministic under test (a manual timer
 * double captures the scheduled fn). `set` returns an opaque token `clear` cancels.
 */
export interface WatchTimer {
  set(fn: () => void, ms: number): number;
  clear(token: number): void;
}

export interface VaultWatcherDeps {
  readonly windowMs: number;
  readonly timer: WatchTimer;
  /** Monotonic clock (ms) stamping each notification. */
  readonly clock: () => number;
  /** Called ONCE per settled burst with the coalesced batch. */
  readonly onSettled: (batch: FsEventBatch) => void;
}

export interface VaultWatcher {
  /** Buffer an external change; (re)arms the trailing-edge debounce timer. */
  notify(event: { readonly path: string; readonly kind: FsEventKind }): void;
}

/**
 * A trailing-edge debouncer: each `notify` buffers the event and resets the window;
 * `onSettled` fires once `windowMs` elapses after the LAST notify, carrying the whole
 * buffered burst as a single coalesced batch. The buffer clears on fire, so the next
 * notify begins a fresh, independent batch.
 */
export function createVaultWatcher(deps: VaultWatcherDeps): VaultWatcher {
  let buffer: FsEvent[] = [];
  let token: number | null = null;

  const settle = (): void => {
    token = null;
    if (buffer.length === 0) {
      return;
    }
    const events = buffer;
    buffer = [];
    // A single burst coalesces to exactly one batch by construction; fall back to
    // the first batch defensively if the window somehow split the buffer.
    const [batch] = coalesceBurst(events, deps.windowMs);
    if (batch !== undefined) {
      deps.onSettled(batch);
    }
  };

  return {
    notify(event) {
      buffer.push({ path: event.path, kind: event.kind, at: deps.clock() });
      if (token !== null) {
        deps.timer.clear(token);
      }
      token = deps.timer.set(settle, deps.windowMs);
    },
  };
}

// ── LIFE-6 wake/restart ordering ─────────────────────────────────────────────

export interface PendingWriteReport {
  readonly appliedRevisionId: RevisionId;
  readonly appliedCount: number;
}

export interface IndexDrainReport {
  readonly drainedCount: number;
  readonly atRevisionId: RevisionId;
}

/** Typed wake fault (never thrown across the boundary, §16). */
export interface WakeFault {
  readonly code: "apply_failed" | "drain_failed" | "revision_unavailable";
  readonly message: string;
  readonly cause?: unknown;
}

export interface WakeReconcileDeps {
  /**
   * Apply any pending KnowledgeWriter writes. Runs FIRST on wake so the vault is at
   * its intended revision before anything indexes it.
   */
  readonly applyPendingWrites: () => Promise<Result<PendingWriteReport, WakeFault>>;
  /** The current on-disk revision id (read AFTER pending writes land). */
  readonly currentRevisionId: () => Promise<RevisionId>;
  /**
   * Drain queued GBrain index jobs, re-deriving from the CURRENT Markdown revision
   * (passed in) — never a stale revision.
   */
  readonly drainIndexJobs: (rev: RevisionId) => Promise<Result<IndexDrainReport, WakeFault>>;
}

export interface WakeOutcome {
  readonly pending: PendingWriteReport;
  readonly drainedAtRevisionId: RevisionId;
  readonly indexDrain: IndexDrainReport;
}

/**
 * Enforce the LIFE-6 wake ordering: pending KnowledgeWriter writes are applied
 * BEFORE queued GBrain index jobs are drained, and the drain re-derives current
 * Markdown by revision id (no stale-revision indexing). Fails CLOSED — a failed
 * pending-write apply short-circuits before the index drain is reached. NEVER throws.
 */
export async function runWakeReconcile(
  deps: WakeReconcileDeps,
): Promise<Result<WakeOutcome, WakeFault>> {
  // 1 — pending KW writes FIRST. If they don't land, do NOT index (fail closed).
  const applied = await deps.applyPendingWrites();
  if (!applied.ok) {
    return err(applied.error);
  }

  // 2 — read the current revision AFTER the writes have landed.
  const rev = await deps.currentRevisionId();

  // 3 — drain queued index jobs against the CURRENT revision only.
  const drained = await deps.drainIndexJobs(rev);
  if (!drained.ok) {
    return err(drained.error);
  }

  return ok({
    pending: applied.value,
    drainedAtRevisionId: rev,
    indexDrain: drained.value,
  });
}
