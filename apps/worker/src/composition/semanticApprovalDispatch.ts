// §13.10a G4a — assemble the on-approval SEMANTIC dispatch (the DISPATCH side of the Copilot semantic-write
// bridge). An APPROVED `semantic_mutation` Approval commits its referenced KMP through KnowledgeWriter (the
// sole autonomous writer, safety rule 1) — never a direct/auto write. This factory is the composition seam:
// it wires the already-tested pieces (the gate-1 note reader + existence probe over the vault, the
// head-at-commit KnowledgeWriter commit port, and `createSemanticMutationDispatch`) into one
// `DispatchApprovalFn`. Boot routes it as the SEMANTIC branch of `createApprovalDispatchRouter`.
//
// HEAD-AT-COMMIT (the load-bearing choice): the expected base revision is resolved LIVE at commit time
// (`readVaultHeadRevision`). A Copilot semantic plan is approved long AFTER propose, so a fixed base would
// spuriously `write_conflict` on any unrelated vault change in between. Resolving head makes the writer's
// whole-vault compare pass; TARGET integrity is delegated to the executor's gate 1 — a PATCH is a region
// replace (correct even if the note changed elsewhere), and a CREATE over an occupied path is rejected by
// the existence probe. Both fail closed.
//
// DORMANT: reached only when (a) a semantic card EXISTS (propose is OFF today) and (b) the KnowledgeWriter
// durable path — a `KnowledgeRevisionStore` — is provisioned (boot wires this factory only when
// `config.proofSpineParams` is present; the default/Temporal-degraded boot leaves `dispatchApproval` external-only).
import type { WorkflowRunRef } from "@sow/contracts";
import { applyPlan as realApplyPlan, readVaultHeadRevision } from "@sow/knowledge";
import type { KnowledgeWriterDeps, VaultFs, KnowledgeRevisionStore } from "@sow/knowledge";
import { createCommitActivity } from "@sow/workflows";
import type { ApplyPlanFn } from "@sow/workflows";
import type { PendingKnowledgeMutationRepository } from "@sow/db";
import { createSemanticMutationDispatch } from "../api/procedures/semanticMutationDispatch";
import type { DispatchApprovalFn } from "../api/procedures/approvalCommands";
import {
  createNoteProjectIdReader,
  createNoteExistsProbe,
  type WorkspaceNoteRead,
} from "../api/adapters/noteProjectIdReader";

/**
 * The deps for the semantic-approval dispatch. `vault` + `revisions` + `audit` + `now` are the
 * KnowledgeWriter commit substrate (the sole writer); `pendingKmp` is the operational store the executor
 * fetches the frozen plan from; `commit` is the KnowledgeWriter commit metadata (actor / source / run ref).
 * `applyPlan` is INJECTABLE (defaults to the real @sow/knowledge writer) so this composition is unit-testable
 * with a recording fake — the real writer is exercised by the knowledge-package suite.
 */
export interface SemanticApprovalDispatchDeps {
  readonly vault: VaultFs;
  readonly pendingKmp: PendingKnowledgeMutationRepository;
  readonly revisions: KnowledgeRevisionStore;
  readonly audit: KnowledgeWriterDeps["audit"];
  readonly now: () => string;
  readonly commit: {
    readonly actor: string;
    readonly sourceEventRef: string;
    readonly workflowRunRef: WorkflowRunRef;
  };
  /** The KnowledgeWriter apply entry — defaults to the real writer; injected in tests. */
  readonly applyPlan?: ApplyPlanFn;
}

/**
 * Build the `DispatchApprovalFn` for the semantic branch. The note read is WS-8-scoped BY THE PATH: every KMP
 * target is already workspace-rooted (`projectNotePath`), so `vault.read(path)` reads exactly the
 * workspace-scoped file — no separate workspace resolution is needed here.
 */
export function buildSemanticApprovalDispatch(deps: SemanticApprovalDispatchDeps): DispatchApprovalFn {
  const readNote: WorkspaceNoteRead = (path) => deps.vault.read(path);
  const writerDeps: KnowledgeWriterDeps = {
    vault: deps.vault,
    revisions: deps.revisions,
    audit: deps.audit,
    now: deps.now,
    // ownershipCheck + secretScan LEFT UNSET → the writer uses its secure enforceHumanOwnership + scanForSecrets
    // defaults (safety rules 1/7). Never pass a pass-through.
  };
  const commit = createCommitActivity({
    applyPlan: deps.applyPlan ?? realApplyPlan,
    deps: writerDeps,
    actor: deps.commit.actor,
    sourceEventRef: deps.commit.sourceEventRef,
    workflowRunRef: deps.commit.workflowRunRef,
    // Head-at-commit: resolve the LIVE whole-vault head so the writer's compare-revision passes; a resolver
    // throw folds to commit_failed (fail-closed — no partial commit).
    expectedBaseRevision: () => readVaultHeadRevision(deps.vault),
    deriveIdempotencyKey: (plan) => `kw:commit:${String(plan.planId)}`,
  });
  return createSemanticMutationDispatch({
    pendingKmp: deps.pendingKmp,
    commit,
    readNoteProjectId: createNoteProjectIdReader(readNote),
    noteExists: createNoteExistsProbe(readNote),
    now: deps.now,
  });
}
