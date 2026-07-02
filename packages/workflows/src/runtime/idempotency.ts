// @sow/workflows — slice 7.4: the idempotency seam (resolveRun) (§9).
//
// resolveRun is THE idempotency seam every §9 workflow builds on: a re-submitted
// trigger carrying an ALREADY-SEEN idempotencyKey resolves to the EXISTING
// WorkflowRun (getByIdempotencyKey) — NO duplicate run is started. A NOVEL key
// creates a new run (workspace-scoped at admission, WS-2, via createWorkflowRun).
//
// PURE + deterministic + workflow-safe: no @temporalio, no node:crypto, no
// Date.now(). Persistence + time are INJECTED (WorkflowRunRefRepository + Clock).
// §16 error convention: never throws; returns a typed
// Result<ResolveRunOutcome, WorkflowRunError> with an enumerable failure set.
import { ok, isOk } from "@sow/contracts";
import type { Result, WorkflowRunRef } from "@sow/contracts";
import type { WorkflowRunRefRepository, Clock } from "../ports/operational";
import { createWorkflowRun } from "./workflowRun";
import type { CreateWorkflowRunInput, WorkflowRunError } from "./workflowRun";

/**
 * The input for resolving a run against its idempotency key. Identical shape to
 * {@link CreateWorkflowRunInput}: the candidate `workflowId`/`trigger`/
 * `workspaceId` are used ONLY when the key is novel (a new run is created); on a
 * seen key the candidate is discarded and the EXISTING run is returned.
 */
export type ResolveRunInput = CreateWorkflowRunInput;

/**
 * The outcome of {@link resolveRun}. `reused === true` ⇒ the idempotencyKey was
 * already seen and `run` is the PRE-EXISTING run (no duplicate started).
 * `reused === false` ⇒ the key was novel and `run` is the freshly-created run.
 */
export interface ResolveRunOutcome {
  readonly reused: boolean;
  readonly run: WorkflowRunRef;
}

/**
 * Resolve a trigger submission to its WorkflowRun, idempotently. Lookup FIRST by
 * idempotencyKey: on a hit, return the existing run with `reused: true` (NO
 * duplicate run is started — the candidate workflowId is never persisted). On a
 * miss, admit a new run via createWorkflowRun (which enforces WS-2 workspace
 * binding — an unscoped novel submission fails closed with `unscoped_run`).
 *
 * A `not_found` from getByIdempotencyKey is the NOVEL-key signal (per the repo
 * contract), not an error to surface — it routes to creation. Any OTHER repo
 * error on lookup is surfaced as a typed `persist_failed`.
 *
 * ATOMICITY (§9 / LIFE-3) — create-then-reconcile, mirroring the Phase-6 reserve
 * pattern. The fast-path read is NOT a uniqueness guarantee: two concurrent
 * submissions carrying the SAME novel idempotencyKey can BOTH observe `not_found`
 * and BOTH proceed to create. The race-safe backstop is the repo's atomic
 * UNIQUE-idempotencyKey insert: exactly one create wins; the loser gets a typed
 * error. On that loss we RE-READ by idempotencyKey — if the winner's run is now
 * present we reuse it (`reused: true`); only if it is STILL absent do we surface
 * the ORIGINAL create error (a genuine `unscoped_run` never reaches create — WS-2
 * rejects it before persistence — or a real persist failure).
 *
 * CROSS-PROCESS GUARANTEE (WW-1, delivered): the real @sow/db `workflow_run_refs`
 * table now carries a UNIQUE constraint on idempotencyKey, and both the SQLite and
 * Postgres `create` adapters surface a duplicate-idempotencyKey insert as a typed
 * `conflict` (INSERT … ON CONFLICT DO NOTHING + empty-returning) — the same contract
 * the in-memory fake already modeled. So the create-then-reconcile re-read below is
 * exact-once ACROSS PROCESSES, not just within one worker.
 */
export async function resolveRun(
  input: ResolveRunInput,
  repo: WorkflowRunRefRepository,
  clock: Clock,
): Promise<Result<ResolveRunOutcome, WorkflowRunError>> {
  const existing = await repo.getByIdempotencyKey(input.idempotencyKey);
  if (isOk(existing)) {
    // Already seen → reuse. No duplicate run is created.
    return ok({ reused: true, run: existing.value });
  }
  // The repo signals a novel key with `not_found`; any other code is a real
  // persistence failure and must be surfaced (fail-closed), not treated as novel.
  if (existing.error.code !== "not_found") {
    return {
      ok: false,
      error: {
        code: "persist_failed",
        message: `idempotency lookup failed: ${existing.error.message}`,
      },
    };
  }

  // Novel key → admit a new run (createWorkflowRun enforces WS-2 + persistence).
  const created = await createWorkflowRun(input, repo, clock);
  if (isOk(created)) {
    return ok({ reused: false, run: created.value });
  }

  // Create FAILED. This may be a lost race: a concurrent same-key submission won
  // the atomic unique-idempotencyKey insert between our read and our create.
  // RE-READ by idempotencyKey — if the winner's run is now present, reuse it.
  const reconciled = await repo.getByIdempotencyKey(input.idempotencyKey);
  if (isOk(reconciled)) {
    return ok({ reused: true, run: reconciled.value });
  }

  // Still absent on re-read → the create error is genuine (a real WS-2
  // `unscoped_run`, or a true persist failure), not a lost race. Surface it.
  return created;
}
