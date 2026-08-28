// @sow/worker — the proof-spine COMPOSITION ROOT (activity-binding half).
//
// buildProofSpineActivities wires every pure @sow/workflows activity FACTORY over
// the REAL backends assembled in backends.ts, and exposes them as a PLAIN-ASYNC-
// FUNCTION object — the exact shape @temporalio/worker registers (`{ [name]: async
// (...args) => ... }`). The Spine phase (the @temporalio Worker.create wiring) consumes
// this object; each function is a thin, boundary-safe delegate to a port method (§16:
// nothing throws across the boundary — every method already returns a typed Result).
//
// Three flows are bound:
//   • meeting-closeout — correlate → runAgentJob → validate → buildOutputs → commit
//     → propose → reindex.
//   • approval-flow    — recordPending → surfaceCard → applyTransition → dispatchApproved.
//   • ingestion-triage — recordDisposition → rescopeSource → reenterIngestion.
// PLUS the infra ports each pure driver needs: the WorkflowRunRefRepository, the
// HealthItemStore, the Clock, and the per-driver *HealthSink backed by the 7.5
// surfaceWorkflowFailure (so every failure class routes to health/outbox — inv-5).
//
// The activity factories' Deps are read straight from packages/workflows/src/
// activities/ — this module supplies each Dep from the backends bundle or a
// clearly-scoped deterministic value; the safety-bearing seams (KnowledgeWriter real
// ownership+secret defaults, the fail-closed approval unwrap, the always-supplied
// broker localConfig, the faithful ReceiptStore mapping) live in backends.ts and are
// threaded here unchanged.
import { ok, err, isOk, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  SourceRef,
  WorkflowRunRef,
  ProposedAction,
  ExternalWriteEnvelope,
  KnowledgeMutationPlan,
  Approval,
  AuditId,
  ContextRef,
} from "@sow/contracts";
import { planId as makePlanId } from "@sow/contracts";
import { refreshRecentChanges } from "./recentChangesProducer";
import {
  createDurableDispositionStore,
  createDurableMeetingParkPort,
  createDurableParkedReader,
  createRegistryValidatedRescope,
  createReenterRunner,
} from "./dispositionDurable";

// KnowledgeWriter — the SOLE Markdown writer; real ownership+secret defaults kept.
// `readVaultHeadRevision` resolves the LIVE vault head for the source commit's compare-revision
// base (the ingested vault moves between commits — a fixed base would spuriously write_conflict).
import { applyPlan, readVaultHeadRevision } from "@sow/knowledge";
import { makeEnforceWorkspacePathScope } from "@sow/knowledge";
import { LEGACY_UNPREFIXED_WORKSPACE_ID } from "./legacy-workspace";
import type {
  KnowledgeWriterDeps,
  KnowledgeRevisionStore,
  RevisionId,
  StamperDeps,
} from "@sow/knowledge";
// 19.1 — the durable GBrain post-commit sync outbox (triggerGbrainSync/toIndexDispatcher already
// exist, §6/task 4.4/4.8; this leg gives them a real substrate + their first production caller).
import { triggerGbrainSync, toIndexDispatcher } from "@sow/knowledge";
import {
  createGbrainSyncOutboxBinding,
  createWorkingTreeMarkdownSource,
  type GbrainSyncOutboxBinding,
} from "./gbrainSyncOutbox";

// The §8 Tool Gateway external-write entry + its deps.
import { dispatchRouted, createUnroutedWriteAdapter } from "@sow/integrations";
import type { ExternalWriteDeps, ExternalWriteResult, WriteSecretsAccessor } from "@sow/integrations";

// task 21.4/24.8 — the write-outbox DRAIN-ON-WAKE (buildDrainDeps/buildWakeDrainHook had ZERO
// production importers; see outboxDrainBind.ts's module header). Bound below, mirroring THIS
// file's own established drain-on-wake idiom (the 19.1 GBrain-sync-outbox drain a few lines down).
import { buildDrainDeps, buildWakeDrainHook } from "./outboxDrainBind";

// 21.8 — PROV-3's default-OFF card-transport owner gate (@sow/integrations/tools/cards). Deep
// subpath import (explicit /index — the package's "./*" export map is file-literal, no directory
// resolution): the main @sow/integrations barrel does not re-export this module (its own header
// notes worker wiring is THIS package's territory, not integrations' — see cards/index.ts:1-20).
import { selectCardRenderer } from "@sow/integrations/tools/cards/index";
import type { CardTransportGate } from "@sow/integrations/tools/cards/index";

// The REAL §8 source-register candidate gate (ajv structural + Zod .strict() + the
// Flow-4 dedupe probe). This is the ONE source-ingestion leaf that runs FOR REAL in
// the make-it-real C1 slice — every other source leaf below is a deterministic fake.
import { registerSource } from "@sow/integrations";

// The 7.5 failure sink every flow routes through (inv-5).
import {
  surfaceWorkflowFailure,
  type WorkflowFailure,
  type SurfaceDeps,
  type OutboxSink,
} from "@sow/workflows";

// The activity factories (each read from packages/workflows/src/activities/).
import {
  createCorrelateActivity,
  createRunAgentJobActivity,
  createValidateActivity,
  createBuildOutputsActivity,
  // 18.8 — the shared TBD-sentinel frontmatter value extractor (the meeting projection uses the SAME
  // helper; parity, not a re-impl) — an absent extraction field ⇒ TBD, never an invented value (REQ-F-017).
  frontmatterValue,
  createCommitActivity,
  createProposeActivity,
  createReindexActivity,
  createRecordPendingActivity,
  createSurfaceCardActivity,
  createApplyTransitionActivity,
  createDispatchApprovedActivity,
  createRecordDispositionActivity,
  createReenterIngestionActivity,
  meetingOutputsProjection,
  // source-ingestion (make-it-real C1): the REAL registerSource gate activity + the
  // real threshold-gated route activity (over a deterministic classifier).
  createRegisterSourceActivity,
  createRouteSourceActivity,
} from "@sow/workflows";
import type {
  CorrelatePort,
  CorrelationSignals,
  CorrelateError,
  RunMeetingAgentJobPort,
  MeetingJobInputs,
  ValidateExtractionPort,
  BuildOutputsPort,
  SourceBuildOutputsPort,
  SourceNoteIdentity,
  SourceLivingVaultPort,
  ProposeKnowledgeApprovalPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  ReindexGbrainPort,
  GbrainReindexClient,
  GbrainReindexAck,
  ReindexError,
  MeetingCloseoutContext,
  MeetingSchemaGate,
  AgentExtraction,
  RecordPendingPort,
  RecordPendingGateway,
  SurfaceCardPort,
  CardRenderer,
  ApplyTransitionPort,
  DispatchApprovedActionPort,
  ApprovedDispatchGateway,
  DispatchApprovedResult,
  DispatchApprovedError,
  RecordDispositionPort,
  MeetingParkPort,
  DispositionStore,
  RescopeSourcePort,
  ParkedSourceReader,
  ReenterIngestionPort,
  SourceIngestionRunner,
  NoteExistsReader,
  NoteExistsError,
  // source-ingestion (make-it-real C1) — the driver's leaf ports + shared derive types.
  RegisterSourcePort,
  RouteSourcePort,
  RouteSignals,
  RouteError,
  RunSourceAgentJobPort,
  SourceAgentFailure,
  IndexGbrainPort,
  IndexError,
  ValidatedExtraction,
  MeetingBuiltOutputs,
  BuildOutputsFailure,
  MeetingVaultRewritePort,
} from "@sow/workflows";
import type { BrokerOutcome } from "@sow/providers";

// WP4 (task 25.1's crossTerritoryNeed close-out) — the output-workflow (dailyBrief/periodReview/
// projectSync/crossCalendarScheduling) activity-adapter factory + the projectSync registry
// resolver + the frozen scheduled-runtime activity-name contract. See the big doc comment at this
// module's binding site (below, inside buildProofSpineActivities) for the full picture; this block
// is just the import surface.
import { createOutputWorkflowActivities } from "@sow/workflows";
import type { OutputWorkflowActivities, ProjectSyncContext, ProjectRegistryEntry, ResolveRegistryError, WorkflowRunRefRepository, ScheduleBookkeeping } from "@sow/workflows";
// W1 (§16/rule 7) — the closed `DbError`/`DbErrorCode` taxonomy (only the `code` half is a real
// type here; `DbError` itself is referenced only in comments below) the durable scheduled-runtime
// activities (`SCHEDULED_RUNTIME_ACTIVITY_NAMES`) redact down to before returning/throwing across
// the Temporal activity boundary. See `redactDbError`'s doc comment (small pure helpers, below) for
// why a `DbError.message` needs this treatment and a `WriteFailure.message` does not.
import type { DbErrorCode } from "@sow/db";
import { createProjectRegistryResolvePort } from "./projectRegistry";
import { SCHEDULED_RUNTIME_ACTIVITY_NAMES } from "../temporal/scheduleArgs";

import type {
  ProofSpineBackends,
  ResolvedWorkspacePolicy,
} from "./backends";
import { makeRequireApproval } from "./backends";
import {
  createContentProjectClassify,
  createCorrelationSignalProducer,
  createBootWorkspaceContentResolver,
  createBootCorrelationScorer,
  DEFAULT_THRESHOLD as ROUTING_THRESHOLD,
  type ContentResolver,
  type CorrelationScorerPort,
} from "./content-project-resolver";
import {
  mapAcceptedMeetingExtraction,
  createMeetingExtractionSchemaGate,
} from "./meeting-extraction";
// 18.4 — the source-ingestion extraction leg ROUTED THROUGH THE BROKER (+ ING-7), replacing the
// fixed `sourceAgent.run` bypass. The SOURCE analog of 18.3's meeting broker routing.
import { createSourceAgentBrokerRouting } from "./source-extraction";
// 18.7 — the deterministic PENDING external-action producer (no dispatch; targetSystem + the
// existence/dedupe keys from the binding + a traversal-safe identity, NEVER content).
import { produceProposedActions, type ExternalActionBinding } from "./proposed-action-producer";
// 18.8 — the shared marker-neutralizer (the meeting projection uses the SAME helper) so a `kw:region`
// marker in an extraction frontmatter value can't forge a region boundary. Deep import (established
// pattern — cf. semanticMutationDispatch's projectNotePath; not barrel-exported).
import { neutralizeFrontmatterValue } from "@sow/workflows/activities/projections/noteSlug";
import { createIngestionInboxProjectionPort, type IngestionInboxProjectionPort } from "../api/projections/ingestionInboxProjection";
// The per-file ingestion note-path derivation (traversal-safe, content-addressed) — task 11.1.
import { deriveSourceNotePath, sourceIdentityDigest } from "./sourceNotePath";
// 13.8d — the living-vault rewrite leg's arming gate. Importing the ACTIVITY factory (not
// `rewriteVaultForSource` itself) keeps this module free of the knowledge synthesis surface; the real
// rewrite is bound one hop away in `living-vault.ts`, which carries the dormancy waiver.
import { createLivingVaultActivity, createProposeKnowledgeApprovalActivity } from "./living-vault";
// 16.2 — the connector-poll activity + its real resolve binding (16.1 adapters + 15.1 bridge + backoff).
import { createConnectorPollActivity, type ConnectorPollPort } from "@sow/workflows";
import { composeConnectors } from "./connectors";
import {
  createConnectorPollResolve,
  createDormantConnectorCursorRepo,
  dormantBridgeFor,
  CONNECTOR_POLL_BACKOFF,
} from "./connectorPolling";
// 16.6 — the real persisted seen-content-hash dedupe probe (15.4 store → the Flow-4 probe).
import { createSeenContentHashProbe } from "./seenContentHashProbe";

// ---------------------------------------------------------------------------
// The per-flow binding parameters (identity/config that is not a backend adapter)
// ---------------------------------------------------------------------------

/**
 * The identity + policy parameters the proof-spine flows are bound under. These are
 * the correlation-bound workspace, the meeting.close job inputs, the KnowledgeWriter
 * commit metadata, and the resolved workspace posture the approval predicate reads.
 * Supplied by the Spine phase (or a test) alongside the backends bundle.
 */
/**
 * The additive source-ingestion binding (make-it-real C1). OPTIONAL: when absent the
 * source-ingestion delegates are still registered but fail closed (route parks
 * low-confidence, the agent rejects) — so the existing proof-spine params/boot are
 * unchanged. When present it binds the deterministic leaves the C1 live spine drives:
 * a HIGH-confidence workspace bind (WS-2), the candidate the (faked) source agent
 * emits, the SourceRef the derived plan cites, and the stable plan-identity seed.
 * Only `registerSource()` runs for real (guardrail-3); every leaf here is deterministic.
 */
export interface SourceIngestionParams {
  /** The workspace a HIGH-confidence route binds (WS-2). */
  readonly boundWorkspaceId: WorkspaceId;
  /** The deterministic candidate extraction the (faked) source agent emits. */
  readonly extraction: AgentExtraction;
  /**
   * NOTE (task 11.1 slice #46): `sourceRef` + `planIdentity` are NO LONGER read by the source build —
   * the note path, planId, and `sourceRefs` now derive from the PER-FILE `SourceNoteIdentity` threaded
   * through `SourceBuildOutputsPort` (the fix for the fixed-path collision). They remain on the binding
   * for now (still constructed at boot + in fixtures); a follow-on may prune them once no caller sets them.
   */
  readonly sourceRef: SourceRef;
  /** See the note on `sourceRef` — retained but unread by the source build after slice #46. */
  readonly planIdentity: Record<string, string>;
  /**
   * 18.7 — the OPTIONAL external-action binding (config/binding, NEVER content). UNSET (the shipped
   * default) ⇒ the ProposedAction producer emits nothing ⇒ `externalActionProposals: []` +
   * `actions: []` (byte-equivalent to pre-18.7). Present (owner-configured) ⇒ an implied action becomes
   * a PENDING §9 Approval through the existing propose path — NO dispatch.
   */
  readonly externalActionBinding?: ExternalActionBinding;
  /**
   * 18.24 step-6 — the OPTIONAL ContextRefs stamped onto the source-processing `AgentJob` (config/binding,
   * NEVER content). UNSET (the shipped default) ⇒ the source job carries empty `contextRefs` (byte-equivalent
   * to pre-18.24). Populated ONLY on the owner-armed subscription path by `withSubscriptionExtractionArming`
   * with EXACTLY ONE `{refKind:"source", ref: sourceRef.sourceId}` — the routing-bound identity (WS-8, never a
   * content field) the 18.21 `ExtractionContentResolver` derefs to inline the parked body.
   */
  readonly contextRefs?: readonly ContextRef[];
  /**
   * 18.27 / #13 Finding C — the OPTIONAL owner-armed source-processing `outputSchemaId` (config/binding). UNSET
   * (the shipped default) ⇒ the source job falls back to `KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID` (byte-equivalent —
   * the KMP stand-in ⇒ `mapAcceptedMeetingExtraction` reconstructs EMPTY ⇒ reject, L46). Populated ONLY on the
   * owner-armed path by `withSubscriptionExtractionArming` with `sow:agent-extraction`, so the run-leg candidate
   * normalizes to a first-class `agent_extraction` candidate carrying `evidenceRef` through to `validateNoInference`
   * (GATE-1, L51/L57). AND-locked to the SAME arming signal (a supplied value cannot arm a disabled gate).
   */
  readonly outputSchemaId?: string;
}

