// @sow/workflows — Phase 25 (PKG-W3): the OUTPUT-WORKFLOW ACTIVITY-ADAPTER
// FACTORY. This is the single seam between the four ALREADY-GREEN pure drivers
// (workflows/dailyBrief.ts, workflows/periodReview.ts, workflows/projectSync.ts,
// workflows/crossCalendarScheduling.ts) and the composition root: one exported
// factory, `createOutputWorkflowActivities(deps)`, returning a FLAT plain-async-
// function object — the exact shape ProofSpineActivities already uses
// (apps/worker/src/composition/buildActivities.ts) — so the composition root
// binds ONE symbol instead of four scattered activity families.
//
// SAFETY POSTURE (explicit, load-bearing): this package REGISTERS NOTHING,
// SCHEDULES NOTHING, and FLIPS NO DEFAULT. Every family here is a PURE factory
// over INJECTED ports — the only way any of it runs in production is if the
// composition root (PKG-W1, apps/worker/src/composition/buildActivities.ts)
// binds it into ProofSpineActivities AND the durable schedule registrar
// (PKG-W2) is given a real client — NEITHER of which happens by constructing
// this factory. `deps.schedule` (the 7.2 durable-schedule store each driver's
// Deps interface also requires) is DELIBERATELY ABSENT from this factory's
// surface — it stays an INJECTED port the composition root binds straight from
// PKG-W2's real store; this factory never constructs an in-sandbox stub
// schedule (a stub `getBookkeeping` returning `undefined` would make the
// LIFE-2 catch-up collapse false-durable while unit tests stayed green — see
// the ports/dailyBrief.ts + workflows/periodReview.ts Deps interfaces, and
// PKG-W3's brief).
//
// ★★ SAFETY RULE 4 (workspace isolation / leakage): the daily-brief +
// period-review global/coordination view reads cross-workspace context ONLY
// through activities/buildGclProjection.ts's `UpdateProjectionsPort`, now bound
// FOR REAL to the @sow/knowledge GCL Visibility Gate (activities/
// gclProjectionGate.ts's `createGclProjectionGate`, over the REAL
// `admitProjection`) — a candidate carrying raw content is HARD-rejected by the
// composed ajv+Zod+visibility-policy gate, never sanitized-and-stored. The
// cross-calendar-scheduling family's availability read is the analogous seam
// (activities/gatherAvailability.ts): every source read is gated, and an
// unauthorized cross-workspace source hard-fails the WHOLE gather (REQ-F-009 —
// never silently treated as free).
//
// ★★ REQ-F-011 (no model-supplied progress percentage): projectSync's `parse`
// member is ALWAYS bound to `createDeterministicProgressActivity` (the SOLE
// producer of the numeric progress) and `buildOutputs` is ALWAYS bound to
// `createBuildSyncOutputsActivity` (which derives the committed percent from
// the DETERMINISTIC facts, never the narrative) — this factory has no other
// path to either member, so a model-supplied percentage cannot reach the
// committed payload through this seam.
//
// This module owns only the FLAT wrapper + the dep-composition wiring; the real
// per-port adapters it wires live in their own files (buildGclProjection.ts,
// gclProjectionGate.ts, readOnlyAgentJob.ts, validateFields.ts,
// buildBriefOutputs.ts, buildReviewOutputs.ts, deterministicProgress.ts,
// commitKnowledge.ts, dashboardUpdate.ts, proposeExternalActions.ts,
// gatherAvailability.ts, proposeWindows.ts, classifyAction.ts,
// routeToApproval.ts, outputHealthSink.ts, refreshConnectors.ts) — this file
// composes them, it does not re-implement them.
import type { Result } from "@sow/contracts";

