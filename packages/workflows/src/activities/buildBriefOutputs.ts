// @sow/workflows — task 25.2 (PKG-W3) ACTIVITY: implement {@link
// BuildGlobalBriefPort} + {@link BuildWorkspaceBriefPort} — DERIVE the daily
// brief's committed outputs FROM the VALIDATED brief (never caller-supplied).
//
// This is an ACTIVITY, NOT workflow code — it MAY use node:crypto (via
// @sow/domain's `buildIdempotencyKey`/`buildCanonicalObjectKey`) to compute the
// plan + envelope keys that drive the driver's idempotent replay (inv-5).
//
// Mirrors the established derive-from-validated pattern (activities/
// deterministicProgress.ts's BuildSyncOutputsPort, activities/proposeWindows.ts's
// BuildSchedulingOutputsPort): the ACTIVITY assembles the real
// KnowledgeMutationPlan/ProposedAction/ExternalWriteEnvelope; an injected PURE
// projection owns the concrete note-body/dashboard-payload shape (the §9/Phase-7
// output-schema arch_gap this codebase names repeatedly — the mapper owns it,
// never guessed here). `plan.workspaceId` is stamped from the PASSED
// (bound) workspace — never a caller-controlled field (WS-2/WS-4). SCOPING
// (deliberate, first real wiring): unlike projectSync's §13.5 create-vs-patch,
// the brief note is always a fresh NoteCreate per run — create-vs-patch for
// brief notes is a follow-up (KnowledgeWriter's own idempotent-replay handles a
// same-run re-drive; a genuine re-run overwrite policy is deferred, arch_gap).
//
// §16: never throws. A projection the mapper cannot build folds to a typed
// {@link BuildGlobalBriefFailure} — NO commit happens before this step, so a
// failure here is always pre-commit (no-partial-commit, inv-4).
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
import type {
  ValidatedBrief,
  DailyBriefExternalAction,
  GlobalBriefOutputs,
  BuildGlobalBriefFailure,
  BuildGlobalBriefPort,
  BuildWorkspaceBriefPort,
} from "../ports/dailyBrief";

/** A committed note the deriver produces — a fresh NoteCreate every run (see the file-level scoping note). */
export interface DerivedBriefNote {
  readonly path: string;
  readonly title?: string;
  readonly body: string;
  readonly frontmatter?: Record<string, unknown>;
}

/** A deterministic descriptor for the telegram-summary external action (keys computed here, node:crypto). */
export interface DerivedNotifyAction {
  readonly targetSystem: TargetSystem;
  readonly canonicalIdentity: Record<string, string>;
  readonly operation: string;
  readonly idempotencyIdentity: Record<string, string>;
  readonly payload: Record<string, unknown>;
  readonly approvalPolicy: string;
  readonly payloadHash: string;
  readonly preconditions: readonly string[];
}

/** The injected PURE projection for the GLOBAL/Coordination brief outputs. */
export interface GlobalBriefProjection {
  project(
    validated: ValidatedBrief,
    projections: readonly GclProjection[],
    globalWorkspaceId: WorkspaceId,
  ): Result<
    { readonly note: DerivedBriefNote; readonly dashboard: Record<string, unknown>; readonly notify?: DerivedNotifyAction },
    BuildGlobalBriefFailure
  >;
}

/** The injected PURE projection for a per-workspace brief note. */
export interface WorkspaceBriefProjection {
  project(
    validated: ValidatedBrief,
    workspaceId: WorkspaceId,
  ): Result<DerivedBriefNote, BuildGlobalBriefFailure>;
}

/** Injected deps shared by both derivers. */
export interface BuildBriefOutputsActivityDeps {
  readonly globalProjection: GlobalBriefProjection;
  readonly workspaceProjection: WorkspaceBriefProjection;
  /** The evidence (REQ-F-006: ≥1 sourceRef) the derived plan cites. */
  readonly sourceRef: SourceRef;
  readonly planIdentitySeed: string;
  readonly provenanceOrigin?: ProvenanceOrigin;
}

function toPlan(
  note: DerivedBriefNote,
  workspaceId: WorkspaceId,
  operation: string,
  identity: Record<string, string>,
  deps: BuildBriefOutputsActivityDeps,
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
    // arch_gap (25.2): no dedicated "daily_brief" ProvenanceOrigin member exists
    // yet in @sow/contracts (packages/contracts is out of this package's
    // territory) — defaults to "ingestion", mirroring activities/proposeWindows.ts's
    // established default for the analogous crossCalendarScheduling gap.
    provenanceOrigin: deps.provenanceOrigin ?? "ingestion",
  };
}

function toNotifyAction(d: DerivedNotifyAction): DailyBriefExternalAction {
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

/**
 * Build a {@link BuildGlobalBriefPort} that DERIVES the global plan + dashboard +
 * optional telegram summary FROM the validated global brief + sanitized
 * projections + the passed globalWorkspaceId. Never throws.
 */
export function createBuildGlobalBriefActivity(
  deps: BuildBriefOutputsActivityDeps,
): BuildGlobalBriefPort {
  return {
    async build(
      validated: ValidatedBrief,
      projections: readonly GclProjection[],
      globalWorkspaceId: WorkspaceId,
    ): Promise<Result<GlobalBriefOutputs, BuildGlobalBriefFailure>> {
      const projected = deps.globalProjection.project(validated, projections, globalWorkspaceId);
      if (!projected.ok) return err(projected.error);
      const plan = toPlan(
        projected.value.note,
        globalWorkspaceId,
        "daily-brief.global.plan",
        { seed: deps.planIdentitySeed },
        deps,
      );
      const outputs: GlobalBriefOutputs = {
        plan,
        dashboard: projected.value.dashboard,
        ...(projected.value.notify !== undefined ? { notify: toNotifyAction(projected.value.notify) } : {}),
      };
      return ok(outputs);
    },
  };
}

/**
 * Build a {@link BuildWorkspaceBriefPort} that DERIVES a per-workspace brief
 * plan FROM the validated workspace draft + the bound workspaceId. Never throws.
 */
export function createBuildWorkspaceBriefActivity(
  deps: BuildBriefOutputsActivityDeps,
): BuildWorkspaceBriefPort {
  return {
    async build(
      validated: ValidatedBrief,
      workspaceId: WorkspaceId,
    ): Promise<Result<KnowledgeMutationPlan, BuildGlobalBriefFailure>> {
      const projected = deps.workspaceProjection.project(validated, workspaceId);
      if (!projected.ok) return err(projected.error);
      const plan = toPlan(
        projected.value,
        workspaceId,
        "daily-brief.workspace.plan",
        { seed: deps.planIdentitySeed },
        deps,
      );
      return ok(plan);
    },
  };
}
