# Worker-Wiring Reachability Audit — Phase-7 Waiver Discharge

**Date:** 2026-07-02
**Auditor:** reachability-auditor
**Subject:** Worker-wiring wave (WW-1 + WW-2/3), commits d755c7b + 11d7e6b
**Area:** `apps/worker` + `packages/workflows`
**Gate type:** Phase-exit reachability (discharges Phase-7 waiver: "re-run when worker wiring lands")

---

## Production Entry Point Chain

The sole production entry point for the proof spine is:

```
bootstrapWorker (apps/worker/src/temporal/worker.ts:197)
  └─ options.onConnected(connection, taskQueue)          [RegisterWorkerHook — live path]
       └─ makeProofSpineRegisterHook (registerWorker.ts:339)
            └─ assembleBackends (composition/backends.ts)
            └─ buildRegisteredActivities (registerWorker.ts:211)
                 └─ buildProofSpineActivities (composition/buildActivities.ts:221)
            └─ createProofSpineWorker (registerWorker.ts:249)
                 └─ Worker.create({ workflowsPath: proofSpineWorkflowsPath(), activities })
                      └─ workflowsPath → apps/worker/src/temporal/workflows.ts
                           ├─ meetingCloseoutWorkflow (export, line 224)
                           ├─ approvalFlowWorkflow (export, line 273)
                           └─ ingestionTriageWorkflow (export, line 328)
```

The `onConnected` hook is a callback dispatch (dynamic); it is registered at the call site when
`bootstrapWorker` is invoked with `makeProofSpineRegisterHook(...)` as `options.onConnected`. The
static call graph shows no path from `bootstrapWorker` to `runMeetingCloseout` because the
callback boundary breaks static analysis — this is expected and correct; the dynamic path is
confirmed by the SOW_TEMPORAL integration test executing all 3 workflows live (4/4 passes).

---

## The 3 Wired Drivers — REACHABLE

Each @temporalio sandbox wrapper exports the workflow function, imports the pure driver, and
delegates to it. Worker.create registers the whole module via `workflowsPath`, so every export
in `workflows.ts` is registered on the task queue.

| Driver | Wrapper (workflows.ts) | Pure driver called | Status |
|--------|------------------------|-------------------|--------|
| meeting-closeout | `meetingCloseoutWorkflow` (line 224) | `runMeetingCloseout` | **REACHABLE** |
| approval-flow | `approvalFlowWorkflow` (line 273) | `runApprovalFlow` | **REACHABLE** |
| ingestion-triage | `ingestionTriageWorkflow` (line 328) | `runIngestionTriage` | **REACHABLE** |

### Activity factories wired in `buildProofSpineActivities` (REACHABLE via composition root)

14 activity factories + 1 projection are bound by `buildProofSpineActivities`
(`composition/buildActivities.ts:221`):

**meeting-closeout flow (7 activities):**
- `createCorrelateActivity` → `meetingCorrelate`
- `createRunAgentJobActivity` → `meetingRunAgentJob`
- `createValidateActivity` → `meetingValidate` (also run in-sandbox as `validate` seam)
- `createBuildOutputsActivity` + `meetingOutputsProjection` → `meetingBuildOutputs`
- `createCommitActivity` → `meetingCommit` (real KnowledgeWriter)
- `createProposeActivity` → `meetingPropose` (real Tool Gateway)
- `createReindexActivity` → `meetingReindex` (deterministic stub IndexApplyClient)

**approval-flow (4 activities):**
- `createRecordPendingActivity` → `approvalRecordPending`
- `createSurfaceCardActivity` → `approvalSurfaceCard`
- `createApplyTransitionActivity` → `approvalApply` (real ApprovalRepository CAS)
- `createDispatchApprovedActivity` → `approvalDispatchApproved`

**ingestion-triage (3 activities):**
- `createRecordDispositionActivity` → `triageRecordDisposition`
- `createRescopeSourceActivity` → `triageRescopeSource`
- `createReenterIngestionActivity` → `triageReenter`

**Cross-flow (1 activity):**
- `surfaceWorkflowFailure` → `surfaceFailure` (inv-5 health/outbox sink for all 3 flows)

### Integration test citation

`apps/worker/test/integration/proof-spine.test.ts` (SOW_TEMPORAL-gated, `describe.skipIf(!SOW_TEMPORAL)`):
- **(a)** meeting-closeout happy path → state `knowledge_committed` or `summarized` + Markdown note in vault
- **(b)** idempotency — same plan identity twice → exactly 1 committed note (DB-backed KW replay)
- **(c)** approval-flow exactly-once — double apply → 1 `approved` approval in DB
- **(d)** ingestion-triage replay — second drive `dispositionNoop: true`

