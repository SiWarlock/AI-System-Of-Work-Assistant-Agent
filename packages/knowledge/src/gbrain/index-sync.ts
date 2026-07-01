// GBrain index/sync apply (§6, task 4.8). Consumes a post-commit index job — a
// durable 4.4 sync-outbox entry keyed by (workspaceId, revisionId) — and refreshes
// the DERIVED GBrain index from the CURRENT committed Markdown identified by that
// revision id. GBrain is a derived, disposable store; Markdown is the only
// canonical semantic truth (REQ-D-001, safety rule 1). This module therefore:
//
//   1. re-derives index content from committed Markdown BY REVISION ID — never
//      from a byte source carried in the job. The job names a revision; we load the
//      committed Markdown at that revision (injected `CanonicalMarkdownSource`) and
//      run the gbrain-INDEPENDENT `deriveCanonicalFacts` parser (task 4.14). A
//      guard re-hashes the loaded snapshot and refuses to index anything that does
//      not hash to the job's revision id — no stale-revision indexing (LIFE-6).
//   2. applies the derived fact set through an injected write-side `IndexApplyClient`
//      (the sole-issuer worker path to the single-owner gbrain, DISTINCT from the
//      read-only runtime adapter of task 4.7). The apply is idempotent per
//      (workspaceId, revisionId): re-running the same job yields an identical index
//      state with NO duplicate nodes (facts key by content-independent
//      `factIdentity`), advancing gbrain_sync_queued → indexed.
//   3. on any load/derive/apply failure, degrades to a distinct `sync_lagging`
//      System Health item (§16) and leaves the outbox entry retryable — the
//      Markdown commit is durable and independent of index success (task 4.4). The
//      apply NEVER writes back into Markdown (there is structurally no Markdown-write
//      seam here) and never becomes a source of truth (any DB-only fact is a parity
//      defect handled by task 4.9).
//
// NEVER THROWS across the boundary (§16): every outcome is a typed value, including
// the case where the injected index client itself throws (caught → sync_lagging).
import { ok, err, HealthItemSchema } from "@sow/contracts";
import type { HealthItem, Result } from "@sow/contracts";
import { knowledgeMutationMachine } from "@sow/domain";
import { computeRevisionId } from "../knowledge-writer/revision";
import type { GbrainSyncOutboxEntry, GbrainSyncOutboxStore } from "../knowledge-writer/sync-outbox";
import type { GbrainSyncDispatchError, GbrainIndexDispatcher } from "../knowledge-writer/gbrain-sync-trigger";
import { deriveCanonicalFacts } from "./derive/canonical-fact-deriver";
import type { CanonicalVaultSnapshot, DerivedFact } from "./derive/canonical-fact-deriver";

// ── injected: committed-Markdown source (read-only; the index is derived) ─────

/** Enumerable failures of loading committed Markdown at a revision. */
export type SnapshotLoadError =
  | { readonly code: "revision_unavailable"; readonly revisionId: string; readonly message: string }
  | { readonly code: "source_fault"; readonly message: string; readonly cause?: unknown };

/**
 * Loads the COMMITTED Markdown snapshot identified by a revision id. Deliberately
 * READ-ONLY — there is no write method, because the index is derived and Markdown
 * is never written back through this path (safety rule 1). The concrete adapter
 * (reconstruct-from-revision-store / working-tree read) is out of scope; tests
 * inject a fake. Never throws — returns a typed `Result`.
 */
export interface CanonicalMarkdownSource {
  loadSnapshot(
    workspaceId: string,
    revisionId: string,
  ): Promise<Result<CanonicalVaultSnapshot, SnapshotLoadError>>;
}

// ── injected: derived-index write client (sole-issuer worker path) ────────────

/** The full derived fact set to (re)apply for one committed revision. */
export interface IndexApplyRequest {
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly facts: readonly DerivedFact[];
}

/** Proof of an applied revision. `mutated=false` marks an idempotent no-op. */
export interface IndexApplyReceipt {
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly nodeCount: number;
  /** True IFF this call changed the derived index; false = idempotent no-op. */
  readonly mutated: boolean;
}

/** Enumerable failures of the derived-index apply. */
export type IndexApplyError =
  | { readonly code: "gbrain_unavailable"; readonly message: string; readonly cause?: unknown }
  | { readonly code: "apply_failed"; readonly message: string; readonly cause?: unknown };

