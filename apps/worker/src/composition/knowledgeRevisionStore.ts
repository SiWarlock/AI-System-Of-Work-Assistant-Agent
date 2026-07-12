// @sow/worker — the durable KnowledgeRevisionStore adapter (task 11.1, §6/§16).
//
// Bridges the REAL @sow/db `KnowledgeRevisionRepository` onto the pure @sow/knowledge
// `KnowledgeRevisionStore` port the KnowledgeWriter's `applyPlan` records committed revisions
// through (its idempotent-replay short-circuit reads `getByIdempotencyKey`). Mirror of the
// `store-adapters.ts` bridges (HealthItem / Schedule / InstanceLease): @sow/db MUST NOT import
// @sow/knowledge (the §2.5 import direction is knowledge → db), so the port-shaped adapter lives
// HERE at the composition root, where both packages are visible.
//
// This is the DURABLE replacement for the in-memory `Map` stub (`buildAutoIngestProofSpineParams`
// `inertRevisions` in boot.ts): a Map loses the record across a worker restart — re-opening a
// duplicate KnowledgeWriter commit — while this persists to the migrated operational store. The
// consumer swap (wiring boot to select this adapter over the inert Map) is slice 2b.
//
// FAIL-CLOSED CONTRACT (§16 + the exactly-once substrate). The port returns bare Promises (not
// Result), so a genuine @sow/db `DbError` fault (unavailable / conflict / serialization_failure /
// unknown) is surfaced by REJECTING the promise — NEVER by returning a plausible-but-wrong answer.
//   • `getByIdempotencyKey` — a benign `not_found` MISS folds to the port's absence sentinel
//     (`undefined`); EVERY other DbError REJECTS. This is the load-bearing fail-closed direction:
//     a swallowed fault answered `undefined` would read as "no prior commit" and let the writer
//     RE-COMMIT (a duplicate Markdown write) — the exactly-once store's worst failure.
//   • `record` — a real DbError REJECTS. A duplicate `idempotencyKey` is NOT a fault here: the
//     repo's `record` is first-write-wins (idempotent no-op → `ok`), so only a genuine store
//     fault reaches this branch (a silently dropped record would re-open a duplicate commit).
import { isErr } from "@sow/contracts";
import type { CommittedRevisionRow, DbError, KnowledgeRevisionRepository } from "@sow/db";
import type { CommittedRevision, KnowledgeRevisionStore } from "@sow/knowledge";

/** True for the ONE benign code a lookup may legitimately return: a MISS (no prior commit). */
function isMiss(error: DbError): boolean {
  return error.code === "not_found";
}

/**
 * Surface a genuine @sow/db fault as a rejected promise (the port has no typed error channel).
 * The message keeps the enumerable `DbError.code` so a caller's redacted log line carries the
 * fault class; the opaque driver `cause` is NOT attached (it may carry raw content — safety
 * rule 7). Never called for a `not_found` miss.
 */
function faultRejection(op: string, error: DbError): Error {
  return new Error(`operational-store ${op} failed (${error.code}): ${error.message}`);
}

/**
 * The @sow/db {@link CommittedRevisionRow} and the @sow/knowledge {@link CommittedRevision} port
 * DTO are structurally identical. Copy field-for-field (rather than cast) so a future field
 * divergence on EITHER side is a compile error HERE, not a silent mismatch — the same discipline
 * as `store-adapters.ts` `rowToLease` / `leaseToRow`.
 */
function rowToRevision(r: CommittedRevisionRow): CommittedRevision {
  return {
    revisionId: r.revisionId,
    baseRevisionId: r.baseRevisionId,
    idempotencyKey: r.idempotencyKey,
    planId: r.planId,
    actor: r.actor,
    sourceEventRef: r.sourceEventRef,
    workflowRunRef: r.workflowRunRef,
    auditRecord: r.auditRecord,
    committedAt: r.committedAt,
  };
}

function revisionToRow(rev: CommittedRevision): CommittedRevisionRow {
  return {
    revisionId: rev.revisionId,
    baseRevisionId: rev.baseRevisionId,
    idempotencyKey: rev.idempotencyKey,
    planId: rev.planId,
    actor: rev.actor,
    sourceEventRef: rev.sourceEventRef,
    workflowRunRef: rev.workflowRunRef,
    auditRecord: rev.auditRecord,
    committedAt: rev.committedAt,
  };
}

/**
 * Adapt the @sow/db {@link KnowledgeRevisionRepository} onto the @sow/knowledge
 * {@link KnowledgeRevisionStore} port the KnowledgeWriter records committed revisions in. The
 * writer's idempotent-replay short-circuit + commit-record now PERSIST to the migrated operational
 * store (durable across a worker restart) instead of process memory.
 *
 *   • `getByIdempotencyKey` — `not_found` → `undefined` (an unseen key is a miss, not a fault);
 *     any other DbError REJECTS (fail-closed — see the module header); `ok` unwraps the revision.
 *   • `record` — a real DbError REJECTS; a duplicate key is an idempotent no-op inside the repo.
 */
export function createKnowledgeRevisionStoreAdapter(
  repo: KnowledgeRevisionRepository,
): KnowledgeRevisionStore {
  return {
    async getByIdempotencyKey(idempotencyKey: string): Promise<CommittedRevision | undefined> {
      const r = await repo.getByIdempotencyKey(idempotencyKey);
      if (isErr(r)) {
        if (isMiss(r.error)) return undefined;
        throw faultRejection("knowledgeRevision.getByIdempotencyKey", r.error);
      }
      return rowToRevision(r.value);
    },
    async record(revision: CommittedRevision): Promise<void> {
      const r = await repo.record(revisionToRow(revision));
      if (isErr(r)) throw faultRejection("knowledgeRevision.record", r.error);
    },
  };
}