import type {
  DailyBriefContext,
  RefreshConnectorsPort,
  UpdateProjectionsPort,
  RunBriefingAgentPort,
  BriefingAgentOutput,
  ValidateBriefPort,
  BuildGlobalBriefPort,
  BuildWorkspaceBriefPort,
  CommitBriefPort,
  UpdateDashboardPort,
  NotifyPort,
  DailyBriefHealthSink,
} from "../ports/dailyBrief";
import type {
  PeriodReviewContext,
  ReviewRefreshConnectorsPort,
  ReviewUpdateProjectionsPort,
  RunReviewAgentPort,
  ReviewAgentOutput,
  ValidateReviewPort,
  BuildGlobalReviewPort,
  BuildWorkspaceReviewPort,
  CommitReviewPort,
  ReviewUpdateDashboardPort,
  ReviewNotifyPort,
  PeriodReviewHealthSink,
} from "../workflows/periodReview";
import type {
  ProjectSyncContext,
  ParseProgressPort,
  DeterministicProgress,
  SynthesizeNarrativePort,
  ProgressNarrativeDraft,
  ValidateNarrativePort,
  BuildSyncOutputsPort,
  CommitStatusPort,
  ProjectSyncUpdateDashboardPort,
  ProjectSyncProposeActionsPort,
  ProjectSyncHealthSink,
} from "../ports/projectSync";
import type {
  CrossCalendarSchedulingContext,
  GatherAvailabilityPort,
  ProposeWindowsAgentPort,
  ProposedWindows,
  ValidateProposalPort,
  BuildSchedulingOutputsPort,
  ClassifyActionPort,
  AutoCreateEventPort,
  RouteToApprovalPort,
  CommitSchedulingNotePort,
  SchedulingHealthSink,
} from "../ports/crossCalendarScheduling";

import { createBuildGclProjectionActivity } from "./buildGclProjection";
import type { ProjectionSource, ProjectionGate } from "./buildGclProjection";
import { createGclProjectionGate } from "./gclProjectionGate";
import type { WorkspaceLookup } from "./gclProjectionGate";
import { createRefreshConnectorsActivity } from "./refreshConnectors";
import type { RefreshConnectorsActivityDeps } from "./refreshConnectors";
import { createReadOnlyAgentJobActivity } from "./readOnlyAgentJob";
import type { ReadOnlyAgentJobDeps } from "./readOnlyAgentJob";
import { createFieldsValidateActivity } from "./validateFields";
import type { FieldsDraft } from "./validateFields";
import { createBuildGlobalBriefActivity, createBuildWorkspaceBriefActivity } from "./buildBriefOutputs";
import type { BuildBriefOutputsActivityDeps } from "./buildBriefOutputs";
import { createBuildGlobalReviewActivity, createBuildWorkspaceReviewActivity } from "./buildReviewOutputs";
import type { BuildReviewOutputsActivityDeps } from "./buildReviewOutputs";
import { createDeterministicProgressActivity, createBuildSyncOutputsActivity } from "./deterministicProgress";
import type { DeterministicProgressActivityDeps, BuildSyncOutputsActivityDeps } from "./deterministicProgress";
import { createValidateNarrativePort } from "./validateNarrative";
import { createCommitActivity } from "./commitKnowledge";
import type { CommitActivityDeps } from "./commitKnowledge";
import { createDashboardUpdateActivity } from "./dashboardUpdate";
import type { DashboardReadModelStore } from "./dashboardUpdate";
import { createProposeActivity } from "./proposeExternalActions";
import type { ProposeActivityDeps } from "./proposeExternalActions";
import { createGatherAvailabilityActivity } from "./gatherAvailability";
import type { GatherAvailabilityActivityDeps } from "./gatherAvailability";
import { createProposeWindowsActivity } from "./proposeWindows";
import type { ProposeWindowsActivityDeps } from "./proposeWindows";
import { createClassifyActionActivity } from "./classifyAction";
import type { ClassifyActionActivityDeps } from "./classifyAction";
import { createRouteToApprovalActivity } from "./routeToApproval";
import type { RouteToApprovalActivityDeps } from "./routeToApproval";
import { createOutputWorkflowHealthSink } from "./outputHealthSink";
import type { SurfaceDeps } from "../workflows/systemHealthSurfacing";

// ---------------------------------------------------------------------------
// (1) The injected dependency bundle
// ---------------------------------------------------------------------------

/** The projectSync `SynthesizeNarrativePort` core reads BOTH the context and the
 *  deterministic facts (REQ-F-011 — the facts are handed to the agent, never
 *  produced by it) — combined into one opaque Ctx for the generic core. */
export interface ProjectSyncSynthesizeCtx {
  readonly ctx: ProjectSyncContext;
  readonly progress: DeterministicProgress;
}

/**
 * Everything `createOutputWorkflowActivities` needs, grouped by what it is
 * shared across (never per-port — a port-shaped dep would just be the port
 * itself, defeating the point of an activity-adapter factory) vs what is
 * genuinely family-specific (the model-synthesis job inputs, the KMP-deriving
 * pure projections). `schedule`/`runs`/`clock` are DELIBERATELY ABSENT (see the
 * file-level safety-posture note) — the composition root threads those directly
 * from PKG-W2's durable store / the 7.4 seam / the injected Clock.
 */
