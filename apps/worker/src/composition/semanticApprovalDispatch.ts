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
import { makeEnforceWorkspacePathScope } from "@sow/knowledge";
import { LEGACY_UNPREFIXED_WORKSPACE_ID } from "./legacy-workspace";
import type { KnowledgeWriterDeps, VaultFs, KnowledgeRevisionStore, StamperDeps } from "@sow/knowledge";
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
  /**
   * task 20.2 — the KnowledgeWriter provenance-signing dep (gate 4/G1d-2, already optional on
   * `KnowledgeWriterDeps.signing` — see writer.ts:190). OPTIONAL/DORMANT BY DEFAULT: UNSET ⇒
   * `writerDeps.signing` stays key-ABSENT (conditional spread below) ⇒ `embedProvenanceStamps`
   * never runs ⇒ the committed Markdown bytes are BYTE-IDENTICAL to pre-20.2. Mirrors the sibling
   * `buildActivities.ts` site (task 19.2, `buildActivities.ts:379`) — the SAME `StamperDeps` pair
   * `boot.ts` sources from `keychainSecrets`/`provenanceServingOracle` threads here too; no new
   * arming surface.
   */
  readonly signing?: StamperDeps;
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
    //
    // 24.26 — SUPPLY the exempt workspace id (see the matching site in buildActivities.ts, which carries the
    // full reasoning and the mutation evidence). Built ONCE here, OUTSIDE the per-approval `commit:` closure
    // below — a per-approval construction would turn a config fault into an uncaught throw where `applyPlan`
    // promises a typed WriteFailure.
    // ⛔ LOAD-BEARING AS OF STEP 3 (`46e34ca8`): `workspacePathCheck` is REQUIRED and writer.ts's
    // `?? enforceWorkspacePathScope` fallback is DELETED, so this line is the sole enforcement of the
    // rule-4 / WS-8 path guard on the approval-driven commit path. ⚠ It read "behaviourally inert until
    // step 3" until step 3 landed — true when written, falsified from another package with nothing red.
    //
    // ⭐ 24.75 (enumeration method + boundary): this is one of exactly TWO production sites, derived by
    // TYPE + CALL PATH, not by grepping the constant's spelling — full statement + re-confirmation at
    // the matching site in `buildActivities.ts`, not restated here.
    // ⚠ 24.61 (full reasoning at the matching site in `buildActivities.ts`) — the blank/Cf-zero-width
    // throw inside `makeEnforceWorkspacePathScope` is a misconfiguration tripwire, not known-workspace-
    // set validation; closing that class is an owed composition-root change only once this argument
    // stops being a compile-time constant (still `LEGACY_UNPREFIXED_WORKSPACE_ID` today — not owed yet).
    // The differential test below ("the supplied check carries the exempt id") already exercises the
    // value the factory receives HERE unmodified: a hidden transform at this site would flip its
    // "exempt commits unprefixed" assertion to a violation, not just the wrong-id one it was written for.
    workspacePathCheck: makeEnforceWorkspacePathScope(LEGACY_UNPREFIXED_WORKSPACE_ID),
    // task 20.2 — the provenance-signing dep, same conditional-spread idiom as buildActivities.ts's
    // sibling site (task 19.2): the key is ABSENT, not `undefined`-valued, when `deps.signing` is
    // unset, so the shipped default stays byte-identical (writer.ts:626-637 gates ALL stamping on
    // `deps.signing !== undefined`).
    ...(deps.signing !== undefined ? { signing: deps.signing } : {}),
  };
  return createSemanticMutationDispatch({
    pendingKmp: deps.pendingKmp,
    // Build the commit port PER-APPROVAL so the authorizing approval id lands in the audit trail. An
    // approval-driven commit runs under NO workflow, so `workflowRunRef` stays a placeholder; the meaningful
    // linkage is folded into `sourceEventRef` — which the writer records on BOTH the AuditRecord and the
    // CommittedRevision — as `<base>#approval:<id>`. So a committed KMP is traceable to the exact §9.8 approval
    // that authorized it (not only via the pending-KMP row). `#approval:` is an unambiguous, parseable suffix.
    // task 24.105 — binding-site precondition guard. UNLIKE buildActivities.ts's two sibling
    // `createCommitActivity` sites (which feed the ALREADY-registered `meetingCommit`/`sourceCommit`
    // Temporal activities by deliberate design), this port is consumed ONLY in-process by
    // `createSemanticMutationDispatch`'s executor — invoked synchronously from `decideApprovalCommand`
    // (the tRPC approve/reject command), NEVER via a Temporal workflow. The executor's own
    // `commitFailureToVariant` DROPS the raw `cause` (only a stable code crosses, safety rule 7) before
    // returning to its caller — so today NOTHING raw leaves this boundary. ⛔ THAT REDACTION IS THE
    // EXECUTOR'S, NOT THIS PORT'S: a rejection here still carries `cause: result.error`, the WHOLE
    // `WriteFailure` with validator-authored messages constructed at
    // `packages/workflows/src/activities/commitKnowledge.ts:164`. If this port (or the dispatch function
    // built over it) were EVER registered as a Temporal activity directly — bypassing
    // `createSemanticMutationDispatch`'s redaction — that full unredacted `WriteFailure` would be
    // serialized into Temporal's DURABLE, REPLAYED workflow history with no drop on that path and no way
    // to scrub it after the fact. This factory must stay in-process; pinned in
    // `proof-spine-composition.test.ts` (the SAME assertion the buildActivities.ts sites carry) that no
    // registered proof-spine Temporal activity exposes a raw commit port.
    commit: ({ approvalId }) =>
      createCommitActivity({
        applyPlan: deps.applyPlan ?? realApplyPlan,
        deps: writerDeps,
        actor: deps.commit.actor,
        sourceEventRef: `${deps.commit.sourceEventRef}#approval:${approvalId}`,
        workflowRunRef: deps.commit.workflowRunRef,
        // Head-at-commit: resolve the LIVE whole-vault head so the writer's compare-revision passes; a resolver
        // throw folds to commit_failed (fail-closed — no partial commit).
        expectedBaseRevision: () => readVaultHeadRevision(deps.vault),
        deriveIdempotencyKey: (plan) => `kw:commit:${String(plan.planId)}`,
      }),
    readNoteProjectId: createNoteProjectIdReader(readNote),
    noteExists: createNoteExistsProbe(readNote),
    now: deps.now,
  });
}