All 4 live against a real `TestWorkflowEnvironment` + real sqlite DB + real filesystem vault +
real `buildProofSpineActivities` composition root. 4/4 pass (`SOW_TEMPORAL=1`).

---

## Reachable-vs-Unreachable Gap Table

### REACHABLE via worker production entry point

| Symbol | File | Wired via |
|--------|------|-----------|
| `bootstrapWorker` | `apps/worker/src/temporal/worker.ts` | live process boot |
| `makeProofSpineRegisterHook` | `apps/worker/src/temporal/registerWorker.ts` | passed as `onConnected` |
| `buildRegisteredActivities` | `apps/worker/src/temporal/registerWorker.ts` | called in register hook |
| `buildProofSpineActivities` | `apps/worker/src/composition/buildActivities.ts` | called by `buildRegisteredActivities` |
| `assembleBackends` | `apps/worker/src/composition/backends.ts` | called in register hook |
| `createProofSpineWorker` | `apps/worker/src/temporal/registerWorker.ts` | called in register hook |
| `meetingCloseoutWorkflow` | `apps/worker/src/temporal/workflows.ts` | registered via `workflowsPath` |
| `approvalFlowWorkflow` | `apps/worker/src/temporal/workflows.ts` | registered via `workflowsPath` |
| `ingestionTriageWorkflow` | `apps/worker/src/temporal/workflows.ts` | registered via `workflowsPath` |
| `runMeetingCloseout` | `packages/workflows/src/workflows/meetingCloseout.ts` | called by `meetingCloseoutWorkflow` |
| `runApprovalFlow` | `packages/workflows/src/workflows/approvalFlow.ts` | called by `approvalFlowWorkflow` |
| `runIngestionTriage` | `packages/workflows/src/workflows/ingestionTriage.ts` | called by `ingestionTriageWorkflow` |
| `createCorrelateActivity` + port | `packages/workflows/src/activities/correlateMeeting.ts` | `buildProofSpineActivities` |
| `createRunAgentJobActivity` + port | `packages/workflows/src/activities/runAgentJob.ts` | `buildProofSpineActivities` |
| `createValidateActivity` + port | `packages/workflows/src/activities/validateCloseout.ts` | `buildProofSpineActivities` |
| `createBuildOutputsActivity` + `meetingOutputsProjection` | `packages/workflows/src/activities/buildOutputs.ts` + `projections/meetingOutputs.ts` | `buildProofSpineActivities` |
| `createCommitActivity` + port | `packages/workflows/src/activities/commitKnowledge.ts` | `buildProofSpineActivities` |
| `createProposeActivity` + port | `packages/workflows/src/activities/proposeExternalActions.ts` | `buildProofSpineActivities` |
| `createReindexActivity` + port | `packages/workflows/src/activities/reindexGbrain.ts` | `buildProofSpineActivities` |
| `createRecordPendingActivity` + port | `packages/workflows/src/activities/approvalTransition.ts` | `buildProofSpineActivities` |
| `createSurfaceCardActivity` + port | `packages/workflows/src/activities/approvalTransition.ts` | `buildProofSpineActivities` |
| `createApplyTransitionActivity` + port | `packages/workflows/src/activities/approvalTransition.ts` | `buildProofSpineActivities` |
| `createDispatchApprovedActivity` + port | `packages/workflows/src/activities/approvalTransition.ts` | `buildProofSpineActivities` |
| `createRecordDispositionActivity` + port | `packages/workflows/src/activities/disposition.ts` | `buildProofSpineActivities` |
| `createRescopeSourceActivity` + port | `packages/workflows/src/activities/disposition.ts` | `buildProofSpineActivities` |
| `createReenterIngestionActivity` + port | `packages/workflows/src/activities/disposition.ts` | `buildProofSpineActivities` |
| `surfaceWorkflowFailure` | `packages/workflows/src/activities/healthItem.ts` | `buildProofSpineActivities` |
| `resolveRun` | `packages/workflows/src/runtime/idempotency.ts` | called by all 3 drivers |

---

### UNREACHABLE from production — FAKE-ONLY / EXPLICITLY DEFERRED by phase

The following are exported from `packages/workflows/src/index.ts` (or sub-modules) but have
**zero production-path imports** in `apps/worker/src/` (confirmed: no match in non-test files).
All are explicitly deferred per the Phase-7 design:

