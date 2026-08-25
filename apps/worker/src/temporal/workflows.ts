// @sow/worker — the WORKFLOWSPATH MODULE (the Temporal sandbox side of the proof
// spine). This is the ONLY module @temporalio bundles into the deterministic V8
// workflow sandbox (bundleWorkflowCode({ workflowsPath: require.resolve("./workflows") })).
//
// ★ SANDBOX PURITY (root CLAUDE.md two-layer split — the load-bearing constraint):
// This file imports ONLY
//   • @temporalio/workflow            — proxyActivities (the ONLY way a workflow
//                                        reaches a side effect: everything is an
//                                        activity call scheduled on the task queue);
//   • the PURE drivers + their port/Deps/Input types from @sow/workflows —
//     the drivers import NEITHER @temporalio NOR node:crypto and call NO Date.now()
//     (they take time through the injected Clock), so they are sandbox-safe;
//   • the ProofSpineActivities TYPE (type-only — erased at compile, never a runtime
//     import) so proxyActivities is fully typed against the composition-root shape.
//
// It imports NOTHING from ./composition (backends open a DB / vault / vendor client —
// forbidden in the sandbox), NO node:crypto, NO node:fs, and calls NO Date.now()
// directly — the Temporal VM replaces global Date/Math.random/setTimeout with
// deterministic, replay-safe versions, so the injected Clock's `now()` (which reads
// `new Date()`) is itself deterministic INSIDE the sandbox. All real I/O (the DB,
// the KnowledgeWriter, the Tool Gateway, the broker) lives behind the activity
// proxies, which run in the ACTIVITY worker over the real backends — never here.
//
// WHAT EACH WRAPPER DOES: for each fully-wireable driver it
//   1. obtains typed activity proxies (proxyActivities<ProofSpineActivities>);
//   2. adapts the flat activity functions onto the driver's PORT interfaces (each
//      port method delegates to exactly one activity — the composition root already
//      made every activity a boundary-safe typed-Result delegate, so nothing throws
//      across the seam);
//   3. injects a deterministic {@link Clock} + an in-sandbox WorkflowRun repo for
//      the driver's resolveRun seam (see the note on the repo below);
//   4. RUNS the pure driver (return runMeetingCloseout(input, deps) etc.) inside the
//      sandbox and returns its Outcome.
import { proxyActivities } from "@temporalio/workflow";

// DEEP, LEAF-PURE value imports — NOT the package barrels. The @sow/contracts barrel
// (index.ts) `export *`s schema/registry.ts, whose top-level `import { readdirSync }
// from "node:fs"` + ajv would be pulled into the workflow bundle graph and rejected
// by the Temporal bundler (node:fs is an unhandled scheme in the sandbox). Importing
// the leaf `result` module (a pure Ok/Err record + guards, no side effects) instead
// keeps the sandbox graph clean. Likewise the driver + validate value imports come
// from their DEEP module paths, never the @sow/workflows barrel (which re-exports the
// activity set — node:crypto, etc.). See the module header's sandbox-purity note.
import { ok } from "@sow/contracts/primitives/result";
import type { Result } from "@sow/contracts/primitives/result";