export interface ProofSpineParams {
  /** The resolved workspace posture the fail-closed approval unwrap reads. */
  readonly resolved: ResolvedWorkspacePolicy;
  /** The correlation signals the (stub) correlator resolves — inv-1 threshold-gated. */
  readonly correlationSignals: CorrelationSignals;
  /** The meeting.close AgentJob inputs (READ-ONLY tool policy default; inv-2). */
  readonly meetingJobInputs: MeetingJobInputs;
  /**
   * The deterministic stub meeting extraction. As of 18.12b/CP-2 `mapAcceptedMeetingExtraction`
   * reconstructs from the `agent_extraction` candidate (no longer echoed), so this field is currently
   * UNREAD on the dormant path — retained pending the arming-bundle cleanup that makes the stub emit a
   * real `agent_extraction` candidate (outputSchemaId → sow:agent-extraction, #13 Finding C). A Step-9
   * Future-TODO removes the orphaned thread (boot.ts → registerWorker → params) if arming doesn't reuse it.
   */
  readonly meetingExtraction: AgentExtraction;
  /** The KnowledgeRevisionStore the writer records committed revisions in. */
  readonly revisions: KnowledgeRevisionStore;
  /** The commit metadata (actor / sourceEventRef / run ref / expected base revision). */
  readonly commit: {
    readonly actor: string;
    readonly sourceEventRef: string;
    readonly workflowRunRef: WorkflowRunRef;
    readonly expectedBaseRevision: RevisionId;
  };
  /** The SourceRef the derived plan cites (REQ-F-006: ≥1 sourceRef). */
  readonly sourceRef: SourceRef;
  /** The stable plan-identity seed (→ deterministic planId; inv-5 replay). */
  readonly planIdentity: Record<string, string>;
  /**
   * The additive source-ingestion binding (make-it-real C1). OPTIONAL — absent leaves
   * the existing proof-spine params/boot unchanged; present binds the C1 live spine's
   * deterministic leaves (only `registerSource()` runs for real, guardrail-3).
   */
  readonly sourceIngestion?: SourceIngestionParams;
  /**
   * 18.6 — the content→workspace/project resolver injected into the source-route `classify`.
   * OPTIONAL: UNSET ⇒ the BYTE-EQUIVALENT boot-workspace default (bind the single boot
   * workspace confidently, no project, never park). The real registry-backed resolver
   * (`createRegistryContentResolver` over `ResolveRegistryPort`) is bound at the reachability
   * follow-up (needs the registry+readModels repos, not in `backends`).
   */
  readonly contentResolver?: ContentResolver;
  /**
   * 18.5 — the correlation SCORER injected into the meeting `resolveSignals` producer.
   * OPTIONAL: UNSET ⇒ the BYTE-EQUIVALENT fixed `correlationSignals` binding. The real
   * model-via-broker scorer binds at the crossing (eval-tested).
   */
  readonly correlationScorer?: CorrelationScorerPort;
  /**
   * 18.6/18.5 — the Ingestion-Inbox PARK sink the classify/producer record to on a
   * no-match/below-threshold (REQ-F-017 clarification surface). OPTIONAL: UNSET ⇒ a dormant
   * no-op park (never observable — the byte-equivalent default never parks). The real
   * `createIngestionInboxProjectionPort` (readModels-backed) is the reachability follow-up.
   */
  readonly ingestionPark?: IngestionInboxProjectionPort;
  /**
   * 13.8d — the OPTIONAL living-vault rewrite port (§6 KN-10). UNSET is the shipped default ⇒ the
   * `sourceLivingVaultRewrite` activity is inert (empty plan set) and source ingestion is byte-equivalent
   * to pre-13.8d. It is TO BE supplied by `boot.ts`'s `gateLivingVaultRewrite` on the owner-armed path
   * (built via `createLivingVaultPort` — realpath containment against the configured vaultRoot); that
   * boot call site is the arming follow-up and does NOT exist yet, so today this is always unset.
   */
  readonly livingVault?: SourceLivingVaultPort;
  /**
   * 13.8f-B — the OPTIONAL meeting-path living-vault rewrite port (§6 KN-10, the meeting analog of
   * `livingVault`). UNSET is the shipped default ⇒ `meetingBuildOutputs`'s plan keeps `linkMutations: []`,
   * byte-equivalent to pre-13.8f-B. It is TO BE supplied by `boot.ts`'s `gateMeetingVaultRewrite` on the
   * owner-armed path (built via `createMeetingVaultPort`, apps/worker/src/composition/meeting-vault.ts);
   * that boot call site is a future arming follow-up and does NOT exist yet, so today this is always
   * unset. Narrow cut (13.8f-B): only `meetingNoteLinkMutations` folds here — the sibling entity-page
   * `plans` a real rewrite also derives are 13.8f-C's territory (tracked separately), not read via this
   * field at all.
   */
  readonly meetingVault?: MeetingVaultRewritePort;
  /**
   * 13.8i-B — the propose-knowledge-approval port (§6 KN-10 / §9.8), shared by BOTH the source and
   * meeting paths (one port instance, two registered activity names — mirrors the `meetingCommit`/
   * `sourceCommit` per-path-naming convention). UNLIKE `livingVault`/`meetingVault` this carries NO
   * separate arming flag of its own: `boot.ts`'s `withProposeKnowledgeApproval` binds it UNCONDITIONALLY
   * whenever `proofSpineParams` exists at all. The "default boot mints ZERO Approval cards" guarantee
   * rests entirely on `livingVault`/`meetingVault` staying dormant (empty plan sets) — NOT on this field
   * being absent. See `createProposeKnowledgeApprovalActivity` (living-vault.ts) for the unarmed-branch
   * fallback this field's absence still triggers (test-only / a future construction site that omits it).
   */
  readonly proposeKnowledgeApproval?: ProposeKnowledgeApprovalPort;
  /**
   * 19.1 — the durable GBrain post-commit sync outbox binding. OPTIONAL: UNSET ⇒ this
   * builder constructs its OWN `:memory:`-backed binding (byte-equivalent-in-effect for
   * every existing call site — a private, never-otherwise-observed table). `boot.ts`
   * supplies the REAL file-backed binding (built once, over `config.dbPath`) so the
   * commit-triggered sync + drain-on-wake share the SAME durable store across a restart.
   */
  readonly gbrainSyncOutbox?: GbrainSyncOutboxBinding;
  /**
   * task 19.2 — the KnowledgeWriter provenance-signing dep (gate 4/G1d-2, already optional on
   * `KnowledgeWriterDeps.signing` — see writer.ts:190). OPTIONAL/DORMANT BY DEFAULT: UNSET ⇒
   * `knowledgeWriterDeps.signing` stays unset ⇒ `embedProvenanceStamps` never runs ⇒ the
   * committed Markdown bytes are BYTE-IDENTICAL to pre-19.2. `boot.ts` sources the real value
   * from the SAME owner-provisioned `keychainSecrets`/`provenanceServingOracle` pair the C5.4b
   * serving oracle already uses (boot.ts:~2171) — no new arming surface.
   */
  readonly signing?: StamperDeps;
  /**
   * 21.10 — the external-write CREDENTIAL SEAM accessor (mirrors `signing`'s optional-attach shape
   * above). UNSET (the shipped default) ⇒ `externalWriteDeps.secrets` stays ABSENT — a conditional
   * spread key-omits it rather than setting `undefined` — so `dispatchExternalWrite`'s credential-
   * seam step (gateway.ts:182, `deps.secrets !== undefined`) is skipped entirely and dispatch stays
   * BYTE-EQUIVALENT to pre-21.10 (packages/integrations/test/credential-seam.test.ts's ABSENT-
   * accessor pin). `boot.ts` sources the real value from the SAME owner-provisioned `keychainSecrets`
   * facade the C5.4b serving oracle / provenance signing already use (via `withWriteSecretsAccessor`)
   * — no new arming surface; the real Keychain touch stays owner-gated.
   */
  readonly secretsAccessor?: WriteSecretsAccessor;
  /**
   * 21.8 — the OPTIONAL default-OFF card-transport owner gate (mirrors PROV-3's `CardTransportGate`,
   * @sow/integrations/tools/cards/index.ts, itself modelled on `WriteTransportGate`, backends.ts:155).
   * UNSET (the shipped default) ⇒ `selectCardRenderer(undefined)` returns the SAME deterministic
   * no-op renderer this builder used inline pre-21.8 (byte-identical) — the real Mac/Telegram
   * transports are NEVER constructed/invoked on the OFF path. `boot.ts` threads `config.cardTransport`
   * here unchanged; NOTHING in this slice arms it (no default flips, no key provisioned).
   */
  readonly cardTransport?: CardTransportGate;
}

// ---------------------------------------------------------------------------
// The exported activities shape (what @temporalio/worker registers)
// ---------------------------------------------------------------------------

/**
 * 25.2/25.4/WP4 — the durable scheduled-runtime activity NAMES (scheduleArgs.ts's frozen
 * contract). TYPO-SAFETY: mirrors temporal/workflows.ts's `ScheduledRunActivities`/
 * `ScheduledScheduleActivities` EXACTLY — each member is a COMPUTED key off the SAME frozen
 * `SCHEDULED_RUNTIME_ACTIVITY_NAMES` constant the sandbox proxies against, and each signature is
 * lifted via indexed access off the REAL `@sow/db`-backed port types (never re-declared), so a
 * drift between the sandbox's proxy and this registration is a TYPECHECK failure — never a silent
 * "activity not registered" fault that only surfaces against a live server.
 */
export interface ScheduledRuntimeActivities {
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate]: WorkflowRunRefRepository["create"];
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGet]: WorkflowRunRefRepository["get"];
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGetByIdempotencyKey]: WorkflowRunRefRepository["getByIdempotencyKey"];
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runUpdateState]: WorkflowRunRefRepository["updateState"];
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runAppendAuditRef]: WorkflowRunRefRepository["appendAuditRef"];
  // W1b (§16/rule 7) — UNLIKE the five run-repo members above (already `Result`-shaped at the
  // `WorkflowRunRefRepository` port), the underlying `ScheduleStore` port (@sow/workflows/ports/
  // operational, unowned by this track) is a THROW-shaped bare-Promise port BY DESIGN
  // (store-adapters.ts's "FAIL-CLOSED CONTRACT" doc: a genuine `DbError` fault REJECTS the
  // promise). Registering `ScheduleStore["getBookkeeping"]`/`["put"]` VERBATIM as Temporal
  // activities (the shape this interface declared before this fix) meant a real store fault
  // THREW straight across the activity boundary — landing the raw, driver-authored
  // `DbError.message` (interpolated into `faultRejection`'s thrown text, store-adapters.ts) in
  // durable, replayed workflow history. So these two members are typed `Result`-shaped HERE,
  // deliberately diverging from the bare-Promise `ScheduleStore` shape: the activity binding
  // below (`scheduledScheduleGetBookkeeping`/`scheduledSchedulePut`) catches the adapter's throw
  // and folds it to `err(redactDbError(...))` rather than ever re-throwing (small pure helpers,
  // below).
  //
  // ⚠ CROSS-FILE NOTE (flagged, not silently left inconsistent): `apps/worker/src/temporal/
  // workflows.ts`'s `ScheduledScheduleActivities` (a DIFFERENT track's file, not owned here)
  // independently declares its OWN mirror of this interface for its `proxyActivities<>()` stub,
  // and that mirror STILL types both members against the old bare-Promise `ScheduleStore` shape.
  // The two interfaces are never a shared type (each side declares its own, matched only by
  // convention/comment — see that file's own doc note), so this compiles clean on BOTH sides
  // today. But the two are now WIRE-INCOMPATIBLE on a fault (this side resolves `err(...)`; that
  // side's caller — `createScheduleRegistry`/`dailyBrief.ts`/`periodReview.ts`/etc. — expects a
  // REJECTED promise) — safe only because hard rule #4 holds (`dailyBrief`/`periodReview`'s
  // SCHEDULED entry points stay default-OFF; nothing arms). The mirror needs a matching
  // Result-aware update on the calling side before this leg is ever armed.
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]: (
    scheduleId: string,
  ) => Promise<Result<ScheduleBookkeeping | undefined, { readonly code: DbErrorCode; readonly message: string }>>;
  [SCHEDULED_RUNTIME_ACTIVITY_NAMES.schedulePut]: (
    bookkeeping: ScheduleBookkeeping,
  ) => Promise<Result<void, { readonly code: DbErrorCode; readonly message: string }>>;
}

/**
 * The proof-spine activities as PLAIN ASYNC FUNCTIONS — the shape @temporalio/worker
 * registers. The Spine phase passes this object to `Worker.create({ activities })`.
 * Names are stable, flow-prefixed, and 1:1 with a port method.
 *
 * WP4 — extends {@link OutputWorkflowActivities} (packages/workflows/src/activities/
 * outputWorkflows.ts's flat dailyBrief/periodReview/projectSync/crossCalendarScheduling surface)
 * and {@link ScheduledRuntimeActivities} (the durable scheduled-runtime activities above), plus the
 * projectSync registry-resolution member below — closing task 25.1's own named
 * crossTerritoryNeed ("the composition-root binding ... is a NAMED, NOT-YET-LANDED follow-up").
 */
export interface ProofSpineActivities extends OutputWorkflowActivities, ScheduledRuntimeActivities {
  // ── meeting-closeout ──
  meetingCorrelate(ctx: MeetingCloseoutContext): Promise<ReturnType<CorrelatePort["correlate"]> extends Promise<infer R> ? R : never>;
  meetingRunAgentJob(ctx: MeetingCloseoutContext): Promise<Awaited<ReturnType<RunMeetingAgentJobPort["run"]>>>;
  meetingValidate(extraction: AgentExtraction): ReturnType<ValidateExtractionPort["validate"]>;
  meetingBuildOutputs(
    ...args: Parameters<BuildOutputsPort["build"]>
  ): Promise<Awaited<ReturnType<BuildOutputsPort["build"]>>>;
  meetingCommit(
    ...args: Parameters<CommitKnowledgePort["commit"]>
  ): Promise<Awaited<ReturnType<CommitKnowledgePort["commit"]>>>;
  meetingPropose(
    ...args: Parameters<ProposeActionsPort["propose"]>
  ): Promise<Awaited<ReturnType<ProposeActionsPort["propose"]>>>;
  meetingReindex(
    revisionId: string,
  ): Promise<Awaited<ReturnType<ReindexGbrainPort["reindex"]>>>;
  meetingPark(
    ...args: Parameters<MeetingParkPort["park"]>
  ): Promise<Awaited<ReturnType<MeetingParkPort["park"]>>>;
  /**
   * 13.8i-B — the meeting-path propose-approval delegate (mirrors `sourceProposeKnowledgeApproval`;
   * both register the SAME shared port instance under a per-path name, the `meetingCommit`/`sourceCommit`
   * convention). Dormancy lives INSIDE the activity (`createProposeKnowledgeApprovalActivity`, L59
   * shape) — never gated at the workflow level.
   */
  meetingProposeKnowledgeApproval(
    ...args: Parameters<ProposeKnowledgeApprovalPort["propose"]>
  ): Promise<Awaited<ReturnType<ProposeKnowledgeApprovalPort["propose"]>>>;

  // ── approval-flow ──
  approvalRecordPending(
    ...args: Parameters<RecordPendingPort["record"]>
  ): Promise<Awaited<ReturnType<RecordPendingPort["record"]>>>;
  approvalSurfaceCard(
    ...args: Parameters<SurfaceCardPort["surface"]>
  ): Promise<Awaited<ReturnType<SurfaceCardPort["surface"]>>>;
  approvalApply(
    ...args: Parameters<ApplyTransitionPort["apply"]>
  ): Promise<Awaited<ReturnType<ApplyTransitionPort["apply"]>>>;
  approvalDispatchApproved(
    ...args: Parameters<DispatchApprovedActionPort["dispatch"]>
  ): Promise<Awaited<ReturnType<DispatchApprovedActionPort["dispatch"]>>>;

  // ── ingestion-triage ──
  triageRecordDisposition(
    ...args: Parameters<RecordDispositionPort["record"]>
  ): Promise<Awaited<ReturnType<RecordDispositionPort["record"]>>>;
  triageRescopeSource(
    ...args: Parameters<RescopeSourcePort["rescope"]>
  ): Promise<Awaited<ReturnType<RescopeSourcePort["rescope"]>>>;
  triageReenter(
    ...args: Parameters<ReenterIngestionPort["reenter"]>
  ): Promise<Awaited<ReturnType<ReenterIngestionPort["reenter"]>>>;

