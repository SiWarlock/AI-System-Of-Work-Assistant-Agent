// spec(§9) — slice 7.4 idempotency seam (resolveRun).
//
// resolveRun is THE idempotency seam every §9 workflow builds on: a re-submitted
// trigger carrying an ALREADY-SEEN idempotencyKey resolves to the EXISTING
// WorkflowRun (getByIdempotencyKey) — NO duplicate run is started. A NOVEL key
// creates a new run (workspace-scoped, WS-2). PURE over an injected repo + clock;
// returns a typed Result<ResolveRunOutcome, WorkflowRunError> (§16).
import { describe, it, expect } from "vitest";
import { isOk, isErr, err, workflowId } from "@sow/contracts";
import type { WorkflowRunRef } from "@sow/contracts";
import { resolveRun } from "../src/runtime/idempotency";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";
import type { WorkflowRunRefRepository, DbResult } from "../src/ports/operational";

/**
 * A repo decorator over a real InMemoryWorkflowRunRepo that models a concurrent
 * same-key race: it lies to the FIRST getByIdempotencyKey(raceKey) with a
 * `not_found` (as if the caller read before the winner committed) and delegates
 * faithfully on every other call. So a racing caller's fast-path read misses, its
 * create then hits the underlying unique-idempotencyKey `conflict`, and its
 * reconcile re-read sees the winner's real row.
 */
class RaceInterleavingRepo implements WorkflowRunRefRepository {
  private firstReadServed = false;
  constructor(
    private readonly inner: InMemoryWorkflowRunRepo,
    private readonly raceKey: string,
  ) {}
  create(ref: WorkflowRunRef): DbResult<WorkflowRunRef> {
    return this.inner.create(ref);
  }
  get(id: WorkflowRunRef["workflowId"]): DbResult<WorkflowRunRef> {
    return this.inner.get(id);
  }
  getByIdempotencyKey(key: WorkflowRunRef["idempotencyKey"]): DbResult<WorkflowRunRef> {
    if (!this.firstReadServed && key === this.raceKey) {
      this.firstReadServed = true;
      return Promise.resolve(
        err({ code: "not_found" as const, message: `no workflow run for idempotency key: ${key}` }),
      );
    }
    return this.inner.getByIdempotencyKey(key);
  }
  updateState(
    id: WorkflowRunRef["workflowId"],
    state: WorkflowRunRef["state"],
  ): DbResult<WorkflowRunRef> {
    return this.inner.updateState(id, state);
  }
  appendAuditRef(
    id: WorkflowRunRef["workflowId"],
    auditRef: WorkflowRunRef["auditRefs"][number],
  ): DbResult<WorkflowRunRef> {
    return this.inner.appendAuditRef(id, auditRef);
  }
}