import { runMeetingCloseout } from "@sow/workflows/workflows/meetingCloseout";
import { runApprovalFlow } from "@sow/workflows/workflows/approvalFlow";
import { runIngestionTriage } from "@sow/workflows/workflows/ingestionTriage";
// make-it-real C1: the previously-uncalled §9 source-ingestion driver, deep-imported
// (the barrel re-exports the activity set — node:crypto etc.) so the sandbox graph
// stays clean, exactly like the three drivers above.
import { runSourceIngestion } from "@sow/workflows/workflows/sourceIngestion";
// 16.2: the previously-unregistered §9 connector-sync-health driver, deep-imported (barrel-free) so the
// sandbox graph stays clean. Its schedule/wakeDrain seams use in-sandbox stubs (Phase-23 binds the real
// DB-backed bookkeeping + drain + the live createSchedule START); the shipped default polls zero connectors.
import { runConnectorSyncHealth } from "@sow/workflows/workflows/connectorSyncHealth";
// 25.1 — the four §9 OUTPUT-WORKFLOW drivers (dailyBrief/periodReview/projectSync/
// crossCalendarScheduling), deep-imported (barrel-free) for the SAME sandbox-purity reason as every
// driver above. This is the "extend the registered bundle past the proof spine" leg (task 25.1):
// registerWorker.ts's `workflowsPath` already resolves to THIS module, so widening what this module
// EXPORTS is the whole mechanism — no separate bundle/path to repoint. ⚠ CORRECTING THE PLAN TEXT
// (task 25.1 dispatch note): `IMPLEMENTATION_PLAN.md`'s §25.1 entry frames this file as exposing "the
// two proof-spine entry points" — that was already false at HEAD before this slice (the file exported
// FIVE: meetingCloseoutWorkflow, approvalFlowWorkflow, ingestionTriageWorkflow, sourceIngestionWorkflow,
// connectorSyncHealthWorkflow — see the module header's own wrapper list above). This slice adds a SIXTH
// through NINTH: dailyBriefWorkflow, periodReviewWorkflow, projectSyncWorkflow,
// crossCalendarSchedulingWorkflow.
import { runDailyBrief } from "@sow/workflows/workflows/dailyBrief";
import { runPeriodReview } from "@sow/workflows/workflows/periodReview";
import { runProjectSync } from "@sow/workflows/workflows/projectSync";
import { runCrossCalendarScheduling } from "@sow/workflows/workflows/crossCalendarScheduling";
// The validate gate is PURE + SYNC (no-inference + schema gate) — it runs IN-SANDBOX,
// not as a proxied activity, so the driver's synchronous ValidateExtractionPort
// contract is honored (an activity proxy is always async).
import { createValidateActivity } from "@sow/workflows/activities/validateCloseout";
// 18.4 — the REAL structural candidate-data gate (rule 2 / REQ-S-006), reused from 18.3's
// meeting-extraction leaf. PURE (typeof/Object.keys only; @sow/contracts value import + type-only
// imports) so it is Temporal-workflow-sandbox-safe, exactly like validateCloseout above.
import { createMeetingExtractionSchemaGate } from "../composition/meeting-extraction";
// 25.1 — the output-workflow families' "validate" legs. ⛔ NOT proxied via `proxyActivities`:
// `OutputWorkflowActivities`'s own dailyBriefValidate/periodReviewValidate/
// projectSyncValidateNarrative/crossCalendarValidateProposal members declare a SYNCHRONOUS
// `Result<...>` return (matching each port's own sync contract) — @temporalio/workflow's
// `proxyActivities<T>` REQUIRES every member to return `Promise<...>` (a non-Promise member types
// to the uncallable `NotAnActivityMethod` — see @temporalio/workflow's own worked example in its
// .d.ts). So, exactly like `validate`/`createValidateActivity` above (meetingCloseout/
// sourceIngestion's PURE in-sandbox gate), these run IN-SANDBOX as plain synchronous functions —
// never proxied. Import shape is IDENTICAL to `validateCloseout` (both value-import the
// `@sow/contracts` + `@sow/domain` barrels, both PROVEN sandbox-safe by that already-registered
// import two lines up), so no new sandbox-purity exposure.
import { createFieldsValidateActivity } from "@sow/workflows/activities/validateFields";
import { createValidateNarrativePort } from "@sow/workflows/activities/validateNarrative";
import type {
  // driver input/deps/outcome
  MeetingCloseoutInput,
  MeetingCloseoutDeps,
  MeetingCloseoutOutcome,
  ApprovalFlowInput,
  ApprovalFlowDeps,
  ApprovalFlowOutcome,
  IngestionTriageInput,
  IngestionTriageDeps,
  IngestionTriageOutcome,
  // the foundation clock + run-repo the drivers' resolveRun seam takes
  Clock,
  WorkflowRunRefRepository,
  // the meeting-closeout ports the wrappers adapt onto
  CorrelatePort,
  RunMeetingAgentJobPort,
  ValidateExtractionPort,
  BuildOutputsPort,
  SourceBuildOutputsPort,
  SourceLivingVaultPort,
  ProposeKnowledgeApprovalPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  ReindexGbrainPort,
  MeetingHealthSink,
  MeetingParkPort,
  MeetingWorkflowFailure,
  // the approval-flow ports
  RecordPendingPort,
  SurfaceCardPort,
  ApplyTransitionPort,
  DispatchApprovedActionPort,
  ApprovalHealthSink,
  ApprovalWorkflowFailure,
  // the ingestion-triage ports
  RecordDispositionPort,
  RescopeSourcePort,
  ReenterIngestionPort,
  TriageHealthSink,
  TriageWorkflowFailure,
  // the source-ingestion (make-it-real C1) input/deps/outcome + its leaf ports
  // (BuildOutputsPort / CommitKnowledgePort / ProposeActionsPort are shared with the
  // meeting flow above — the source-ingestion seam re-exports the SAME derive surface).
  SourceIngestionInput,
  SourceIngestionDeps,
  SourceIngestionOutcome,
  RegisterSourcePort,
  RouteSourcePort,
  RunSourceAgentJobPort,
  IndexGbrainPort,
  SourceHealthSink,
  SourceWorkflowFailure,
  // the connector-sync-health (16.2) input/deps/outcome + the ports the wrapper adapts onto
  ConnectorSyncHealthInput,
  ConnectorSyncHealthDeps,
  ConnectorSyncHealthOutcome,
  ConnectorPollPort,
  WakeDrainPort,
  ConnectorSyncHealthHealthSink,
  ConnectorSyncHealthFailure,
  ScheduleStore,
  // 25.1 — the four output-workflow input/deps/outcome + leaf-port types. All re-exported by the
  // @sow/workflows barrel (packages/workflows/src/index.ts) from ports/dailyBrief.ts,
  // workflows/periodReview.ts (which owns its OWN Review*-prefixed port set — no dedicated
  // ports/periodReview.ts file), ports/projectSync.ts + workflows/projectSync.ts, and
  // ports/crossCalendarScheduling.ts + workflows/crossCalendarScheduling.ts — a TYPE-ONLY import here
  // pulls no runtime code (sandbox-purity note above governs only VALUE imports).
  DailyBriefInput,
  DailyBriefDeps,
  DailyBriefOutcome,
  BriefDraft,
  RefreshConnectorsPort,
  UpdateProjectionsPort,
  RunBriefingAgentPort,
  ValidateBriefPort,
  BuildGlobalBriefPort,
  BuildWorkspaceBriefPort,
  CommitBriefPort,
  UpdateDashboardPort,
  NotifyPort,
  DailyBriefHealthSink,
  DailyBriefFailure,
  PeriodReviewInput,
  PeriodReviewDeps,
  PeriodReviewOutcome,
  ReviewDraft,
  ReviewRefreshConnectorsPort,
  ReviewUpdateProjectionsPort,
  RunReviewAgentPort,
  ValidateReviewPort,
  BuildGlobalReviewPort,
  BuildWorkspaceReviewPort,
  CommitReviewPort,
  ReviewUpdateDashboardPort,
  ReviewNotifyPort,
  PeriodReviewHealthSink,
  PeriodReviewFailure,
  ProjectSyncInput,
  ProjectSyncDeps,
  ProjectSyncOutcome,
  ResolveRegistryPort,
  ProjectRegistryEntry,
  ResolveRegistryError,
  ProjectSyncContext,
  ParseProgressPort,
  SynthesizeNarrativePort,
  ValidateNarrativePort,
  BuildSyncOutputsPort,
  CommitStatusPort,
  ProjectSyncUpdateDashboardPort,
  ProjectSyncProposeActionsPort,
  ProjectSyncHealthSink,
  ProjectSyncFailure,
  CrossCalendarSchedulingInput,
  CrossCalendarSchedulingDeps,
  CrossCalendarSchedulingOutcome,
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
  SchedulingWorkflowFailure,
  FieldsDraft,
  // 25.1 — the flat output-workflow activity surface (packages/workflows/src/activities/
  // outputWorkflows.ts). ProofSpineActivities (../composition/buildActivities, type-only below)
  // does NOT yet include these members — the composition-root binding that spreads
  // `createOutputWorkflowActivities(...)`'s real backends into the registered activities object is a
  // NAMED, NOT-YET-LANDED follow-up (crossTerritoryNeed: apps/worker/src/composition/buildActivities.ts,
  // outside this package's territory). Proxying against THIS type independently of ProofSpineActivities
  // means that follow-up needs no edit here when it lands — only a matching-named function added to the
  // registered activities object at the composition root.
  OutputWorkflowActivities,
} from "@sow/workflows";