export interface OutputWorkflowActivitiesDeps {
  // --- shared across ALL FOUR families ---
  /** The KnowledgeWriter commit leg — safety rule 1, the SOLE Markdown writer. */
  readonly commit: CommitActivityDeps;
  /** The §8 Tool Gateway dispatch leg — safety rule 3, the ONLY external-write path. */
  readonly propose: ProposeActivityDeps;
  /** The rebuildable dashboard read-model sink (§4/§16 — summary-only). */
  readonly dashboard: { readonly store: DashboardReadModelStore };
  /** The 7.5 failure sink every family routes through (inv-5). */
  readonly health: SurfaceDeps;

  // --- shared across dailyBrief + periodReview (the GLOBAL/Coordination leg) ---
  /** REQ-F-005/008 leakage seam: the candidate source + the REAL GCL gate. */
  readonly gclProjection: {
    readonly source: ProjectionSource;
    readonly lookupWorkspace: WorkspaceLookup;
  };
  readonly refreshConnectors: RefreshConnectorsActivityDeps;

  // --- per-family model-synthesis legs (inv-2: read-only, ING-7 admission) ---
  readonly dailyBriefAgent: ReadOnlyAgentJobDeps<DailyBriefContext, BriefingAgentOutput>;
  readonly periodReviewAgent: ReadOnlyAgentJobDeps<PeriodReviewContext, ReviewAgentOutput>;
  readonly projectSyncSynthesize: ReadOnlyAgentJobDeps<ProjectSyncSynthesizeCtx, ProgressNarrativeDraft>;
  readonly crossCalendarProposeAgent: ReadOnlyAgentJobDeps<CrossCalendarSchedulingContext, ProposedWindows>;

  // --- per-family derive-from-validated legs ---
  readonly dailyBriefOutputs: BuildBriefOutputsActivityDeps;
  readonly periodReviewOutputs: BuildReviewOutputsActivityDeps;
  readonly projectSyncParse: DeterministicProgressActivityDeps;
  readonly projectSyncBuildOutputs: BuildSyncOutputsActivityDeps;
  readonly crossCalendarGather: GatherAvailabilityActivityDeps;
  readonly crossCalendarBuildOutputs: ProposeWindowsActivityDeps;
  readonly crossCalendarClassify: ClassifyActionActivityDeps;
  readonly crossCalendarRouteToApproval: RouteToApprovalActivityDeps;
}

// ---------------------------------------------------------------------------
// (2) The flat activity surface — one member per port method, flow-prefixed
//     (mirrors apps/worker/src/composition/buildActivities.ts's own
//     ProofSpineActivities convention exactly, so PKG-W1 can literally spread
//     this object's members into that one).
// ---------------------------------------------------------------------------

export interface OutputWorkflowActivities {
  // ── dailyBrief (25.2) ──
  dailyBriefRefreshConnectors(
    ...args: Parameters<RefreshConnectorsPort["refresh"]>
  ): Promise<Awaited<ReturnType<RefreshConnectorsPort["refresh"]>>>;
  dailyBriefUpdateProjections(
    ...args: Parameters<UpdateProjectionsPort["update"]>
  ): Promise<Awaited<ReturnType<UpdateProjectionsPort["update"]>>>;
  dailyBriefRunAgent(
    ...args: Parameters<RunBriefingAgentPort["run"]>
  ): Promise<Awaited<ReturnType<RunBriefingAgentPort["run"]>>>;
  dailyBriefValidate(
    ...args: Parameters<ValidateBriefPort["validate"]>
  ): ReturnType<ValidateBriefPort["validate"]>;
  dailyBriefBuildGlobal(
    ...args: Parameters<BuildGlobalBriefPort["build"]>
  ): Promise<Awaited<ReturnType<BuildGlobalBriefPort["build"]>>>;
  dailyBriefBuildWorkspace(
    ...args: Parameters<BuildWorkspaceBriefPort["build"]>
  ): Promise<Awaited<ReturnType<BuildWorkspaceBriefPort["build"]>>>;
  dailyBriefCommit(
    ...args: Parameters<CommitBriefPort["commit"]>
  ): Promise<Awaited<ReturnType<CommitBriefPort["commit"]>>>;
  dailyBriefUpdateDashboard(
    ...args: Parameters<UpdateDashboardPort["update"]>
  ): Promise<Awaited<ReturnType<UpdateDashboardPort["update"]>>>;
  dailyBriefNotify(
    ...args: Parameters<NotifyPort["notify"]>
  ): Promise<Awaited<ReturnType<NotifyPort["notify"]>>>;
  dailyBriefSurfaceFailure(
    ...args: Parameters<DailyBriefHealthSink["surface"]>
  ): Promise<Awaited<ReturnType<DailyBriefHealthSink["surface"]>>>;