  // ── source-ingestion (make-it-real C1) ──
  // Only `sourceRegister` runs the REAL registerSource gate; the rest are deterministic
  // leaves (guardrail-3). `sourceValidate` is intentionally ABSENT — the driver's
  // validate port is PURE+SYNC and runs IN-SANDBOX (never a proxied activity), exactly
  // like meeting-closeout.
  sourceRegister(
    ...args: Parameters<RegisterSourcePort["register"]>
  ): Promise<Awaited<ReturnType<RegisterSourcePort["register"]>>>;
  sourceRoute(
    ...args: Parameters<RouteSourcePort["route"]>
  ): Promise<Awaited<ReturnType<RouteSourcePort["route"]>>>;
  sourceRunAgentJob(
    ...args: Parameters<RunSourceAgentJobPort["run"]>
  ): Promise<Awaited<ReturnType<RunSourceAgentJobPort["run"]>>>;
  sourceBuildOutputs(
    ...args: Parameters<SourceBuildOutputsPort["build"]>
  ): Promise<Awaited<ReturnType<SourceBuildOutputsPort["build"]>>>;
  sourceCommit(
    ...args: Parameters<CommitKnowledgePort["commit"]>
  ): Promise<Awaited<ReturnType<CommitKnowledgePort["commit"]>>>;
  sourcePropose(
    ...args: Parameters<ProposeActionsPort["propose"]>
  ): Promise<Awaited<ReturnType<ProposeActionsPort["propose"]>>>;
  sourceIndex(
    ...args: Parameters<IndexGbrainPort["index"]>
  ): Promise<Awaited<ReturnType<IndexGbrainPort["index"]>>>;
  /**
   * 13.8d — derive the living-vault rewrite's plan set for the ingested source (§6 KN-10). DORMANT in
   * the shipped default: with no armed port it returns an EMPTY plan set, so no extra commit happens and
   * the pipeline outcome is identical to pre-13.8d. Armed, it returns the realpath-CONTAINED plans.
   */
  sourceLivingVaultRewrite(
    ...args: Parameters<SourceLivingVaultPort["rewrite"]>
  ): Promise<Awaited<ReturnType<SourceLivingVaultPort["rewrite"]>>>;
  /**
   * 13.8i-B — the source-path propose-approval delegate (mirrors `meetingProposeKnowledgeApproval`;
   * both register the SAME shared port instance under a per-path name). Dormancy lives INSIDE the
   * activity (`createProposeKnowledgeApprovalActivity`, L59 shape) — never gated at the workflow level.
   */
  sourceProposeKnowledgeApproval(
    ...args: Parameters<ProposeKnowledgeApprovalPort["propose"]>
  ): Promise<Awaited<ReturnType<ProposeKnowledgeApprovalPort["propose"]>>>;

  // ── connector sync & health (16.2) ──
  /**
   * Poll ONE connector through the §8 Connector Gateway (`runConnectorSync`) — resolves the 16.1
   * composed adapter + cursor + the 15.1 ingestion bridge + backoff, drives one sync pass, and
   * projects the outcome. DORMANT in the shipped default (inert transport, zero armed instances).
   */
  connectorPoll(
    ...args: Parameters<ConnectorPollPort["poll"]>
  ): Promise<Awaited<ReturnType<ConnectorPollPort["poll"]>>>;

  // ── infra ports the pure drivers need ──
  /** Route a cross-subsystem failure through health+outbox (inv-5; never silent). */
  surfaceFailure(failure: WorkflowFailure): Promise<Awaited<ReturnType<typeof surfaceWorkflowFailure>>>;