// TYPE-ONLY import of the composition-root activities shape. Types are erased, so
// this pulls NO composition/backends code into the sandbox bundle — it only pins
// the proxy's type so every activity call is checked against the real registered
// object (buildProofSpineActivities). A value import here would be a sandbox-purity
// violation (it would drag @sow/db et al. into the bundle).
import type { ProofSpineActivities } from "../composition/buildActivities";

// ---------------------------------------------------------------------------
// The typed activity proxies (the ONLY side-effect surface a workflow may touch)
// ---------------------------------------------------------------------------

/**
 * The proof-spine activity proxies, typed against the composition-root
 * {@link ProofSpineActivities} shape. Every proxied call is scheduled on the task
 * queue and executed by the ACTIVITY worker over the real backends. The retry +
 * timeout policy is the §16 default: a bounded start-to-close timeout so a hung
 * activity degrades rather than pins the workflow, and a bounded retry so a
 * transient fault re-drives (the underlying activities are all idempotent — inv-5 —
 * so a retry never duplicates a durable write).
 */
const activities = proxyActivities<ProofSpineActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

/**
 * 25.1 — the output-workflow activity proxies, typed against `OutputWorkflowActivities`
 * (packages/workflows/src/activities/outputWorkflows.ts) — a SEPARATE flat shape from
 * {@link ProofSpineActivities} (see the type-import note above for why: the composition-root
 * binding is a named follow-up, not landed here). Same retry/timeout policy as `activities` (§16
 * default — every underlying activity is idempotent, inv-5).
 */
const outputWorkflowActivities = proxyActivities<OutputWorkflowActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

/**
 * 25.1 (projectSync leg) — the ONE projectSync activity deliberately EXCLUDED from
 * `OutputWorkflowActivities` (see that interface's own in-code note: "`registry` stays INJECTED
 * ... the composition root supplies it directly on ProjectSyncDeps"). A real production
 * implementation already exists (`createProjectRegistryResolvePort`,
 * apps/worker/src/composition/projectRegistry.ts) but is NOT YET bound into the registered
 * activities object — that file's own header names this exact gap as "a named spine follow-up"
 * (task 14.6). Proxied under its own name here so wiring it later needs no further edit to this
 * file — only a matching-named `projectSyncResolveRegistry` function added at the composition
 * root (crossTerritoryNeed, apps/worker/src/composition/buildActivities.ts).
 */
