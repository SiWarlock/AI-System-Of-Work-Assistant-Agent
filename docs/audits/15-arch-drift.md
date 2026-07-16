# Phase 15 — Architecture-drift audit (spec-vs-code, phase-exit gate)

- **Phase:** 15 — Ingestion Spine Plumbing + Human Routing-Resolution (§19.2)
- **Repo HEAD:** `1461c815`
- **Auditor:** arch-drift-auditor (read-only; findings, not edits)
- **Anchors dispatched:** §19.2 (primary), §9 (workflows 1/4/5), §6 (KW note projection), §8 (read→register bridge + meeting dispatcher + external-write propose), §4 (durable dedupe + disposition stores), §11 (Ingestion Inbox reroute UI); Appendix A models: SourceEnvelope, RegisterSourceInput, MeetingCloseoutInput, ProposedAction, ExternalWriteEnvelope, triage-disposition `target {workspaceId, projectId?}`.
- **Method:** codegraph/graphify to locate implementing symbols; verbatim source read of the key symbols; Appendix-A models verified by their green schema-snapshot tests (verified-by-test shortcut); documented dormancy waivers (Lesson 11) treated as NOT drift per dispatch.
- **Verdict:** **CLEAR** — 0 DRIFT findings. 1 STALE-DOC note, 0 ambiguous.

---

## §19.2 — Ingestion Spine Plumbing + Human Routing-Resolution (primary)

| # | Contract statement | Verdict | Evidence |
|---|---|---|---|
| 1 | `onRecords → RegisterSourceInput → dispatchSourceIngestion` bridge; scoped fields from BOUND instance, nothing from `record.payload` | VERIFIED | `apps/worker/src/composition/connectorIngestionBridge.ts:129-201` (input built from `binding.*`, `contentHash` from record; `src:${ws}:${contentHash}` key) |
| 2 | Production meeting-closeout dispatcher `dispatchMeetingCloseout` (analog of `dispatchSourceIngestion`) starts `meetingCloseoutWorkflow` | VERIFIED | `apps/worker/src/temporal/dispatchMeetingCloseout.ts:57-108`; `MEETING_CLOSEOUT_WORKFLOW_TYPE` L37 |
| 3 | Threads extracted body text through `SourceEnvelope` (add body field) | VERIFIED-BY-TEST | `source-envelope.snap` includes `body`; `test/models/source-envelope.test.ts` green (23 tests) |
| 4 | Projects note body/frontmatter from the validated extraction (kills the `"source ingestion (C1)"` placeholder) | VERIFIED | `apps/worker/src/composition/buildActivities.ts:659-716` — `body` written verbatim (L699), honest degrade `_No extracted content yet._` (L658), placeholder removed (comment L657) |
| 5 | Persisted `seenContentHash` dedupe store (Flow-4 / REQ-F-010) | VERIFIED | migrations `packages/db/migrations/{sqlite,pg}/0010_seen_content_hash.sql`; `SeenContentHashRepository` `packages/db/src/repositories/interfaces.ts:371-397` |
| 6 | Parked sources re-enterable, reusing the same idempotency key (replay-safe) | VERIFIED | `SourceDispositionRepository` `interfaces.ts:407-441`; reenter reuses key `buildActivities.ts:586-612`; command reuses key verbatim `triageCommands.ts:164-175` |
| 7 | Auto-ingest does not re-fire on its own `.md` output | VERIFIED | `SOURCE_NOTE_SUBTREE="sources"` `sourceNotePath.ts:48`; watcher exclusion via same constant (worker Lesson 37) |
| 8 | Human routing-resolution: low-confidence "which project" → reroute-to-project + re-drive (not accept/reject) | VERIFIED | `disposeTriageCommand` `triageCommands.ts:134-180`; `createRegistryValidatedRerouteTarget` `dispositionDurable.ts:159-183` |
| 9 | Invariants: REQ-F-017 no-inference / replay-safe key reuse / KW sole-writer + WS-8 path guard | VERIFIED | `registerSource` gate `source-register.ts:78-108`; `deriveSourceNotePath` WS-8 segment guard `sourceNotePath.ts:83-95`; commit via `applyPlan` `buildActivities.ts:731-739` |
| 10 | Kind: pure-build (fakes only; no network, no tokenRef bound) | VERIFIED | bridge fakes-only (type-only Temporal import, injected `dispatch`); worker Lessons 33/38/39 |

