// GBrain sync outbox — the durable, OPERATIONAL-TRUTH queue of post-commit GBrain
// re-index jobs (§6, task 4.4). GBrain is a DERIVED store (Markdown is the only
// canonical semantic truth, REQ-D-001), but the SYNC OUTBOX is operational truth:
// a lost sync entry would silently drop a re-index and let the derived brain fall
// permanently behind the committed Markdown, so it is persisted and NOT
// rebuildable. Entries are enqueued AFTER a successful Markdown commit, drained on
// wake (LIFE-6 ordering — task 4.6), and the index apply (task 4.8) re-derives
// index content from the committed Markdown by revision id.
//
// IDENTITY / IDEMPOTENCY: an entry is keyed by (workspaceId, revisionId). Two
// triggers for the same committed revision collapse to ONE effective index job
// (task 4.4 bullet 2) — the key is the collapse identity.
//
// arch_gap (flagged for §4 / Phase-4 wiring, mirrors `revision.ts`): the frozen
// `@sow/db` interface set has an EXTERNAL-WRITE outbox (`OutboxRepository` /
// `OutboxEntry` — targetSystem + canonicalObjectKey + WriteReceipt, the §8/§9
// exactly-once external-side-effect envelope) but NO gbrain-sync outbox. A GBrain
// re-index is an INTERNAL derived-store refresh, not an external write, and has no
// write receipt — reusing the external-write envelope would conflate safety rule 3
// with an internal refresh. So the store PORT is defined in-package here; it speaks
// the `@sow/db` error convention (`DbResult` / `DbError`) so a concrete driver can
// back it later. The concrete driver + the both-dialect contract suite are out of
// scope; tests inject an in-memory fake.
import type { DbResult } from "@sow/db";
import type { RevisionId } from "./revision";

/**
 * The sync-job status an outbox entry rides — a SUBSET of the Knowledge Mutation
 * lifecycle (DOMAIN_MODEL.md) that is meaningful once Markdown is committed:
 * `gbrain_sync_queued` (enqueued, awaiting index), `sync_lagging` (a dispatch
 * failed; retryable), `indexed` (terminal — re-index applied, task 4.8).
 */
export const GBRAIN_SYNC_STATUSES = [
  "gbrain_sync_queued",
  "sync_lagging",
  "indexed",
] as const;
export type GbrainSyncStatus = (typeof GBRAIN_SYNC_STATUSES)[number];

/**
 * One durable GBrain re-index job. OPERATIONAL TRUTH: append-on-enqueue, status
 * advances toward `indexed`; carries SUMMARY refs only (audit ref, source event
 * ref) — never raw content (§16). `revisionId` names the committed Markdown the
 * index must re-derive from (Markdown is the source; the brain is derived).
 */
export interface GbrainSyncOutboxEntry {
  /** Deterministic (workspaceId, revisionId) key — the idempotency/collapse id. */
  readonly outboxId: string;
  readonly workspaceId: string;
  readonly revisionId: RevisionId;
  readonly planId: string;
  readonly status: GbrainSyncStatus;
  /** Dispatch attempts made so far (0 at enqueue; incremented on each failure). */
  readonly attempts: number;
  /** AuditId of the commit that produced this revision (summary linkage, §16). */
  readonly auditRef: string;
  readonly sourceEventRef?: string;
  readonly enqueuedAt: string;
  readonly lastAttemptAt?: string;
  /** Last dispatch error message (summary only — no raw content / secrets). */
  readonly lastError?: string;
}

/**
 * Operational-truth store of GBrain sync jobs (task 4.4). Defined in-package (see
 * the module `arch_gap` note). Every method returns a typed `@sow/db` `DbResult`
 * and NEVER throws across the boundary (§16); the concrete driver is out of scope.
 */
export interface GbrainSyncOutboxStore {
  /**
   * Idempotency / collapse lookup: the entry for (workspaceId, revisionId), else
   * `undefined`. A present entry means a prior trigger already queued this
   * revision — the caller collapses to one effective index (task 4.4 bullet 2).
   */
  getByKey(
    workspaceId: string,
    revisionId: RevisionId,
  ): DbResult<GbrainSyncOutboxEntry | undefined>;
  /** Persist a freshly built entry (append-on-enqueue). */
  enqueue(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry>;
  /** Advance status / attempts / backoff bookkeeping (no hard delete). */
  update(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry>;
  /**
   * Not-yet-`indexed` entries to drain on wake (LIFE-6; the drainer lives in
   * task 4.6 — pending KW writes apply BEFORE these jobs are drained).
   */
  listDue(now: string, limit: number): DbResult<GbrainSyncOutboxEntry[]>;
  /** The highest-`enqueuedAt` entry that has reached the `indexed` terminal for this
   *  workspace (the applied high-water mark), or undefined if none. Used to no-op an
   *  out-of-order OLDER re-index that would otherwise regress the served index. */
  indexedHighWater(workspaceId: string): DbResult<GbrainSyncOutboxEntry | undefined>;
}

/**
 * The deterministic (workspaceId, revisionId) outbox key — the collapse identity.
 * PURE: a total function of its two inputs, no clock/random/I/O.
 */
export function gbrainSyncOutboxKey(
  workspaceId: string,
  revisionId: RevisionId,
): string {
  return `gbrain-sync:${workspaceId}:${revisionId}`;
}

/** Inputs to build a fresh (pre-enqueue) sync outbox entry. */
export interface SyncOutboxEntryInput {
  readonly workspaceId: string;
  readonly revisionId: RevisionId;
  readonly planId: string;
  readonly auditRef: string;
  readonly sourceEventRef?: string;
  readonly enqueuedAt: string;
}

/**
 * Build a fresh sync outbox entry (status `gbrain_sync_queued`, `attempts` 0).
 * PURE: no clock (`enqueuedAt` is injected) / random / I/O — deterministic for a
 * given input, so an enqueue is replayable.
 */
export function buildSyncOutboxEntry(
  input: SyncOutboxEntryInput,
): GbrainSyncOutboxEntry {
  const base: GbrainSyncOutboxEntry = {
    outboxId: gbrainSyncOutboxKey(input.workspaceId, input.revisionId),
    workspaceId: input.workspaceId,
    revisionId: input.revisionId,
    planId: input.planId,
    status: "gbrain_sync_queued",
    attempts: 0,
    auditRef: input.auditRef,
    enqueuedAt: input.enqueuedAt,
  };
  return input.sourceEventRef !== undefined
    ? { ...base, sourceEventRef: input.sourceEventRef }
    : base;
}