interface ProjectSyncRegistryActivities {
  projectSyncResolveRegistry(
    ctx: ProjectSyncContext,
  ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>>;
}
const projectSyncRegistryActivities = proxyActivities<ProjectSyncRegistryActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

// ---------------------------------------------------------------------------
// Sandbox-safe shared seams: the deterministic Clock + the run-resolution repo
// ---------------------------------------------------------------------------

/**
 * The deterministic workflow clock. Inside the Temporal VM the global `Date` is
 * replaced with a REPLAY-SAFE deterministic clock, so reading `new Date()` here
 * yields the same value on every replay — this is exactly the injected-Clock seam
 * the pure drivers were built around (they never call Date.now() themselves). The
 * driver threads this into resolveRun + any bookkeeping; the durable timestamps
 * that matter (audit / receipt / commit) are stamped in the ACTIVITY layer over the
 * real wall clock, not here.
 */
const workflowClock: Clock = {
  now(): string {
    return new Date().toISOString();
  },
};

/**
 * The PURE, SYNCHRONOUS validate port (inv-3: no-inference + schema gate). It is
 * deterministic + sandbox-safe (imports only @sow/contracts + @sow/domain pure code)
 * and returns a synchronous Result, so it runs IN-SANDBOX rather than as an async
 * activity proxy — which is what the driver's SYNC {@link ValidateExtractionPort}
 * contract requires. 18.4 — the schema gate is now the REAL structural candidate-data gate
 * (`createMeetingExtractionSchemaGate`, rule 2 / REQ-S-006), replacing the prior pass-through, and it
 * runs IN-SANDBOX for BOTH the meeting AND source drivers (they share this module-level `validate`).
 * The gate is PURE + total (typeof/Object.keys only — no Date.now/Math.random/I/O), so it is
 * Temporal-workflow-sandbox-safe. Composed with the real safety-bearing half — validateNoInference
 * (REQ-F-017) — which rejects an inferred owner/date before any commit. (18.3 wired the same gate at
 * the activity layer; 18.4 makes it the reachable in-sandbox gate the drivers actually run.)
 */
const validate: ValidateExtractionPort = createValidateActivity({
  schemaGate: createMeetingExtractionSchemaGate(),
});

/**
 * The run-resolution repository the drivers' 7.4 `resolveRun` seam takes.
 *
 * WHY IN-SANDBOX (not an activity): the WorkflowRunRefRepository is a DB adapter —
 * it cannot open the operational store inside the workflow sandbox. The run-registry
 * row is NOT where this proof spine proves exactly-once: the exactly-once guarantees
 * the integration test asserts are enforced in the ACTIVITY layer over the real DB —
 * the KnowledgeWriter commit is idempotent by the plan's key (a replay reuses the
 * revision) and the Tool Gateway reserve-then-create reuses the DB-backed write
 * receipt (a replay issues zero duplicate external write). So the driver only needs a
 * WorkflowRunRef to THREAD; this in-sandbox repo mints a deterministic novel run for
 * the submission (getByIdempotencyKey → not_found → create returns the candidate ref).
 * A replay of the SAME workflowId re-drives the whole pipeline, and the DB-backed
 * commit/receipt reuse makes that re-drive produce no duplicate durable write — the
 * inv-5 invariant, upheld where it actually lives.
 *
 * CARRY-FORWARD: when the run-registry is promoted to a durable cross-execution
 * fact, replace this with a proxyActivities-backed run repo (a `resolveRun` activity
 * added to the composition root) so `runReused` reflects the persisted registry too.
 */
function sandboxRunRepo(): WorkflowRunRefRepository {
  return {
    getByIdempotencyKey(idempotencyKey) {
      // Novel-key signal (per the repo contract) — routes resolveRun to create.
      return Promise.resolve({
        ok: false,
        error: { code: "not_found", message: `no run for idempotencyKey ${idempotencyKey}` },
      });
    },
    create(ref) {
      return Promise.resolve({ ok: true, value: ref });
    },
    get(workflowId) {
      return Promise.resolve({
        ok: false,
        error: { code: "not_found", message: `no run ${workflowId}` },
      });
    },
    updateState(workflowId, state) {
      return Promise.resolve({
        ok: false,
        error: { code: "not_found", message: `no run ${workflowId} to move to ${state}` },
      });
    },
    appendAuditRef(workflowId) {
      return Promise.resolve({
        ok: false,
        error: { code: "not_found", message: `no run ${workflowId}` },
      });
    },
  };
}

/**
 * 25.1 — an in-sandbox `ScheduleStore` STUB for the dailyBrief/periodReview LIFE-2 catch-up seam,
 * mirroring `connectorSyncHealthWorkflow`'s OWN inline stub below (same shape, same reason — see
 * that wrapper's doc comment): `getBookkeeping → undefined` (every tick reads as first-run, no
 * durable catch-up window) and a no-op `put`. Phase-23 TODO #1 replaces this with the real
 * DB-backed bookkeeping at the composition root; a false-durable stub must not survive into a
 * firing schedule, which is exactly why 25.2/25.3's schedules stay default-OFF until then.
 */
function sandboxScheduleStoreStub(): ScheduleStore {
  return {
    getBookkeeping: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// meeting-closeout workflow
// ---------------------------------------------------------------------------

/**
 * The meeting-closeout workflow: a THIN @temporalio wrapper that adapts the proof-
 * spine activity proxies onto the {@link MeetingCloseoutDeps} port set and runs the
 * pure {@link runMeetingCloseout} driver inside the sandbox. Every port method
 * delegates to exactly one activity (the composition root made each a typed-Result
 * delegate, so nothing throws across the boundary — §16). The health sink maps the
 * driver's {@link MeetingWorkflowFailure} onto the 7.5 `surfaceFailure` activity;
 * even if surfacing rejects, the driver still returns the resting failure state
 * (fail-closed).
 */
export async function meetingCloseoutWorkflow(
  input: MeetingCloseoutInput,
): Promise<MeetingCloseoutOutcome> {
  const correlate: CorrelatePort = { correlate: (ctx) => activities.meetingCorrelate(ctx) };
  const agent: RunMeetingAgentJobPort = { run: (ctx) => activities.meetingRunAgentJob(ctx) };
  // `validate` is the module-level PURE in-sandbox port (see above) — NOT a proxied
  // activity: the port is synchronous and the gate is deterministic + sandbox-safe.
  const buildOutputs: BuildOutputsPort = {
    build: (validated, workspaceId) => activities.meetingBuildOutputs(validated, workspaceId),
  };
  const commit: CommitKnowledgePort = { commit: (plan) => activities.meetingCommit(plan) };
  const propose: ProposeActionsPort = {
    propose: (action, env) => activities.meetingPropose(action, env),
  };
  const reindex: ReindexGbrainPort = {
    reindex: (revisionId) => activities.meetingReindex(revisionId),
  };
  const health: MeetingHealthSink = {
    surface: (failure: MeetingWorkflowFailure) => activities.surfaceFailure(failure),
  };
  // G5: the low-confidence routing-review PARK — the sandbox proxy onto the durable park activity.
  const park: MeetingParkPort = {
    park: (source, idempotencyKey) => activities.meetingPark(source, idempotencyKey),
  };
  // 13.8i-B — the propose-approval leg (§6 KN-10). The delegate is ALWAYS bound because the sandbox
  // cannot read boot config; the ARMING decision lives in the activity (`createProposeKnowledgeApprovalActivity`),
  // which yields a typed `not_armed` err unless the owner-armed port was supplied at the composition
  // root — mirrors the `livingVault` leg in `sourceIngestionWorkflow` below (L59).
  const proposeKnowledgeApproval: ProposeKnowledgeApprovalPort = {
    propose: (plan, workspaceId) => activities.meetingProposeKnowledgeApproval(plan, workspaceId),
  };

  const deps: MeetingCloseoutDeps = {
    correlate,
    agent,
    validate,
    buildOutputs,
    commit,
    propose,
    reindex,
    health,
    park,
    runs: sandboxRunRepo(),
    clock: workflowClock,
    proposeKnowledgeApproval,
  };

  return runMeetingCloseout(input, deps);
}

// ---------------------------------------------------------------------------
// approval-flow workflow
// ---------------------------------------------------------------------------

/**
 * The approval-flow workflow: adapts the proof-spine approval activities onto the
 * {@link ApprovalFlowDeps} port set and runs {@link runApprovalFlow} inside the
 * sandbox. The exactly-once transition (inv-C) is enforced by the DB-backed
 * ApprovalRepository CAS behind `approvalApply`; the approved dispatch (inv-E) reuses
 * the DB-backed write receipt behind `approvalDispatchApproved` — so a double-apply /
 * replay yields ONE transition and ZERO duplicate external write.
 */
export async function approvalFlowWorkflow(
  input: ApprovalFlowInput,
): Promise<ApprovalFlowOutcome> {
  const record: RecordPendingPort = { record: (ctx) => activities.approvalRecordPending(ctx) };
  const surface: SurfaceCardPort = {
    surface: (approval) => activities.approvalSurfaceCard(approval),
  };
  const applyTransition: ApplyTransitionPort = {
    apply: (approval, decision) => activities.approvalApply(approval, decision),
    // applySystem (the deferred snooze/expiry actor-less move) is NOT exposed as a
    // proof-spine activity — the deferred snooze timer is a later wave. The proof
    // spine only drives the `decide` path (record → surface → apply → dispatch), so
    // a snooze_tick never reaches applySystem in this wiring; guard it fail-closed.
    applySystem: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "apply_failed",
          message:
            "applySystem (deferred snooze/expiry) is not wired in the proof spine — only the decide path is",
        },
      }),
  };
  const dispatch: DispatchApprovedActionPort = {
    dispatch: (action, env) => activities.approvalDispatchApproved(action, env),
  };
  const health: ApprovalHealthSink = {
    surface: (failure: ApprovalWorkflowFailure) => activities.surfaceFailure(failure),
  };