  // ── projectSync registry resolution (WP4 / 25.1 crossTerritoryNeed close-out) ──
  /**
   * The PRODUCTION project-registry resolver (task 14.6's `createProjectRegistryResolvePort`) —
   * the exact member temporal/workflows.ts's `projectSyncRegistryActivities` proxy names as its
   * wiring point ("`registry` stays INJECTED ... a matching-named `projectSyncResolveRegistry`
   * function added at the composition root"). DELIBERATELY not part of `OutputWorkflowActivities`
   * (that factory's own doc comment: "the composition root supplies it directly").
   */
  projectSyncResolveRegistry(
    ctx: ProjectSyncContext,
  ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>>;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Bind every proof-spine activity factory over the real backends + the flow params,
 * and return the plain-async-function object @temporalio registers. This is the whole
 * composition wiring — no business logic, only adapter binding.
 */
export function buildProofSpineActivities(
  backends: ProofSpineBackends,
  params: ProofSpineParams,
): ProofSpineActivities {
  const { now } = backends;

  // 19.1 — the durable GBrain post-commit sync-outbox binding + the index-apply dispatcher over the
  // EXISTING `backends.indexClient` (createStubIndexApplyClient, untouched) and a working-tree
  // CanonicalMarkdownSource. `params.gbrainSyncOutbox` lets `boot.ts` supply the real file-backed
  // binding; every other (existing, unmodified) call site gets this builder's own private `:memory:`
  // fallback — a table nothing else ever reads, so the new side effect is unobservable there.
  const gbrainSyncOutboxBinding = params.gbrainSyncOutbox ?? createGbrainSyncOutboxBinding(undefined);
  const gbrainIndexDispatcher = toIndexDispatcher({
    outbox: gbrainSyncOutboxBinding.store,
    snapshotSource: createWorkingTreeMarkdownSource(backends.vault),
    indexClient: backends.indexClient,
    now,
    newHealthItemId: (): string => `gbrain-sync:${now()}:${Math.random().toString(36).slice(2)}`,
  });
  /**
   * Best-effort post-commit GBrain sync trigger (task 4.4's `triggerGbrainSync`, now REACHABLE — see
   * module header). NEVER blocks/fails the commit (mirrors the `sourceCommit`/`refreshRecentChanges`
   * post-commit hook a few lines below, worker Lesson 76/77): a trigger fault is swallowed, the ORIGINAL
   * commit `Result` is returned unchanged. `auditRef` reuses the SAME `kw:commit:${planId}` string both
   * commit sites already derive their idempotencyKey from — `buildCommitAuditRecord` (revision.ts) folds
   * that exact string into the committed AuditRecord's `refs`, so it is a genuine, queryable audit
   * linkage, not an invented value (the frozen `AuditRecord` model carries no `id` field to read back).
   */
  async function withGbrainSync(
    plan: KnowledgeMutationPlan,
    result: Awaited<ReturnType<CommitKnowledgePort["commit"]>>,
  ): Promise<void> {
    if (!isOk(result)) return;
    try {
      await triggerGbrainSync(
        {
          workspaceId: String(plan.workspaceId),
          committedRevisionId: result.value.revisionId as RevisionId,
          planId: String(plan.planId),
          auditRef: `kw:commit:${String(plan.planId)}`,
        },
        {
          outbox: gbrainSyncOutboxBinding.store,
          now,
          newHealthItemId: (): string => `gbrain-sync:${now()}:${Math.random().toString(36).slice(2)}`,
          dispatchIndex: gbrainIndexDispatcher,
        },
      );
    } catch {
      /* fail-SAFE: a sync-trigger fault (even a totality regression) never fails the commit */
    }
  }

  // 18.6/18.5 + 9.16 — the Ingestion-Inbox PARK sink the content classifier + correlation producer
  // record to on a no-match/below-threshold (REQ-F-017 clarification surface). ALWAYS-ON: the default
  // is the REAL readModels-backed `createIngestionInboxProjectionPort` (9.7-B producer core — WS-8-safe
  // by construction, drop-rules AT WRITE, never-throws), so a real park populates `ingestion_inbox` and
  // a triage disposition removes it (the 2nd "make the daily briefing real" producer leg, mirrors 9.15
  // recentChanges / LESSON 76). `params.ingestionPark` stays the test/fake override seam.
  const ingestionPark: IngestionInboxProjectionPort =
    params.ingestionPark ??
    createIngestionInboxProjectionPort({ readModels: backends.repos.readModels, now });

  // ── the failure sink (7.5) backing every per-driver *HealthSink (inv-5) ──────
  const outboxSink: OutboxSink = {
    async enqueueRetry(entry): Promise<void> {
      await backends.repos.outbox.enqueue(entry);
    },
  };
  const surfaceDeps: SurfaceDeps = {
    health: backends.healthItems,
    outbox: outboxSink,
    clock: { now },
  };

  // ── meeting-closeout ─────────────────────────────────────────────────────────

  // (a) correlate — a deterministic signal source (inv-1: high IFF cleared+resolved).
  const correlate: CorrelatePort = createCorrelateActivity({
    // 18.5 — a real confidence-scored correlation producer over the INJECTED scorer (UNSET ⇒
    // the BYTE-EQUIVALENT fixed `correlationSignals` binding). Below-threshold ⇒ recordPark
    // (REQ-F-017), never an invented binding. Threshold single-sourced with the activity.
    resolveSignals: createCorrelationSignalProducer({
      scorer: params.correlationScorer ?? createBootCorrelationScorer(params.correlationSignals),
      park: ingestionPark,
      threshold: ROUTING_THRESHOLD,
    }),
    threshold: ROUTING_THRESHOLD,
  });

  // (b) runAgentJob — the REAL broker (localConfig ALWAYS supplied by backends).
  const runAgentJob: RunMeetingAgentJobPort = createRunAgentJobActivity({
    broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
    inputs: params.meetingJobInputs,
    buildEgress: () => params.resolved.egressPolicy,
    buildMatrix: () => params.resolved.providerMatrix,
    buildWorkspace: () => ({
      type: params.resolved.type,
      dataOwner: params.resolved.dataOwner,
    }),
    // The stub broker run is fixed, so the accepted outcome maps to the deterministic
    // meeting extraction; the real transport folds a model's candidate here instead.
    // 18.3 — GATE on the broker verdict: only an ACCEPTED outcome (run-leg output passed the
    // broker schema gate) authorizes the extraction to trace through; a rejection ⇒ an EMPTY
    // extraction the downstream candidate-data gate rejects (no commit). Faithful evidence-bearing
    // reconstruction from the accepted candidate is deferred to the agent_extraction candidate (#18).
    mapCandidate: (outcome: BrokerOutcome): AgentExtraction =>
      mapAcceptedMeetingExtraction(outcome),
    // Phase-3/5 carry-forward: localConfig is ALWAYS supplied to the broker.
    localConfig: backends.localConfig,
  });

  // (c) validate — no-inference (real) + a deterministic pass-through schema gate.
  // 18.3 — the REAL meeting-extraction structural candidate-data gate (rule 2 / REQ-S-006),
  // replacing the pass-everything stub. Composed with validateNoInference (REQ-F-017) inside
  // createValidateActivity. Worker-injected (reuses ExtractionField; no new frozen model).
  const schemaGate: MeetingSchemaGate = createMeetingExtractionSchemaGate();
  const validate: ValidateExtractionPort = createValidateActivity({ schemaGate });

  // (d) buildOutputs — the REAL imported meetingOutputsProjection (WS-2 stamp).
  // §9 create-vs-patch: a WS-8-scoped note-exists probe over the committed vault — a re-close region-PATCHes the
  // `meeting-outputs` region instead of clobbering the whole note via a NoteCreate; a vault read fault fails the
  // build CLOSED (build_failed, no commit — never a guessed create-vs-patch under uncertainty).
  const meetingNoteExists: NoteExistsReader = {
    exists: async (path: string): Promise<Result<boolean, NoteExistsError>> => {
      try {
        const content = await backends.vault.read(path);
        return ok(content !== undefined);
      } catch (cause) {
        return err({ code: "read_failed", message: "meeting note-exists probe: vault read failed", cause });
      }
    },
  };
  const buildOutputs: BuildOutputsPort = createBuildOutputsActivity({
    projection: meetingOutputsProjection,
    sourceRef: params.sourceRef,
    planIdentity: params.planIdentity,
    noteExists: meetingNoteExists,
    // 13.8f-B — narrow cut: UNSET on the shipped default (params.meetingVault is always undefined until
    // a future boot.ts call site exists), so linkMutations stays [], byte-equivalent to pre-13.8f-B.
    meetingVaultRewrite: params.meetingVault,
  });

  // (e) commit — the REAL KnowledgeWriter applyPlan; REAL ownership+secret defaults.
  const knowledgeWriterDeps: KnowledgeWriterDeps = {
    vault: backends.vault,
    revisions: params.revisions,
    audit: backends.repos.audit,
    now,
    // ownershipCheck + secretScan LEFT UNSET → applyPlan uses the real
    // enforceHumanOwnership + scanForSecrets defaults (secure-by-default, safety rule
    // 1/7). We must NEVER pass a pass-through here.
    //
    // 24.26 — SUPPLY the exempt workspace id. Built HERE (composition, once per boot) and NOT
    // inside a job path: constructing it per job would turn a config fault into an uncaught throw
    // where `applyPlan` promises a typed WriteFailure (step 1's note).
    //
    // ⛔ LOAD-BEARING AS OF STEP 3 (`46e34ca8`) — THIS LINE IS NOW THE ONLY THING ENFORCING THE
    // WORKSPACE-PATH GUARD (safety rule 4 / WS-8) ON THIS PATH. `KnowledgeWriterDeps.workspacePathCheck`
    // is REQUIRED and writer.ts's `?? enforceWorkspacePathScope` fallback is DELETED — there is
    // nothing behind it. Verified by mutation rather than inherited: deleting this line yields
    // `TS2741: Property 'workspacePathCheck' is missing … but required in type 'KnowledgeWriterDeps'`.
    //
    // ⚠ THIS COMMENT READ "BEHAVIOURALLY INERT TODAY" UNTIL STEP 3 LANDED, and the correction is
    // recorded rather than silently swapped because the FAILURE MODE is the interesting part: it was
    // TRUE WHEN WRITTEN and was falsified by a change in ANOTHER PACKAGE, with no edit to this file
    // and nothing going red (`contracts L134`'s shape arriving in comments rather than switch
    // statements; `L148`'s family — an artifact outliving the state it describes). ⛔ And the
    // direction is the dangerous one: a comment calling a LIVE guard "inert" invites the next reader
    // to delete it as dead weight, which fails OPEN on a rule-4 guard.
    //
    // ⚠ THE OLD BLOCK ALSO SAID "do not read the absence of a behavioural test as an oversight."
    // That is STILL TRUE and its REASON CHANGED, so it is replaced rather than struck: absence is now
    // caught by the type system (the `TS2741` above), and what no test can reach is whether the
    // SUPPLIED STRING is the right one — a required parameter type-checks PRESENCE, never the value
    // (`worker L28`). The boundary pins in `test/composition/semanticApprovalDispatch.test.ts` carry
    // that reasoning in full.
    //
    // ⭐ 24.75 ENUMERATION METHOD + BOUNDARY (its Done-when's 2nd clause): "sites supplying the exempt
    // id" are derived by TYPE (every production `KnowledgeWriterDeps` object-literal construction) and
    // CALL PATH (every production call to `makeEnforceWorkspacePathScope`) — never by grepping
    // `LEGACY_UNPREFIXED_WORKSPACE_ID`'s spelling, which a renamed/aliased import would silently miss.
    // Both derivations return the SAME two sites, exhaustively: this one, and
    // `semanticApprovalDispatch.ts`'s — re-confirmed at this writing (`grep -rn`, excluding test/dist,
    // for `': KnowledgeWriterDeps = {'` and separately for `'makeEnforceWorkspacePathScope('`, over
    // `apps` + `packages`, each returns exactly these two non-test hits). Both are pinned: this site by
    // the exact-source-text pin below (worker L28), the sibling by its own runtime differential — both
    // in `semanticApprovalDispatch.test.ts`.
    //
    // ⚠ 24.61 — THE OTHER AXIS THE TYPE SYSTEM ALSO CANNOT REACH, and this comment is what the guard's
    // own Done-when calls "the composition root" — a BLANK id, or one built entirely from Cf zero-width/
    // format code points (U+200B/U+200C/U+2060/U+180E). `makeEnforceWorkspacePathScope`
    // (`packages/knowledge/src/knowledge-writer/workspace-path-guard.ts`) throws on either, and its OWN
    // docstring is explicit about what that throw does NOT guarantee: it is a MISCONFIGURATION
    // TRIPWIRE, not validation that the supplied string is a LEGITIMATE workspace id — a well-formed
    // but WRONG id sails through untouched (that residual is 24.75, immediately above). Closing THAT
    // class needs validating the supplied id against the known workspace set, which the guard's own
    // docstring names as "a composition-root change, outside this module's territory" — i.e. HERE.
    // ⛔ NOT ADDED, and per the guard's own documented PRECONDITION it is not yet OWED here either: "a
    // hardcoded literal … does NOT make the residual reachable" — what makes it reachable is sourcing
    // the id from anything other than a compile-time constant (env, settings, a DB row, a user-editable
    // file). `LEGACY_UNPREFIXED_WORKSPACE_ID` (`./legacy-workspace.ts`) is exactly such a constant, so
    // the trigger has not fired. ⭐ IF YOU ARE HERE CHANGING THIS ARGUMENT TO A CONFIG READ: that change
    // IS the trigger, and known-workspace-set validation (or an equivalent construction) becomes owed
    // at that moment, not before.
    // ⭐ WHAT IS ALREADY PROVEN, so this residual isn't standing on faith: the exact-source-text pin
    // immediately below (`semanticApprovalDispatch.test.ts`, "buildActivities' literal supplies the
    // check from the SAME shared const") asserts the LITERAL source text
    // `makeEnforceWorkspacePathScope(LEGACY_UNPREFIXED_WORKSPACE_ID)` — no intervening transform of the
    // constant — so whatever reaches the factory here is the raw, untouched import, and the factory's
    // own Cf/blank throw (24.61's remedy, landed in the guard module) applies to it unconditionally.
    workspacePathCheck: makeEnforceWorkspacePathScope(LEGACY_UNPREFIXED_WORKSPACE_ID),
    // task 19.2 — the provenance-signing dep, NESTED inside this SAME dormancy gate (conditional-
    // spread: the key is ABSENT, not `undefined`-valued, when `params.signing` is unset) so the
    // shipped default stays byte-identical to pre-19.2 (writer.ts:626-637 gates ALL stamping on
    // `deps.signing !== undefined`).
    ...(params.signing !== undefined ? { signing: params.signing } : {}),
  };
  // task 24.105 — binding-site precondition guard, RESOLVED. `commit`'s `.commit(plan)` returns the
  // RAW `CommitKnowledgePort` Result — a rejection carries `cause: result.error`, the WHOLE
  // `WriteFailure` with validator-authored messages constructed at
  // `packages/workflows/src/activities/commitKnowledge.ts:164` (e.g. the secret-scan/workspace-path/
  // ownership rejection detail). That raw `cause` is exactly what must never become this activity's
  // Temporal result: the `meetingCommit:` wrapper below (the ONLY place this `commit` instance's
  // Result crosses into a registered activity) redacts the `err` arm via `dropCommitFailureCause`
  // (small pure helpers, near the bottom of this file) before returning — the closed `code` still
  // crosses (every downstream `.error.code` consumer keeps switching identically) but `cause` never
  // does, so a failed commit no longer lands raw in WORKFLOW HISTORY. ⛔ NEVER expose this raw
  // `commit` PORT OBJECT itself as a registered Temporal activity VALUE — only ever through the
  // plain-async WRAPPER function (`meetingCommit:` below), and never let that wrapper return `result`
  // verbatim on the `err` arm. Spreading `commit` directly into
  // the returned activities literal (e.g. a future `{...commit, ...}` shorthand) would register a
  // `CommitKnowledgePort`-shaped OBJECT (with a `.commit` method) under a Temporal activity key — this
  // module's own header requires PLAIN ASYNC FUNCTIONS, and Temporal's `Worker.create({activities})`
  // expects each member directly invocable, not a nested method. A prohibition alone invites its own
  // deletion — `proof-spine-composition.test.ts` pins that every exposed commit-bearing activity is a
  // bare function with no nested `.commit`, never this port spread in; the `cause`-redaction itself is
  // pinned in `test/composition/commitCauseRedaction.test.ts` (hostile-fixture `cause` never crosses,
  // `code` still does; the `ok` arm still reaches `withGbrainSync` unredacted).
  const commit: CommitKnowledgePort = createCommitActivity({
    applyPlan,
    deps: knowledgeWriterDeps,
    actor: params.commit.actor,
    sourceEventRef: params.commit.sourceEventRef,
    workflowRunRef: params.commit.workflowRunRef,
    expectedBaseRevision: params.commit.expectedBaseRevision,
    // Stable idempotency key from the plan id (inv-5: same plan replays same commit).
    deriveIdempotencyKey: (plan) => `kw:commit:${String(plan.planId)}`,
  });

  // (f) propose — the §8 Tool Gateway routed via dispatchRouted (→ dispatchExternalWrite) over real backends.
  const requireApproval = makeRequireApproval(params.resolved);
  const externalWriteDeps: ExternalWriteDeps = {
    // 21.1/2 binding: the ExternalWriteDeps type requires an `adapter`, but the vendor adapter is now
    // selected PER-CALL by `dispatchRouted` (keyed on `action.targetSystem`) — so this is the fail-closed
    // sentinel (`createUnroutedWriteAdapter`): every op REJECTS if a dispatch ever bypasses the registry
    // (defense-in-depth, never a silent single-vendor write). `dispatchRouted` overrides it with the pick.
    adapter: createUnroutedWriteAdapter(),
    receiptStore: backends.receiptStore,
    requireApproval, // SYNC bare verdict; FAILS CLOSED on a policy DENY.
    recordPendingApproval: async (action, env): Promise<Result<unknown, unknown>> => {
      // Record a pending Approval so an approval-required action is never lost. The
      // pending record's id is derived from the envelope's idempotencyKey (idempotent).
      const approval: Approval = {
        id: makeApprovalIdFromEnvelope(env),
        actionRef: action.actionId,
        // §13.10a — a Tool-Gateway external write is an external_action subject (actionRef only).
        subjectKind: "external_action",
        // WS-4 inbox-scope: the meeting-close job's bound workspace (server-side, authoritative).
        workspaceId: params.meetingJobInputs.workspaceId,
        status: "pending",
        actor: params.commit.actor,
        channel: "mac",
        payloadHash: env.payloadHash,
      };
      const created = await backends.repos.approvals.create(approval);
      return created.ok ? ok(created.value) : err(created.error);
    },
    isApproved: async (env): Promise<boolean> => {
      const id = makeApprovalIdFromEnvelope(env);
      const got = await backends.repos.approvals.get(id);
      return got.ok && got.value.status === "approved";
    },
    audit: async (rec): Promise<void> => {
      await backends.repos.audit.append(rec);
    },
    clock: now,
    // 21.10 — conditional-spread (key ABSENT when unset, never `undefined`-valued) so the shipped
    // default is BYTE-IDENTICAL to pre-21.10 (credential-seam.test.ts's ABSENT-accessor pin; L57).
    ...(params.secretsAccessor !== undefined ? { secrets: params.secretsAccessor } : {}),
  };
  const propose: ProposeActionsPort = createProposeActivity({
    // 21.1/2 binding: route by `action.targetSystem` through the registry (dispatchRouted overrides
    // the sentinel `deps.adapter` with the vendor pick); an unregistered target FAILS CLOSED (rejected).
    dispatch: (
      env: ExternalWriteEnvelope,
      action: ProposedAction,
      deps: ExternalWriteDeps,
    ): Promise<ExternalWriteResult> => dispatchRouted(backends.writeAdapters, env, action, deps),
    deps: externalWriteDeps,
  });

  // (g) reindex — the GBrain re-index client over the deterministic index transport.
  const reindexClient: GbrainReindexClient = {
    async reindex(
      revisionId: string,
    ): Promise<Result<GbrainReindexAck, ReindexError>> {
      // The lower-level IndexApplyClient is keyed by (workspaceId, revisionId); here
      // we bind the closeout's workspace and ACK idempotently. A revision maps 1:1.
      const applied = await backends.indexClient.applyRevision({
        workspaceId: String(params.meetingJobInputs.workspaceId),
        revisionId,
        facts: [],
      });
      if (!applied.ok) {
        return err({
          code: "revision_unavailable",
          message: `GBrain index apply failed: ${applied.error.code}`,
        });
      }
      const ack: GbrainReindexAck = {
        kind: applied.value.mutated ? "indexed" : "already_indexed",
        revisionId,
      };
      return ok(ack);
    },
  };
  const reindex: ReindexGbrainPort = createReindexActivity({ client: reindexClient });

  // ── approval-flow ────────────────────────────────────────────────────────────

  // recordPending — reserve the pending action through the Tool Gateway seam + create
  // the pending Approval in the real ApprovalRepository.
  const recordPendingGateway: RecordPendingGateway = {
    async reservePending(envelope, _action) {
      // The pending reservation rides the §8 receipt store (reserve the object key so a
      // later dispatch reuses the receipt). A reserve fault surfaces as record_failed.
      const reservation = await backends.receiptStore.reserve(
        envelope.targetSystem,
        envelope.canonicalObjectKey,
      );
      if (reservation.kind === "committed") {
        // Already written — the pending record can carry the same envelope.
        return ok({ envelope, created: false });
      }
      return ok({ envelope, created: reservation.kind === "reserved" });
    },
  };
  const recordPending: RecordPendingPort = createRecordPendingActivity({
    gateway: recordPendingGateway,
    approvals: backends.repos.approvals,
    now: now(),
    expiresAt: addHours(now(), 168), // 7d default auto-expire window
    actor: params.commit.actor,
    seedChannel: "mac",
  });

  // surfaceCard — render on BOTH channels with parity (21.8: the renderer is now SELECTED via
  // PROV-3's default-OFF `selectCardRenderer` gate rather than hardcoded — `params.cardTransport`
  // UNSET (the shipped default) returns the SAME deterministic no-op literal byte-identical to
  // pre-21.8; an owner-armed gate swaps in the real Mac/Telegram transports, still rendering both).
  const cardRenderer: CardRenderer = selectCardRenderer(params.cardTransport);
  const surfaceCard: SurfaceCardPort = createSurfaceCardActivity(cardRenderer);

  // applyTransition — the REAL ApprovalRepository CAS (exactly-once across channels).
  const applyTransition: ApplyTransitionPort = createApplyTransitionActivity({
    approvals: backends.repos.approvals,
    now: now(),
    snoozeUntil: addHours(now(), 24), // 24h default snooze re-surface window
    expiresAt: addHours(now(), 168),
  });

  // dispatchApproved — the §8 Tool Gateway envelope (reserve-then-create replay reuse).
  const approvedGateway: ApprovedDispatchGateway = {
    async dispatch(
      action: ProposedAction,
      envelope: ExternalWriteEnvelope,
    ): Promise<Result<DispatchApprovedResult, DispatchApprovedError>> {
      // 21.1/2 binding: route the approved dispatch by `action.targetSystem` through the registry too.
      const outcome = await dispatchRouted(backends.writeAdapters, envelope, action, externalWriteDeps);
      switch (outcome.status) {
        case "created":
        case "updated":
        case "reused":
          return ok({
            status: outcome.status,
            envelope: { ...envelope, writeReceipt: outcome.receipt },
          });
        // I1 (SUPERSEDED) — this switch used to fold `outcome.reason` through
        // `redactDispatchApprovedError` to a fixed code-keyed string. That collapse was a
        // REGRESSION: it stripped the §21.10 credential-fault token (`"locked"`/`"empty"`/the
        // fault code) an operator NEEDS to tell "your Mac Keychain is locked" from "the vendor
        // rejected the write" (worker LESSONS §41). `outcome.reason` is now forwarded VERBATIM.
        //
        // Do NOT restate the safety property more strongly than the mechanism supports: the
        // gateway does not build `reason` "from a closed code only" — on these arms it
        // INTERPOLATES the adapter's `AdapterError.message` (gateway.ts ~:266 / ~:310). `reason`
        // is safe by TWO provenances: (1) GATEWAY-AUTHORED text (a closed code in a fixed
        // template, a `.code`/`.path`-only Zod-issue summary, the §21.10 token, the reservation
        // literal); and (2) ADAPTER-AUTHORED `AdapterError.message`, safe because the ADAPTER
        // builds it from CLOSED inputs — every shipped vendor adapter comes from
        // `makeTargetWriteAdapter` (packages/integrations/src/tools/adapters/adapter-core.ts),
        // whose `faultToError` composes `message` from the 4-value closed `TransportFault` code
        // plus the NUMERIC `httpStatus`, never the transport's free-text `detail`. RESIDUAL,
        // honestly: `TargetWriteAdapter` is a plain interface, so a hand-written adapter that
        // bypasses that core could still put arbitrary text in `message` and this path would
        // forward it — the guarantee is by the shared core, not by the type.
        //
        // `code` crosses UNCHANGED, and the workflow driver
        // (packages/workflows/src/workflows/approvalFlow.ts:412-440) branches ONLY on
        // `.error.code` — never on this prose.
        // ⛔ DO NOT re-add a message redaction here. It would buy no safety (the residual above
        // lives at the ADAPTER boundary, which is where it must be closed) and would re-strip the
        // credential-fault signal, which is provenance (1) and never adapter text at all.
        case "conflict":
          return err({ code: "conflict", message: outcome.reason });
        case "held":
          return err({ code: "held", message: outcome.reason });
        // "approval_pending" keeps its own pre-existing fixed literal (never gateway-sourced, so
        // out of scope for the above).
        case "approval_pending":
          return err({ code: "rejected", message: "external write awaits approval" });
        case "superseded":
          // C3 — a newer payload is already applied and this intent predates it, so
          // nothing was written. Terminal: `held` would re-drive a stale intent
          // forever. The reason is gateway-authored and redaction-safe.
          return err({ code: "rejected", message: outcome.reason });
        // No `default:` — see proposeExternalActions.ts: a catch-all on the closed
        // `ExternalWriteResult` union silently absorbs a new status into `rejected`.
        case "rejected":
          return err({ code: "rejected", message: outcome.reason });
      }
      const unhandled: never = outcome;
      return err({ code: "rejected", message: `unhandled dispatch status: ${String(unhandled)}` });
    },
  };
  const dispatchApproved: DispatchApprovedActionPort =
    createDispatchApprovedActivity(approvedGateway);

  // task 21.4/24.8 — the write-outbox DRAIN-ON-WAKE: give buildDrainDeps/buildWakeDrainHook
  // (composition/outboxDrainBind.ts, previously ZERO production importers) a real caller. This factory
  // runs once per Temporal (re)connect (boot.ts's registerHook fires on `onConnected`), so binding the
  // drain HERE mirrors BOTH this file's own established drain-on-wake idiom (compare the 19.1
  // GBrain-sync-outbox drain a few lines up) AND matches LIFE-6's `network_reconnect` wake reason
  // exactly — a genuine reconnect trigger, not an invented one. `gatewayDeps` REUSES the SAME
  // `externalWriteDeps` bundle `propose`/`dispatchApproved` dispatch through (never a second
  // construction — no drift), so a re-driven held entry reaches the IDENTICAL routing decision
  // (dispatchRouted over `backends.writeAdapters`). `workspaceId` is threaded from
  // `params.meetingJobInputs.workspaceId` (task 24.50, safety rule 4) — a due entry for any OTHER
  // workspace is skipped, never evaluated against this posture. Fire-and-forget + swallowed: this
  // factory is SYNCHRONOUS (no `await` here, mirrors every other construction step in this function)
  // and a drain fault must never block/fail activity construction (§16, mirrors the 19.1 drain's own
  // discipline). SAFE, evidence: `backends.writeAdapters` (backends.ts) is
  // `buildWriteAdapterRegistry({ transport: selectAdapterTransport(config.writeTransport), ... })` —
  // with `config.writeTransport` unset (the shipped default, never set by any production BootConfig
  // caller) `selectAdapterTransport` ALWAYS returns the in-memory `createStubAdapterTransport()`, never
  // a real vendor client, so this drain reaches no real vendor until the owner explicitly arms
  // `config.writeTransport` (§ARM-21).
  const drainOnWakeDeps = buildDrainDeps({
    gatewayDeps: externalWriteDeps,
    workspaceId: String(params.meetingJobInputs.workspaceId),
    writeAdapters: backends.writeAdapters,
    clock: now,
  });
  const wakeDrainOnConnect = buildWakeDrainHook({ outbox: backends.repos.outbox, drainDeps: drainOnWakeDeps });
  void wakeDrainOnConnect({ reason: "network_reconnect", now: now() }).catch(() => {
    /* fail-SAFE: a drain-on-wake fault must never block activity construction (§16) */
  });

  // ── ingestion-triage ───────────────────────────────────────────────────────

  // recordDisposition — the DURABLE disposition store (task 15.5) over the @sow/db SourceDisposition
  // repo + the real audit sink; exactly-once CAS record + real isParked (no longer hardwired true).
  const dispositionStore: DispositionStore = createDurableDispositionStore({
    repo: backends.repos.sourceDisposition,
    audit: backends.repos.audit,
    now: backends.now,
    runRef: params.commit.workflowRunRef,
  });
  const recordDisposition: RecordDispositionPort = createRecordDispositionActivity({
    store: dispositionStore,
  });

  // meetingPark (G5) — the low-confidence routing-review PARK over the SAME durable SourceDisposition
  // repo (first-write-wins; NO new writer). Parks a queued_for_review row, workspace-UNBOUND (inv-1).
  const meetingParkPort = createDurableMeetingParkPort({
    repo: backends.repos.sourceDisposition,
    now,
  });

  // rescopeSource — read the parked source back from the durable store (real reader), apply the
  // owner override (inv-C) REGISTRY-VALIDATED (WS-8), preserve contentHash (inv-D).
  const parkedReader: ParkedSourceReader = createDurableParkedReader(backends.repos.sourceDisposition);
  const rescopeSource: RescopeSourcePort = createRegistryValidatedRescope({
    reader: parkedReader,
    readModels: backends.repos.readModels,
  });

  // reenterIngestion — re-drive REUSING the same idempotencyKey (inv-D). The scoped-but-real runner
  // re-drives THROUGH the candidate gate (rule 2) + replays over the real KnowledgeRevisionStore
  // (rule 3); the full-7.7 fresh-commit re-drive (route/agent/build/commit) is a named follow-up.
  const ingestionRunner: SourceIngestionRunner = createReenterRunner({
    reGate: async (source) => {
      // seenContentHash is hardwired false here BY DESIGN: a re-entry is a DELIBERATE re-drive of a
      // known source, so the content-hash dedup leg must NOT short-circuit it — the reused
      // idempotencyKey is the replay/dedupe guard downstream (inv-D), not the seen-hash leg.
      const res = await registerSource(
        {
          sourceId: String(source.sourceId),
          workspaceId: String(source.workspaceId),
          origin: source.origin,
          contentHash: source.contentHash,
          type: source.type,
          sensitivity: source.sensitivity,
          routingHints: source.routingHints,
        },
        { seenContentHash: () => Promise.resolve(false) },
      );
      return res.outcome === "rejected" ? err({ code: "rejected" as const }) : ok(undefined);
    },
    revisions: params.revisions,
  });
  const reenterIngestion: ReenterIngestionPort = createReenterIngestionActivity({
    runner: ingestionRunner,
  });

  // ── source-ingestion (make-it-real C1) ──────────────────────────────────────
  // ONLY `sourceRegister` runs the REAL @sow/integrations registerSource candidate
  // gate; every other leaf here is a DETERMINISTIC fake (guardrail-3). No real vault
  // write, no model call, no external write, no disk-content read in C1 (C2/C3).
  const sourceBinding = params.sourceIngestion;

  // (a) register — the REAL §8 gate (ajv structural + Zod .strict() + Flow-4 dedupe).
  // 16.6 — the Flow-4 dedupe probe now reads the REAL persisted 15.4 SeenContentHashRepository
  // (WS-8-scoped, first-write-wins). This de-deads 15.4 (0 live consumers per the Phase-15 gate) and
  // gives the source-ingestion-workflow path (the live fs-watcher dispatch runs this `sourceRegister`
  // activity) persistent content-dedup that survives Temporal history-retention expiry. L34: a store
  // fault PROCEEDs (never a HOLD / false dedupe-hit).
  //   NOTE (Step-9 flag): the 16.2 connector-poll path calls `registerSource` through the 15.1
  //   `connectorIngestionBridge`, which carries its OWN `registerDeps.seenContentHash` seam (not this
  //   activity). Point that seam at the SAME probe when the bridge is constructed with real deps
  //   (Phase-16 binding-metadata wiring) so the poll path dedups too.
  const sourceRegister: RegisterSourcePort = createRegisterSourceActivity({
    registerSource,
    seenContentHash: createSeenContentHashProbe(backends.repos.seenContentHash, backends.now),
  });

  // (b) route — the REAL threshold-gated routeSource activity over a DETERMINISTIC
  // classifier: a present binding resolves a HIGH-confidence workspace bind (WS-2);
  // absent → a sub-threshold Ingestion-Inbox park (fail-closed, never auto-routes).
  const sourceRoute: RouteSourcePort = createRouteSourceActivity({
    // 18.6 — a real content→project classifier over the INJECTED resolver (UNSET ⇒ the
    // BYTE-EQUIVALENT boot-workspace bind: confidence:1 boot ws, no project — matching the
    // pre-18.6 single-workspace classify; the bound path never parks). The C1 no-binding
    // fallback (sourceBinding undefined) parks via the ingestionPark default — now the REAL
    // always-on producer (9.16), so the C1 park populates `ingestion_inbox`. No-match/below-
    // threshold ⇒ recordPark (REQ-F-017), projectId NEVER guessed. Threshold single-sourced with the activity.
    classify: createContentProjectClassify({
      resolve:
        params.contentResolver ??
        (sourceBinding !== undefined
          ? createBootWorkspaceContentResolver(sourceBinding.boundWorkspaceId)
          : {
              resolve: (): Promise<Result<RouteSignals, RouteError>> =>
                Promise.resolve(ok({ confidence: 0, reason: "no source-ingestion binding (C1)" })),
            }),
      park: ingestionPark,
      threshold: ROUTING_THRESHOLD,
    }),
    threshold: ROUTING_THRESHOLD,
  });

  // (c) runAgentJob — 18.4: the source-processing job now ROUTES THROUGH THE BROKER (replacing the
  // fixed `ok(sourceBinding.extraction)` bypass), SUBJECTING the untrusted imported source to ING-7
  // admission (rule 6) + the broker's gate pipeline (route → egress-veto → health → budget → run →
  // schema). The run leg is 18.1's DORMANT STUB (no real model); on an ACCEPTED outcome `mapCandidate`
  // (18.12b/CP-2, the shared meeting-leg mapper) reconstructs FAITHFULLY from an `agent_extraction`
  // candidate. The dormant stub emits a KMP stand-in ⇒ `mapCandidate` returns EMPTY (fail-closed, no
  // commit — L46), NOT byte-equivalent to the prior echo bypass; CP-3b threads the source stubExtraction
  // so the dormant source run emits a real agent_extraction (reachability = the arming bundle, L11). WS-8 (rule 4): the job's workspace
  // is bound DYNAMICALLY from the routing-bound `ctx.workspaceId` INSIDE `createSourceAgentBrokerRouting`
  // (never a source content field). Absent binding → the fail-closed unsupported_type rejection (C1).
  const sourceAgent: RunSourceAgentJobPort =
    sourceBinding === undefined
      ? {
          run: (): Promise<Result<AgentExtraction, SourceAgentFailure>> =>
            Promise.resolve(
              err({ code: "unsupported_type", message: "no source-ingestion binding (C1)" }),
            ),
        }
      : createSourceAgentBrokerRouting({
          broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
          inputs: {
            workflowRunId: params.meetingJobInputs.workflowRunId,
            // `source.process` — a worker-internal capability arch_gap string (orch-confirmed; no
            // contract change). Its route lives in the workspace ProviderMatrix (local zero-egress).
            capability: "source.process",
            // 18.27 / #13 Finding C — the OWNER-ARMED outputSchemaId (AND-locked to the arming signal via
            // `withSubscriptionExtractionArming`, L57). UNSET (the shipped default) ⇒ the KMP stand-in ⇒
            // `mapAcceptedMeetingExtraction` reconstructs EMPTY ⇒ reject (byte-equivalent, L46). Armed ⇒
            // `sow:agent-extraction` ⇒ the accepted candidate carries `evidenceRef` to validateNoInference (GATE-1).
            outputSchemaId: sourceBinding.outputSchemaId ?? KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
            maxRuntimeSeconds: params.meetingJobInputs.maxRuntimeSeconds,
            // Deterministic, WS-8-scoped idempotency key (mirrors the meeting job's fixed key). The
            // per-file dedupe axis is the ctx-threaded SourceNoteIdentity downstream (note path/planId).
            idempotencyKey: `job:source:${String(sourceBinding.boundWorkspaceId)}:${String(sourceBinding.sourceRef.sourceId)}`,
            // 18.24 step-6 — thread the OPTIONAL binding-supplied ContextRefs onto the job. UNSET (shipped
            // default) ⇒ `undefined` ⇒ `source-extraction` folds it to `[]` (byte-equivalent). Populated ONLY on
            // the owner-armed path (`withSubscriptionExtractionArming`) with the routing-bound source ref (WS-8).
            contextRefs: sourceBinding.contextRefs,
            // toolPolicy left unset → the READ_ONLY default (ING-7): a read-only untrusted source job.
          },
          // WS-8: the source routes to its OWN `ctx.workspaceId` (routing-bound), which may differ from the
          // proof-spine's configured workspace. The broker requires `matrix.workspaceId === job.workspaceId`
          // (route-resolution) and evaluates the egress veto over the job's workspace, so scope BOTH the matrix
          // and the egress policy to the source job's ws. In the shipped single-workspace-per-worker proof-spine
          // (`buildAutoIngestProofSpineParams`, where `boundWorkspaceId === resolved.workspaceId`) this is a
          // NO-OP; it only bites when a source classifies into a workspace distinct from the worker's default.
          buildEgress: (ctx) => ({
            ...params.resolved.egressPolicy,
            workspaceId: ctx.workspaceId ?? params.resolved.egressPolicy.workspaceId,
          }),
          buildMatrix: (ctx) => ({
            ...params.resolved.providerMatrix,
            workspaceId: ctx.workspaceId ?? params.resolved.providerMatrix.workspaceId,
          }),
          buildWorkspace: () => ({
            type: params.resolved.type,
            dataOwner: params.resolved.dataOwner,
          }),
          // gate-on-outcome (18.12b/CP-2, shared mapper): an ACCEPTED `agent_extraction` candidate is
          // reconstructed FAITHFULLY (value + evidenceRef); a non-agent_extraction candidate (today's dormant
          // KMP stand-in) OR a rejection yields EMPTY ⇒ no commit (L46). CP-3b threads the source stubExtraction
          // so the dormant source run emits a real agent_extraction; production reachability = the arming bundle
          // (outputSchemaId → sow:agent-extraction, #13 Finding C), reachability-WAIVERED (L11).
          mapCandidate: (outcome: BrokerOutcome): AgentExtraction =>
            mapAcceptedMeetingExtraction(outcome),
          // Phase-3/5 carry-forward: localConfig is ALWAYS supplied to the broker.
          localConfig: backends.localConfig,
        });

  // (d) buildOutputs — DETERMINISTICALLY derive a KnowledgeMutationPlan FROM the
  // validated extraction + the routing-BOUND workspace (WS-2/WS-4 stamp — never a
  // caller value). `actions: []` so the happy path rests at `applied` without the
  // external-write stage (C1 scope). A stable planId (per workspace + planIdentity)
  // makes the commit fake's replay hold (inv-5).
  // The honest degrade body (Lesson 15) when the source carries no extracted content — a REAL
  // minimal note, never the old `"source ingestion (C1)"` placeholder and never empty/a failure.
  const SOURCE_NOTE_ABSENT_BODY = "_No extracted content yet._";
  const sourceBuildOutputs: SourceBuildOutputsPort = {
    build: (
      validated: ValidatedExtraction,
      ws: WorkspaceId,
      source: SourceNoteIdentity,
      body?: string,
    ): Promise<Result<MeetingBuiltOutputs, BuildOutputsFailure>> => {
      if (sourceBinding === undefined) {
        return Promise.resolve(
          err({ code: "build_failed", message: "no source-ingestion binding (C1)" }),
        );
      }
      // Derive a PER-FILE, traversal-safe, content-addressed note path from the dropped file's
      // identity (task 11.1) — so DISTINCT files persist as DISTINCT notes (a fixed path collapsed
      // every file to one). The path fails CLOSED on an unsafe `ws` segment (WorkspaceId is not
      // charset-validated); a same-file same-content re-drop derives the same path + planId ⇒ the
      // durable revision store replays (no duplicate); an edited file ⇒ a new note (lossless).
      const notePath = deriveSourceNotePath(ws, source);
      if (!notePath.ok) {
        return Promise.resolve(err({ code: "build_failed", message: notePath.error.message }));
      }
      // planId keys on the SAME content-addressed digest as the path, so path ↔ planId stay
      // consistent (same file+content → replay; edit → new note). Includes `ws` (WS-8 distinct).
      const digest = sourceIdentityDigest(source);
      // 18.7 — the deterministic PENDING external-action producer (SAFE-BUILD, NO dispatch). UNSET
      // binding (the shipped default) ⇒ [] ⇒ byte-equivalent. WS-8/no-inference: the identity is the
      // routing-bound `ws` + the per-file source identity, NEVER content; the keys are traversal-safe
      // (LESSON 5); an emitted action lands PENDING via the propose path below (no dispatch here).
      const externalActions = produceProposedActions({
        validated,
        identity: { workspaceId: ws, sourceId: String(source.sourceId) },
        binding: sourceBinding.externalActionBinding,
      });
      // 18.29 — the committed note carries the REAL validated extraction in its frontmatter, alongside the
      // identity provenance (source/contentHash). This GENERALIZES the 18.8 FIXED [owner,dueDate] convention
      // to a STRICT PATTERN allow-list that ALSO projects the real model's MULTI-TASK task-prefixed fields
      // (task1_owner, task1_dueDate, task2_owner, …) — the maiden run emitted these and the fixed-key read
      // degraded them to blanket TBD/TBD. It stays injection-resistant BY CONSTRUCTION (L49): a key lands ONLY
      // if it is a bare convention field OR matches `^task<n>_(owner|dueDate)$` EXACTLY — a smuggled
      // `workspaceId`/path/`../x`/`taskN_secret`/non-digit-index key can NEVER inject frontmatter or redirect
      // the path/workspace (WS-8/no-inference). An absent field ⇒ the TBD sentinel via `frontmatterValue`
      // (REQ-F-017, never invented); every value is neutralized so an embedded `kw:region` marker can't forge a
      // region boundary (parity with the meeting projection). The content reaches the note ONLY via this
      // validated KMP → createCommitActivity → applyPlan (the sole writer, which re-runs the gate — rule 1).
      const BARE_FRONTMATTER_FIELDS = ["owner", "dueDate"] as const;
      // task R18-a (documented LIVE finding, IMPLEMENTATION_PLAN.md §ARM-18 crossing Step A,
      // 2026-07-24): the underscore form `^task(\d+)_(owner|dueDate)$` NEVER matched the real
      // model's multi-task INPUT field names — the maiden run's live output is camelCase
      // (`task1Owner`/`task1DueDate`), so every multi-task owner/dueDate silently degraded to
      // absent (worse than TBD — the field never even entered the loop below) despite real
      // evidence-backed values being present. ONE casing only (never both — accepting both would
      // double the MAX_FRONTMATTER_TASKS cap slots for what could be the SAME logical task under
      // two spellings): this regex now matches the MODEL's real INPUT shape. The NOTE's own OUTPUT
      // frontmatter key convention stays UNCHANGED (underscore, `task1_owner`) — that is this
      // worker's own choice for how a note looks, independent of what the model called its fields;
      // only the INPUT match (which `vfields` keys count as a task field, and which SUFFIX reads
      // owner vs dueDate) moved. Anchored (no `g` flag ⇒ stateless `.exec`).
      const TASK_FRONTMATTER_FIELD = /^task(\d+)(Owner|DueDate)$/;
      /** Map the regex's matched INPUT suffix (`Owner`/`DueDate`) to the OUTPUT field name + key segment (unchanged). */
      const TASK_FIELD_BY_INPUT_SUFFIX = { Owner: "owner", DueDate: "dueDate" } as const;
      // Defensive bound on the projected task COUNT: the agent_extraction candidate is not yet key-count-bounded
      // (maxProperties is a deferred §9-catalog Future-TODO, L51), so a pathological/hostile extraction could
      // emit unbounded taskN_* keys. Cap the tasks (NOT a silent per-key drop) — beyond the cap a single
      // `tasksTruncated: true` sentinel (a projection-added literal, NEVER read from `fields` ⇒ injection-safe)
      // honestly signals the elision.
      const MAX_FRONTMATTER_TASKS = 50;
      // Defensive degrade to the SAFE no-inference value: `ValidatedExtraction.fields` is non-optional per
      // contract, but a contract-violating absent `fields` degrades to `{}` ⇒ every convention field resolves
      // to the TBD sentinel (never an invented value), with the KnowledgeWriter gate as the real backstop.
      const vfields = validated.fields ?? {};
      const noteFrontmatter: Record<string, unknown> = {
        source: String(source.sourceId),
        contentHash: source.contentHash,
      };
      // (i) the bare convention fields — ALWAYS projected (backward-compat: a single-task source is
      // byte-equivalent to 18.8; a pure multi-task source keeps the honest TBD pair). Absent ⇒ TBD.
      for (const name of BARE_FRONTMATTER_FIELDS) {
        noteFrontmatter[name] = neutralizeFrontmatterValue(frontmatterValue(vfields[name]));
      }
      // (ii) the multi-task fields — collect the DISTINCT task-index digit strings present under the strict
      // pattern, order ASCENDING by numeric value (digit-string tiebreak for determinism), cap, then project
      // BOTH owner+dueDate per task (an absent sibling ⇒ TBD). Reading by the canonical `task${idx}_${field}`
      // key uses the exact matched digit string, so a leading-zero variant (`task01_`) is neither lost nor
      // collided with `task1_`.
      const taskIndices = [
        ...new Set(
          Object.keys(vfields)
            .map((k) => TASK_FRONTMATTER_FIELD.exec(k)?.[1])
            .filter((d): d is string => d !== undefined),
        ),
      ].sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0));
      const projectedTasks = taskIndices.slice(0, MAX_FRONTMATTER_TASKS);
      for (const idx of projectedTasks) {
        for (const [inputSuffix, outputField] of Object.entries(TASK_FIELD_BY_INPUT_SUFFIX) as readonly [
          keyof typeof TASK_FIELD_BY_INPUT_SUFFIX,
          "owner" | "dueDate",
        ][]) {
          // INPUT key: the model's REAL casing (`task1Owner`) — what `vfields` is actually keyed by.
          const inputKey = `task${idx}${inputSuffix}`;
          // OUTPUT key: the note's own UNCHANGED convention (`task1_owner`).
          const outputKey = `task${idx}_${outputField}`;
          noteFrontmatter[outputKey] = neutralizeFrontmatterValue(frontmatterValue(vfields[inputKey]));
        }
      }
      // No silent cap (L51): a truncated projection stamps a visible sentinel (a projection-added literal,
      // never read from `fields`, so it can't be forged by a hostile extraction).
      if (taskIndices.length > projectedTasks.length) {
        noteFrontmatter.tasksTruncated = true;
      }
      const plan: KnowledgeMutationPlan = {
        planId: makePlanId(`plan-source-${String(ws)}-${digest}`),
        // WS-2/WS-4: stamped from the PASSED (routing-bound) workspace, never a caller/source field.
        workspaceId: ws,
        // Honest per-file traceability — the REAL dropped source, not the static boot binding ref.
        sourceRefs: [{ sourceId: source.sourceId }],
        creates: [
          {
            path: notePath.value,
            title: `Ingested: ${String(source.sourceId)}`,
            // The REAL note body (15.3): the GATE-VALIDATED SourceEnvelope.body (threaded as an
            // explicit param, already cleared the §8/15.2 candidate-data gate — never raw-around-gate,
            // rule 2). Absent OR empty ⇒ the honest minimal degrade (Lesson 15) — an empty markdown
            // body is a worse artifact than an honest marker, so an empty string collapses too. `body`
            // NEVER influenced the path above (deriveSourceNotePath keys only on the identity —
            // traversal-safe, WS-8).
            body: body !== undefined && body.length > 0 ? body : SOURCE_NOTE_ABSENT_BODY,
            // 18.8 — the identity provenance (source/contentHash) PLUS the real validated extraction
            // (owner/dueDate, TBD when absent) via the fixed convention built above — no attacker-
            // influenceable / arbitrary field. (Deeper source metadata — origin/type/sensitivity — and
            // an extraction-derived note title remain a future enhancement.)
            frontmatter: noteFrontmatter,
          },
        ],
        patches: [],
        linkMutations: [],
        frontmatterUpdates: [],
        // 18.7 — the produced PENDING external actions (empty when no binding ⇒ byte-equivalent). The
        // candidate-data gate (18.2: applyUniversalRules → ruleExternalWriteKeys) validates each one's keys.
        externalActionProposals: externalActions.map((a) => a.action),
        confidence: 1,
        requiresApproval: false,
        provenanceOrigin: "ingestion",
      };
      // 13.8f-C widened the shared MeetingBuiltOutputs (also used by this SOURCE-path binding — see its
      // own header comment on siblingPlans/meetingVaultRewriteFault) to carry the meeting path's sibling
      // entity-page plans + rewrite-fault signal. The SOURCE path has its OWN, entirely separate
      // sibling-plan mechanism (`deps.livingVault` on SourceIngestionDeps, driven directly in
      // sourceIngestion.ts) — these fields are always empty/unset here, byte-equivalent to pre-13.8f-C.
      return Promise.resolve(ok({ plan, actions: externalActions, siblingPlans: [] }));
    },
  };