  // ── periodReview (25.2) ──
  periodReviewRefreshConnectors(
    ...args: Parameters<ReviewRefreshConnectorsPort["refresh"]>
  ): Promise<Awaited<ReturnType<ReviewRefreshConnectorsPort["refresh"]>>>;
  periodReviewUpdateProjections(
    ...args: Parameters<ReviewUpdateProjectionsPort["update"]>
  ): Promise<Awaited<ReturnType<ReviewUpdateProjectionsPort["update"]>>>;
  periodReviewRunAgent(
    ...args: Parameters<RunReviewAgentPort["run"]>
  ): Promise<Awaited<ReturnType<RunReviewAgentPort["run"]>>>;
  periodReviewValidate(
    ...args: Parameters<ValidateReviewPort["validate"]>
  ): ReturnType<ValidateReviewPort["validate"]>;
  periodReviewBuildGlobal(
    ...args: Parameters<BuildGlobalReviewPort["build"]>
  ): Promise<Awaited<ReturnType<BuildGlobalReviewPort["build"]>>>;
  periodReviewBuildWorkspace(
    ...args: Parameters<BuildWorkspaceReviewPort["build"]>
  ): Promise<Awaited<ReturnType<BuildWorkspaceReviewPort["build"]>>>;
  periodReviewCommit(
    ...args: Parameters<CommitReviewPort["commit"]>
  ): Promise<Awaited<ReturnType<CommitReviewPort["commit"]>>>;
  periodReviewUpdateDashboard(
    ...args: Parameters<ReviewUpdateDashboardPort["update"]>
  ): Promise<Awaited<ReturnType<ReviewUpdateDashboardPort["update"]>>>;
  periodReviewNotify(
    ...args: Parameters<ReviewNotifyPort["notify"]>
  ): Promise<Awaited<ReturnType<ReviewNotifyPort["notify"]>>>;
  periodReviewSurfaceFailure(
    ...args: Parameters<PeriodReviewHealthSink["surface"]>
  ): Promise<Awaited<ReturnType<PeriodReviewHealthSink["surface"]>>>;

  // ── projectSync (25.3) — NOTE: `registry` stays INJECTED (PKG-W5's
  //    worker-side typed-Project registry), so it is NOT a member here; the
  //    composition root supplies it directly on ProjectSyncDeps. ──
  projectSyncParseProgress(
    ...args: Parameters<ParseProgressPort["parse"]>
  ): Promise<Awaited<ReturnType<ParseProgressPort["parse"]>>>;
  projectSyncSynthesizeNarrative(
    ...args: Parameters<SynthesizeNarrativePort["synthesize"]>
  ): Promise<Awaited<ReturnType<SynthesizeNarrativePort["synthesize"]>>>;
  projectSyncValidateNarrative(
    ...args: Parameters<ValidateNarrativePort["validate"]>
  ): ReturnType<ValidateNarrativePort["validate"]>;
  projectSyncBuildOutputs(
    ...args: Parameters<BuildSyncOutputsPort["build"]>
  ): Promise<Awaited<ReturnType<BuildSyncOutputsPort["build"]>>>;
  projectSyncCommitStatus(
    ...args: Parameters<CommitStatusPort["commit"]>
  ): Promise<Awaited<ReturnType<CommitStatusPort["commit"]>>>;
  projectSyncUpdateDashboard(
    ...args: Parameters<ProjectSyncUpdateDashboardPort["update"]>
  ): Promise<Awaited<ReturnType<ProjectSyncUpdateDashboardPort["update"]>>>;
  projectSyncProposeActions(
    ...args: Parameters<ProjectSyncProposeActionsPort["propose"]>
  ): Promise<Awaited<ReturnType<ProjectSyncProposeActionsPort["propose"]>>>;
  projectSyncSurfaceFailure(
    ...args: Parameters<ProjectSyncHealthSink["surface"]>
  ): Promise<Awaited<ReturnType<ProjectSyncHealthSink["surface"]>>>;