  const deps: ApprovalFlowDeps = {
    record,
    surface,
    applyTransition,
    dispatch,
    health,
    runs: sandboxRunRepo(),
    clock: workflowClock,
  };

  return runApprovalFlow(input, deps);
}

// ---------------------------------------------------------------------------
// ingestion-triage workflow
// ---------------------------------------------------------------------------

/**
 * The ingestion-triage workflow: adapts the proof-spine triage activities onto the
 * {@link IngestionTriageDeps} port set and runs {@link runIngestionTriage} inside the
 * sandbox. The exactly-once disposition record (inv-A/inv-B) and the same-key
 * re-entry (inv-D) are enforced in the activity layer behind `triageRecordDisposition`
 * / `triageReenter` — a re-submit / replay reuses the audit ref + the run, so the
 * downstream writes are idempotent.
 */
export async function ingestionTriageWorkflow(
  input: IngestionTriageInput,
): Promise<IngestionTriageOutcome> {
  const record: RecordDispositionPort = {
    record: (disposition) => activities.triageRecordDisposition(disposition),
  };
  const rescope: RescopeSourcePort = {
    rescope: (disposition) => activities.triageRescopeSource(disposition),
  };
  const reenter: ReenterIngestionPort = {
    reenter: (reScopedSource, idempotencyKey) =>
      activities.triageReenter(reScopedSource, idempotencyKey),
  };
  const health: TriageHealthSink = {
    surface: (failure: TriageWorkflowFailure) => activities.surfaceFailure(failure),
  };

  const deps: IngestionTriageDeps = {
    record,
    rescope,
    reenter,
    health,
    runs: sandboxRunRepo(),
    clock: workflowClock,
  };

  return runIngestionTriage(input, deps);
}

// ---------------------------------------------------------------------------
// source-ingestion workflow (make-it-real C1)
// ---------------------------------------------------------------------------

/**
 * The source-ingestion workflow: a THIN @temporalio wrapper that adapts the proof-
 * spine source-ingestion activity proxies onto the {@link SourceIngestionDeps} port
 * set and runs the pure {@link runSourceIngestion} driver inside the sandbox — the
 * SAME two-layer shape as the three drivers above. Every port method delegates to
 * exactly one activity (each a typed-Result delegate — nothing throws across the
 * boundary, §16). `validate` reuses the module-level PURE in-sandbox port. The health
 * sink maps the driver's {@link SourceWorkflowFailure} onto the 7.5 `surfaceFailure`
 * activity; even if surfacing rejects, the driver still returns the resting failure
 * state (fail-closed). Guardrail-3: only `sourceRegister` runs the REAL registerSource
 * gate — every other leaf is a deterministic composition-root fake in C1.
 */
