# Phase-15 reachability audit — WORKER area

- **Area:** worker (`apps/worker`, `packages/workflows`, `packages/db` worker-consumed exports)
- **HEAD:** `1461c815` — "docs(arch+tasks): 15.8 round — G60 closed; Phase-15 spine complete"
- **Scope:** Phase-15-ADDED exports only (commits `a6190122`→`bf33b669`); Phase-14-and-earlier symbols trusted unless a Phase-15 slice touched their wiring.
- **Method:** graphify + codegraph callers/context to enumerate + trace; targeted grep/read to confirm composition-root wiring (boot.ts / buildActivities.ts / registerWorker.ts / api router). Test/fixture/mock references NOT counted as reachable.
- **Verdict: CLEAR.** 0 UNDOCUMENTED unreachable symbols. Every dormant seam maps to a documented Lesson-11 waiver (connectorPoll binding = Phase-16 · re-scope-by-reroute-target = Phase-16 · real external transport = Phase-21).

## Production entry points (worker area)

1. **`bootWorker()`** — `apps/worker/src/boot.ts:1104` — LIVE control-plane composition root.
2. **`startApiServer()`** — `apps/worker/src/api/mount.ts:165` — tRPC command/query router (loopback), reached from `bootWorker`. Mounts `buildCommandRouter` (`commands.ts:251`) incl. the `disposeTriage` procedure (`commands.ts:286`).
3. **Temporal worker registration** — `bootWorker` → `makeProofSpineRegisterHook` (`registerWorker.ts:339`) handed to `bootstrapWorker` on the **gated-on** Temporal-connect path (boot.ts:175,628; `buildProofSpineParams` thunk boot.ts:621) → `buildRegisteredActivities` (`registerWorker.ts:211`) → `buildProofSpineActivities` (`buildActivities.ts:319`) → registers activity bundle + workflows `{sourceIngestionWorkflow, meetingCloseoutWorkflow, ingestionTriageWorkflow, approvalFlowWorkflow}` (`temporal/workflows.ts`). A gated-on path counts as a live wire (runtime toggle, not a missing edge).

## Classification

### REACHABLE — proven production reference to an entry point

| Slice | Symbol (file:line) | Production path proven |
|---|---|---|
| 15.8 | `createRegistryValidatedRerouteTarget` (`dispositionDurable.ts`, exp) | `bootWorker` boot.ts:1174 → passed as `rerouteTargets` to `disposeTriageCommand` (`commands.ts:291`) → mounted at `disposeTriage` procedure (`commands.ts:286`) → reached via `startApiServer`. Codegraph caller = `bootWorker`. |
| 15.8 | `RerouteTarget` / `RerouteTargetValidatorPort` / `REROUTE_DISPOSITION` + deps | Consumed by the above validator + `disposeTriageCommand` input validation (`triageCommands.ts:134`). |
| 15.5 | `createReenterRunner` (`buildActivities.ts:589`) | Bound into `buildProofSpineActivities` (registered) as `ingestionRunner`; reached via `ingestionTriageWorkflow` (triggered by `disposeTriage` → `createDbTriagePort` boot.ts:1168 → `triageDispatch`). |
| 15.5 | `createDurableDispositionStore` / `createDurableParkedReader` / `createRegistryValidatedRescope` (`buildActivities.ts:573-611`) | Composed into the registered activity bundle; `parkedReader` buildActivities:580, `rescope` buildActivities:778. Reached via the registered ingestion-triage activities. |
| 15.5 | `sourceDisposition` table + `SourceDispositionRepository` | Implemented in both db adapters (postgres/sqlite index.ts) + consumed by `dispositionDurable.ts` (the durable store above). |
| G5 | `createDurableMeetingParkPort` (`dispositionDurable.ts:236`) | Bound in `buildActivities.ts:573` → feeds the `meetingPark` activity leaf → consumed by `runMeetingCloseout` (registered `meetingCloseoutWorkflow`). Reachable-as-registered activity. (End-to-end *external trigger* is dormant — see WAIVERED 15.9.) |
| 15.7 | `sourcePropose` activity (`buildActivities.ts:298,794`) | `sourcePropose: (action,env) => propose.propose(action,env)` — real Tool Gateway `propose`; registered activity + consumed by `sourceIngestionWorkflow` (`workflows.ts:411`). (Real external SEND tail = Phase-21 waiver.) |
| 15.3 | note-body projection (`sourceNotePath.ts`, `registerSource` path) | Real `SourceEnvelope.body` projected on the live `registerSource`→note path (the registered `sourceRegister` activity; killed the C1 placeholder). |
| 15.6 | `SOURCE_NOTE_SUBTREE` (`buildActivities.ts`, exp) | Used at `sourceNotePath.ts:94` to build the note path on the live projection path. |