> Phase 7 shipped 13 pure drivers; the 3 fully-wireable ones were wired this wave.
> The other 10 drivers depend on 40 fake-only ports and are deferred by natural phase
> (agent-runners → eval/Phase 12; read-model/dashboard/notify → Phase 8/9).

#### Deferred workflow drivers (10) — NOTE, not a gap

| Symbol | File | Deferred to phase |
|--------|------|-------------------|
| `runCrossCalendarScheduling` | `packages/workflows/src/workflows/crossCalendarScheduling.ts` | Phase 8/9 (scheduling UI + read-model) |
| `runDailyBrief` | `packages/workflows/src/workflows/dailyBrief.ts` | Phase 8/9 (dashboard/notify ports) |
| `runPeriodReview` | `packages/workflows/src/workflows/periodReview.ts` | Phase 8/9 (dashboard/notify ports) |
| `runSourceIngestion` | `packages/workflows/src/workflows/sourceIngestion.ts` | Phase 9 (connector + ingestion pipeline) |
| `runSystemHealthSurfacing` | `packages/workflows/src/workflows/systemHealthSurfacing.ts` | Phase 8/9 (read-model/notify) |
| `runConnectorSyncHealth` | `packages/workflows/src/workflows/connectorSyncHealth.ts` | Phase 9 (connector transport) |
| `runCopilotQa` | `packages/workflows/src/workflows/copilotQa.ts` | Phase 12 (agent-runner transport) |
| `runDeletionSaga` | `packages/workflows/src/workflows/deletionSaga.ts` | Phase 9/10 (deletion pipeline) |
| `runHermesAutomation` | `packages/workflows/src/workflows/hermesAutomation.ts` | Phase 12 (agent-runner/Hermes transport) |
| `runNotebookLmSync` | `packages/workflows/src/workflows/notebookLmSync.ts` | Phase 12 (agent-runner transport) |
| `runProjectSync` | `packages/workflows/src/workflows/projectSync.ts` | Phase 9 (project-sync ports) |

#### Deferred activity factories (wired to fake-only / stub ports) — NOTE, not a gap

| Symbol | File | Status | Deferred to phase |
|--------|------|--------|-------------------|
| `createConnectorPollActivity` | `connectorPoll.ts` | fake-only (no real connector transport) | Phase 9 |
| `createBuildGclProjectionActivity` | `buildGclProjection.ts` | fake-only (no real GCL store) | Phase 9 |
| `createRegisterSourceActivity` | `registerSource.ts` | fake-only (no real source registry) | Phase 9 |
| `createProposeWindowsActivity` | `proposeWindows.ts` | fake-only (no real window store) | Phase 8/9 |
| `createRouteSourceActivity` | `routeSource.ts` | fake-only (no real source router) | Phase 9 |
| `createDeletionPlanActivity` + `createExecuteDeletionPlanActivity` | `deletionPlan.ts` | fake-only | Phase 9/10 |
| `createCompensateDeletionActivity` + siblings | `compensateDeletion.ts` | fake-only | Phase 9/10 |
| `createHermesRouteActivity` | `hermesRoute.ts` | fake-only (no Hermes transport) | Phase 12 |
| `createAssembleNotebookDocsActivity` | `assembleNotebookDocs.ts` | fake-only | Phase 12 |
| `createDeterministicProgressActivity` + `createDeterministicCheckpointActivity` | `deterministicProgress.ts` | fake-only | Phase 12 |
| `createScopedRetrievalActivity` + `createProjectionScopeActivity` | `scopedRetrieval.ts` | fake-only (no real retrieval transport) | Phase 12 |
| `createPeriodWindowActivity` (exported type-only helpers) | `periodWindow.ts` | fake-only | Phase 8/9 |

---

## Summary

```
reachability-auditor: apps/worker + packages/workflows (worker-wiring wave)
  Wired drivers audited: 3 (meeting-closeout, approval-flow, ingestion-triage)
  REACHABLE (production entry point → driver confirmed): 3/3 drivers
  Activity factories wired in composition root: 15 (14 create* + meetingOutputsProjection)
  Workflow wrappers registered via workflowsPath: 3

  Deferred drivers (explicitly documented, test-only): 10
  Deferred activity factories (fake-only / no real transport): 12 factory groups

  SOW_TEMPORAL integration test: 4/4 live runs covering all 3 wired paths

Phase-exit gate: CLEAR
  — The 3 wired paths are fully reachable from the production entry point.
  — The deferred gap (10 drivers + ~12 factory groups) is honestly documented
    by phase and depends on fake-only ports; no silent unreachable cap.
  — Phase-7 reachability waiver DISCHARGED.
```
