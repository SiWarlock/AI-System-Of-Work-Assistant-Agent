// Task 11.1 — createKnowledgeRevisionStoreAdapter: the @sow/db KnowledgeRevisionRepository →
// @sow/knowledge KnowledgeRevisionStore bridge at the composition root (§6/§16).
//
// Proves the port MAPPING + the FAIL-CLOSED contract with a recording/injectable fake repo (the
// durability of the substrate itself is proven by the @sow/db durability + contract suites; this
// isolates the bridge logic). The load-bearing fail-closed direction: a real store fault on the
// idempotency LOOKUP must REJECT — never resolve `undefined` (which the writer would read as "no
// prior commit" and RE-COMMIT, a duplicate Markdown write).
import { describe, it, expect } from "vitest";
import { ok, err, validAuditRecord, validWorkflowRunRef, type Result } from "@sow/contracts";
import type { CommittedRevisionRow, DbError, DbResult, KnowledgeRevisionRepository } from "@sow/db";
import type { CommittedRevision } from "@sow/knowledge";
import { createKnowledgeRevisionStoreAdapter } from "../../src/composition/knowledgeRevisionStore";

const ROW: CommittedRevisionRow = {
  revisionId: "rev:abc",
  baseRevisionId: "rev:000",
  idempotencyKey: "idem-1",
  planId: "plan-1",
  actor: "KnowledgeWriter",
  sourceEventRef: "evt-1",
  workflowRunRef: validWorkflowRunRef,
  auditRecord: validAuditRecord,
  committedAt: "2026-07-12T00:00:00.000Z",
};
const REVISION: CommittedRevision = { ...ROW };

/**
 * A fake repo whose two methods return caller-supplied `DbResult`s and record every `record`
 * argument — so a test can inject a fault, a miss, or a hit, and assert the bridge's behavior.
 */
function fakeRepo(over: {
  get?: Result<CommittedRevisionRow, DbError>;
  record?: Result<void, DbError>;
}): { repo: KnowledgeRevisionRepository; recorded: CommittedRevisionRow[] } {
  const recorded: CommittedRevisionRow[] = [];
  const miss: DbError = { code: "not_found", message: "miss" };
  const repo: KnowledgeRevisionRepository = {
    getByIdempotencyKey: (): DbResult<CommittedRevisionRow> =>
      Promise.resolve(over.get ?? err(miss)),
    record: (revision): DbResult<void> => {
      recorded.push(revision);
      return Promise.resolve(over.record ?? ok(undefined));
    },
  };
  return { repo, recorded };
}

describe("createKnowledgeRevisionStoreAdapter — port mapping (11.1)", () => {
  it("getByIdempotencyKey maps ok(row) → CommittedRevision, json fields structurally intact", async () => {
    const { repo } = fakeRepo({ get: ok(ROW) });
    const store = createKnowledgeRevisionStoreAdapter(repo);
    const got = await store.getByIdempotencyKey("idem-1");
    expect(got).toEqual(REVISION);
    expect(got?.workflowRunRef).toEqual(validWorkflowRunRef);
    expect(got?.auditRecord).toEqual(validAuditRecord);
  });

  it("record forwards the revision to the repo (field-for-field) and resolves void on ok", async () => {
    const { repo, recorded } = fakeRepo({ record: ok(undefined) });
    const store = createKnowledgeRevisionStoreAdapter(repo);
    await expect(store.record(REVISION)).resolves.toBeUndefined();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual(ROW);
  });
});

describe("createKnowledgeRevisionStoreAdapter — fail-closed contract (§16)", () => {
  it("getByIdempotencyKey folds a benign not_found MISS to the absence sentinel (undefined)", async () => {
    const miss: DbError = { code: "not_found", message: "miss" };
    const { repo } = fakeRepo({ get: err(miss) });
    const store = createKnowledgeRevisionStoreAdapter(repo);
    await expect(store.getByIdempotencyKey("nope")).resolves.toBeUndefined();
  });

  // The load-bearing fail-closed direction: a REAL fault must REJECT, not resolve undefined —
  // else the writer reads "no prior commit" and re-commits (a duplicate write).
  for (const code of ["unavailable", "serialization_failure", "conflict", "unknown"] as const) {
    it(`getByIdempotencyKey REJECTS on a real ${code} fault (never a false 'no prior commit')`, async () => {
      const fault: DbError = { code, message: `boom (${code})` };
      const { repo } = fakeRepo({ get: err(fault) });
      const store = createKnowledgeRevisionStoreAdapter(repo);
      await expect(store.getByIdempotencyKey("idem-1")).rejects.toThrow(code);
    });
  }

  it("record REJECTS on a real store fault (a silently dropped record re-opens a duplicate commit)", async () => {
    const fault: DbError = { code: "unavailable", message: "down" };
    const { repo } = fakeRepo({ record: err(fault) });
    const store = createKnowledgeRevisionStoreAdapter(repo);
    await expect(store.record(REVISION)).rejects.toThrow("unavailable");
  });

  it("the rejection message keeps the DbError code but NOT the opaque driver cause (safety rule 7)", async () => {
    const fault: DbError = { code: "unknown", message: "surface", cause: { secret: "RAW" } };
    const { repo } = fakeRepo({ get: err(fault) });
    const store = createKnowledgeRevisionStoreAdapter(repo);
    await expect(store.getByIdempotencyKey("idem-1")).rejects.toThrow(/unknown/);
    await store.getByIdempotencyKey("idem-1").catch((e: unknown) => {
      expect(String(e)).not.toContain("RAW");
    });
  });
});