  // ── crossCalendarScheduling (25.4) ──
  crossCalendarGatherAvailability(
    ...args: Parameters<GatherAvailabilityPort["gather"]>
  ): Promise<Awaited<ReturnType<GatherAvailabilityPort["gather"]>>>;
  crossCalendarProposeWindowsAgent(
    ...args: Parameters<ProposeWindowsAgentPort["run"]>
  ): Promise<Awaited<ReturnType<ProposeWindowsAgentPort["run"]>>>;
  crossCalendarValidateProposal(
    ...args: Parameters<ValidateProposalPort["validate"]>
  ): ReturnType<ValidateProposalPort["validate"]>;
  crossCalendarBuildOutputs(
    ...args: Parameters<BuildSchedulingOutputsPort["build"]>
  ): Promise<Awaited<ReturnType<BuildSchedulingOutputsPort["build"]>>>;
  crossCalendarClassifyAction(
    ...args: Parameters<ClassifyActionPort["classify"]>
  ): Promise<Awaited<ReturnType<ClassifyActionPort["classify"]>>>;
  crossCalendarAutoCreateEvent(
    ...args: Parameters<AutoCreateEventPort["create"]>
  ): Promise<Awaited<ReturnType<AutoCreateEventPort["create"]>>>;
  crossCalendarRouteToApproval(
    ...args: Parameters<RouteToApprovalPort["route"]>
  ): Promise<Awaited<ReturnType<RouteToApprovalPort["route"]>>>;
  crossCalendarCommitNote(
    ...args: Parameters<CommitSchedulingNotePort["commit"]>
  ): Promise<Awaited<ReturnType<CommitSchedulingNotePort["commit"]>>>;
  crossCalendarSurfaceFailure(
    ...args: Parameters<SchedulingHealthSink["surface"]>
  ): Promise<Awaited<ReturnType<SchedulingHealthSink["surface"]>>>;
}

// ---------------------------------------------------------------------------
// (3) The factory
// ---------------------------------------------------------------------------

/**
 * Build the flat {@link OutputWorkflowActivities} object. Pure composition —
 * every real I/O-touching decision (which broker, which store, which gate
 * source, which connector set) lives in the injected `deps`; this function only
 * WIRES the already-real per-port adapters (see the file-level comment) into
 * the names ProofSpineActivities-style consumers expect. Registers nothing,
 * schedules nothing, flips no default (see the file-level safety-posture note).
 */
