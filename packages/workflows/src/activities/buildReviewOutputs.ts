// @sow/workflows — task 25.2 (PKG-W3) ACTIVITY: implement {@link
// BuildGlobalReviewPort} + {@link BuildWorkspaceReviewPort} — DERIVE the
// period-review's committed outputs FROM the VALIDATED review + the computed
// window (never caller-supplied). Sibling of activities/buildBriefOutputs.ts;
// same derive-from-validated shape, distinguished only by the extra `window:
// ReviewWindow` param workflows/periodReview.ts's ports thread through both
// build methods. See buildBriefOutputs.ts's file-level comment for the shared
// design rationale (arch_gap notes, the fresh-NoteCreate-per-run scoping).
//
// §16: never throws.
import { ok, err, planId, actionId } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  GclProjection,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  SourceRef,
  TargetSystem,
  ProvenanceOrigin,
} from "@sow/contracts";
import { buildIdempotencyKey, buildCanonicalObjectKey } from "@sow/domain";
import type { ReviewWindow } from "./periodWindow";
import type {
  ValidatedReview,
  PeriodReviewExternalAction,
  GlobalReviewOutputs,
  BuildReviewFailure,
  BuildGlobalReviewPort,
  BuildWorkspaceReviewPort,
} from "../workflows/periodReview";

export interface DerivedReviewNote {
  readonly path: string;
  readonly title?: string;
  readonly body: string;
  readonly frontmatter?: Record<string, unknown>;
}

export interface DerivedReviewNotifyAction {
  readonly targetSystem: TargetSystem;
  readonly canonicalIdentity: Record<string, string>;
  readonly operation: string;
  readonly idempotencyIdentity: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly approvalPolicy: string;
  readonly payloadHash: string;
  readonly preconditions: readonly string[];
}

export interface GlobalReviewProjection {
  project(
    validated: ValidatedReview,
    projections: readonly GclProjection[],
    window: ReviewWindow,
    globalWorkspaceId: WorkspaceId,
  ): Result<
    { readonly note: DerivedReviewNote; readonly dashboard: Record<string, unknown>; readonly notify?: DerivedReviewNotifyAction },
    BuildReviewFailure
  >;
}

export interface WorkspaceReviewProjection {
  project(
    validated: ValidatedReview,
    window: ReviewWindow,
    workspaceId: WorkspaceId,
  ): Result<DerivedReviewNote, BuildReviewFailure>;
}

export interface BuildReviewOutputsActivityDeps {
  readonly globalProjection: GlobalReviewProjection;
  readonly workspaceProjection: WorkspaceReviewProjection;
  readonly sourceRef: SourceRef;
  readonly planIdentitySeed: string;
  readonly provenanceOrigin?: ProvenanceOrigin;
}

function toPlan(
  note: DerivedReviewNote,
  workspaceId: WorkspaceId,
  operation: string,
  identity: Record<string, string>,
  deps: BuildReviewOutputsActivityDeps,
): KnowledgeMutationPlan {
  const key = buildIdempotencyKey({ operation, identity: { ...identity, workspace: String(workspaceId) } });
  return {
    planId: planId(key),
    workspaceId,
    sourceRefs: [deps.sourceRef],
    creates: [
      {
        path: note.path,
        body: note.body,
        ...(note.title !== undefined ? { title: note.title } : {}),
        ...(note.frontmatter !== undefined ? { frontmatter: note.frontmatter } : {}),
      },
    ],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 1,
    requiresApproval: false,
    // arch_gap (25.2) — see buildBriefOutputs.ts's identical note.
    provenanceOrigin: deps.provenanceOrigin ?? "ingestion",
  };
}

function toNotifyAction(d: DerivedReviewNotifyAction): PeriodReviewExternalAction {
  const canonicalObjectKey = buildCanonicalObjectKey({ targetSystem: d.targetSystem, identity: d.canonicalIdentity });
  const idempotencyKey = buildIdempotencyKey({ operation: d.operation, identity: d.idempotencyIdentity });
  const action: ProposedAction = {
    actionId: actionId(idempotencyKey),
    targetSystem: d.targetSystem,
    canonicalObjectKey,
    payload: d.payload,
    approvalPolicy: d.approvalPolicy,
    idempotencyKey,
  };
  const envelope: ExternalWriteEnvelope = {
    actionId: action.actionId,
    targetSystem: d.targetSystem,
    canonicalObjectKey,
    idempotencyKey,
    preconditions: [...d.preconditions],
    payloadHash: d.payloadHash,
  };
  return { action, envelope };
}

export function createBuildGlobalReviewActivity(
  deps: BuildReviewOutputsActivityDeps,
): BuildGlobalReviewPort {
  return {
    async build(
      validated: ValidatedReview,
      projections: readonly GclProjection[],
      window: ReviewWindow,
      globalWorkspaceId: WorkspaceId,
    ): Promise<Result<GlobalReviewOutputs, BuildReviewFailure>> {
      const projected = deps.globalProjection.project(validated, projections, window, globalWorkspaceId);
      if (!projected.ok) return err(projected.error);
      const plan = toPlan(
        projected.value.note,
        globalWorkspaceId,
        "period-review.global.plan",
        { seed: deps.planIdentitySeed, windowEnd: window.windowEnd },
        deps,
      );
      const outputs: GlobalReviewOutputs = {
        plan,
        dashboard: projected.value.dashboard,
        ...(projected.value.notify !== undefined ? { notify: toNotifyAction(projected.value.notify) } : {}),
      };
      return ok(outputs);
    },
  };
}

export function createBuildWorkspaceReviewActivity(
  deps: BuildReviewOutputsActivityDeps,
): BuildWorkspaceReviewPort {
  return {
    async build(
      validated: ValidatedReview,
      window: ReviewWindow,
      workspaceId: WorkspaceId,
    ): Promise<Result<KnowledgeMutationPlan, BuildReviewFailure>> {
      const projected = deps.workspaceProjection.project(validated, window, workspaceId);
      if (!projected.ok) return err(projected.error);
      const plan = toPlan(
        projected.value,
        workspaceId,
        "period-review.workspace.plan",
        { seed: deps.planIdentitySeed, windowEnd: window.windowEnd },
        deps,
      );
      return ok(plan);
    },
  };
}