/**
 * Write-side seam to the single-owner gbrain's DERIVED index (§13). This is NOT
 * the read-only runtime adapter (task 4.7): re-indexing legitimately writes gbrain's
 * disposable derived store from committed Markdown — the sanctioned derivation path,
 * never a hidden-brain Markdown write. The apply MUST be idempotent per
 * (workspaceId, revisionId), keyed within by `factIdentity`, so a replay produces no
 * duplicate nodes. Never throws — the caller also defends against it throwing.
 */
export interface IndexApplyClient {
  applyRevision(request: IndexApplyRequest): Promise<Result<IndexApplyReceipt, IndexApplyError>>;
}

// ── deps / outcome ────────────────────────────────────────────────────────────

export interface GbrainIndexSyncDeps {
  readonly snapshotSource: CanonicalMarkdownSource;
  readonly indexClient: IndexApplyClient;
  readonly outbox: GbrainSyncOutboxStore;
  /** Injected clock (ISO-8601) — keeps the apply deterministic under test. */
  readonly now: () => string;
  /** Injected System Health id minter (no ambient random). */
  readonly newHealthItemId: () => string;
}

/**
 * - `indexed` — re-derived from committed Markdown and applied; entry advanced to
 *   `indexed` (gbrain_sync_queued|sync_lagging → indexed).
 * - `already_indexed` — the entry is the frozen `indexed` terminal; no re-work.
 * - `lagging` — a load/derive/apply failure; durable retry + distinct health item.
 */
export type GbrainIndexOutcomeKind = "indexed" | "already_indexed" | "lagging";

export interface GbrainIndexOutcome {
  readonly kind: GbrainIndexOutcomeKind;
  readonly entry: GbrainSyncOutboxEntry;
  /** The advanced Knowledge Mutation state this outcome reflects. */
  readonly mutationState: "indexed" | "sync_lagging";
  /** Present IFF `kind === "indexed"`: proof of the applied revision. */
  readonly receipt?: IndexApplyReceipt;
  /** Present IFF `kind === "lagging"`: the distinct sync_lagging item (§16). */
  readonly healthItem?: HealthItem;
}

// ── load-time invariant: the edges this apply advances must exist ─────────────

const INDEXED_STATE = "indexed" as const;
const QUEUED_STATE = "gbrain_sync_queued" as const;
const LAGGING_STATE = "sync_lagging" as const;