### §19.2 "landed" notes (2026-07-15/16)

| # | Statement | Verdict | Evidence |
|---|---|---|---|
| 15.9-a | `dispatchMeetingCloseout` workflowId = `meeting:${workspaceId}:${recordId}`, Temporal `REJECT_DUPLICATE` | VERIFIED | `connectorIngestionBridge.ts:165` `meetingKey = meeting:${binding.workspaceId}:${record.recordId}` → `run.idempotencyKey`; `createTemporalClientStartRun` `dispatchSourceIngestion.ts:187` `workflowIdReusePolicy:"REJECT_DUPLICATE"` |
| 15.9-b | Bridge discriminates on BOUND instance `binding.kind` (never record/payload); `meeting`→meeting dispatcher, default `source`→registerSource | VERIFIED | `connectorIngestionBridge.ts:159-203` |
| 15.9-c | Meeting path routes THROUGH the candidate gate but SKIPS `registerSource`'s contentHash dedupe | VERIFIED | `connectorIngestionBridge.ts:113-119` (`effectiveRegisterDeps` forces `seenContentHash → false` for a meeting binding); worker Lesson 38 |
| 15.9-d | Correlation runs INSIDE `meetingCloseoutWorkflow`, not the bridge | VERIFIED | bridge only starts the run; `meetingCloseout.ts:250` `deps.correlate.correlate(context)` (WS-2 binds inside) |
| 15.9-e | `dispatchMeeting` dep fail-fast-required at bridge construction for a meeting-capable binding | VERIFIED | `connectorIngestionBridge.ts:109-111` (construction throw); worker Lesson 39 |
| 15.7 | Source propose routes through the SAME real Tool Gateway `propose` (`createProposeActivity` over `dispatchExternalWrite`) as `meetingPropose`; approval-required → `approval_pending` fail-closed; dormant (transport unbound) | VERIFIED | `buildActivities.ts:741-747` + `sourcePropose` `L794` reuses `propose`; `proposeExternalActions.ts:54-85` (`approval_pending` err L68-69) |
| 15.8-a | Triage `target {workspaceId, projectId?}` is a worker-API-layer shape (NOT a contracts model) | VERIFIED | `triageCommands.ts:41-52` (`RerouteTarget`); not in `packages/contracts` |
| 15.8-b | Reroute with no/blank target fails closed `reroute_target_required`; validator never consulted; no default ws | VERIFIED | `triageCommands.ts:143-150` |
| 15.8-c | Target registry-validated (14.1/14.6): unknown ws → `reroute_target_unknown`; project not under ws → `reroute_target_project_unknown` | VERIFIED | `dispositionDurable.ts:163-180` (`createRegistryValidatedRerouteTarget`) |
| 15.8-d | Target on a non-reroute disposition → `reroute_target_forbidden` (not silently ignored) | VERIFIED | `triageCommands.ts:158-162` |
| 15.8-e | Reroute idempotencyKey encodes the full target `${sourceId}:reroute:${workspaceId}[:${projectId}]` | VERIFIED | `apps/desktop/renderer/lib/triage-disposition.ts:76-95` |
| 15.8-f | Desktop picker registry-sourced, no free-text; submit blocked until a workspace is chosen | VERIFIED | `apps/desktop/renderer/surfaces/ingestion-inbox/index.tsx` (registry-sourced `ReroutePickerOptions`; "submit is inert until a workspace is explicitly chosen") |
| 15.8-g | Phase-16 follow-up: command VALIDATES + FORWARDS the target; re-entry runner re-scoping the parked envelope BY the target is deferred | WAIVERED (documented) | `triageCommands.ts:164-175` forwards target; `TriagePort.reenterIngestion` accepts `target?` `L95-105` (type carries it, so forward is real). Re-scope-by-target deferred — matches §19.2 waiver text (L457) |

---

## §9 — Temporal Workflows

| Workflow | Statement | Verdict | Evidence |
|---|---|---|---|
| 1 Meeting closeout | Production dispatch trigger exists (not test-only) | VERIFIED | `dispatchMeetingCloseout.ts`; wired from the bridge on a `meeting` binding |
| 4 Source ingestion | `SourceEnvelope` register → route (low-conf → Inbox) → build → KW commit | VERIFIED | `buildActivities.ts:614-755` (register/route/agent/build/commit/index) |
| 5 Ingestion-inbox triage | User disposition re-enters the pipeline REUSING the same idempotency key (replay-safe); resolves ING-4 dead-end | VERIFIED | `triageCommands.ts:89-106,164-175`; reuse verbatim (ING-4) |

