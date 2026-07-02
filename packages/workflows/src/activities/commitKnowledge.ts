// @sow/workflows — slice 7.6 ACTIVITY: commit the validated extraction through the
// KnowledgeWriter (inv-4/inv-5 — the SOLE Markdown writer; idempotent replay).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use the real
// @sow/knowledge `applyPlan` (the provably-sole autonomous semantic writer, safety
// rule 1). It takes `applyPlan` + its deps + the per-commit metadata INJECTED so it
// is Vitest-unit-testable with a fake `applyPlan` and never touches a real vault in
// the module. It implements {@link CommitKnowledgePort}.
//
// SAFETY:
//   inv-4 — semantic outputs go ONLY through KnowledgeWriter (this is the only path).
//   inv-5 — the commit is IDEMPOTENT by the KnowledgeWriteCommand's idempotencyKey:
//           a re-commit of the same plan returns `replayed:true` with the SAME
//           revisionId — no second write, no second audit (the writer's own §6
//           idempotent-replay gate provides this; we derive a STABLE idempotencyKey
//           per plan so the property holds on restart/replay).
//
// §16: returns a typed Result — never throws. A KnowledgeWriter `WriteFailure` is
// mapped onto the closed {@link KnowledgeCommitFailureCode} set (a write_conflict is
// the compare-revision clash; schema/ownership/secret/commit failures fold too).
import { ok, err } from "@sow/contracts";
import type {
  Result,
  KnowledgeMutationPlan,
  WorkflowRunRef,
} from "@sow/contracts";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
  WriteSuccess,
  WriteFailure,
  RevisionId,
} from "@sow/knowledge";
import type {
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
} from "../ports/meetingCloseout";

/** The KnowledgeWriter apply entry (injected — the real @sow/knowledge `applyPlan`). */
export type ApplyPlanFn = (
  command: KnowledgeWriteCommand,
  deps: KnowledgeWriterDeps,
) => Promise<Result<WriteSuccess, WriteFailure>>;

/**
 * Injected deps for the commit activity: the KnowledgeWriter apply fn + its deps,
 * the per-commit metadata (actor / sourceEventRef / workflowRunRef /
 * expectedBaseRevision), and the STABLE idempotency-key derivation for the plan
 * (drives the writer's idempotent replay — inv-5).
 */
export interface CommitActivityDeps {
  readonly applyPlan: ApplyPlanFn;
  readonly deps: KnowledgeWriterDeps;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly expectedBaseRevision: RevisionId;
  readonly deriveIdempotencyKey: (plan: KnowledgeMutationPlan) => string;
}

/** Map a KnowledgeWriter WriteFailure onto the closed commit-failure code set. */
function mapWriteFailure(failure: WriteFailure): KnowledgeCommitFailureCode {
  switch (failure.code) {
    case "schema_rejected":
      return "schema_rejected";
    case "write_conflict":
      return "write_conflict";
    case "ownership_violation":
      return "ownership_violation";
    case "secret_found":
      return "secret_found";
    case "commit_failed":
    default:
      return "commit_failed";
  }
}

/**
 * Build a {@link CommitKnowledgePort} over the injected KnowledgeWriter. The commit
 * is idempotent by the derived idempotencyKey (inv-5): a replay returns the prior
 * revision with `replayed:true`, no second write. A compare-revision clash is
 * `write_conflict`. Never throws.
 */
export function createCommitActivity(deps: CommitActivityDeps): CommitKnowledgePort {
  return {
    async commit(
      plan: KnowledgeMutationPlan,
    ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
      const command: KnowledgeWriteCommand = {
        // `plan` is candidate data to the writer — it re-runs the composed gate.
        plan,
        expectedBaseRevision: deps.expectedBaseRevision,
        actor: deps.actor,
        sourceEventRef: deps.sourceEventRef,
        workflowRunRef: deps.workflowRunRef,
        idempotencyKey: deps.deriveIdempotencyKey(plan),
      };
      const result = await deps.applyPlan(command, deps.deps);
      if (!result.ok) {
        return err({
          code: mapWriteFailure(result.error),
          message: `KnowledgeWriter rejected the commit: ${result.error.code}`,
          cause: result.error,
        });
      }
      return ok({
        revisionId: String(result.value.revisionId),
        replayed: result.value.replayed,
      });
    },
  };
}