describe("spec(§9) resolveRun — the idempotency seam (no duplicate runs)", () => {
  it("creates a NEW run for a NOVEL idempotency key", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await resolveRun(
      {
        workflowId: workflowId("wf-new"),
        trigger: "schedule",
        idempotencyKey: "novel-key",
        workspaceId: "ws-1",
      },
      repo,
      clock,
    );
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.reused).toBe(false);
    expect(res.value.run.workflowId).toBe("wf-new");
    expect(res.value.run.state).toBe("running");
  });

  it("resolves an ALREADY-SEEN key to the EXISTING run — NO duplicate started", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();

    const first = await resolveRun(
      { workflowId: workflowId("wf-1"), trigger: "schedule", idempotencyKey: "same-key", workspaceId: "ws-1" },
      repo,
      clock,
    );
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.reused).toBe(false);

    // Re-submit the SAME idempotency key (a different candidate workflowId,
    // proving resolution is by key, not by id).
    const second = await resolveRun(
      { workflowId: workflowId("wf-2-would-be-dup"), trigger: "schedule", idempotencyKey: "same-key", workspaceId: "ws-1" },
      repo,
      clock,
    );
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.reused).toBe(true);
    // It returns the ORIGINAL run, not the re-submitted candidate.
    expect(second.value.run.workflowId).toBe("wf-1");

    // And the second workflowId was NEVER persisted → no duplicate run.
    const dupLookup = await repo.get(workflowId("wf-2-would-be-dup"));
    expect(isErr(dupLookup)).toBe(true);
  });

  it("distinct keys create distinct runs", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const a = await resolveRun(
      { workflowId: workflowId("wf-a"), trigger: "schedule", idempotencyKey: "k-a", workspaceId: "ws" },
      repo,
      clock,
    );
    const b = await resolveRun(
      { workflowId: workflowId("wf-b"), trigger: "connector_event", idempotencyKey: "k-b", workspaceId: "ws" },
      repo,
      clock,
    );
    expect(isOk(a) && isOk(b)).toBe(true);
    if (!isOk(a) || !isOk(b)) return;
    expect(a.value.reused).toBe(false);
    expect(b.value.reused).toBe(false);
    expect(a.value.run.workflowId).not.toBe(b.value.run.workflowId);
  });

  it("a NOVEL key on an UNSCOPED submission is REJECTED (WS-2 propagates)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await resolveRun(
      { workflowId: workflowId("wf-x"), trigger: "schedule", idempotencyKey: "unscoped-novel" },
      repo,
      clock,
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unscoped_run");
  });

  // FINDING 9 (HIGH) — resolveRun was a NON-ATOMIC read-then-create: two concurrent
  // submissions with the SAME novel idempotencyKey can BOTH pass the fast-path read
  // (`not_found`) before either has persisted, then both create → a DUPLICATE run.
  //
  // The true race interleaving is: racer B's fast-path read misses, THEN racer A's
  // row lands (A won the atomic unique-idempotencyKey insert), THEN B creates and
  // hits `conflict`. A sequential two-call test can't reproduce this (the second
  // call's fast-path read would already see A). We model the interleaving with a
  // repo decorator that injects the winner's row EXACTLY between B's fast-path read
  // and B's create — so B's create hits the repo's unique-key `conflict`, and the
  // create-then-reconcile re-read recovers the winner (reused:true).
  //
  // Fail-before/pass-after: on the OLD non-atomic code B's create-failure returned
  // `persist_failed` (no re-read) → isOk(second) false; the fix makes it reuse A.
  it("same-key RACE (B reads-misses, A lands, B creates): exactly ONE run; both return it", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const KEY = "raced-key";

    // Racer A resolves normally and wins the insert.
    const first = await resolveRun(
      { workflowId: workflowId("wf-racer-a"), trigger: "schedule", idempotencyKey: KEY, workspaceId: "ws-1" },
      repo,
      clock,
    );
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;
    expect(first.value.reused).toBe(false);

    // A decorator over the SAME repo that lies to B's FAST-PATH read once
    // (modeling B reading before A committed), then delegates faithfully — so B's
    // create hits the underlying unique-key `conflict` and B's reconcile re-read
    // (the 2nd getByIdempotencyKey) sees A's real row.
    const racingRepo = new RaceInterleavingRepo(repo, KEY);

    const second = await resolveRun(
      { workflowId: workflowId("wf-racer-b"), trigger: "schedule", idempotencyKey: KEY, workspaceId: "ws-1" },
      racingRepo,
      clock,
    );

    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    // B reconciled to A's run — reused, not a duplicate.
    expect(second.value.reused).toBe(true);
    expect(second.value.run.workflowId).toBe(first.value.run.workflowId);
    expect(first.value.run.workflowId).toBe("wf-racer-a");

    // B's candidate workflowId was NEVER persisted.
    const loser = await repo.get(workflowId("wf-racer-b"));
    expect(isErr(loser)).toBe(true);

    // The repo holds exactly ONE run for that idempotency key.
    const byKey = await repo.getByIdempotencyKey(KEY);
    expect(isOk(byKey)).toBe(true);
    if (!isOk(byKey)) return;
    expect(byKey.value.workflowId).toBe("wf-racer-a");
  });

  // FINDING 9 corollary — the create-then-reconcile re-read must NOT MASK a genuine
  // create failure. An unscoped novel submission fails at WS-2 admission (before any
  // persistence + before the re-read path), so the re-read never fires and the
  // ORIGINAL `unscoped_run` still surfaces — not a spurious reuse.
  it("a genuine unscoped create failure still surfaces (not masked by the re-read)", async () => {
    const repo = new InMemoryWorkflowRunRepo();
    const clock = new FakeClock();
    const res = await resolveRun(
      // Novel key, but NO workspaceId → createWorkflowRun rejects with unscoped_run.
      { workflowId: workflowId("wf-unscoped"), trigger: "schedule", idempotencyKey: "novel-unscoped" },
      repo,
      clock,
    );
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unscoped_run");
    // Nothing was persisted under that key.
    const byKey = await repo.getByIdempotencyKey("novel-unscoped");
    expect(isErr(byKey)).toBe(true);
  });
});