  // (e) commit — the REAL KnowledgeWriter `applyPlan` (the SOLE Markdown writer, safety rule 1),
  // over the DURABLE revisions store (slice 2a, threaded via `params.revisions`) so idempotent-
  // replay survives a worker restart (the exactly-once substrate). Reuses the meeting commit's real
  // KnowledgeWriter deps (`knowledgeWriterDeps`: vault + durable revisions + audit; ownershipCheck/
  // secretScan UNSET → the real enforceHumanOwnership/scanForSecrets — NEVER a pass-through).
  //   • `expectedBaseRevision` is a RESOLVER reading the LIVE vault head (NOT the meeting's fixed
  //     `params.commit.expectedBaseRevision`) — the ingested vault moves between commits, so a fixed
  //     base would spuriously write_conflict. `createCommitActivity` runs it inside the §16 boundary.
  //   • idempotent by `kw:commit:${planId}`; the source plan's planId incorporates the routing-bound
  //     workspace (WS-8 — no cross-workspace key collision in the globally-keyed 2a store).
  //   • fail-closed: a durable-store fault (getByIdempotencyKey/record reject) folds to `commit_failed`
  //     inside `createCommitActivity` (§16) — never a silent proceed / re-commit.
  // Metadata is the proof-spine run context (`params.commit` — derived, not caller-supplied → honest audit).
  //
  // task 24.105 — the SAME binding-site precondition guard as `commit`'s site above, RESOLVED (its own
  // comment carries the full reasoning): a rejection's `cause: result.error` — the WHOLE `WriteFailure`
  // with validator-authored messages (`commitKnowledge.ts:164`) — is what the `sourceCommit:` wrapper
  // below now REDACTS (via `dropCommitFailureCause`, small pure helpers below) before returning it as
  // its Temporal activity result; the closed `code` still crosses, `cause` never does, so it no longer
  // lands in WORKFLOW HISTORY. `sourceCommit` is the higher-risk of the two commit sites — source-
  // ingestion note paths derive from user-dropped/imported (untrusted) files, so a leaked `.path` would
  // be attacker-influenced by design. NEVER expose this `sourceCommit` PORT OBJECT itself as a
  // registered activity value — only through the wrapper function, and never let that wrapper return
  // `result` verbatim on the `err` arm. The shape (no nested `.commit`) is pinned in
  // `proof-spine-composition.test.ts`; the `cause`-redaction itself is pinned in
  // `test/composition/commitCauseRedaction.test.ts`.
  const sourceCommit: CommitKnowledgePort = createCommitActivity({
    applyPlan,
    deps: knowledgeWriterDeps,
    actor: params.commit.actor,
    sourceEventRef: params.commit.sourceEventRef,
    workflowRunRef: params.commit.workflowRunRef,
    expectedBaseRevision: () => readVaultHeadRevision(backends.vault),
    deriveIdempotencyKey: (plan) => `kw:commit:${String(plan.planId)}`,
  });

