// @sow/worker — the WORKFLOWSPATH MODULE (the Temporal sandbox side of the proof
// spine). This is the ONLY module @temporalio bundles into the deterministic V8
// workflow sandbox (bundleWorkflowCode({ workflowsPath: require.resolve("./workflows") })).
//
// ★ SANDBOX PURITY (root CLAUDE.md two-layer split — the load-bearing constraint):
// This file imports ONLY
//   • @temporalio/workflow            — proxyActivities (the ONLY way a workflow
//                                        reaches a side effect: everything is an
//                                        activity call scheduled on the task queue);
//   • the three PURE drivers + their port/Deps/Input types from @sow/workflows —
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
// WHAT EACH WRAPPER DOES: for one of the three fully-wireable drivers it
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

import { runMeetingCloseout } from "@sow/workflows/workflows/meetingCloseout";
import { runApprovalFlow } from "@sow/workflows/workflows/approvalFlow";
import { runIngestionTriage } from "@sow/workflows/workflows/ingestionTriage";
// make-it-real C1: the previously-uncalled §9 source-ingestion driver, deep-imported
// (the barrel re-exports the activity set — node:crypto etc.) so the sandbox graph
// stays clean, exactly like the three drivers above.
import { runSourceIngestion } from "@sow/workflows/workflows/sourceIngestion";
// The validate gate is PURE + SYNC (no-inference + schema gate) — it runs IN-SANDBOX,
// not as a proxied activity, so the driver's synchronous ValidateExtractionPort
// contract is honored (an activity proxy is always async).
import { createValidateActivity } from "@sow/workflows/activities/validateCloseout";
import type { MeetingSchemaGate } from "@sow/workflows/activities/validateCloseout";
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
 * contract requires. The schema gate is the deterministic pass-through the
 * composition root also uses (the structural ajv gate is a later wave); the real
 * safety-bearing half — validateNoInference (REQ-F-017) — runs unchanged and rejects
 * an inferred owner/date before any commit.
 */
const passThroughSchemaGate: MeetingSchemaGate = () => ok(undefined);
const validate: ValidateExtractionPort = createValidateActivity({
  schemaGate: passThroughSchemaGate,
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
  };

  return runSourceIngestion(input, deps);
}