export function createOutputWorkflowActivities(
  deps: OutputWorkflowActivitiesDeps,
): OutputWorkflowActivities {
  // --- shared instances ---
  const gclGate: ProjectionGate = createGclProjectionGate(deps.gclProjection.lookupWorkspace);
  const gclProjectionActivity = createBuildGclProjectionActivity({
    source: deps.gclProjection.source,
    gate: gclGate,
  });
  const refreshConnectorsActivity = createRefreshConnectorsActivity(deps.refreshConnectors);
  // task 24.105 — binding-site precondition guard (the FOURTH `createCommitActivity` site named by
  // that task; the other three are apps/worker/src/composition/buildActivities.ts:717/:1246 and
  // semanticApprovalDispatch.ts:103). `commitActivity.commit(plan)` returns the RAW `CommitKnowledgePort`
  // Result verbatim: a rejection carries `cause: result.error` — the WHOLE `WriteFailure`, validator-
  // authored messages included, constructed at `commitKnowledge.ts:164` (secret-scan/workspace-path/
  // ownership rejection detail). That full Result is exactly what `dailyBriefCommit`, `periodReviewCommit`,
  // `projectSyncCommitStatus` and `crossCalendarCommitNote` below return as their Temporal ACTIVITY
  // result — so once the composition root registers this factory's members as real Temporal activities
  // (the task 25.1 registration this precondition gates), that unredacted `cause` lands in workflow
  // history BY CONSTRUCTION, with no drop anywhere on this path.
  // ⛔ NEVER expose this raw `commitActivity` PORT OBJECT itself as a member of the returned
  // `OutputWorkflowActivities` literal — only ever through the plain-async WRAPPER functions below
  // (`dailyBriefCommit:` etc.). Spreading `commitActivity` directly (e.g. a future `{...commitActivity}`
  // shorthand) would put a `CommitKnowledgePort`-shaped object — with a nested `.commit` method — under a
  // Temporal activity key; this file's own header requires a FLAT plain-async-function object. A bare
  // prohibition invites its own deletion (`L82`) — factory.test.ts's task-24.105 suite pins that no
  // `"commit"` key exists on the returned object and that every commit-bearing member is a bare function
  // with no nested `.commit`.
  const commitActivity = createCommitActivity(deps.commit);
  const proposeActivity = createProposeActivity(deps.propose);
  const dashboardActivity = createDashboardUpdateActivity(deps.dashboard);
  const healthSink = createOutputWorkflowHealthSink(deps.health);

  // --- dailyBrief ---
  const dailyBriefAgentActivity = createReadOnlyAgentJobActivity<DailyBriefContext, BriefingAgentOutput>(
    deps.dailyBriefAgent,
  );
  const dailyBriefValidateActivity = createFieldsValidateActivity<FieldsDraft>();
  const dailyBriefGlobalOutputs = createBuildGlobalBriefActivity(deps.dailyBriefOutputs);
  const dailyBriefWorkspaceOutputs = createBuildWorkspaceBriefActivity(deps.dailyBriefOutputs);

  // --- periodReview ---
  const periodReviewAgentActivity = createReadOnlyAgentJobActivity<PeriodReviewContext, ReviewAgentOutput>(
    deps.periodReviewAgent,
  );
  const periodReviewValidateActivity = createFieldsValidateActivity<FieldsDraft>();
  const periodReviewGlobalOutputs = createBuildGlobalReviewActivity(deps.periodReviewOutputs);
  const periodReviewWorkspaceOutputs = createBuildWorkspaceReviewActivity(deps.periodReviewOutputs);

  // --- projectSync ---
  const projectSyncParseActivity = createDeterministicProgressActivity(deps.projectSyncParse);
  const projectSyncSynthesizeActivity = createReadOnlyAgentJobActivity<
    ProjectSyncSynthesizeCtx,
    ProgressNarrativeDraft
  >(deps.projectSyncSynthesize);
  const projectSyncValidateActivity = createValidateNarrativePort();
  const projectSyncBuildOutputsActivity = createBuildSyncOutputsActivity(deps.projectSyncBuildOutputs);

  // --- crossCalendarScheduling ---
  const crossCalendarGatherActivity = createGatherAvailabilityActivity(deps.crossCalendarGather);
  const crossCalendarAgentActivity = createReadOnlyAgentJobActivity<
    CrossCalendarSchedulingContext,
    ProposedWindows
  >(deps.crossCalendarProposeAgent);
  const crossCalendarValidateActivity = createFieldsValidateActivity<
    FieldsDraft & { readonly windows: ProposedWindows["windows"] }
  >();
  const crossCalendarBuildOutputsActivity = createProposeWindowsActivity(deps.crossCalendarBuildOutputs);
  const crossCalendarClassifyActivity = createClassifyActionActivity(deps.crossCalendarClassify);
  const crossCalendarRouteActivity = createRouteToApprovalActivity(deps.crossCalendarRouteToApproval);

  return {
    // dailyBrief
    dailyBriefRefreshConnectors: (ctx) => refreshConnectorsActivity.refresh(ctx),
    dailyBriefUpdateProjections: (ctx) => gclProjectionActivity.update(ctx),
    dailyBriefRunAgent: (ctx) => dailyBriefAgentActivity.run(ctx),
    dailyBriefValidate: (draft) =>
      dailyBriefValidateActivity.validate(draft) as ReturnType<ValidateBriefPort["validate"]>,
    dailyBriefBuildGlobal: (validated, projections, globalWorkspaceId) =>
      dailyBriefGlobalOutputs.build(validated, projections, globalWorkspaceId),
    dailyBriefBuildWorkspace: (validated, workspaceId) =>
      dailyBriefWorkspaceOutputs.build(validated, workspaceId),
    dailyBriefCommit: (plan) =>
      commitActivity.commit(plan) as Promise<Awaited<ReturnType<CommitBriefPort["commit"]>>>,
    dailyBriefUpdateDashboard: (payload) =>
      dashboardActivity.update(payload) as Promise<Awaited<ReturnType<UpdateDashboardPort["update"]>>>,
    dailyBriefNotify: (action, env) =>
      proposeActivity.propose(action, env) as Promise<Awaited<ReturnType<NotifyPort["notify"]>>>,
    dailyBriefSurfaceFailure: (failure) =>
      healthSink.surface(failure) as Promise<Awaited<ReturnType<DailyBriefHealthSink["surface"]>>>,

    // periodReview
    periodReviewRefreshConnectors: (ctx) => refreshConnectorsActivity.refresh(ctx),
    periodReviewUpdateProjections: (ctx) => gclProjectionActivity.update(ctx),
    periodReviewRunAgent: (ctx) => periodReviewAgentActivity.run(ctx),
    periodReviewValidate: (draft) =>
      periodReviewValidateActivity.validate(draft) as ReturnType<ValidateReviewPort["validate"]>,
    periodReviewBuildGlobal: (validated, projections, window, globalWorkspaceId) =>
      periodReviewGlobalOutputs.build(validated, projections, window, globalWorkspaceId),
    periodReviewBuildWorkspace: (validated, window, workspaceId) =>
      periodReviewWorkspaceOutputs.build(validated, window, workspaceId),
    periodReviewCommit: (plan) =>
      commitActivity.commit(plan) as Promise<Awaited<ReturnType<CommitReviewPort["commit"]>>>,
    periodReviewUpdateDashboard: (payload) =>
      dashboardActivity.update(payload) as Promise<Awaited<ReturnType<ReviewUpdateDashboardPort["update"]>>>,
    periodReviewNotify: (action, env) =>
      proposeActivity.propose(action, env) as Promise<Awaited<ReturnType<ReviewNotifyPort["notify"]>>>,
    periodReviewSurfaceFailure: (failure) =>
      healthSink.surface(failure) as Promise<Awaited<ReturnType<PeriodReviewHealthSink["surface"]>>>,

    // projectSync
    projectSyncParseProgress: (ctx) => projectSyncParseActivity.parse(ctx),
    projectSyncSynthesizeNarrative: (ctx, progress) => projectSyncSynthesizeActivity.run({ ctx, progress }),
    projectSyncValidateNarrative: (draft) => projectSyncValidateActivity.validate(draft),
    projectSyncBuildOutputs: (validated, progress, workspaceId, identity, updatedAt) =>
      projectSyncBuildOutputsActivity.build(validated, progress, workspaceId, identity, updatedAt),
    projectSyncCommitStatus: (plan) =>
      commitActivity.commit(plan) as Promise<Awaited<ReturnType<CommitStatusPort["commit"]>>>,
    projectSyncUpdateDashboard: (payload) =>
      dashboardActivity.update(payload) as Promise<
        Awaited<ReturnType<ProjectSyncUpdateDashboardPort["update"]>>
      >,
    projectSyncProposeActions: (action, env) =>
      proposeActivity.propose(action, env) as Promise<
        Awaited<ReturnType<ProjectSyncProposeActionsPort["propose"]>>
      >,
    projectSyncSurfaceFailure: (failure) =>
      healthSink.surface(failure) as Promise<Awaited<ReturnType<ProjectSyncHealthSink["surface"]>>>,

    // crossCalendarScheduling
    crossCalendarGatherAvailability: (ctx) => crossCalendarGatherActivity.gather(ctx),
    crossCalendarProposeWindowsAgent: (ctx) => crossCalendarAgentActivity.run(ctx),
    crossCalendarValidateProposal: (proposal) =>
      crossCalendarValidateActivity.validate(proposal) as ReturnType<ValidateProposalPort["validate"]>,
    crossCalendarBuildOutputs: (validated, organizerWorkspaceId) =>
      crossCalendarBuildOutputsActivity.build(validated, organizerWorkspaceId),
    crossCalendarClassifyAction: (action, organizerWorkspaceId) =>
      crossCalendarClassifyActivity.classify(action, organizerWorkspaceId),
    crossCalendarAutoCreateEvent: (action, env) =>
      proposeActivity.propose(action, env) as Promise<Awaited<ReturnType<AutoCreateEventPort["create"]>>>,
    crossCalendarRouteToApproval: (action, env) => crossCalendarRouteActivity.route(action, env),
    crossCalendarCommitNote: (plan) =>
      commitActivity.commit(plan) as Promise<Awaited<ReturnType<CommitSchedulingNotePort["commit"]>>>,
    crossCalendarSurfaceFailure: (failure) =>
      healthSink.surface(failure) as Promise<Awaited<ReturnType<SchedulingHealthSink["surface"]>>>,
  };
}

// Re-export the Result type consumers assembling deps may reference.
export type { Result };