  // (f) propose — 15.7 (closes G7): the source-ingestion external-write propose now routes through the
  // SAME real Tool Gateway propose port as `meetingPropose` (the `propose` = createProposeActivity over
  // dispatchRouted → dispatchExternalWrite, defined in §f-meeting above) — REPLACING the in-memory `ext-source-N` receipt
  // stub. A source propose produces a real ProposedAction → ExternalWriteEnvelope (idempotencyKey +
  // canonicalObjectKey, rule 3) → a pending §9 Approval (an approval-required action FAILS CLOSED to
  // approval_pending — no blind write). DORMANT/no hard line: the write adapter stays the default stub
  // (WriteTransportGate OFF) ⇒ ZERO real egress; the real external transport is Phase-21 (L11).

  // (g) index — a DETERMINISTIC GBrain index that runs AFTER the commit and never
  // rolls it back. Inherently idempotent: it performs no side effect, so re-indexing
  // the same revision is a no-op (the real idempotent GBrain index lands at C2/C3).
  const sourceIndexPort: IndexGbrainPort = {
    index: (_revisionId: string): Promise<Result<void, IndexError>> =>
      Promise.resolve(ok(undefined)),
  };

  // 16.2 — the connector-poll activity, bound to the REAL resolve over the 16.1 composed adapters
  // (`ComposedConnectors.ports`, by connectorId) + backoff. DORMANT by construction: the composed
  // transport is INERT (no real vendor call, no tokenRef), the cursor repo + `bridgeFor` are dormant
  // fail-closed seams (Phase-23 TODO #3/#4), and the shipped default enumerates ZERO enabled instances
  // (see `enumerateEnabledConnectorTargets`), so this activity is never driven until arming.
  //
  // ⚠ PHASE-23 ARMING INJECTION POINT (TODO #5 — single-engine coherence): the poll path drives
  // `runConnectorSync`, so THIS `composeConnectors()` (NOT `BootedWorker.connectors`, which the API
  // surface exposes but the poll does not consume) is the ONE transport-injection seam. Arming MUST
  // inject the real transport HERE (or thread `BootedWorker.connectors` in so there is a single engine)
  // — arming boot's connectors alone would leave the fetch path inert (a split-brain footgun).
  const connectorPollPort: ConnectorPollPort = createConnectorPollActivity({
    resolve: createConnectorPollResolve({
      connectors: composeConnectors(),
      cursors: createDormantConnectorCursorRepo(),
      backoffCfg: CONNECTOR_POLL_BACKOFF,
      clock: backends.now,
      bridgeFor: dormantBridgeFor,
    }),
  });

