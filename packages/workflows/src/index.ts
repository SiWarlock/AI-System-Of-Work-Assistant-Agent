// @sow/workflows — §9 Temporal Workflows & Automation (the durable integration spine).
//
// Two-layer design:
//   • src/runtime/       PURE, deterministic lifecycle logic (single-active lease
//                        decision, durable-schedule catch-up, clock-jump-safe
//                        bookkeeping, WorkflowRun idempotency, in-flight resume +
//                        §8 external-write-envelope reuse, snooze/deferral timers).
//                        No @temporalio, no node:crypto, no I/O — Vitest-unit-tested
//                        against injected fakes.
//   • src/ports/         Activity port interfaces the pure workflow drivers call.
//   • src/activities/    Activity implementations (call real gateway / KnowledgeWriter
//                        / Broker adapters; do I/O; node:crypto allowed). Tested with
//                        injected fakes.
//   • src/workflows/     PURE per-workflow control DRIVERS over Phase-1 @sow/domain
//                        state machines + injected activity ports — where each
//                        workflow's decision logic lives + is unit-tested. No
//                        @temporalio, no node:crypto, no Date.now()/Math.random().
//
// Synthesis-finalized barrel: flat `export *` over runtime/ + ports/ + activities/ +
// workflows/ (NOT test/support). Every module-level symbol name is now unique across
// the package, so the flat re-export is unambiguous.
//
// COLLISION RESOLVED (synthesis): src/workflows/periodReview.ts declared its OWN
// workflow-local port types (RefreshConnectors*, UpdateProjections*, UpdateDashboard*,
// Notify*) whose names collided with the CENTRAL port declarations in
// src/ports/dailyBrief.ts (structurally distinct — periodReview's carry
// PeriodReviewContext; dailyBrief's carry DailyBriefContext). The LESS-CENTRAL ones
// (inline in the periodReview workflow file, not a dedicated ports/ file) were renamed
// with a `Review` prefix (ReviewRefreshConnectorsPort, ReviewUpdateProjectionsPort,
// ReviewUpdateDashboardPort, ReviewNotifyPort, + their *Error/*ErrorCode/*Result
// siblings). dailyBrief's names are kept as the canonical port surface.
//
// COLLISIONS RESOLVED (synthesis, 7.13–7.18 workflows-B): the newer, less-central
// workflow-B modules were renamed where a name met an already-committed central
// surface (structurally distinct in every case — different context/candidate types):
//   • ports/projectSync.ts  — Propose{Result,ActionsPort,Error,ErrorCode} collided
//     with the CENTRAL 7.6 ports/meetingCloseout.ts, UpdateDashboard{Port,Error,
//     ErrorCode} with ports/dailyBrief.ts, and Synthesize{Failure,FailureCode} with
//     ports/copilotQa.ts — all prefixed `ProjectSync…` (projectSync keeps only its
//     own-domain names). meetingCloseout/dailyBrief/copilotQa keep the base names.
//   • ports/copilotQa.ts    — RouteToApprovalPort collided with the CENTRAL 7.11
//     ports/crossCalendarScheduling.ts → renamed `QaRouteToApprovalPort`.
//   • activities/scopedRetrieval.ts — GateRejection / ProjectionGate collided with
//     the committed activities/buildGclProjection.ts → renamed `ScopedGateRejection`
//     / `ScopedProjectionGate` (scopedRetrieval carries CandidateGlobalProjection;
//     buildGclProjection carries CandidateProjection).
//
// Deep subpath imports (`@sow/workflows/ports/operational`,
// `@sow/workflows/runtime/taskQueue`) remain available via the package `exports` map
// ("./*") and are used by @sow/worker.

// --- src/ports/ — activity port surfaces ------------------------------------
export * from "./ports/operational";
export * from "./ports/meetingCloseout";
export * from "./ports/approvalFlow";
export * from "./ports/crossCalendarScheduling";
export * from "./ports/dailyBrief";
export * from "./ports/ingestionTriage";
export * from "./ports/sourceIngestion";
// 7.13–7.18 workflows-B port surfaces
export * from "./ports/copilotQa";
export * from "./ports/projectSync";

// --- src/runtime/ — PURE deterministic lifecycle logic ----------------------
export * from "./runtime/taskQueue";
export * from "./runtime/clock";
export * from "./runtime/schedule";
export * from "./runtime/catchUpWindow";
export * from "./runtime/workflowRun";
export * from "./runtime/idempotency";
export * from "./runtime/resume";
export * from "./runtime/wakeHooks";
export * from "./runtime/snoozeTimer";

// --- src/activities/ — worker-side activity implementations -----------------
export * from "./activities/healthItem";
export * from "./activities/envelopeReuse";
// 7.6 MEETING-CLOSEOUT adapters
export * from "./activities/correlateMeeting";
export * from "./activities/runAgentJob";
export * from "./activities/validateCloseout";
export * from "./activities/buildOutputs";
export * from "./activities/projections/meetingOutputs";
export * from "./activities/commitKnowledge";
export * from "./activities/proposeExternalActions";
export * from "./activities/reindexGbrain";
// 7.7–7.12 activity adapters
export * from "./activities/approvalTransition";
export * from "./activities/buildGclProjection";
export * from "./activities/disposition";
export * from "./activities/periodWindow";
export * from "./activities/proposeWindows";
export * from "./activities/registerSource";
export * from "./activities/routeSource";
// 7.13–7.18 workflows-B activity adapters
export * from "./activities/connectorPoll";
export * from "./activities/scopedRetrieval";
export * from "./activities/deletionPlan";
export * from "./activities/compensateDeletion";
export * from "./activities/hermesRoute";
export * from "./activities/assembleNotebookDocs";
export * from "./activities/deterministicProgress";
export * from "./activities/projectDashboard";
export * from "./activities/validateNarrative";
export * from "./activities/projections/projectSyncOutputs";

// --- src/workflows/ — PURE orchestration drivers ----------------------------
export * from "./workflows/systemHealthSurfacing";
// 7.6 MEETING-CLOSEOUT
export * from "./workflows/meetingCloseout";
// 7.7–7.12 workflows A
export * from "./workflows/approvalFlow";
export * from "./workflows/crossCalendarScheduling";
export * from "./workflows/dailyBrief";
export * from "./workflows/ingestionTriage";
export * from "./workflows/periodReview";
export * from "./workflows/sourceIngestion";
// 7.13–7.18 workflows B
export * from "./workflows/connectorSyncHealth";
export * from "./workflows/copilotQa";
export * from "./workflows/deletionSaga";
export * from "./workflows/hermesAutomation";
export * from "./workflows/notebookLmSync";
export * from "./workflows/projectSync";