export async function sourceIngestionWorkflow(
  input: SourceIngestionInput,
): Promise<SourceIngestionOutcome> {
  const register: RegisterSourcePort = { register: (ctx) => activities.sourceRegister(ctx) };
  const route: RouteSourcePort = { route: (ctx) => activities.sourceRoute(ctx) };
  const agent: RunSourceAgentJobPort = { run: (ctx) => activities.sourceRunAgentJob(ctx) };
  // `validate` is the module-level PURE in-sandbox port (see above). Source-ingestion's build
  // takes the DEDICATED SourceBuildOutputsPort — it carries the per-file source identity so the
  // note path + planId are derived per dropped file (many files persist per workspace).
  const buildOutputs: SourceBuildOutputsPort = {
    build: (validated, workspaceId, source) =>
      activities.sourceBuildOutputs(validated, workspaceId, source),
  };
  const commit: CommitKnowledgePort = { commit: (plan) => activities.sourceCommit(plan) };
  const propose: ProposeActionsPort = {
    propose: (action, env) => activities.sourcePropose(action, env),
  };
  const index: IndexGbrainPort = { index: (revisionId) => activities.sourceIndex(revisionId) };
  const health: SourceHealthSink = {
    surface: (failure: SourceWorkflowFailure) => activities.surfaceFailure(failure),
  };
  // 13.8d — the living-vault leg (§6 KN-10). The delegate is ALWAYS bound because the sandbox cannot
  // read boot config; the ARMING decision lives in the activity (`createLivingVaultActivity`), which
  // yields an EMPTY plan set unless the owner-armed port was supplied at the composition root. So the
  // shipped default derives nothing, commits nothing extra, and surfaces nothing — byte-equivalent.
  const livingVault: SourceLivingVaultPort = {
    rewrite: (validated, workspaceId, source) =>
      activities.sourceLivingVaultRewrite(validated, workspaceId, source),
  };
  // 13.8i-B — the propose-approval leg (§6 KN-10), mirroring `livingVault` immediately above: the
  // delegate is ALWAYS bound (sandbox cannot read boot config), and the ARMING decision lives in the
  // activity (`createProposeKnowledgeApprovalActivity`), which yields a typed `not_armed` err unless the
  // owner-armed port was supplied at the composition root.
  const proposeKnowledgeApproval: ProposeKnowledgeApprovalPort = {
    propose: (plan, workspaceId) => activities.sourceProposeKnowledgeApproval(plan, workspaceId),
  };

  const deps: SourceIngestionDeps = {
    register,
    route,
    agent,
    validate,
    buildOutputs,
    commit,
    propose,
    index,
    health,
    runs: sandboxRunRepo(),
    clock: workflowClock,
    livingVault,
    proposeKnowledgeApproval,
  };

  return runSourceIngestion(input, deps);
}

// ---------------------------------------------------------------------------
// connector-sync-health workflow (16.2)
// ---------------------------------------------------------------------------

/**
 * The connector-sync-health workflow (§9 workflow 10): a THIN @temporalio wrapper that adapts the
 * activity proxies onto the {@link ConnectorSyncHealthDeps} port set and runs the pure
 * {@link runConnectorSyncHealth} driver inside the sandbox. `poll` delegates to the 16.2
 * `connectorPoll` activity (which resolves the 16.1 adapter + 15.1 bridge + backoff); the failure sink
 * routes through `surfaceFailure` (inv-5).
 *
 * DORMANT: the shipped default polls a connectors set enumerated from the ENABLED 14.2 instances —
 * EMPTY until arming — so a scheduled tick is a no-op (no fetch, no health). The `schedule` + `wakeDrain`
 * seams are IN-SANDBOX STUBS (mirroring `sandboxRunRepo`): `getBookkeeping → undefined` (first-run every
 * tick, no durable LIFE-2 catch-up) and a no-op drain. Phase-23 arming replaces BOTH with the real
 * DB-backed schedule bookkeeping + the §8 replay-safe wake-drain (a false-durable stub must NOT survive
 * into a firing schedule), and adds the live `ScheduleClient.createSchedule` START.
 */
export async function connectorSyncHealthWorkflow(
  input: ConnectorSyncHealthInput,
): Promise<ConnectorSyncHealthOutcome> {
  const poll: ConnectorPollPort = {
    poll: (connector) => activities.connectorPoll(connector),
  };
  // Phase-23 TODO #1: the REAL §8 replay-safe wake-drain. In-sandbox no-op stub — the shipped default
  // holds nothing to drain, and a pure `schedule` trigger never drains anyway.
  const wakeDrain: WakeDrainPort = {
    // `skipped: 0` is honest for THIS stub specifically: it drains nothing because it is a no-op,
    // not because 24.50's workspace gate diverted anything. When Phase-23 TODO #1 replaces this
    // with the real drain, `skipped` becomes a live count and a non-zero value means the pass was
    // bound to the wrong workspace — do not carry this literal 0 forward into that binding.
    drain: () => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0, skipped: 0 })),
  };
  const health: ConnectorSyncHealthHealthSink = {
    surface: (failure: ConnectorSyncHealthFailure) => activities.surfaceFailure(failure),
  };
  // Phase-23 TODO #1: the REAL DB-backed schedule bookkeeping (LIFE-2 durability). In-sandbox stub now —
  // getBookkeeping → undefined (a first-run every tick; no catch-up park), put → no-op. Dormant: a
  // false-durable bookkeeping must NOT survive into a firing schedule (Phase-23 TODO #2 = the live START).
  const schedule: ScheduleStore = {
    getBookkeeping: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  };
  const deps: ConnectorSyncHealthDeps = {
    poll,
    wakeDrain,
    health,
    runs: sandboxRunRepo(),
    schedule,
    clock: workflowClock,
  };
  return runConnectorSyncHealth(input, deps);
}