  // ── output workflows (WP4 — task 25.1's crossTerritoryNeed close-out) ────────
  //
  // Task 25.1 wired FOUR sandbox workflow wrappers (dailyBrief/periodReview/projectSync/
  // crossCalendarScheduling) + their SCHEDULED entry points, but temporal/workflows.ts's own
  // header names the exact gap this closes: "the composition-root binding that spreads
  // createOutputWorkflowActivities(...)'s real backends into the registered activities object is a
  // NAMED, NOT-YET-LANDED follow-up." Until this bound, EVERY scheduled dailyBrief / periodReview /
  // projectSync / crossCalendarScheduling occurrence would fail on its FIRST activity call with
  // "activity not registered" — nothing in Phase 25 could run.
  //
  // WHAT IS REAL vs HONEST-DORMANT below: `commit` (the SOLE KnowledgeWriter path, reusing the
  // SAME `knowledgeWriterDeps`/`applyPlan` this function already built for meeting/source),
  // `propose` (the SAME §8 Tool-Gateway `dispatchRouted` binding), `health` (the SAME 7.5
  // `surfaceDeps` sink), the projectSync `noteExists` probe (the SAME real vault-backed
  // `meetingNoteExists`), the crossCalendar `classify` policy lookup (the SAME `params.resolved`
  // posture already resolved for this worker's single bound workspace), and the crossCalendar
  // `routeToApproval` gateway (a REAL pending Approval recorded via `backends.repos.approvals`,
  // get-before-create idempotent — Lesson 30) are ALL genuine reuse of backends this file already
  // assembled. Every OTHER leg below (the per-workspace GCL summary producer, the plan/PM progress
  // reader, the calendar-availability connector, the brief/review/sync note projections, the
  // dashboard read-model sink, the connector-refresh set) has NO real business-logic producer wired
  // anywhere in this codebase yet (arch_gap — each family's own port doc names its own "Phase
  // 25.2/25.4, deferred, zero production callers" gap explicitly). WP4's job is REGISTRATION
  // correctness, not inventing that business logic — reuse existing wiring, do NOT invent new
  // backends — so every such leg is an HONEST, ALWAYS FAIL-CLOSED (or, where "nothing to
  // refresh"/"no candidates" IS the honest answer, an ALWAYS-EMPTY) placeholder: it can only ever
  // return a typed failure or an empty result, NEVER a guessed/fabricated value (REQ-F-017) and
  // NEVER a partial/duplicate write (§16). A real producer for each such leg is a separate, later,
  // named follow-up — clearly marked below, never silently papered over.
  //
  // ⛔ SAFETY RULE 7 / task 24.105 — WHY THIS IS SAFE TO REGISTER AT ALL. Every one of
  // `dailyBriefCommit`/`periodReviewCommit`/`projectSyncCommitStatus`/`crossCalendarCommitNote`
  // below carries a REAL KnowledgeWriter commit RESULT as its Temporal ACTIVITY return value — and
  // a commit REJECTION's `cause` is the WHOLE `WriteFailure` (validator-authored secret-scan /
  // workspace-path / ownership detail, commitKnowledge.ts:161-165). Registering a member that
  // returned that `cause` verbatim would put it into WORKFLOW HISTORY by construction the moment
  // Temporal calls it — the exact defect task 24.105 filed as a PRECONDITION blocking this exact
  // registration. It is safe here ONLY because `outputWorkflows.ts`'s own `commitWithRedactedFailure`
  // (that file's §2.5) already drops `cause` — via `dropCommitFailureCause` — on the `err` arm of
  // EVERY commit-bearing member `createOutputWorkflowActivities` returns, BEFORE this function ever
  // sees the Result. This binding does not re-derive that redaction (there is nothing to add) — it
  // DEPENDS on it: if a future edit to `outputWorkflows.ts` ever stopped redacting `cause`, the
  // `...outputWorkflowActivities` spread below would silently start leaking validator detail into
  // workflow history again. See that file's own §2.5 comment for the full mapping. ⛔ NEVER expose a
  // raw `CommitKnowledgePort`-shaped object (a `.commit` method) as a registered activity value here
  // — `outputWorkflowActivities`'s commit-bearing members are ALREADY bare plain-async functions
  // (verified at their construction site, outputWorkflows.ts's own §2.5 wrapper), so spreading the
  // object below is safe; `test/composition/outputWorkflowActivities.test.ts` pins the non-vacuity
  // property (no `"commit"` key, no nested `.commit`) the same way `proof-spine-composition.test.ts`
  // already pins it for `meetingCommit`/`sourceCommit`.
  const outputWorkflowJobIdentity = {
    workflowRunId: params.meetingJobInputs.workflowRunId,
    workspaceId: params.meetingJobInputs.workspaceId,
    maxRuntimeSeconds: params.meetingJobInputs.maxRuntimeSeconds,
  };
  const outputWorkflowActivities: OutputWorkflowActivities = createOutputWorkflowActivities({
    // ── shared across all four families (REAL — reuses this function's own existing wiring) ──
    commit: {
      applyPlan,
      deps: knowledgeWriterDeps,
      actor: params.commit.actor,
      sourceEventRef: params.commit.sourceEventRef,
      workflowRunRef: params.commit.workflowRunRef,
      // Same live-head resolver as `sourceCommit` above: these are periodic auto-commits (not a
      // single fixed-base run), so a fixed base would spuriously write_conflict.
      expectedBaseRevision: () => readVaultHeadRevision(backends.vault),
      deriveIdempotencyKey: (plan) => `kw:commit:${String(plan.planId)}`,
    },
    propose: {
      dispatch: (env, action, deps) => dispatchRouted(backends.writeAdapters, env, action, deps),
      deps: externalWriteDeps,
    },
    // No real dashboard read-model sink is wired at the composition root yet (arch_gap — the
    // DashboardReadModelStore port carries no workspaceId/key at all, so a single shared sink would
    // conflate all four families' payloads under one row; a real per-family key convention is a
    // separate, later, named follow-up). Honest no-op: never throws, never fabricates a stored row.
    dashboard: { store: { put: async (): Promise<void> => { /* no-op — see arch_gap note above */ } } },
    health: surfaceDeps,

    // ── the GLOBAL/Coordination leg (dailyBrief + periodReview) ──
    // No real per-workspace GCL summary producer exists yet (arch_gap — ports/dailyBrief.ts's own
    // UpdateProjectionsPort doc names this exact gap + "Phase 25.2/25.4" as the wiring point, with
    // zero production callers as of this writing). ALWAYS zero candidates — never guessed, never
    // raw — so the global brief/review always renders with ZERO cross-workspace context until a real
    // producer lands. Because there are never any candidates, `lookupWorkspace` is never actually
    // invoked; it stays fail-closed (mirrors createGclProjectionGate's own posture on an unresolved
    // workspace) rather than a guessed default.
    gclProjection: {
      source: { project: async () => ok([]) },
      lookupWorkspace: () => undefined,
    },
    // No real connector-refresh producer exists yet either (distinct from the 16.2 `connectorPoll`
    // engine above, which drives a DIFFERENT capability). `connectorIds: []` is the SAME "zero
    // enabled instances" shipped default `connectorPollPort` uses above — the refresher below is
    // therefore never invoked. `composeConnectors()` (this file, above) is the real substrate to
    // bind a refresher over once this is armed.
    refreshConnectors: {
      connectorIds: [],
      refresher: { refresh: async () => ok(undefined) },
    },

    // ── per-family model-synthesis legs (REAL broker + REAL egress/matrix/workspace posture — the
    //    SAME reuse `runAgentJob`/`sourceAgent` above already make; a KMP-stand-in outputSchemaId
    //    per Lesson 44, since no real output schema is registered for these worker-internal
    //    capabilities yet — `mapCandidate` below is therefore unreachable in practice until one is,
    //    Lesson 64: the broker's own schema gate rejects first) ──
    dailyBriefAgent: {
      broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
      inputs: {
        ...outputWorkflowJobIdentity,
        capability: "daily_brief.synthesize",
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        idempotencyKey: `job:daily-brief:${String(params.meetingJobInputs.workspaceId)}`,
      },
      buildEgress: () => params.resolved.egressPolicy,
      buildMatrix: () => params.resolved.providerMatrix,
      buildWorkspace: () => ({ type: params.resolved.type, dataOwner: params.resolved.dataOwner }),
      // Honest EMPTY brief (zero extraction fields) — never a fabricated field (REQ-F-017).
      mapCandidate: () => ({ global: { fields: {} }, workspaceDrafts: {} }),
      localConfig: backends.localConfig,
    },
    periodReviewAgent: {
      broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
      inputs: {
        ...outputWorkflowJobIdentity,
        capability: "period_review.synthesize",
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        idempotencyKey: `job:period-review:${String(params.meetingJobInputs.workspaceId)}`,
      },
      buildEgress: () => params.resolved.egressPolicy,
      buildMatrix: () => params.resolved.providerMatrix,
      buildWorkspace: () => ({ type: params.resolved.type, dataOwner: params.resolved.dataOwner }),
      mapCandidate: () => ({ global: { fields: {} }, workspaceDrafts: {} }),
      localConfig: backends.localConfig,
    },
    projectSyncSynthesize: {
      broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
      inputs: {
        ...outputWorkflowJobIdentity,
        capability: "project_sync.synthesize",
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        idempotencyKey: `job:project-sync:${String(params.meetingJobInputs.workspaceId)}`,
      },
      buildEgress: () => params.resolved.egressPolicy,
      buildMatrix: () => params.resolved.providerMatrix,
      buildWorkspace: () => ({ type: params.resolved.type, dataOwner: params.resolved.dataOwner }),
      // No numeric progress here (REQ-F-011 — the deterministic parser is the sole source); an
      // empty prose-only draft is the honest mapping.
      mapCandidate: () => ({ fields: {} }),
      localConfig: backends.localConfig,
    },
    crossCalendarProposeAgent: {
      broker: { runJob: (req, signal) => backends.broker.runJob(req, signal) },
      inputs: {
        ...outputWorkflowJobIdentity,
        capability: "cross_calendar.propose_windows",
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        idempotencyKey: `job:cross-calendar:${String(params.meetingJobInputs.workspaceId)}`,
      },
      buildEgress: () => params.resolved.egressPolicy,
      buildMatrix: () => params.resolved.providerMatrix,
      buildWorkspace: () => ({ type: params.resolved.type, dataOwner: params.resolved.dataOwner }),
      // Zero proposed windows — never a fabricated interval.
      mapCandidate: () => ({ fields: {}, windows: [] }),
      localConfig: backends.localConfig,
    },

    // ── per-family derive-from-validated legs ──
    dailyBriefOutputs: {
      globalProjection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no daily-brief global projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      workspaceProjection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no daily-brief workspace projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      sourceRef: params.sourceRef,
      planIdentitySeed: JSON.stringify(params.planIdentity),
    },
    periodReviewOutputs: {
      globalProjection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no period-review global projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      workspaceProjection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no period-review workspace projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      sourceRef: params.sourceRef,
      planIdentitySeed: JSON.stringify(params.planIdentity),
    },
    projectSyncParse: {
      reader: {
        read: async () =>
          err({
            code: "parse_failed",
            message: "no plan/provider progress source wired yet (WP4: activity-registration scope only)",
          }),
      },
    },
    projectSyncBuildOutputs: {
      projection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no project-sync outputs projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      sourceRef: params.sourceRef,
      planIdentity: params.planIdentity,
      // REAL — reuses the SAME vault-backed `meetingNoteExists` probe this function already built.
      noteExists: meetingNoteExists,
    },
    crossCalendarGather: {
      query: {
        query: async () =>
          err({
            code: "calendar_unreachable",
            message: "no availability-source connector wired yet (WP4: activity-registration scope only)",
          }),
      },
      gate: {
        admit: async () =>
          err({ reason: "no availability visibility gate wired yet (WP4: activity-registration scope only)" }),
      },
    },
    crossCalendarBuildOutputs: {
      projection: {
        project: () =>
          err({
            code: "build_failed",
            message: "no cross-calendar scheduling projection wired yet (WP4: activity-registration scope only)",
          }),
      },
      sourceRef: params.sourceRef,
      planIdentity: params.planIdentity,
    },
    // REAL — reuses the SAME `params.resolved` single-bound-workspace posture the meeting leg
    // resolves above (mirrors ClassifyActionActivityDeps's own "boot-resolved, not per-call I/O"
    // doc comment).
    crossCalendarClassify: {
      resolvePolicy: (workspaceId) =>
        workspaceId === params.meetingJobInputs.workspaceId ? params.resolved : undefined,
    },
    // REAL — a genuine pending Approval, get-before-create idempotent (Lesson 30), over the SAME
    // `backends.repos.approvals` the meeting/approval-flow legs above already use.
    crossCalendarRouteToApproval: {
      gateway: {
        async reservePending(action, env) {
          const approvalRef = makeApprovalIdFromEnvelope(env);
          const existing = await backends.repos.approvals.get(approvalRef);
          if (existing.ok) {
            return ok({ approvalRef, created: false });
          }
          const approval: Approval = {
            id: approvalRef,
            actionRef: action.actionId,
            subjectKind: "external_action",
            // Single-workspace-per-worker proof-spine (matches every other static-identity field in
            // this function) — the port carries no workspaceId param to bind per-call.
            workspaceId: params.meetingJobInputs.workspaceId,
            status: "pending",
            actor: params.commit.actor,
            channel: "mac",
            payloadHash: env.payloadHash,
          };
          const created = await backends.repos.approvals.create(approval);
          if (!created.ok) {
            return err({ code: "route_failed", message: `pending approval record failed: ${created.error.code}` });
          }
          return ok({ approvalRef, created: true });
        },
      },
    },
  });

  // The PRODUCTION projectSync registry resolver (task 14.6) — the SAME real @sow/db-backed port
  // temporal/workflows.ts's `projectSyncRegistryActivities` proxy names as its wiring point
  // ("crossTerritoryNeed, apps/worker/src/composition/buildActivities.ts"). Reuses the durable
  // ProjectRegistryRepository + the 14.1 WS-8 workspace registry already assembled in `backends`.
  const projectSyncRegistryPort = createProjectRegistryResolvePort({
    repo: backends.repos.projectRegistry,
    readModels: backends.repos.readModels,
  });