### WAIVERED — dormant-by-design, documented waiver (NOT gaps)

| Slice | Symbol (file:line) | Status + waiver |
|---|---|---|
| 15.1 | `createConnectorIngestionBridge` (`connectorIngestionBridge.ts:103`) + `ConnectorIngestion*` types | **No production caller** (codegraph: 0 callers; grep: only self + tests). Waiver: **connectorPoll/schedule BINDING = Phase-16** — `connectorPoll` has no prod usage today; wiring the bridge now would be dormant-on-dormant. Commit `a6190122` itself landed it "fakes; reachability-waivered". |
| 15.9 | `dispatchMeetingCloseout` (`temporal/dispatchMeetingCloseout.ts:57`) + `ConnectorMeetingDispatch` + `MEETING_CLOSEOUT_WORKFLOW_TYPE` | **No production composition-root injection** — the meeting-closeout *starter* is only consumable via `createConnectorIngestionBridge`'s `dispatchMeeting` seam (line 161), which itself has no prod caller. Same waiver as 15.1 (connectorPoll binding = Phase-16). NB: the `meetingCloseoutWorkflow` it *would* start IS registered on the worker; only its external trigger is dormant. |
| 15.4 | persisted `seenContentHash` store: `seenContentHash` table (pg+sqlite) + `SeenContentHashRepository` (`packages/db`) | **ZERO production callsites** of the repo method (`grep repos.seenContentHash` = empty). Its only intended live consumer is the bridge dedupe probe `registerDeps.seenContentHash` (waivered 15.1); the live C1 path deliberately hardwires `seenContentHash: () => false` with a documented comment (`buildActivities.ts:621` "no persisted dedupe store in C1"). Dormant-on-dormant under the connectorPoll (Phase-16) waiver. **See NOTE below.** |
| 15.8 | re-scope-by-reroute-target seam | The `disposeTriage` reroute *validation* is live (`createRegistryValidatedRerouteTarget`, above), but the validated target actually **re-scoping the re-enter runner** is the documented **Phase-16 follow-up** (Lesson 11). Validator reachable; downstream re-scope wire deferred. |
| 15.7 | real external transport tail | `propose.propose` builds the `ExternalWriteEnvelope`; the real external SEND is **Phase-21**. Propose path live; transport dormant (documented). |

## NOTE to orchestrator (not a Phase-15 blocker)

The persisted **15.4 `seenContentHash` store has NO production consumer at all today** — not even a dormant-but-wired one. Its sole intended consumer (`createConnectorIngestionBridge`'s dedupe probe) also has zero prod callers. It is validly covered by the connectorPoll (Phase-16) waiver, but Phase-16 must wire **BOTH** the connector bridge **AND** its `seenContentHash` dep, else the store stays permanently dead. Recommend an explicit Phase-16 wiring task line-item so the store does not silently rot.

## Summary for orchestrator

- Exports audited: ~38 new Phase-15 exported symbols across 11 slices (13 load-bearing runtime seams).
- REACHABLE: 9 seams (all proven to `bootWorker`/`startApiServer`/registered Temporal worker).
- WAIVERED (documented dormant): 5 seams — 3 under connectorPoll-binding=Phase-16 (15.1 bridge, 15.9 meeting starter, 15.4 dedupe store), 1 under re-scope-by-reroute=Phase-16 (15.8 sub-seam), 1 under real-transport=Phase-21 (15.7 tail).
- UNDOCUMENTED unreachable / falsely-claimed-live: **0**.
- Wiring tasks recommended: 0 for Phase-15 exit; 1 Phase-16 tracking note (wire 15.4 store's consumer alongside the connector bridge).
- **Phase-exit reachability gate: CLEAR.**