// ---------------------------------------------------------------------------
// 25.1 — output workflows (dailyBrief, periodReview, projectSync, crossCalendarScheduling)
// ---------------------------------------------------------------------------
//
// Same thin-wrapper shape as every driver above: adapt the activity proxies onto the driver's
// Deps port set, run the pure driver inside the sandbox. NONE of these four has a production
// dispatcher yet (no scheduler calls `client.workflow.start(...)` for them — that is 25.2-25.5's
// scheduling leg, gated default-OFF where built), so exposing them here only WIDENS the bundle;
// it changes no shipped behavior (NOTHING ARMS).

const dailyBriefValidator = createFieldsValidateActivity<BriefDraft>();
const reviewValidator = createFieldsValidateActivity<ReviewDraft>();
const crossCalendarValidator = createFieldsValidateActivity<
  FieldsDraft & { readonly windows: ProposedWindows["windows"] }
>();
const projectSyncValidator = createValidateNarrativePort();

/**
 * The daily-brief workflow (25.2). `validate` runs IN-SANDBOX (see the module-level import note);
 * every other port proxies through `outputWorkflowActivities`; `schedule` is the dormant
 * {@link sandboxScheduleStoreStub} (Phase-23 TODO — LIFE-2 catch-up bookkeeping is not yet durable).
 */
export async function dailyBriefWorkflow(input: DailyBriefInput): Promise<DailyBriefOutcome> {
  const refreshConnectors: RefreshConnectorsPort = {
    refresh: (ctx) => outputWorkflowActivities.dailyBriefRefreshConnectors(ctx),
  };
  const updateProjections: UpdateProjectionsPort = {
    update: (ctx) => outputWorkflowActivities.dailyBriefUpdateProjections(ctx),
  };
  const agent: RunBriefingAgentPort = {
    run: (ctx) => outputWorkflowActivities.dailyBriefRunAgent(ctx),
  };
  const validate: ValidateBriefPort = {
    validate: (draft) => dailyBriefValidator.validate(draft) as ReturnType<ValidateBriefPort["validate"]>,
  };
  const buildGlobal: BuildGlobalBriefPort = {
    build: (validated, projections, globalWorkspaceId) =>
      outputWorkflowActivities.dailyBriefBuildGlobal(validated, projections, globalWorkspaceId),
  };
  const buildWorkspace: BuildWorkspaceBriefPort = {
    build: (validated, workspaceId) => outputWorkflowActivities.dailyBriefBuildWorkspace(validated, workspaceId),
  };
  const commit: CommitBriefPort = {
    commit: (plan) => outputWorkflowActivities.dailyBriefCommit(plan),
  };
  const dashboard: UpdateDashboardPort = {
    update: (payload) => outputWorkflowActivities.dailyBriefUpdateDashboard(payload),
  };
  const notify: NotifyPort = {
    notify: (action, env) => outputWorkflowActivities.dailyBriefNotify(action, env),
  };
  const health: DailyBriefHealthSink = {
    surface: (failure: DailyBriefFailure) => outputWorkflowActivities.dailyBriefSurfaceFailure(failure),
  };

  const deps: DailyBriefDeps = {
    refreshConnectors,
    updateProjections,
    agent,
    validate,
    buildGlobal,
    buildWorkspace,
    commit,
    dashboard,
    notify,
    health,
    runs: sandboxRunRepo(),
    schedule: sandboxScheduleStoreStub(),
    clock: workflowClock,
  };

  return runDailyBrief(input, deps);
}

/**
 * The period-review workflow (25.2, weekly/monthly). Same shape as {@link dailyBriefWorkflow};
 * `validate` runs IN-SANDBOX; `schedule` is the same dormant stub.
 */
export async function periodReviewWorkflow(input: PeriodReviewInput): Promise<PeriodReviewOutcome> {
  const refreshConnectors: ReviewRefreshConnectorsPort = {
    refresh: (ctx) => outputWorkflowActivities.periodReviewRefreshConnectors(ctx),
  };
  const updateProjections: ReviewUpdateProjectionsPort = {
    update: (ctx) => outputWorkflowActivities.periodReviewUpdateProjections(ctx),
  };
  const agent: RunReviewAgentPort = {
    run: (ctx) => outputWorkflowActivities.periodReviewRunAgent(ctx),
  };
  const validate: ValidateReviewPort = {
    validate: (draft) => reviewValidator.validate(draft) as ReturnType<ValidateReviewPort["validate"]>,
  };
  const buildGlobal: BuildGlobalReviewPort = {
    build: (validated, projections, window, globalWorkspaceId) =>
      outputWorkflowActivities.periodReviewBuildGlobal(validated, projections, window, globalWorkspaceId),
  };
  const buildWorkspace: BuildWorkspaceReviewPort = {
    build: (validated, window, workspaceId) =>
      outputWorkflowActivities.periodReviewBuildWorkspace(validated, window, workspaceId),
  };
  const commit: CommitReviewPort = {
    commit: (plan) => outputWorkflowActivities.periodReviewCommit(plan),
  };
  const dashboard: ReviewUpdateDashboardPort = {
    update: (payload) => outputWorkflowActivities.periodReviewUpdateDashboard(payload),
  };
  const notify: ReviewNotifyPort = {
    notify: (action, env) => outputWorkflowActivities.periodReviewNotify(action, env),
  };
  const health: PeriodReviewHealthSink = {
    surface: (failure: PeriodReviewFailure) => outputWorkflowActivities.periodReviewSurfaceFailure(failure),
  };

  const deps: PeriodReviewDeps = {
    refreshConnectors,
    updateProjections,
    agent,
    validate,
    buildGlobal,
    buildWorkspace,
    commit,
    dashboard,
    notify,
    health,
    runs: sandboxRunRepo(),
    schedule: sandboxScheduleStoreStub(),
    clock: workflowClock,
  };

  return runPeriodReview(input, deps);
}