  // ── the plain-async-function object Temporal registers ───────────────────────
  return {
    // meeting-closeout
    meetingCorrelate: (ctx) => correlate.correlate(ctx),
    meetingRunAgentJob: (ctx) => runAgentJob.run(ctx),
    meetingValidate: (extraction) => validate.validate(extraction),
    meetingBuildOutputs: (validated: import("@sow/workflows").ValidatedExtraction, workspaceId: WorkspaceId) =>
      buildOutputs.build(validated, workspaceId),
    meetingCommit: async (plan) => {
      const result = await commit.commit(plan);
      // task 24.105 — `withGbrainSync` gets the FULL unredacted `result` (it only ever reads
      // `result.value.revisionId` on its own `isOk` early-return, never `.error`/`.cause`, but is
      // handed the real Result regardless — an in-process consumer is not the boundary this
      // redacts). Redaction happens ONLY on what this function RETURNS, below.
      await withGbrainSync(plan, result);
      // task 24.105 — redact the `err` arm before it crosses into the Temporal ACTIVITY result
      // (workflow history is a log sink, rule 7): drop `cause` via `dropCommitFailureCause`
      // (small pure helpers, below) — `code`/`message` cross unchanged, `cause` never does. The
      // `ok` arm is untouched.
      return isOk(result) ? result : err(dropCommitFailureCause(result.error));
    },
    meetingPropose: (action, env) => propose.propose(action, env),
    meetingReindex: (revisionId) => reindex.reindex(revisionId),
    meetingPark: (source, idempotencyKey) => meetingParkPort.park(source, idempotencyKey),
    // 13.8i-B — the meeting-path leg. SAME `params.proposeKnowledgeApproval` instance as the source leg
    // below (one shared port, two registered names — the meetingCommit/sourceCommit convention);
    // dormancy (absent ⇒ typed not_armed err) lives inside createProposeKnowledgeApprovalActivity.
    meetingProposeKnowledgeApproval: createProposeKnowledgeApprovalActivity(params.proposeKnowledgeApproval),

    // approval-flow
    approvalRecordPending: (ctx) => recordPending.record(ctx),
    approvalSurfaceCard: (approval) => surfaceCard.surface(approval),
    approvalApply: (approval, decision) => applyTransition.apply(approval, decision),
    approvalDispatchApproved: (action, env) => dispatchApproved.dispatch(action, env),

    // ingestion-triage
    triageRecordDisposition: async (disposition) => {
      const result = await recordDisposition.record(disposition);
      // 9.16 — fail-SAFE ingestion-inbox remove AFTER the durable disposition CAS. Only on a durable
      // success (recorded|noop ⇒ isOk) do we clear the item from the DERIVED `ingestion_inbox`
      // read-model; a remove fault (err OR throw) is swallowed so it NEVER fails the durable disposition
      // (the CAS is sole-writer operational truth; the inbox is rebuildable-derived — §16 / LESSON 21/76).
      // WS-8 (rule 4): the remove keys the server-bound, registry-validated `disposition.workspaceId`
      // (never content-derived) — the producer core only ever touches that one workspace's OWN row.
      // ⚠ RESIDUAL (correct-by-coincidence — the §ARM-21 `Approval.workspaceId` pattern, worker L12/L32):
      // this is the owner's ROUTING-OVERRIDE ws, which under multi-workspace can DIFFER from the source's
      // ORIGINAL parked ws (an A→B rescope); the remove then targets B's row and the item LINGERS in A's
      // inbox until a read-model rebuild — a LIVENESS/staleness residual, NOT a leak (zero cross-ws touch).
      // CORRECT under single-workspace-per-worker (the shipping reality). The arming-era fix threads the
      // ORIGINAL parked ws through the disposition seam. FUTURE-TODO(9.16-health): a persistent remove
      // fault → a HealthItem (mirrors the 9.15 refresh-fault Residual).
      if (isOk(result)) {
        try {
          await ingestionPark.recordDisposition(String(disposition.workspaceId), disposition.sourceId);
        } catch {
          /* fail-SAFE: a read-model remove fault never fails the durable disposition */
        }
      }
      return result;
    },
    triageRescopeSource: (disposition) => rescopeSource.rescope(disposition),
    triageReenter: (reScopedSource, idempotencyKey) =>
      reenterIngestion.reenter(reScopedSource, idempotencyKey),

    // source-ingestion (make-it-real C1) — only sourceRegister runs for real.
    sourceRegister: (ctx) => sourceRegister.register(ctx),
    sourceRoute: (ctx) => sourceRoute.route(ctx),
    sourceRunAgentJob: (ctx) => sourceAgent.run(ctx),
    sourceBuildOutputs: (
      validated: ValidatedExtraction,
      workspaceId: WorkspaceId,
      source: SourceNoteIdentity,
      // 15.3: forward the gate-validated note body (the driver threads context.source.body).
      body?: string,
    ) => sourceBuildOutputs.build(validated, workspaceId, source, body),
    sourceCommit: async (plan) => {
      const result = await sourceCommit.commit(plan);
      // 9.15 — bounded, fail-SAFE post-commit recent-changes refresh. On a successful source commit, rebuild the
      // committing workspace's recent_changes read-model from the freshly-appended `knowledge_writer.commit`
      // audit row so real ingest activity surfaces on the Recent Changes surface. A refresh fault NEVER
      // fails/blocks the commit (the KW commit is sole-writer durable truth; the read-model is
      // rebuildable-derived). FUTURE-TODO(9.15-health): route a persistent refresh fault to a HealthItem.
      if (isOk(result)) {
        try {
          await refreshRecentChanges(
            { workspaceId: String(plan.workspaceId) },
            { audit: backends.repos.audit, readModels: backends.repos.readModels, now: backends.now },
          );
        } catch {
          /* fail-SAFE: a refresh fault (even a totality regression) never fails the commit */
        }
      }
      // 19.1 — same fail-SAFE post-commit hook as the meeting path (see `withGbrainSync` above).
      // task 24.105 — this in-process call, like `refreshRecentChanges` above, gets the FULL
      // unredacted `result` (`withGbrainSync` reads `result.value.revisionId` on its own `isOk`
      // early-return only). Redaction happens ONLY on what this function RETURNS, below.
      await withGbrainSync(plan, result);
      // task 24.105 — redact the `err` arm before it crosses into the Temporal ACTIVITY result
      // (workflow history is a log sink, rule 7): drop `cause` via `dropCommitFailureCause`
      // (small pure helpers, below) — `code`/`message` cross unchanged, `cause` never does. The
      // `ok` arm is untouched.
      return isOk(result) ? result : err(dropCommitFailureCause(result.error));
    },
    sourcePropose: (action, env) => propose.propose(action, env),
    sourceIndex: (revisionId) => sourceIndexPort.index(revisionId),
    // 13.8d — the living-vault leg. `params.livingVault` is supplied ONLY by the boot-level
    // `gateLivingVaultRewrite` (strict `=== true` + a vaultRoot); absent ⇒ the delegate is inert and
    // yields an empty plan set, so the dormant pipeline commits exactly the one source note it always did.
    sourceLivingVaultRewrite: createLivingVaultActivity(params.livingVault),
    // 13.8i-B — the source-path leg. SAME shared port instance as meetingProposeKnowledgeApproval above.
    sourceProposeKnowledgeApproval: createProposeKnowledgeApprovalActivity(params.proposeKnowledgeApproval),

    // infra — the failure sink every driver routes through (inv-5).
    // 16.2 — poll one connector (dormant in the shipped default; the resolve binds the real 16.1 adapters).
    connectorPoll: (connector) => connectorPollPort.poll(connector),
    surfaceFailure: (failure) => surfaceWorkflowFailure(failure, surfaceDeps),

    // ── output workflows (WP4) — see the big doc comment above this function's `return` for the
    //    full real-vs-honest-dormant breakdown and the SAFETY RULE 7 / task 24.105 reasoning this
    //    spread depends on. Every member here is ALREADY a bare plain-async function (verified at
    //    outputWorkflowActivities's own construction site) — never a raw port object.
    ...outputWorkflowActivities,
    // ── projectSync registry resolution (WP4 / 25.1 crossTerritoryNeed close-out) ──
    projectSyncResolveRegistry: (ctx) => projectSyncRegistryPort.resolve(ctx),

    // ── 25.2/25.4 — the durable scheduled-runtime activities (scheduleArgs.ts's frozen contract) ──
    // Thin adapters over the REAL @sow/db `WorkflowRunRefRepository` + the REAL durable
    // `ScheduleStore` already assembled in `backends` (backends.ts's `createScheduleStoreAdapter`)
    // — replacing the sandbox's inert `sandboxRunRepo`/`sandboxScheduleStoreStub` on the SCHEDULED
    // entry points only (temporal/workflows.ts binds these ONLY into
    // `dailyBriefScheduledWorkflow`/`periodReviewScheduledWorkflow`/
    // `crossCalendarSchedulingScheduledWorkflow` — never the direct-start wrappers, and NEVER
    // starts a Schedule pointed at them on its own). Computed keys off the SAME frozen
    // `SCHEDULED_RUNTIME_ACTIVITY_NAMES` constant the sandbox proxies against, so a drift between
    // the two is a TYPECHECK failure here, never a silent "activity not registered" fault that only
    // surfaces against a live server.
    //
    // W1a (§16/rule 7) — the five run-repo members below were BARE pass-throughs of the REAL
    // `WorkflowRunRefRepository`'s `Result<T, DbError>` — returning the raw `DbError` VERBATIM on a
    // fault, including its opaque driver `.cause` UNCHANGED (packages/db/src/adapters/{sqlite,
    // postgres}/errors.ts's `toDbError` sets `cause` to the caught driver throw as-is — a Postgres
    // connection fault's cause can carry a DSN, a driver can throw a bare plain object, etc.).
    // Redacted here exactly like the `meetingCommit`/`sourceCommit` wrappers below (task 24.105):
    // `code` (the closed, enumerable `DbErrorCode` taxonomy) crosses UNCHANGED so a downstream
    // `.error.code` switch keeps matching; `message` is replaced with a FIXED generic string keyed
    // off `code` (see `redactDbError`'s doc comment, small pure helpers below, for why a
    // `DbError.message` — unlike the `WriteFailure.message` `dropCommitFailureCause` passes through
    // verbatim — is NOT provably safe); `cause` is dropped.
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runCreate]: async (ref) => {
      const result = await backends.repos.workflowRunRefs.create(ref);
      return isOk(result) ? result : err(redactDbError(result.error));
    },
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGet]: async (workflowId) => {
      const result = await backends.repos.workflowRunRefs.get(workflowId);
      return isOk(result) ? result : err(redactDbError(result.error));
    },
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runGetByIdempotencyKey]: async (idempotencyKey) => {
      const result = await backends.repos.workflowRunRefs.getByIdempotencyKey(idempotencyKey);
      return isOk(result) ? result : err(redactDbError(result.error));
    },
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runUpdateState]: async (workflowId, state) => {
      const result = await backends.repos.workflowRunRefs.updateState(workflowId, state);
      return isOk(result) ? result : err(redactDbError(result.error));
    },
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.runAppendAuditRef]: async (workflowId, auditRef) => {
      const result = await backends.repos.workflowRunRefs.appendAuditRef(workflowId, auditRef);
      return isOk(result) ? result : err(redactDbError(result.error));
    },
    // W1b (§16/rule 7, CRITICAL) — `backends.scheduleStore` (store-adapters.ts's
    // `createScheduleStoreAdapter`) is a THROW-shaped port BY DESIGN (see that file's "FAIL-CLOSED
    // CONTRACT" doc — a genuine `DbError` fault REJECTS via `faultRejection`, never a silent wrong
    // answer). `faultRejection` interpolates the driver-authored `DbError.message` straight into the
    // thrown `Error.message` (`operational-store ${op} failed (${error.code}): ${error.message}`),
    // and these two members previously let that THROW cross the Temporal ACTIVITY boundary
    // verbatim — a §16 violation (every other member of this whole activities object already avoids
    // throwing) AND a rule-7 leak (the interpolated message is not provably safe — see
    // `redactDbError`'s doc comment).
    //
    // `createScheduleStoreAdapter` ITSELF is left UNCHANGED (its declared return type, `ScheduleStore`
    // — @sow/workflows/ports/operational, unowned by this track — is throw-shaped, and the ONLY other
    // reachable reference to it is `apps/worker/src/lifecycle/last-run.ts`'s RE-EXPORT of the same
    // symbol; `createLastRunService` in that file binds the raw `ScheduleBookkeepingRepository`
    // directly, never this adapter, so nothing there is actually CALLING it either — confirmed via
    // `rg -n "createScheduleStoreAdapter" apps/worker/src`: its only construction call site is
    // `backends.ts`'s `createScheduleStoreAdapter(opened.repos.scheduleBookkeeping)`, and that single
    // `scheduleStore` instance is consumed ONLY by these two activities). With no OTHER in-process
    // caller depending on its throw, the fix still lands at the ACTIVITY BINDING (here) rather than
    // widening the shared adapter's contract, matching the same catch-and-redact shape as the run-repo
    // members above — `faultRejection`'s thrown `Error` also now carries a SAFE `{ code }` hint on its
    // own `.cause` (store-adapters.ts) purely so this catch can recover the closed `DbErrorCode`
    // without ever re-reading the unsafe interpolated `.message`.
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.scheduleGetBookkeeping]: async (scheduleId) => {
      try {
        return ok(await backends.scheduleStore.getBookkeeping(scheduleId));
      } catch (thrown) {
        return err(redactDbError({ code: scheduleStoreFaultCode(thrown) }));
      }
    },
    [SCHEDULED_RUNTIME_ACTIVITY_NAMES.schedulePut]: async (bookkeeping) => {
      try {
        await backends.scheduleStore.put(bookkeeping);
        return ok(undefined);
      } catch (thrown) {
        return err(redactDbError({ code: scheduleStoreFaultCode(thrown) }));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

// task 24.105 — drop the raw KnowledgeWriter `cause` at the ACTIVITY BOUNDARY, before a commit
// rejection can cross into Temporal workflow history (safety rule 7 — secrets/raw-content never
// reach a log sink, and workflow history is exactly such a sink once `meetingCommit`/`sourceCommit`
// are registered real activities).
//
// `commit.commit(plan)` / `sourceCommit.commit(plan)` (createCommitActivity,
// packages/workflows/src/activities/commitKnowledge.ts) return the RAW `CommitKnowledgePort`
// Result: a rejection's `cause` is either the WHOLE @sow/knowledge `WriteFailure` (commitKnowledge.ts
// :164 — validator-authored `issues[]`/`path`/`kind` detail: secret-scan matches, workspace-path
// detail, ownership-rejection detail) or an arbitrary thrown value (:134-139/:157-158, an infra
// fault caught at that boundary). Either would land in workflow history verbatim if returned as-is
// — an adversarial pass demonstrated exactly this leak live (`cause:{code:"workspace_path_violation",
// path:"notes/…SECRET-leak.md"}`, `cause:{code:"secret_found", path:"…", kind:"credential_shaped"}`).
//
// `message` crosses UNCHANGED, not merely for convenience: commitKnowledge.ts is the SOLE producer
// of every commit failure this helper redacts, and its own `message` construction (:137/:158/:163)
// only ever interpolates a fixed string or the CLOSED `WriteFailure.code` — never `.message` or
// `.issues[]` — so `message` never carries the validator-authored detail `cause` does. `code` is
// UNCHANGED too, so every downstream `.error.code` consumer (the meeting/source workflow drivers,
// which branch on the closed `KnowledgeCommitFailureCode` set) keeps switching identically — only
// `cause` is dropped.
//
// Mirrors the discipline `commitFailureToVariant` already applies to the OTHER commit-consuming path
// (apps/worker/src/api/procedures/semanticMutationDispatch.ts:203 — switches on the failure's stable
// `code`, builds a FRESH literal, never reads `.cause`) and the identically-named/-shaped helper
// `packages/workflows/src/activities/outputWorkflows.ts` carries for its own four commit-bearing
// members (`dropCommitFailureCause`/`commitWithRedactedFailure`, that file's §2.5). Built LOCAL here
// rather than imported: this track does not own `packages/workflows`, and single-sourcing the mapping
// would mean reaching outside these owned files to export it from there — flagged, not silently
// duplicated-without-comment (the two definitions are structurally identical by construction, so a
// future single-source pass is a pure mechanical move, not a behavior change).
//
// W1 (this round) GENERALIZES this helper with an OPTIONAL `safeMessage` override rather than
// growing a fourth near-identical `{code, message}`-shaping copy in this file. The two existing
// callers (`meetingCommit`/`sourceCommit` above) omit it — their `failure.message` is PROVEN safe
// by the analysis above, so they keep crossing it UNCHANGED, byte-for-byte identical to before this
// round. `redactDbError` (below) is the ONE caller that supplies an override: a `DbError.message` is
// a DIFFERENT, NOT-provably-safe case (see that helper's own doc comment) — never assume "this
// helper already drops `cause`" also means "any `.message` it's given is safe to keep." A guarantee
// proven for one producer (`commitKnowledge.ts`) does not transfer to a different producer (a DB
// driver) just because both happen to flow through the same generic plumbing.
function dropCommitFailureCause<
  F extends { readonly code: string; readonly message: string; readonly cause?: unknown },
>(failure: F, safeMessage?: string): { readonly code: F["code"]; readonly message: string } {
  return { code: failure.code, message: safeMessage ?? failure.message };
}

// W1 — a fixed, code-keyed generic message for every closed `DbErrorCode` (packages/db/src/
// repositories/interfaces.ts). Used ONLY by `redactDbError` below, which every DbError-sourced
// scheduled-runtime activity (W1a's five run-repo members, W1b's two schedule-store members) routes
// through before returning/throwing across the Temporal activity boundary.
//
// WHY a fixed table instead of passing `error.message` through (the way `dropCommitFailureCause`'s
// two ORIGINAL callers do for `WriteFailure.message`): `DbError.message` is NOT provably safe.
// BOTH dialect adapters (packages/db/src/adapters/sqlite/errors.ts AND .../postgres/errors.ts,
// `toDbError`) copy the RAW DRIVER `Error.message` VERBATIM whenever the caught cause is an `Error`
// instance (`message: cause instanceof Error ? cause.message : ...`) — a Postgres connection/auth
// failure's message can embed a DSN/host/user, a driver can throw a plain object whose OWN
// `.message` field echoes caller-supplied content, and neither adapter sanitizes that text before
// building the `DbError`. So unlike `commitKnowledge.ts` (proven above to interpolate only a fixed
// string or the closed `WriteFailure.code`), a `DbError.message` carries the SAME class of risk its
// `.cause` does — both must be kept off the crossing, not just `.cause`.
const DB_ERROR_SAFE_MESSAGE: Record<DbErrorCode, string> = {
  not_found: "record not found",
  conflict: "conflicting write",
  constraint_violation: "constraint violation",
  serialization_failure: "transient store contention",
  unavailable: "operational store unavailable",
  stored_row_schema_violation: "stored row failed validation",
  unknown: "operational store operation failed",
};

/**
 * Redact a `DbError`-class fault crossing an ACTIVITY boundary down to `{code, message}` — reuses
 * `dropCommitFailureCause`'s drop-`cause` discipline, generalized with its `safeMessage` override.
 * `code` (the closed, enumerable `DbErrorCode` taxonomy) crosses UNCHANGED so a downstream
 * `.error.code` switch keeps matching; `message` is always the FIXED generic string
 * `DB_ERROR_SAFE_MESSAGE` keys off `code` — never the caller's own `.message` (see that table's doc
 * comment for why). The parameter type is narrowed to `{ code }` ONLY — no `message`/`cause` — so a
 * caller structurally CANNOT thread the raw driver detail through even by accident; a real `DbError`
 * (which does carry `.cause`) is still a valid argument (its extra fields are simply never read).
 */
function redactDbError(error: {
  readonly code: DbErrorCode;
}): { readonly code: DbErrorCode; readonly message: string } {
  const safeMessage = DB_ERROR_SAFE_MESSAGE[error.code];
  return dropCommitFailureCause({ code: error.code, message: safeMessage }, safeMessage);
}

// I1 (SUPERSEDED) — this file used to fold every `approvalDispatchApproved` conflict/held/rejected
// fault through a fixed code-keyed generic message (`DISPATCH_APPROVED_SAFE_MESSAGE` +
// `redactDispatchApprovedError`, mirroring `redactDbError` below). That blanket collapse silently
// stripped the §21.10 credential-fault token (`"locked"`/`"empty"`/the fault code) an operator needs
// (worker LESSONS §41) to distinguish "your keychain is locked" from "the vendor rejected the
// write" — so the helper is deleted and `approvedGateway.dispatch` (above) forwards
// `outcome.reason` VERBATIM.
//
// The safety property is NOT "the gateway builds `reason` from a closed code only" — it interpolates
// the adapter's `AdapterError.message` on those arms. It is that BOTH provenances of that string are
// built from closed inputs: gateway-authored text (a closed code in a fixed template, a
// `.code`/`.path`-only Zod-issue summary, the §21.10 token, the reservation literal), and
// adapter-authored `AdapterError.message`, which every SHIPPED vendor adapter derives via
// `makeTargetWriteAdapter`'s `faultToError` (packages/integrations/src/tools/adapters/adapter-core.ts)
// from the closed `TransportFault` code plus the NUMERIC `httpStatus`, never the transport's
// free-text `detail`. That second guarantee is by the shared core, not by the `TargetWriteAdapter`
// type — a hand-written adapter bypassing the core could still emit unsafe `message` text. See the
// dispatch site above and `ExternalWriteResult`'s doc comment (gateway.ts:81-101).
// ⛔ DO NOT reintroduce a fixed-message table for `DispatchApprovedErrorCode` here. The residual
// above must be closed at the ADAPTER boundary, where vendor text enters; re-adding a blanket
// collapse here would buy nothing there and would re-break the credential-fault signal, which is
// gateway-authored and never adapter text at all.

/**
 * Recover the `DbErrorCode` `faultRejection` (composition/store-adapters.ts) attaches to a thrown
 * `ScheduleStore` fault's OWN `Error.cause` as `{ code }` — store-adapters.ts extends `faultRejection`
 * for exactly this purpose (a SAFE, code-only hint; never the opaque driver `cause` that function
 * already keeps off, and never read from the thrown `Error.message`, which is the UNSAFE
 * driver-interpolated text `redactDbError`/`DB_ERROR_SAFE_MESSAGE` exist to avoid re-surfacing).
 * Fails closed to the catch-all `"unknown"` code for anything that isn't EXACTLY that shape — a
 * rogue/foreign throw, a non-Error value, a tampered `.cause` — never guessed, never a crash.
 */
function scheduleStoreFaultCode(thrown: unknown): DbErrorCode {
  const cause = thrown instanceof Error ? thrown.cause : undefined;
  const code = (cause as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" && code in DB_ERROR_SAFE_MESSAGE ? (code as DbErrorCode) : "unknown";
}

/** Derive a stable Approval id from the envelope's idempotencyKey (idempotent record). */
function makeApprovalIdFromEnvelope(env: ExternalWriteEnvelope): Approval["id"] {
  // Not node:crypto — a deterministic, human-legible id keyed to the replay key.
  return `approval:${env.idempotencyKey}` as Approval["id"];
}

/** Add `hours` to an ISO instant, returning an ISO instant. Pure. */
function addHours(iso: string, hours: number): string {
  const base = Date.parse(iso);
  const ms = Number.isNaN(base) ? Date.now() : base;
  return new Date(ms + hours * 3_600_000).toISOString();
}