---

## §6 — KnowledgeWriter note projection from validated plan

| Statement | Verdict | Evidence |
|---|---|---|
| Ingested source becomes a real gate-validated Markdown note committed via the sole KnowledgeWriter `applyPlan` (rule 1); `provenanceOrigin:"ingestion"` | VERIFIED | `buildActivities.ts:683-713` (`KnowledgeMutationPlan`, `provenanceOrigin:"ingestion"`, `requiresApproval:false`) → `sourceCommit = createCommitActivity({ applyPlan, ... })` `L731-739` |
| Note path is body-independent + WS-8 traversal-safe (keys only on `SourceNoteIdentity`) | VERIFIED | `deriveSourceNotePath` `sourceNotePath.ts:83-95` (sha256 digest + `SAFE_WS_SEGMENT` guard); worker Lesson 35 |

---

## §8 — Connector & Tool Gateways

| Statement | Verdict | Evidence |
|---|---|---|
| Connector Gateway read → `registerSource` bridge | VERIFIED | `connectorIngestionBridge.ts:143` routes every record THROUGH `registerSource` (rule 2) |
| Completed-meeting → meeting dispatcher route | VERIFIED | `connectorIngestionBridge.ts:159-188` (kind-discriminated) |
| External-write propose via the Tool Gateway envelope; replay reuses receipt; approval-required fails closed | VERIFIED | `proposeExternalActions.ts:54-85` (`createProposeActivity` over `dispatchExternalWrite`; `created`/`reused`/`approval_pending`) |

---

## §4 — Operational Storage (durable dedupe + disposition store)

| Statement | Verdict | Evidence |
|---|---|---|
| `SeenContentHashRow` (`seen_content_hash`, composite `(workspaceId, contentHash)` PK, migration 0010); WS-8-scoped; fail-closed both directions | VERIFIED | migrations `0010_seen_content_hash.sql` (both dialects); `SeenContentHashRepository` `interfaces.ts:371-397` |
| `SeenContentHash` is a PRE-DISPATCH optimization, reachability-waivered until the Phase-16 bridge binding (source-ingestion activity uses a fresh probe) | WAIVERED (documented) | `buildActivities.ts:620-626` (`seenContentHash: () => Promise.resolve(false)`); worker Lesson 34 |
| `SourceDispositionRow` (`source_disposition`, `sourceId` PK, migration 0011); persists parked `SourceEnvelope` (incl. `+body`) server-side-operational-only; re-enter re-drives THROUGH the gate reusing idempotencyKey | VERIFIED | migrations `0011_source_disposition.sql` (both dialects); `SourceDispositionRepository` `interfaces.ts:407-441`; reenter re-gate `buildActivities.ts:586-609` |
| Both are db-owned operational records, NOT frozen Appendix-A contracts | VERIFIED | `interfaces.ts:370,403` ("db-owned; not a frozen contract"); worker Lessons 34/36 |
| G5 park-write — "structurally closed but not functionally live until wired into the low-confidence branch (a waivered Phase-16 follow-up; fails-safe empty until then)" | **STALE-DOC** (code is MORE complete) | See STALE-DOC note 1 below — the park-write WAS subsequently wired: `meetingCloseout.ts:262` `deps.park.park(context.source, input.run.workflowId)` invoked on `outcome.confidence === "low"`; activity wired `buildActivities.ts:768`; closed by `65e6b09a` |

---

## §11 — Electron Desktop UI (Ingestion Inbox reroute)

| Statement | Verdict | Evidence |
|---|---|---|
| Ingestion Inbox with triage resolution (workflow 5); reroute/assign-project action | VERIFIED | `apps/desktop/renderer/surfaces/ingestion-inbox/index.tsx`; `createTriageDisposition` `triage-disposition.ts:98-130` |
| Registry-sourced workspace/project picker; no free-text; submit inert until a workspace is chosen | VERIFIED | `ingestion-inbox/index.tsx` (`ReroutePickerOptions`; guarded submit; "never dispatch a reroute without an explicit, registry-picked workspace") |