/**
 * The project-sync workflow (25.3). `validate` runs IN-SANDBOX via the pre-existing, tested
 * {@link createValidateNarrativePort} (real REQ-F-017 no-inference gate, not a stub). `registry`
 * proxies through the dedicated {@link projectSyncRegistryActivities} — see that proxy's own doc
 * comment for why it is a crossTerritoryNeed rather than dormant-by-construction here.
 */
export async function projectSyncWorkflow(input: ProjectSyncInput): Promise<ProjectSyncOutcome> {
  const registry: ResolveRegistryPort = {
    resolve: (ctx) => projectSyncRegistryActivities.projectSyncResolveRegistry(ctx),
  };
  const parse: ParseProgressPort = {
    parse: (ctx) => outputWorkflowActivities.projectSyncParseProgress(ctx),
  };
  const synthesize: SynthesizeNarrativePort = {
    synthesize: (ctx, progress) => outputWorkflowActivities.projectSyncSynthesizeNarrative(ctx, progress),
  };
  const validate: ValidateNarrativePort = {
    validate: (draft) => projectSyncValidator.validate(draft),
  };
  const buildOutputs: BuildSyncOutputsPort = {
    build: (validated, progress, workspaceId, identity, updatedAt) =>
      outputWorkflowActivities.projectSyncBuildOutputs(validated, progress, workspaceId, identity, updatedAt),
  };
  const commit: CommitStatusPort = {
    commit: (plan) => outputWorkflowActivities.projectSyncCommitStatus(plan),
  };
  const dashboard: ProjectSyncUpdateDashboardPort = {
    update: (payload) => outputWorkflowActivities.projectSyncUpdateDashboard(payload),
  };
  const propose: ProjectSyncProposeActionsPort = {
    propose: (action, env) => outputWorkflowActivities.projectSyncProposeActions(action, env),
  };
  const health: ProjectSyncHealthSink = {
    surface: (failure: ProjectSyncFailure) => outputWorkflowActivities.projectSyncSurfaceFailure(failure),
  };

  const deps: ProjectSyncDeps = {
    registry,
    parse,
    synthesize,
    validate,
    buildOutputs,
    commit,
    dashboard,
    propose,
    health,
    runs: sandboxRunRepo(),
    clock: workflowClock,
  };

  return runProjectSync(input, deps);
}

/**
 * The cross-calendar-scheduling workflow (25.4). `validate` runs IN-SANDBOX; `commit` is wired
 * (the port is optional on {@link CrossCalendarSchedulingDeps} but the activity exists, so this
 * wrapper always supplies it — a scheduling run may or may not exercise the commit leg, decided
 * inside the pure driver, not here).
 */
export async function crossCalendarSchedulingWorkflow(
  input: CrossCalendarSchedulingInput,
): Promise<CrossCalendarSchedulingOutcome> {
  const gather: GatherAvailabilityPort = {
    gather: (ctx) => outputWorkflowActivities.crossCalendarGatherAvailability(ctx),
  };
  const agent: ProposeWindowsAgentPort = {
    run: (ctx) => outputWorkflowActivities.crossCalendarProposeWindowsAgent(ctx),
  };
  const validate: ValidateProposalPort = {
    validate: (proposal) =>
      crossCalendarValidator.validate(proposal) as ReturnType<ValidateProposalPort["validate"]>,
  };
  const buildOutputs: BuildSchedulingOutputsPort = {
    build: (validated, organizerWorkspaceId) =>
      outputWorkflowActivities.crossCalendarBuildOutputs(validated, organizerWorkspaceId),
  };
  const classify: ClassifyActionPort = {
    classify: (action, organizerWorkspaceId) =>
      outputWorkflowActivities.crossCalendarClassifyAction(action, organizerWorkspaceId),
  };
  const autoCreate: AutoCreateEventPort = {
    create: (action, env) => outputWorkflowActivities.crossCalendarAutoCreateEvent(action, env),
  };
  const routeToApproval: RouteToApprovalPort = {
    route: (action, env) => outputWorkflowActivities.crossCalendarRouteToApproval(action, env),
  };
  const commit: CommitSchedulingNotePort = {
    commit: (plan) => outputWorkflowActivities.crossCalendarCommitNote(plan),
  };
  const health: SchedulingHealthSink = {
    surface: (failure: SchedulingWorkflowFailure) => outputWorkflowActivities.crossCalendarSurfaceFailure(failure),
  };

  const deps: CrossCalendarSchedulingDeps = {
    gather,
    agent,
    validate,
    buildOutputs,
    classify,
    autoCreate,
    routeToApproval,
    commit,
    health,
    runs: sandboxRunRepo(),
    clock: workflowClock,
  };

  return runCrossCalendarScheduling(input, deps);
}
