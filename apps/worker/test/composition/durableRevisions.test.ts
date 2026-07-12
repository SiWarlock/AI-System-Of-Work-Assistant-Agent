// Task 11.1 slice 2b — `withDurableRevisions`: the bootWorker rebind that swaps the
// ProofSpineParams' placeholder revisions store for the durable 2a KnowledgeRevisionStore.
// spec(§13) spec(§4) spec(§16)
//
// LOAD-BEARING (default-OFF preserved): on the OFF/absent-config path (`proofSpineParams`
// undefined) the durable store is NEVER constructed — the rebind returns undefined and no
// KnowledgeRevisionStore adapter is built (the slice-1 invariant: nothing persists unless the
// owner opted in). On the ON path it rebinds `revisions` to a durable store over the real
// operational-store repo, so the ingestion sourceCommit + the (dormant) propose dispatch both
// persist idempotency durably.
import { describe, it, expect } from "vitest";
import { ok, err, validAuditRecord, validWorkflowRunRef } from "@sow/contracts";
import type { CommittedRevisionRow, DbResult, KnowledgeRevisionRepository } from "@sow/db";
import type { CommittedRevision } from "@sow/knowledge";
import { withDurableRevisions } from "../../src/boot";
import type { ProofSpineParams } from "../../src/composition/buildActivities";

/** An in-memory KnowledgeRevisionRepository (typed DbResult) — the durable substrate under test. */
function memRepo(): KnowledgeRevisionRepository {
  const byKey = new Map<string, CommittedRevisionRow>();
  return {
    getByIdempotencyKey: (k): DbResult<CommittedRevisionRow> => {
      const row = byKey.get(k);
      return Promise.resolve(row ? ok(row) : err({ code: "not_found", message: "miss" }));
    },
    record: (rev): DbResult<void> => {
      if (!byKey.has(rev.idempotencyKey)) byKey.set(rev.idempotencyKey, rev); // first-write-wins
      return Promise.resolve(ok(undefined));
    },
  };
}

/** A repo whose every method THROWS — proves the OFF path never even touches it. */
const throwingRepo: KnowledgeRevisionRepository = {
  getByIdempotencyKey: () => {
    throw new Error("repo must not be touched on the OFF path");
  },
  record: () => {
    throw new Error("repo must not be touched on the OFF path");
  },
};

const placeholderStore = {
  getByIdempotencyKey: () => Promise.resolve(undefined),
  record: () => Promise.resolve(),
};
// A minimal ProofSpineParams — only `revisions` matters for this pure rebind (the rest is spread through).
const baseParams = { revisions: placeholderStore } as unknown as ProofSpineParams;

const REVISION: CommittedRevision = {
  revisionId: "rev:xyz",
  baseRevisionId: "rev:000",
  idempotencyKey: "kw:commit:plan-1",
  planId: "plan-1",
  actor: "worker:autoingest",
  sourceEventRef: "evt:autoingest",
  workflowRunRef: validWorkflowRunRef,
  auditRecord: validAuditRecord,
  committedAt: "2026-07-12T00:00:00.000Z",
};

describe("withDurableRevisions — default-OFF preserved (§13/§4/§16)", () => {
  it("OFF path: undefined params → undefined (the durable store is NEVER constructed / repo untouched)", () => {
    expect(withDurableRevisions(undefined, throwingRepo)).toBeUndefined();
  });

  it("ON path: rebinds `revisions` to a durable store over the repo (record → getByIdempotencyKey round-trips)", async () => {
    const out = withDurableRevisions(baseParams, memRepo());
    expect(out).toBeDefined();
    if (out === undefined) return;
    // The placeholder store was REPLACED (not the same object).
    expect(out.revisions).not.toBe(placeholderStore);
    // The rebound store persists through the repo: a record is visible to a subsequent lookup.
    await out.revisions.record(REVISION);
    const got = await out.revisions.getByIdempotencyKey("kw:commit:plan-1");
    expect(got).toEqual(REVISION);
  });

  it("ON path: an unseen key returns undefined via the durable store's not_found fold", async () => {
    const out = withDurableRevisions(baseParams, memRepo());
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(await out.revisions.getByIdempotencyKey("kw:commit:never")).toBeUndefined();
  });
});