_Minor observation (not drift):_ the desktop project sub-picker is offered only when the picked target is the current workspace (the renderer store holds only the current workspace's projects) — a cross-workspace reroute lands at workspace level with `projectId` omitted. This satisfies the 15.8 contract (`projectId` is optional; workspace required); it is a UI-scope detail below the arch's granularity, not a contract violation.

---

## Appendix A — Model / contract inventory

| Model | Verdict | Evidence |
|---|---|---|
| SourceEnvelope (+`body?`) | VERIFIED-BY-TEST | `source-envelope.snap` field-set includes `body`; `test/models/source-envelope.test.ts` green (23 tests); worker/contracts Lesson 23 |
| ExternalWriteEnvelope | VERIFIED-BY-TEST | `external-write-envelope.snap` = {actionId, approvalId, canonicalObjectKey, idempotencyKey, payloadHash, preconditions, targetSystem, writeReceipt} matches Appendix A; test green (24 tests) |
| ProposedAction | VERIFIED-BY-TEST | `proposed-action.snap` = {actionId, approvalPolicy, canonicalObjectKey, idempotencyKey, payload, targetSystem} matches Appendix A; test green (16 tests) |
| RegisterSourceInput | VERIFIED (source) | `@sow/integrations` interface `source-register.ts:31-39` (not a contracts model; no snapshot obligation) |
| MeetingCloseoutInput | VERIFIED (source) | `@sow/workflows` interface `meetingCloseout.ts:92-95` (`run` + `context`); not a contracts model |
| Triage `target {workspaceId, projectId?}` | VERIFIED (source) | worker-API shape `triageCommands.ts:41-52`; confirmed NOT a `packages/contracts` frozen model |

---

## DRIFT findings (code ≠ spec, spec is right)

**None.** No code-vs-contract contradiction found across the dispatched anchors.

---

## STALE-DOC notes (code is right, spec lags) → route to orchestrator as Architecture-doc notes

1. **§4 Phase-15 ingestion-stores note under-claims G5 park-write.** The note (added 2026-07-15) states: *"G5 is structurally closed but not functionally live until the `park`-write is wired into the 7.7 low-confidence branch (a waivered Phase-16 follow-up; fails-safe empty until then)."* The park-write was subsequently wired **in Phase 15** (commit `65e6b09a`, "closes G5"): `packages/workflows/src/workflows/meetingCloseout.ts:256-277` invokes `deps.park.park(context.source, input.run.workflowId)` on `outcome.confidence === "low"`, with a distinct `write_through_failed` fail-safe on park failure; the activity is wired at `apps/worker/src/composition/buildActivities.ts:768`. The §19.2 header (line 444, "Closes G1–G7, G60") already treats G5 as closed by Phase 15, so the §4 sub-note is the lagging text. **Suggested edit:** update the §4 sentence to "G5 park-write is wired into the low-confidence meeting branch (`65e6b09a`); the parked meeting durably reaches the Ingestion Inbox with a fail-safe health signal on park failure." No code change required.

---

## Ambiguous (can't tell which side is right)

**None.**

---

## Documented dormancy waivers confirmed (NOT drift, per dispatch + Lesson 11)

- Connector poll/schedule BINDING that drives `onRecords` in production is Phase-16 — bridge ships fakes-only, reachability-waivered (Lessons 33/38/39).
- `SeenContentHashRepository` binding into the live source-ingestion dedupe leg is Phase-16 — the activity uses a deterministic fresh probe today (`buildActivities.ts:620-626`); the Temporal `src:ws:hash` workflowId `REJECT_DUPLICATE` is the real exactly-once backstop (Lesson 34). Documented in §4.
- Re-entry runner re-scoping the parked envelope BY the 15.8 reroute target is a Phase-16 wiring step — the command validates + forwards; re-scope deferred. Documented in §19.2 (line 457).
- Real external write transport for the source/meeting propose is Phase-21 — `WriteTransportGate` OFF, default stub, zero egress (Lesson 27). Documented in §19.2 (15.7) and §8.

Each of these is an explicit, documented waiver — not counted as drift.

---

## Verdict

**CLEAR** — 0 DRIFT findings; 1 STALE-DOC note (§4 G5 park-write under-claim; code is more complete than the doc); 0 ambiguous. All dispatched anchors' contracts hold against the code as built at HEAD `1461c815`; the documented Phase-16/Phase-21 dormancy waivers are honored, not violated.