// Trips only if the DOMAIN_MODEL machine loses the terminal-index edges the apply
// depends on (queued → indexed catch-up, lagging → indexed catch-up).
if (
  !knowledgeMutationMachine.canTransition(QUEUED_STATE, INDEXED_STATE) ||
  !knowledgeMutationMachine.canTransition(LAGGING_STATE, INDEXED_STATE)
) {
  throw new Error(
    "invariant: Knowledge Mutation machine is missing the gbrain_sync_queued → " +
      "indexed / sync_lagging → indexed edges the GBrain index apply depends on",
  );
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Apply one post-commit GBrain index job. See the module header for the
 * derived-from-Markdown / idempotent / never-rolls-back contract. Total function:
 * returns a typed outcome (`indexed` | `already_indexed` | `lagging`) and NEVER
 * throws. A failure is always a retryable `lagging` outcome — the correct behavior,
 * since the durable outbox entry + drain-on-wake (task 4.6) retry it.
 */
export async function applyGbrainIndexJob(
  entry: GbrainSyncOutboxEntry,
  deps: GbrainIndexSyncDeps,
): Promise<GbrainIndexOutcome> {
  // 1 — frozen terminal: an already-indexed entry is done. No re-derive/re-apply.
  if (entry.status === INDEXED_STATE) {
    return { kind: "already_indexed", entry, mutationState: INDEXED_STATE };
  }

  // 2 — load the CURRENT committed Markdown identified by the job's revision id.
  const loaded = await loadSnapshot(deps, entry);
  if (!loaded.ok) {
    return lagging(entry, deps, loaded.error.message);
  }
  const snapshot = loaded.value;

  // 3 — no stale-revision indexing (LIFE-6) / never a byte source: the loaded
  //     snapshot must hash to exactly the revision the job names.
  const loadedRevision = computeRevisionId(snapshot.files);
  if (loadedRevision !== (entry.revisionId as string)) {
    return lagging(
      entry,
      deps,
      `loaded snapshot hashes to ${loadedRevision}, expected revision ${entry.revisionId}`,
    );
  }

  // 4 — re-derive the index content from committed Markdown (gbrain-independent).
  const derived = deriveCanonicalFacts(snapshot);
  if (!derived.ok) {
    return lagging(entry, deps, `derive failed: ${derived.error.code}`);
  }

  // 5 — apply the derived fact set (idempotent per (workspaceId, revisionId)).
  const applied = await runApply(deps.indexClient, {
    workspaceId: entry.workspaceId,
    revisionId: entry.revisionId as string,
    facts: derived.value.facts,
  });
  if (!applied.ok) {
    return lagging(entry, deps, applied.error.message);
  }

  // 6 — advance the durable entry to the frozen `indexed` terminal. If the status
  //     write itself fails, the derived index IS applied but not durably marked;
  //     drain-on-wake re-runs (the apply is idempotent), so we stay lagging/retryable
  //     rather than falsely claim indexed.
  const indexedEntry: GbrainSyncOutboxEntry = {
    ...entry,
    status: INDEXED_STATE,
    attempts: entry.attempts,
    lastAttemptAt: deps.now(),
  };
  const persisted = await deps.outbox.update(indexedEntry);
  if (!persisted.ok) {
    return lagging(entry, deps, `index applied but status persist failed: ${persisted.error.message}`);
  }

  return {
    kind: "indexed",
    entry: indexedEntry,
    mutationState: INDEXED_STATE,
    receipt: applied.value,
  };
}

/**
 * Adapt the index apply into the task-4.4 `GbrainIndexDispatcher` seam so the
 * post-commit trigger can kick this apply synchronously-async. Maps an `indexed` /
 * `already_indexed` outcome to `ok(void)` and a `lagging` outcome to a typed
 * `GbrainSyncDispatchError` (the trigger then records its own sync_lagging item).
 */
export function toIndexDispatcher(deps: GbrainIndexSyncDeps): GbrainIndexDispatcher {
  return async (entry: GbrainSyncOutboxEntry): Promise<Result<void, GbrainSyncDispatchError>> => {
    const outcome = await applyGbrainIndexJob(entry, deps);
    if (outcome.kind === "lagging") {
      return err({
        code: "gbrain_unavailable",
        message: outcome.healthItem?.message ?? "GBrain index apply lagging",
      });
    }
    return ok(undefined);
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Await the injected loader, converting a THROWN error into a typed err. */
async function loadSnapshot(
  deps: GbrainIndexSyncDeps,
  entry: GbrainSyncOutboxEntry,
): Promise<Result<CanonicalVaultSnapshot, SnapshotLoadError>> {
  try {
    return await deps.snapshotSource.loadSnapshot(entry.workspaceId, entry.revisionId as string);
  } catch (cause) {
    return err({
      code: "source_fault",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

/** Await the injected index client, converting a THROWN error into a typed err. */
async function runApply(
  client: IndexApplyClient,
  request: IndexApplyRequest,
): Promise<Result<IndexApplyReceipt, IndexApplyError>> {
  try {
    return await client.applyRevision(request);
  } catch (cause) {
    return err({
      code: "apply_failed",
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }
}

/**
 * Build the retryable `lagging` outcome: advance the entry to `sync_lagging`
 * (attempts++), persist the advance best-effort (a failed persist is swallowed —
 * the entry is still durably enqueued for drain-on-wake), and attach the distinct
 * `sync_lagging` System Health item (§16).
 */
async function lagging(
  entry: GbrainSyncOutboxEntry,
  deps: GbrainIndexSyncDeps,
  reason: string,
): Promise<GbrainIndexOutcome> {
  const laggingEntry: GbrainSyncOutboxEntry = {
    ...entry,
    status: LAGGING_STATE,
    attempts: entry.attempts + 1,
    lastAttemptAt: deps.now(),
    lastError: reason,
  };
  // Best-effort: if this update faults, the entry is still durably present in its
  // prior state, so drain-on-wake retries it — swallow and stay lagging.
  await deps.outbox.update(laggingEntry);
  return {
    kind: "lagging",
    entry: laggingEntry,
    mutationState: LAGGING_STATE,
    healthItem: buildSyncLaggingHealthItem(entry, deps, reason),
  };
}

/**
 * Build the distinct `sync_lagging` System Health item (§16), validated through the
 * frozen `HealthItemSchema` so a malformed record can never surface. On the
 * (unreachable) parse-fail path we still return a minimal, type-correct item — the
 * apply must never throw and must always surface the lag.
 */
function buildSyncLaggingHealthItem(
  entry: GbrainSyncOutboxEntry,
  deps: GbrainIndexSyncDeps,
  reason: string,
): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: "sync_lagging" as const,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: "warn",
    message:
      `GBrain index apply lagging for workspace ${entry.workspaceId} at revision ` +
      `${entry.revisionId}: ${reason}. Markdown commit is durable; retry via the ` +
      `sync outbox.`,
    auditRef: entry.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}
