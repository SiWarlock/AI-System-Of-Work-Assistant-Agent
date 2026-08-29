// MOUNT wave — `bootWorker(config)`: the LIVE control-plane composition root.
//
// This is the app-shell entrypoint that assembles the WHOLE worker-side live
// control plane over the REAL persistent backends:
//
//   1. `assembleBackends` — the persistent composition root (sqlite operational
//      store + genesis migration, the filesystem vault, the persistent §9
//      health/schedule/lease stores, the redacting logger, the §7 broker).
//   2. `startApiServer` — the real loopback HTTP+WS transport (api/mount.ts) over
//      the REAL @sow/db port adapters (`createDbReadModelQueryPort` +
//      `createDbApprovalCommandPort` + `createDbTriagePort`) and a health/egress
//      query port over the persistent health store — all behind the injected
//      per-launch token + Origin allowlist (REQ-NF-004 loopback bind + the 8.1 auth
//      gate). The push-stream publisher is returned so the worker feeds it.
//   3. `createLogger` — the single redacting structured-log chokepoint (already
//      assembled inside `assembleBackends`; re-exposed on the boot handle).
//   4. the Temporal-UNAVAILABLE degraded controller
//      (`createTemporalUnavailabilityController`) wired over a `HealthSurface`, ready
//      to be driven from the Temporal client's connection state; and the Temporal
//      worker registration hook (`makeProofSpineRegisterHook`) handed to
//      `bootstrapWorker` so a successful connect registers the workflows + activities.
//
// The boot ACCEPTS an injected session token + Origin/Host allowlist + the resolved
// ProofSpineParams — it does NOT mint the token or resolve the workspace posture
// itself (those are upstream concerns). It returns a handle exposing the running API
// server, the backends bundle, the logger, the degraded controller, and a
// `connectTemporal()` that drives `bootstrapWorker`, plus a `close()`.
//
// ── RESIDUAL DEFERRALS (documented; NOT wired here) ──────────────────────────
//   • PHASE 9 (Electron-main SUPERVISOR): the Electron main process SPAWNS this
//     worker as a supervised child and MINTS + INJECTS the per-launch session token
//     and the renderer Origin allowlist. `bootWorker` ACCEPTS the token + allowlist
//     as injected inputs — it never mints them. The supervision restart/backoff loop
//     that drives `connectTemporal()` on the degraded controller's `retryInMs` is
//     also Phase-9 (this boot exposes the controller + the connect entrypoint; the
//     loop that calls them on a schedule is the supervisor's).
//   • PHASE 11 (backup CRON): the operational-backup service
//     (`createOperationalBackupService`) is WIRED into the handle (`backupService`)
//     but NOT SCHEDULED — the periodic CRON that calls `backupService.run()` on the
//     `backupCadenceMs` is Phase-11. The service is ready; only its trigger is deferred.
import { auditId, sourceId, isOk, isErr, workspaceId, workflowId, processorId, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, AGENT_EXTRACTION_SCHEMA_ID } from "@sow/contracts";
import type {
  Result,
  FailureVariant,
  HealthItem,
  AuditId,
  SourceRef,
  WorkspaceId,
  WorkflowRunRef,
  GbrainPin,
  ContextRef,
  BrainId,
} from "@sow/contracts";
import { descriptorFor, isZeroEgressOnlyWorkspace, toAuditRecordInput, isRedactionSafe } from "@sow/policy";
import type { SessionToken, LegacyContentPolicy, CopilotWorkspaceScope, ResolvedWorkspacePolicy } from "@sow/policy";
// task 24.70 — names WHICH of the six `isRedactionSafe`-scanned fields tripped a refusal.
// Deep-imported (not the `@sow/policy` barrel) per that module's own header: the barrel's
// `export * from "./audit-signal"` stays untouched to avoid a merge collision with a
// concurrent wave-1 slice; the package's `exports` map carries the `./*` wildcard.
import { firstUnsafeAuditField } from "@sow/policy/audit-signal-field";
import { TBD, looksLikeCredentialShape } from "@sow/domain";
import type { MeetingJobInputs, AgentExtraction, HealthItemStore, SowTaskQueue } from "@sow/workflows";

import {
  assembleBackends,
  type ProofSpineBackends,
  type BackendsConfig,
  type StubMeetingExtraction,
  type WriteTransportGate,
} from "./composition/backends";
import {
  LOCAL_EXTRACTION_ROUTE,
  CLOUD_EXTRACTION_ROUTE,
} from "./composition/extraction-route-gate";
import {
  SOURCE_CONTEXT_REF_KIND,
  createReaderHolder,
} from "./composition/real-extraction-content-resolver";
import {
  resolveSubscriptionArming,
  buildSubscriptionArmWiring,
} from "./composition/subscription-extraction-arming";
import {
  resolveArmCheckReachable,
  REACHABILITY_LIVE_ENV_VAR,
} from "./composition/subscription-reachability-arming";
import { resolveSubscriptionSpawnChildEnv } from "./composition/subscription-child-env-allowlist";
import {
  guardSettingsOnArmedPath,
  readClaudeCodeSettings,
} from "./composition/subscription-settings-guard";
import { createDurableParkedReader } from "./composition/dispositionDurable";
import type { WorkerOriginAllowlist } from "./api/auth/originAllowlist";
import { startApiServer, type RunningApiServer } from "./api/mount";
import { createDbReadModelQueryPort, READ_MODEL_KEYS } from "./api/adapters/readModel";
import {
  createDbApprovalCommandPort,
  createDbTriagePort,
  type TriageDispatchFn,
} from "./api/adapters/commands";
import type {
  ReadModelQueryPort,
} from "./api/procedures/queries";
import {
  createProvisionWorkspacePort,
  type OnboardingCommandPort,
} from "./api/procedures/onboarding";
import {
  createProjectRegistryCommandPort,
  type ProjectRegistryCommandPort,
} from "./api/procedures/projectRegistry";
import {
  createConnectorConfigCommandPort,
  type ConnectorConfigCommandPort,
} from "./composition/connectorConfig";
import { createRegistryValidatedRerouteTarget } from "./composition/dispositionDurable";
import { composeConnectors, type ComposedConnectors } from "./composition/connectors";
import {
  createCrossWorkspaceLinkCommandPort,
  type CrossWorkspaceLinkCommandPort,
} from "./composition/crossWorkspaceLink";
import { createEgressCommandPort } from "./composition/egressRevoke";
import type { EgressCommandPort } from "./api/procedures/egressCommands";
import {
  buildCopilotDeps,
  resolveCopilotWorkspaces,
  buildInterimCopilotScopeRegistry,
} from "./api/procedures/copilotClaudeSynthesis";
import type { CopilotWorkspace } from "./api/procedures/copilotClaudeSynthesis";
import { createStoreBackedWorkspacePosture } from "./api/adapters/storeBackedWorkspacePosture";
import {
  createGbrainCliExec,
  DEFAULT_GBRAIN_COPILOT_WORKSPACE,
} from "./api/procedures/copilotGbrainSubprocess";
import type { GbrainQueryExec } from "./api/procedures/copilotGbrainSubprocess";
import {
  createGbrainHttpExec,
  createGbrainMcpToolCallExec,
  createGbrainDcrTokenProvider,
  DEFAULT_GBRAIN_HTTP_URL,
} from "./api/procedures/copilotGbrainHttp";
import type { GbrainTokenProvider } from "./api/procedures/copilotGbrainHttp";
import { readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// task 11.1/24.1 (REQ-D-005, safety rule 1) — the REAL OS-atomic single-owner lock primitive.
import { acquireSingleOwnerLock, type LockAcquireResult } from "./install/lock/singleOwnerLock";
import { createWriteFenceProbe } from "./install/lock/writeFenceProbe";
import { createFsVaultReadFileExec, createFsRealpath } from "./api/procedures/copilotVaultRead";
import {
  createAgentRuntimeCopilotSynthesis,
  createClaudeAgentCopilotRunner,
  deriveCopilotContentTrust,
  gbrainMcpEndpoint,
} from "./api/procedures/copilotAgentSynthesis";
import { createApprovalsProposeSink } from "./api/procedures/copilotProposeSink";
// §13.10a G4a — the on-approval SEMANTIC dispatch (approved semantic_mutation card → KnowledgeWriter commit).
import {
  createApprovalDispatchRouter,
  reconcileApprovedSemanticMutations,
} from "./api/procedures/semanticMutationDispatch";
import { buildSemanticApprovalDispatch } from "./composition/semanticApprovalDispatch";
// §13.10a G4b-3 — the SEMANTIC-write propose deps (dormant behind `copilotProposeKnowledge`).
import { createApprovalsKnowledgeProposeSink } from "./api/procedures/copilotProposeKnowledgeSink";
// 13.8i-B — the fresh sink object over the SAME repos, wrapped by the EXISTING factory (a second sink
// OBJECT over identical repos + planId idempotency is one minting path instantiated twice, never a
// second minting PATH — the prohibition is on the behaviour, not the object; contracts L59/brief 241 v2).
import {
  createProposeKnowledgeApprovalPort,
  createLivingVaultPort,
  createIngestRewriteAdapter,
  buildIngestRewriteDeps,
} from "./composition/living-vault";
import type { SignalCountsHealth } from "./composition/living-vault";
import type { CopilotNoteExistsProbe } from "./api/procedures/copilotProposeKnowledge";
import type { CopilotServingOracle } from "./api/procedures/copilotProvenanceStamp";
import { selectServingOracleFactory } from "./api/procedures/servingContextLoader";
import type { CommittedVaultReader } from "./api/procedures/servingContextLoader";
import { createReconcileScheduler } from "./composition/reconcileScheduler";
import type { LoggedReconcileOutcome, ReconcileScheduler } from "./composition/reconcileScheduler";
import { createReconcileTrigger } from "./composition/reconcileTrigger";
import type { ReconcileTrigger } from "./composition/reconcileTrigger";
import { runReconcileForWorkspace } from "./composition/reconcileDriver";
import { buildCanonicalFactSet } from "./composition/canonicalFactSet";
import { buildReconcilerDbProjection } from "./composition/reconcilerDbProjection";
import { runReconcilePass } from "./composition/parityReconcile";
import type { RunReconcilePassDeps, ReconcileHealthSink } from "./composition/parityReconcile";
import { probeRebuildOracle } from "./composition/rebuildOracleStatus";
import type { RebuildOracleProbeDeps, RebuildOracleStatus } from "./composition/rebuildOracleStatus";
import {
  buildLoaderBackedServingOracle,
  buildServedVaultResolver,
} from "./api/procedures/servingOracleAssembly";
import { createServingCoverageReader, createCommittedVaultReader } from "./api/procedures/servingContextBootReaders";
import { createParityReportRecorderAdapter } from "./composition/parityReportStore";
import { buildKeychainSecrets, type KeychainSecretsGate } from "./secrets/keychain-boot";
import { createCopilotProposeMcpServer, createCopilotProposeKnowledgeMcpServer, createCopilotGbrainProxyMcpServer, createCopilotVaultMcpServer, createCopilotSkillsMcpServer } from "@sow/providers";
import type { CopilotSynthesisPort, AuditPersistPort, AuditPersisting } from "./api/procedures/copilot";
import { createReadModelBriefingRetrieval, type CopilotBriefingDeps } from "./api/procedures/copilotBriefing";
import { createClaudeSubscriptionCompletion } from "@sow/providers";
import type { ClaudeSubscriptionCompletion, SubscriptionReachabilityCheck } from "@sow/providers";
import type { SystemHealthQueryPort, UiSafeEgressStatus } from "./api/procedures/systemHealth";
import type {
  ApprovalCommandPort,
  DispatchApprovalFn,
  TriagePort,
  RerouteTargetValidatorPort,
} from "./api/procedures/commands";
import type { Logger } from "./observability/logger";
import { createHealthSurface, type HealthSurface, type HealthFailure } from "./health/surface";
import { createPersistentHealthSurfaceStore } from "./composition/store-adapters";
import { provisionDevWorkspace, type DevProvisionSpec } from "./composition/provisionDev";
import { maybeSeedDemoData } from "./composition/demoSeed";
import {
  createTemporalUnavailabilityController,
  DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
  type TemporalUnavailabilityController,
} from "./lifecycle/degraded/temporal-unavailable";
import {
  createOperationalBackupService,
  type OperationalBackupService,
  type OpDbBackupPort,
  type TemporalPersistenceBackupPort,
} from "./backup/operational-backup";
import { createPeriodicBackupTick } from "./backup/backup-ports";
import { bootstrapWorker, decideBootstrap } from "./temporal/worker";
import type { BootstrapReady, BootstrapDegraded } from "./temporal/worker";
import {
  makeProofSpineRegisterHook,
  PROOF_SPINE_TASK_QUEUE,
} from "./temporal/registerWorker";
// tasks 25.2/25.3/25.4/25.5 — the 25.SCHED leg-1 durable schedule registrar + each output
// workflow's default-OFF gate. scheduleRegistrar.ts's own header: "wiring this gate into
// bootWorker ... is PKG-W1's boot.ts, outside this package's territory" — this IS that wiring,
// for every gate the module exports (25.5 landed ingestionTriage first; this wave adds the
// remaining five).
import {
  createTemporalScheduleRegistrar,
  gateIngestionTriageSchedule,
  gateProjectSyncSchedule,
  gateDailyBriefSchedule,
  gatePeriodReviewWeeklySchedule,
  gatePeriodReviewMonthlySchedule,
  gateCrossCalendarSchedulingSchedule,
  INGESTION_TRIAGE_SCHEDULE_ID,
  PROJECT_SYNC_SCHEDULE_ID,
  DAILY_BRIEF_SCHEDULE_ID,
  PERIOD_REVIEW_WEEKLY_SCHEDULE_ID,
  PERIOD_REVIEW_MONTHLY_SCHEDULE_ID,
  CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID,
  type ScheduleClientPort,
  type TemporalScheduleSpec,
  type ScheduleRegistrarErrorCode,
  type EnsureOutcome,
} from "./temporal/scheduleRegistrar";
// WP5 — the static per-schedule envelope shapes (`scopes`/`sources`/`globalWorkspaceId`/
// `organizerWorkspaceId`/`catchUpWindowMs`) `buildOutputWorkflowScheduleSpecs` composes below.
import type { ScheduledWorkspaceScope, ScheduledAvailabilitySource } from "./temporal/scheduleArgs";
import type { ProofSpineParams } from "./composition/buildActivities";
// 21.10/21.8 — the credential-seam accessor + card-transport gate types `proofSpineParams` carries.
// Deep subpath import: the main @sow/integrations barrel does not re-export tools/cards (its own
// header notes worker wiring is THIS package's territory). `WriteSecretsAccessor` IS re-exported from
// the main barrel (tools/adapters/adapter-core.ts) — imported alongside for the local adapter below.
import type { CardTransportGate } from "@sow/integrations/tools/cards/index";
import type { WriteSecretsAccessor } from "@sow/integrations";
import type { SecretsAccessor } from "@sow/providers";
// §11.1 slice 2b — the durable KnowledgeRevisionStore adapter (over the 2a operational-store repo),
// rebound into the proof-spine params post-backends so the ingestion sourceCommit + propose dispatch
// persist idempotency across a worker restart. Kept OFF the OFF-config path (see withDurableRevisions).
import { createKnowledgeRevisionStoreAdapter } from "./composition/knowledgeRevisionStore";
// task 19.1 — the durable GBrain post-commit sync-outbox binding + drain-on-wake re-driver.
// See withGbrainSyncOutbox's own doc for why this runs UNCONDITIONALLY (not gated on
// config.proofSpineParams the way withDurableRevisions is) — the store + drain are harmless,
// modest internal machinery, not an arming crossing.
import {
  createGbrainSyncOutboxBinding,
  createWorkingTreeMarkdownSource,
  drainGbrainSyncOutbox,
} from "./composition/gbrainSyncOutbox";
// task 11.3b — the write-through enablement gate's real (if today unprovisioned) production caller.
import { evaluateWriteThroughEnablement, surfaceEnablementDecision } from "./composition/enablementLegs";
// C5.4b B4 — the durable ParityReportStore read-adapter, bound into the serving-coverage reader inside the
// triple-locked loaderBackedServingOracle branch (closes the B2 store-consuming reachability waiver).
import { createParityReportStoreAdapter } from "./composition/parityReportStore";
import type { KnowledgeRevisionRepository, AuditRepository, ReadModelRepository } from "@sow/db";
// §9 make-it-real C3b — the local-vault file-watcher capture trigger + its degraded-safe
// dispatch. The Temporal Client's first real caller (deferred to here from C3a).
import { createFileReadTransport } from "@sow/integrations/connectors/adapters/file-read-transport";
import {
  dispatchSourceIngestion,
  createTemporalClientStartRun,
  type StartWorkflowRun,
  type DispatchHealthSink,
} from "./temporal/dispatchSourceIngestion";
import {
  startVaultWatcher,
  type RunningVaultWatcher,
  type VaultDispatch,
  type CaptureOutcome,
} from "./watch/vaultWatcher";
// §13 task 11.3-b — the GBrain version-pin BOOT verify step (closes the 11.3-a reachability waiver).
import { readFile } from "node:fs/promises";
import { createGbrainVersionProbe, computeRevisionId, type GbrainVersionProbe, type KnowledgeRevisionStore, type CommittedRevision, type SecretsPort, type SecretRef, type SecretUnresolved, type StamperDeps, type RunningGbrainVersion, type VaultFs, type GbrainReadAdapter, type ReconcilerDbProjection, type IndexRebuildClient, type EntityGbrainReadPort, type SynthesisReasonPort } from "@sow/knowledge";
import { gbrainStartupVerify } from "./gbrainStartupVerify";

// ── config ────────────────────────────────────────────────────────────────────

/**
 * The live-boot configuration. Extends the persistent {@link BackendsConfig}
 * (durable `dbPath` + `vaultRoot`, the local-endpoint allowlist, the log sink) with
 * the app-shell inputs the composition needs but does NOT own:
 *   - `sessionToken` — the per-launch token minted + injected by Electron main (Phase 9);
 *   - `allowlist`    — the renderer Origin/Host allowlist (Phase 9);
 *   - `apiHost`/`apiPort` — the loopback bind (defaults: 127.0.0.1 : ephemeral);
 *   - `proofSpineParams` — the resolved job identity + workspace posture the Temporal
 *      registration binds the activities under (a deployment resolves these upstream);
 *   - `triageDispatch` — the ingestion re-entry dispatch (Temporal / Tool-Gateway);
 *   - `dispatchApproval` — the approved-approval downstream dispatch;
 *   - `backupPorts?` — the op-DB + Temporal-persistence backup ports (service wired, CRON deferred);
 *   - `stubExtraction?` — the deterministic meeting candidate until the model transport lands.
 */
export interface BootConfig extends BackendsConfig {
  /** Per-launch session token — INJECTED by Electron main (Phase 9); never minted here. */
  readonly sessionToken: SessionToken;
  /** Renderer Origin/Host allowlist — INJECTED (Phase 9). */
  readonly allowlist: WorkerOriginAllowlist;
  /** Owner opt-in for the reconcile-TRIGGER arc (task 13.10) — default absent ⇒ `gateReconcile` returns undefined
   *  (byte-equivalent; NO reconcile machinery constructed). Set ONLY at the owner's ARMING, bundled with the
   *  transport provisioning + the trigger-source wiring (the HARD LINE). Needs a `vaultRoot` precondition. */
  readonly reconcile?: boolean;
  /**
   * task 25.5 — owner opt-in for the ingestion-triage DURABLE schedule (default absent ⇒ no schedule
   * registered; byte-equivalent). Strict `=== true` — a truthy non-boolean never arms (mirrors every
   * other gate in this file, worker LESSONS §2). Even armed, `ensure()` can only CREATE a schedule
   * PAUSED or converge an EXISTING one's spec/cadence — it can NEVER unpause one. ⛔ D2a — this is
   * NOT because `scheduleRegistrar.ts`'s narrow `ScheduleClientPort.update` omits a `paused` field
   * (it does, but that fact alone guarantees nothing — MEASURED FALSE: the prior real-adapter
   * shape also omitted one and it still unpaused a schedule, `afterCreate.paused=true` →
   * `afterUpdate.paused=false`, task F2). The REAL guarantee lives in THIS file's own adapter,
   * {@link createRealScheduleClientPort}`.update` — it reads the schedule's CURRENT
   * `previous.state.paused` back from the real SDK and echoes it into the replace-semantics update
   * call (see that function's own doc for the full proto3 zero-value mechanism this closes). A
   * converge preserves whatever pause state the schedule already had; only a human operator
   * flipping it outside this process (`tctl`/the Temporal UI) ever unpauses one — never this code.
   */
  readonly ingestionTriageSchedule?: {
    readonly enabled?: boolean;
    /** The re-surface cadence. Defaults to 6 hours if armed without an override. */
    readonly intervalMs?: number;
  };
  /**
   * task 25.3 — owner opt-in for the project-sync DURABLE schedule. Same shape + same
   * never-arms-live guarantee as {@link BootConfig.ingestionTriageSchedule} above (strict
   * `=== true`, `ensure()` can only create-paused/converge, never unpause).
   */
  readonly projectSyncSchedule?: {
    readonly enabled?: boolean;
    /** The sync cadence. Defaults to 1 hour if armed without an override. */
    readonly intervalMs?: number;
  };
  /**
   * task 25.2 — owner opt-in for the daily-brief DURABLE schedule. Same shape + same
   * never-arms-live guarantee as {@link BootConfig.ingestionTriageSchedule} above.
   */
  readonly dailyBriefSchedule?: {
    readonly enabled?: boolean;
    /** The brief cadence. Defaults to 24 hours if armed without an override. */
    readonly intervalMs?: number;
    /**
     * WP5 — the LIFE-2 catch-up collapse window. Defaults to 2x the resolved `intervalMs` if
     * armed without an override, so a missed occurrence up to two cadences late still collapses
     * to one run on wake.
     */
    readonly catchUpWindowMs?: number;
    /**
     * WP5 — the Global/Coordination workspace this run's global brief commits to. Defaults to
     * `DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID` if armed without an override — see that
     * constant's own doc for why it, not a fresh id, is the default.
     */
    readonly globalWorkspaceId?: string;
    /**
     * WP5 — the WS-2 authorized workspace set this run reads over. Defaults to the composition
     * root's own workspace registry (`loadRegisteredWorkspaceScopes`) if omitted; an explicit
     * list here overrides the registry derivation entirely (never merged).
     */
    readonly scopes?: readonly ScheduledWorkspaceScope[];
  };
  /**
   * task 25.2 — owner opt-in for the period-review DURABLE schedules (weekly AND monthly — ONE
   * flip arms BOTH cadences, no split-brain between them). Same never-arms-live guarantee as
   * {@link BootConfig.ingestionTriageSchedule} above.
   */
  readonly periodReviewSchedule?: {
    readonly enabled?: boolean;
    /** The weekly-cadence review interval. Defaults to 7 days if armed without an override. */
    readonly weeklyIntervalMs?: number;
    /** The monthly-cadence review interval. Defaults to 30 days if armed without an override. */
    readonly monthlyIntervalMs?: number;
    /**
     * WP5 — the LIFE-2 catch-up collapse window shared by BOTH cadences when explicitly set;
     * absent, each cadence defaults independently to 2x ITS OWN resolved interval (so the
     * monthly schedule doesn't inherit the weekly cadence's much-shorter default window).
     */
    readonly catchUpWindowMs?: number;
    /** WP5 — same default convention as {@link BootConfig.dailyBriefSchedule}'s own field. */
    readonly globalWorkspaceId?: string;
    /** WP5 — same default convention as {@link BootConfig.dailyBriefSchedule}'s own field. */
    readonly scopes?: readonly ScheduledWorkspaceScope[];
  };
  /**
   * task 25.4 — owner opt-in for the cross-calendar-scheduling DURABLE schedule. Same shape +
   * same never-arms-live guarantee as {@link BootConfig.ingestionTriageSchedule} above.
   */
  readonly crossCalendarSchedulingSchedule?: {
    readonly enabled?: boolean;
    /** The scheduling-sweep cadence. Defaults to 1 hour if armed without an override. */
    readonly intervalMs?: number;
    /**
     * WP5 — the WS-2 workspace an auto-created cross-calendar event belongs to. Defaults to
     * `DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID` if armed without an override.
     */
    readonly organizerWorkspaceId?: string;
    /**
     * WP5 — the FULL set of calendar sources REQ-F-009 requires be read across. No workspace-
     * registry enumeration exists for connector source ids at this point in boot (arch_gap,
     * flagged not silently assumed — the registry holds bare workspace ids, not per-workspace
     * connector sources), so an owner must list them explicitly. Defaults to `[]` if armed
     * without an override: an armed-but-sourceless schedule reads across nothing until an owner
     * supplies sources — never a guessed or hardcoded one. (A FRESH one is also created paused;
     * a converge PRESERVES whatever pause state the schedule already had, so this sentence is
     * about the create branch only — see {@link createRealScheduleClientPort}`.update`.)
     */
    readonly sources?: readonly ScheduledAvailabilitySource[];
  };
  /** Loopback bind host — defaults to 127.0.0.1 (a non-loopback host is REFUSED). */
  readonly apiHost?: string;
  /** Loopback bind port — defaults to 0 (ephemeral); a deployment pins one. */
  readonly apiPort?: number;
  /**
   * Resolved job identity + workspace posture the Temporal activities bind under.
   * OPTIONAL: required only to REGISTER workflows on a successful Temporal connect.
   * A desktop first-render (9.4b) boots WITHOUT it — the control-plane API + backends
   * come up and `connectTemporal` degrades cleanly (Temporal-unavailable) rather than
   * registering; the proof-spine pipeline supplies it later.
   */
  readonly proofSpineParams?: ProofSpineParams;
  /** The ingestion re-entry dispatch (Temporal / Tool-Gateway) — replay-safe (ING-4). */
  readonly triageDispatch: TriageDispatchFn;
  /** The approved-approval downstream dispatch (drives the side effect of an APPLIED approval). */
  readonly dispatchApproval: DispatchApprovalFn;
  /** Op-DB + Temporal-persistence backup ports (service wired; the CRON is Phase-11). */
  readonly backupPorts?: {
    readonly opDb: OpDbBackupPort;
    readonly temporal: TemporalPersistenceBackupPort;
  };
  /** The deterministic meeting candidate the broker maps until the real model transport lands. */
  readonly stubExtraction?: StubMeetingExtraction;
  /**
   * 18.25 step-6 — the owner ARM opt-in for the SUBSCRIPTION-ONLY extraction path. OFF by default (`enabled`
   * unset/not `=== true`) ⇒ byte-equivalent: the whole subscription arm is inert, `config.providerTransport`
   * stays as-is. When ARMED, bootWorker CONSTRUCTS the subscription `ProviderTransportGate` over a late-bound
   * reader holder (the eager-consumption ordering fix, backends.ts:809) — this is the owner ENABLE flip (real
   * cloud egress + real spend, HARD LINE; lead+owner-run). `makeCompletion`/`checkReachable` default to the
   * real subscription client + a FAIL-CLOSED reachability probe; a test/-live path injects stubs.
   * ⚠ #13 arm precondition: the real SDK-reachability `checkReachable` (providers-layer) MUST bind before
   * HEALTH can be AVAILABLE at the arm — the default fail-closed probe keeps the arm HEALTH-denied until then.
   */
  readonly subscriptionArm?: {
    readonly enabled?: boolean;
    readonly model?: string;
    readonly makeCompletion?: () => ClaudeSubscriptionCompletion;
    readonly checkReachable?: SubscriptionReachabilityCheck;
  };
  /** Temporal dev-server address (host:port) — defaults to 127.0.0.1:7233. */
  readonly temporalAddress?: string;
  /** Bound the Temporal connect loop so a permanent outage degrades, never spins. Default 5. */
  readonly maxConnectAttempts?: number;
  /**
   * DEV-ONLY data unlock (OFF by default). When supplied, each spec turns a local vault
   * Markdown note into REAL read-model rows (deterministic checkbox parse + the fail-closed
   * workspace registry) so the wired-but-empty Today / workspace / project surfaces show
   * genuine content without vendor I/O — honoring the §9.4 "empty-until-data, no seed"
   * decision (the data is derived from real files, not a DB seed). Best-effort at boot: a
   * per-spec failure is logged and skipped; it never blocks the control plane coming up.
   */
  readonly devProvision?: readonly DevProvisionSpec[];
  /**
   * Real Copilot model path (OFF by default — the interim runs the deterministic stub over a LOCAL
   * route, so nothing egresses and no notice fires). When true, Copilot synthesis calls the Claude
   * SUBSCRIPTION completion client over a CLOUD Claude route, and each dev-provisioned workspace gets
   * the CONSENT posture (`cloudCopilotPosture`) — so an Employer-Work ask egresses to Anthropic WITH
   * the visible notice (the owner's stated posture: "fine with Employer-Work going to a cloud model, I
   * just want a notice"). Flipping this to true is the interim consent gesture until the authoritative
   * per-workspace `WorkspaceConfigRepository` posture lands.
   */
  readonly copilotRealModel?: boolean;
  /** Optional Claude model id for the real Copilot path; defaults to DEFAULT_CLAUDE_COPILOT_MODEL. */
  readonly copilotModel?: string;
  /**
   * Optional SDK beta flags for the real Copilot path; defaults to DEFAULT_COPILOT_BETAS (the
   * 1M-context window, which pairs with the Sonnet default). Override alongside `copilotModel` when
   * switching to a non-Sonnet family (an incompatible beta+model combo is rejected server-side).
   */
  readonly copilotBetas?: readonly string[];
  /**
   * Real GBrain retrieval (P3-live — OFF by default; requires `copilotRealModel` too). When true, the
   * served workspace (`copilotGbrainWorkspaceId`, default personal-business) reads the LOCAL gbrain via the
   * `gbrain call query` CLI instead of the empty fixture stub.
   * ⛔ WHETHER EVERY OTHER WORKSPACE STAYS ON THE FIXTURE DEPENDS ON `copilotWorkspaceScoping` (`### 24.79`):
   * scoping OFF ⇒ yes, and WS-8 holds BY CONSTRUCTION (only the served workspace ever reads the brain);
   * scoping ON ⇒ Option A multi-served, where ANY REGISTERED workspace reads the one combined brain and
   * ⛔ WS-8 holds by the MANDATORY per-request filter, NOT by construction. This doc asserted the
   * by-construction form unconditionally until `24.79`; it describes only the scoping-OFF branch. The worker needs
   * `VOYAGE_API_KEY` in its env (gbrain embeds the query) and the `gbrain` binary on PATH; a missing
   * key/binary fails closed (typed fault), never a throw. Interim TEST transport — NOT the mandated
   * `transport:"http"` GbrainReadGrant path. No effect when `copilotRealModel` is off.
   */
  readonly copilotGbrainRetrieval?: boolean;
  /** The workspace served from the local brain; defaults to DEFAULT_GBRAIN_COPILOT_WORKSPACE. */
  readonly copilotGbrainWorkspaceId?: string;
  /**
   * Which gbrain read transport to use when `copilotGbrainRetrieval` is on:
   *   - "subprocess" (default) — shells `gbrain call query` (needs VOYAGE_API_KEY in the WORKER env + no
   *     concurrent `gbrain serve` on the single-connection PGlite brain);
   *   - "http" — the MANDATED transport:"http" path: reads over a running `gbrain serve --http` (OAuth 2.1
   *     via DCR). COEXISTS with a serve (fixes the PGlite-lock finding) and moves VOYAGE_API_KEY to the
   *     SERVE process. Needs `gbrain serve --http --enable-dcr` reachable at `copilotGbrainHttpUrl`.
   */
  readonly copilotGbrainTransport?: "subprocess" | "http";
  /** The `gbrain serve --http` base URL for the "http" transport; defaults to DEFAULT_GBRAIN_HTTP_URL. */
  readonly copilotGbrainHttpUrl?: string;
  /**
   * §13.10 gate (a) SC3 — WS-8 per-workspace scoping of the served brain (OFF by default; only effective when
   * `copilotGbrainRetrieval` + `copilotRealModel` are also on). When true, the P1 retrieval filters each raw
   * gbrain hit to the served workspace (foreign + legacy-denied dropped) via an INTERIM slug-prefix registry
   * built from the resolved Copilot workspaces. The legacy posture is `copilotLegacyContentPolicy` (default
   * fail-closed `{deny}`). On today's single-workspace brain (all content is the served workspace's own legacy
   * content) this is INERT under `{assign, <served>}` — it lands the mechanism live, not observable enforcement.
   * The durable WS-8 enabler is ingest-time attribution + per-workspace sources (docs/planning/ws8-*).
   */
  readonly copilotWorkspaceScoping?: boolean;
  /**
   * The legacy-content posture for `copilotWorkspaceScoping` (only consulted when it is on). `{deny}` (the safe
   * default) drops every unattributed/legacy hit; `{assign, toWorkspaceId}` treats legacy content as that
   * workspace's and serves it ONLY when that IS the served workspace (never crosses). `{assign}` is a
   * transitional bridge, sound only while the brain holds a single workspace's unprefixed content.
   */
  readonly copilotLegacyContentPolicy?: LegacyContentPolicy;
  /**
   * The AGENTIC Copilot (Phase-C C3 — OFF by default; requires `copilotRealModel` too). When true, Copilot
   * synthesis runs the model as a governed READ-ONLY AGENT over the AgentRuntimePort (Claude Agent SDK) with
   * the gbrain `serve --http` MCP endpoint as its read-tool source — so the model can SEARCH this workspace's
   * brain while it answers, instead of a one-shot tool-less completion. Still bound to the veto-cleared route
   * + the read_only tool policy + the same grounding reconciliation. Needs `gbrain serve --http --enable-dcr`
   * reachable at `copilotGbrainHttpUrl` (the MCP endpoint is `${base}/mcp`; auth via DCR). No effect when
   * `copilotRealModel` is off. Dormant unless a serve is running — flip only alongside one.
   */
  readonly copilotAgentMode?: boolean;
  /**
   * §13.10d — the read-only VAULT page-read tool (`mcp__vault__read`). OFF by default. When true (AND
   * `copilotAgentMode` + workspace scoping on AND a `vaultRoot` configured), the agent ALSO gets a
   * `vault.read` tool to read ONE canonical-Markdown note by path — path-traversal-guarded + WS-8-scoped to
   * the served workspace (a foreign / traversal path is denied, fail-closed). Additive to the gbrain proxy.
   * Needs the Obsidian vault on disk at `vaultRoot`; no effect without it.
   */
  readonly copilotVaultRead?: boolean;
  /**
   * §13.10d — read-only SKILL self-introspection (`mcp__skills__list` + `mcp__skills__get`). OFF by default.
   * When true (AND `copilotAgentMode` + workspace scoping on) the agent ALSO gets tools to enumerate its own
   * read-skill catalog + read one skill's metadata. This touches NO workspace data (it reads the STATIC tool
   * catalog), so it is workspace-agnostic + zero-leak — and it NEVER reveals the write-proposing tool. Additive
   * to the gbrain proxy; needs no vault/disk config.
   */
  readonly copilotSkillIntrospection?: boolean;
  /**
   * The Copilot WRITE-VIA-APPROVALS tool (Phase-C C5.3 — OFF by default; requires `copilotAgentMode` too).
   * When true, the agent MAY hold the `copilot.propose_action` tool, which records a PENDING §9.8 Approval
   * (never a direct write; the owner approves it). Even with this ON, propose stays STRUCTURALLY OFF at
   * runtime because the content-trust resolver (`deriveCopilotContentTrust`) is the fail-closed interim
   * ('untrusted' always) — so a live ask never resolves to a propose-capable job. Real go-live is gated on
   * C5.4 (per-content provenance + the §9.8 read-model workspace-scoping fix). This flag is ALWAYS an AND-term
   * with the trust verdict, never a standalone override.
   */
  readonly copilotProposeMode?: boolean;
  /**
   * 13.8d — the OWNER opt-in that arms the living-vault rewrite on the source-ingestion path (§6 KN-10:
   * ingesting a source also updates the entities/index/op-log it bears on). ABSENT (the shipped default)
   * ⇒ the leg is unbound and ingestion is byte-equivalent to pre-13.8d. Read ONLY through
   * {@link gateLivingVaultRewrite}, which requires a strict `=== true` AND a configured `vaultRoot`.
   */
  readonly livingVaultRewrite?: boolean;
  /**
   * task ARM-RESEARCH-3 — the OWNER-PROVISIONING bundle `gateLivingVaultRewrite`'s ON path needs to
   * actually construct the real `IngestRewriteDeps` (via `buildIngestRewriteDeps`, apps/worker/src/
   * composition/living-vault.ts): the two PROVIDER-territory ports (`gbrain` entity-lookup, `reason`
   * synthesis) that this composition root does not itself implement (a guessed mapping risks a
   * silently-wrong entity resolution or a fabricated model call — see that module's own header).
   * ABSENT (the shipped default) ⇒ `withLivingVaultRewrite`'s `buildWiring` thunk returns `undefined`
   * even when `livingVaultRewrite === true` AND `vaultRoot` is configured — a THIRD independent
   * OFF-lock alongside the flag + vaultRoot, so the flag alone can never arm a real adapter. Present
   * (owner/test-provisioned) ⇒ a genuine `SourceLivingVaultPort` is bound. NOTHING in this slice
   * arms it — no default flips, no key/route provisioned.
   */
  readonly livingVaultProviders?: {
    readonly gbrain: EntityGbrainReadPort;
    readonly reason: SynthesisReasonPort;
  };
  /**
   * 13.8f-B — the OWNER opt-in that arms the meeting-path living-vault rewrite (§6 KN-10 — the meeting
   * analog of `livingVaultRewrite`). ABSENT (the shipped default) ⇒ the leg is unbound and the meeting
   * closeout's `linkMutations` stays `[]`, byte-equivalent to pre-13.8f-B. Read ONLY through
   * {@link gateMeetingVaultRewrite}, which requires a strict `=== true` — no second precondition (unlike
   * `livingVaultRewrite`'s `vaultRoot`), because the meeting adapter performs no realpath containment
   * (see apps/worker/src/composition/meeting-vault.ts's own header for why that's not a gap).
   */
  readonly meetingVaultRewrite?: boolean;
  /**
   * §13.10a — mirror flag for the SEMANTIC-write propose tool (`copilot.propose_knowledge`). OFF by default.
   * EFFECTIVE only when the dispatch side is provisioned (`proofSpineParams`) — else a proposed card could not
   * be committed on approval. Mutually exclusive with `copilotProposeMode` (both on ⇒ the capability resolver
   * fails closed to read_only).
   */
  readonly copilotProposeKnowledge?: boolean;
  /**
   * Copilot PROVENANCE STAMPING (Phase-C C5.4b — OFF by default; effective only WITH `copilotRealModel`).
   * When true, the retrieval is wrapped in the provenance-stamping decorator fed the INTERIM (always-
   * degraded) serving oracle — so a source is stamped `knowledge_writer` ONLY when the oracle admits it.
   * Because boot wires the INTERIM oracle, NOTHING is stamped today ⇒ every ask is untrusted ⇒ propose
   * stays structurally OFF (the C5.4a pattern: a real mechanism kept OFF by its INPUT). Wiring a REAL
   * admitForServing-backed oracle here is a security-review-gated go-live event, never a flag flip (see
   * `copilotProvenanceStamp.ts` GO-LIVE PRECONDITIONS). Turning this ON is safe (it can only make sources
   * LESS trusted than the un-decorated path); it exists so the decorator sits on the live path pre-go-live.
   */
  readonly copilotProvenanceStamping?: boolean;
  /**
   * C5.4b Slice 3 — the go-live ARMING flag for the REAL serving oracle (OFF by default; the flip is the
   * owner's HARD-LINE go-live crossing — do NOT arm in code). AND-composed by `selectServingOracleFactory`
   * (`goLiveArmed === true && loaderBacked !== undefined`), never a standalone override. Even armed, the real
   * oracle stays dormant unless a signing key is provisioned (`provenanceServingOracle`) AND real coverage is
   * green — THREE independent OFF-locks, each sufficient to keep propose OFF.
   */
  readonly copilotServingOracleGoLive?: boolean;
  /**
   * C5.4b Slice 3 — the go-live PROVISIONING bundle for the real serving oracle (default ABSENT ⇒ `loaderBacked`
   * undefined ⇒ OFF-lock 2, STRUCTURAL: the arming flag alone can never arm). Supplies the knowledge-local
   * SecretsPort + signing-key ref (Keychain adapter = HITL/11.4, unbuilt) and the gbrain pin + running-version
   * accessor for the coverage reader — all provided at the owner's go-live event. `arch_gap`: no canonical
   * policy-layer SecretsPort yet — this injects the SAME knowledge-local port the writer's stamp-mint uses. The
   * pin is ONE coverage leg; the serve-time ParityReport store + rebuild-oracle wiring is the remaining go-live
   * coverage gate (arming ≠ trust — OFF-lock 3, the real reader degrades on `parity===undefined`).
   * `secrets` is OPTIONAL (11.4 slice 3): boot sources it from the real Keychain adapter (`keychainSecrets`) when
   * provisioned, falling back to an inline `secrets` (a test injection) — `keychainSecrets?.secrets ?? .secrets`.
   */
  readonly provenanceServingOracle?: {
    readonly secrets?: SecretsPort;
    readonly signingKeyRef: SecretRef;
    readonly pin: GbrainPin;
    readonly resolveRunning?: () => RunningGbrainVersion | undefined;
  };
  /**
   * 11.4 Slice 3 — the OWNER-PROVISIONING gate for the real macOS-Keychain `SecretsPort` (default ABSENT ⇒ INERT:
   * no adapter/backend/`security` process constructed, byte-equivalent boot). When present, `buildKeychainSecrets`
   * builds the Keychain adapter and boot sources `provenanceServingOracle.secrets` (C5.4b OFF-lock 2) from it. The
   * first real Keychain touch is owner-gated. `execFile` is a test seam; production omits it (the real bounded
   * wrapper). The `getSecret` provider facade + the Keychain-locked degraded routing are NOT a future follow-up —
   * they already landed (task 17.3, `09e0630e`) as `createLockRoutingSecretsAccessor` in
   * `apps/worker/src/secrets/keychain-boot.ts`, addressed via the 17.4 secret-ref convention
   * (`secretRefConvention.ts`), and are consumed by all five `ModelProviderPort` adapters (Claude/OpenAI/
   * OpenRouter cloud + Ollama/LM Studio local, no key) in `apps/worker/src/composition/provider-runner.ts`
   * (task 18.1) — dormant behind the default-OFF `ProviderTransportGate`, same as this gate (task 11.4).
   */
  readonly keychainSecrets?: KeychainSecretsGate;
  /**
   * 21.8 — the OWNER-PROVISIONING gate for the real approval-card renderer (default ABSENT ⇒ INERT:
   * `buildProofSpineActivities` keeps the deterministic no-op literal, byte-equivalent boot). Mirrors
   * `keychainSecrets` above and PROV-3's `CardTransportGate` (@sow/integrations/tools/cards) — both
   * `enabled === true` (strict) AND a `make` factory are required to arm; either absent/false stays
   * the no-op. NOTHING in this slice arms it: `make` is never bound here, no default flips.
   */
  readonly cardTransport?: CardTransportGate;
  /**
   * task 22.1 (precondition 4/5 for `gateProposeArming`) — the OWNER-PROVISIONING gate for the real
   * external-write {@link AdapterTransport} (Phase 21). UNSET (the shipped default) ⇒ `assembleBackends`
   * keeps the deterministic stub transport (byte-equivalent, dormant) AND `gateProposeArming` reads
   * `writeTransportArmed: false` ⇒ propose stays OFF regardless of the other four preconditions. NEW
   * `BootConfig` surface (task 22.1) — no prior boot-time signal existed at all, so today's shipped boot
   * has no way to know whether the real external-write transport is armed; forwarded unchanged to
   * `assembleBackends` via `buildBackendsConfig`, mirroring the already-forwarded `providerTransport`
   * sibling field. Unset by default ⇒ byte-equivalent (the stub transport, `writeTransportArmed: false`).
   */
  readonly writeTransport?: WriteTransportGate;
  /**
   * Explicit Copilot workspace set (id + type). Decoupled from `devProvision` (which is SURFACE data).
   * When omitted: devProvision-derived if present, else — on the real path — the 3 well-known scopes
   * (so the Copilot is reachable without a vault note). See `resolveCopilotWorkspaces`.
   */
  readonly copilotWorkspaces?: readonly CopilotWorkspace[];
  /**
   * §9 make-it-real C3b — the local-vault file-watcher capture trigger (OFF by default).
   * When supplied AND `vaultRoot` is configured, `bootWorker` starts a real `node:fs`
   * watcher on the vault root: a `.md` add/change → C2 ROOT-confined capture → C3a dispatch
   * → a live `sourceIngestion` run (`trigger:"connector_event"`). The binding is the WS-2
   * policy scope (workspace + sensitivity) — NEVER content-inferred (REQ-F-017). Degraded-
   * safe: if a loopback Temporal Client cannot be built the watcher still runs and each
   * capture fails CLOSED (a surfaced worker_down health item), never a crash. The dev-server
   * RUN is the owner's separate ops step — boot only lands the wiring.
   */
  readonly vaultWatch?: {
    readonly workspaceId: string;
    readonly sensitivity: string;
    readonly debounceMs?: number;
  };
  /**
   * §13 task 11.3-b — the GBrain version-pin STARTUP verify (OFF unless configured). When supplied,
   * `bootWorker` best-effort probes the running gbrain against `config/gbrain.pin` at startup and, on
   * degrade, surfaces the distinct version-pin System-Health item. NEVER blocks/crashes boot (a
   * gbrain-unavailable / mismatch / PENDING degrade is the EXPECTED safe outcome). Config presence is
   * the gate — keeps CI/test boots shell-out-free + deterministic; production supplies `pinPath`. The
   * write-through flip / serving-oracle re-plumb stay HITL — the only effect is the startup HealthItem.
   */
  readonly gbrainStartupVerify?: {
    /** Path to the `config/gbrain.pin` file (absolute or cwd-relative). */
    readonly pinPath: string;
    /** Optional injected probe (tests); default = the real `createGbrainVersionProbe()`. */
    readonly probe?: GbrainVersionProbe;
  };
}

/** The assembled live control plane the app shell drives. */
export interface BootedWorker {
  /** The running loopback API server (bound host/port + publisher + close). */
  readonly api: RunningApiServer;
  /** The persistent backends bundle (sqlite store + vault + broker + persistent stores). */
  readonly backends: ProofSpineBackends;
  /** The single redacting structured logger (over the assembled sink). */
  readonly logger: Logger;
  /** The Temporal-unavailable degraded controller (driven by the supervisor — Phase 9). */
  readonly degraded: TemporalUnavailabilityController;
  /** The operational-backup service (WIRED; the periodic CRON is Phase-11). */
  readonly backupService: OperationalBackupService | undefined;
  /**
   * Connect to the Temporal dev server + register the workflows + activities via the
   * proof-spine register hook. Returns the typed bootstrap Result — a permanent
   * outage returns the DEGRADED variant (dispatch blocked, worker_down item, bounded
   * backoff), never a throw (§16). The supervisor (Phase 9) drives the reconnect loop.
   */
  connectTemporal(): Promise<Result<BootstrapReady, BootstrapDegraded>>;
  /** Gracefully close the API server + the backends (idempotent). */
  close(): Promise<void>;
  /** The reconcile-TRIGGER wiring (task 13.10/19.4) — present ONLY on the armed path (`config.reconcile === true`
   *  AND a `vaultRoot`); the shipped default omits it (byte-equivalent). `trigger` is already bound to the
   *  vault-watcher's dispatched-capture outcome below (`fs_watch` origin, task 19.4); a future post-KW-commit
   *  hook or schedule can drive the SAME `trigger.notify()` too — both would ride the SAME scheduler. */
  readonly reconcile?: ReconcileWiring;
  /** The composed connector-engine substrate (16.1) — all read adapters over an INERT transport
   *  (no real transport, no tokenRef; dormant until the Phase-23 arming). 16.2 binds poll registration off `ports`. */
  readonly connectors: ComposedConnectors;
}

// ── the health/egress query port over the persistent store ────────────────────

/**
 * A fail-closed egress status: raw Employer-Work egress OFF; zero-egress-only NOT ESTABLISHED.
 *
 * 9.22 ⚠ DIRECTION INVERTED from the pre-9.22 default. Under the old `!acknowledged` meaning, a fault
 * returning `zeroEgressOnly: true` was fail-SAFE (we didn't confirm an ack, so assume the restrictive
 * posture). Under the option-C meaning, `true` asserts the workspace is PROVABLY local-only
 * (`isZeroEgressOnlyWorkspace`) — and a store fault cannot establish that. Returning `true` here would
 * be a false assurance on exactly the surface an owner checks to confirm a revoke landed, so a fault
 * now yields `false` (NOT ESTABLISHED — never "cloud egress is possible", never "local-only").
 */
function failClosedEgress(workspaceId: string): UiSafeEgressStatus {
  return { workspaceId, employerRawEgressAcknowledged: false, zeroEgressOnly: false };
}

/**
 * 24.7 — the real `AuditPersistPort` implementation: stamps a clock-free `AuditSignal` into a durable
 * `AuditRecord` (`toAuditRecordInput`, already-tested pure mapping) carrying the caller-supplied
 * `workspaceId`, then writes it via the already-wired `AuditRepository.append`. Never throws and never
 * surfaces an append failure back to the caller — the denial guarantee (the action stays blocked) must
 * never depend on the audit write succeeding (Step 2.5 Q3). An append failure is made visible via a
 * single redaction-safe `console.error` naming the event + the store error code — deliberately NOT a
 * `HealthItem`: no existing mechanism reaches a `HealthItem` sink from this synchronous API-procedures
 * call path (the only wired minting is inside Temporal activities), and building one is out of this
 * slice's scope. Exported for direct unit testing, mirroring `createSystemHealthQueryPort` below.
 *
 * security-reviewer catch: gated on `isRedactionSafe` before persisting — `packages/policy`'s
 * `audit-signal.ts` doc comment named this EXACT consumer in advance ("if that consumer is ever wired,
 * 9.33's house rule applies: a safety gate must DENY, not throw"). Every current producer (the egress
 * veto, ING-7 admission) is redaction-safe by construction (verified by inspection + pinned by
 * `copilotDenialAudit.test.ts`'s `persisted_record_is_redaction_safe`), so this is defense-in-depth for a
 * FUTURE producer, not a fix for a live leak — a failing signal is refused (fail-closed DENY of the
 * persist attempt, matching 9.33), never persisted, and the refusal is logged carrying NOTHING derived
 * from the signal.
 *
 * ⚠ WHAT WAS WRONG HERE BEFORE `24.62`, enumerated rather than counted (a bare ordinal is
 * unfalsifiable — `audit-signal.ts`'s own house rule). TWO false claims across THREE comment blocks,
 * and THIS block carried BOTH, which is why it was the one that mattered:
 *   • claim A — *"the refusal is logged with the event name only (never the unsafe field content)"*:
 *     here (this paragraph, previously) AND on the refusal branch (*"event name only, never a field
 *     value"*). FALSE because `event` IS one of the six scanned fields — see that branch.
 *   • claim B — *"a single redaction-safe `console.error` naming the event + the store error code"*:
 *     here (above) AND on the append branch (*"event/code only"*). FALSE because that line also
 *     printed `workspaceId` — it named two of the three things it emitted.
 * ⛔ Brief `278` scoped this to the two INLINE blocks and missed this doc comment, i.e. the copy a
 * reader meets first. Recorded because fixing the reported sites and leaving the authoritative one is
 * how a corrected finding survives its own correction (`contracts L61`).
 *
 * ── task 24.62 — THIS PORT HAS TWO DATA CHANNELS AND THE GATE COVERS PART OF ONE ─────────────────
 *
 * `persistDenial(signal, workspaceId)`. ⚠ A gate named for the function it sits in reads as covering
 * the function. It does not. Counting the ungated surface exactly, because the heading "two channels"
 * would itself understate it:
 *   • `AuditSignal` has EIGHT fields; `isRedactionSafe` scans SIX (`actor`, `event`, `payloadHash`,
 *     `beforeSummary`, `afterSummary`, `refs` — `packages/policy/src/audit-signal.ts:170-177`).
 *   • UNSCANNED signal fields: `denialCode` (closed `DenialReason` union) and ⚠ `healthSignalClass`
 *     (bare `string` — so the "closed by type" counter-argument does not even apply to it; it is the
 *     weaker of the two). Neither is emitted by this port today; this is enumeration, not leakage.
 *   • `workspaceId` — the SECOND CHANNEL, a separate parameter, never scanned at all.
 *
 * The second channel's contract, stated in full because the SHORT version is itself the mistake
 * (`contracts L147`):
 *  1. **PROVENANCE** — registry-validated at both call sites, not caller-injected: `resolve` fails
 *     closed with `WORKSPACE_NOT_FOUND` on an unknown id, and the store-backed resolver additionally
 *     re-gates on read-back identity (`String(ws.id) !== workspaceId`, strict —
 *     `api/adapters/storeBackedWorkspacePosture.ts`, `createStoreBackedWorkspacePosture`). An
 *     arbitrary caller string cannot reach here. ⚠ BUT THE TWO SITES EARN THAT DIFFERENTLY, AND THE
 *     DIFFERENCE IS THE PART THAT CAN DECAY:
 *       • `runGovernedCopilotSynthesis` (`api/procedures/copilot.ts`) resolves the posture as its
 *         FIRST statement and reaches `persistDenial` ~12 lines later — a LOCAL guarantee, visible
 *         in one screen.
 *       • the agentic `synthesize` (`api/procedures/copilotAgentSynthesis.ts`,
 *         `createAgentRuntimeCopilotSynthesis`) resolves NOTHING. Its `workspaceId` is a bare
 *         parameter handed straight to `persistDenial`. ⛔ Its guarantee is INHERITED from the fact
 *         that `runGovernedCopilotSynthesis` is its ONLY production caller and validates before
 *         passing (measured 2026-08-13 by backward trace from the call site: the sole other
 *         `.synthesize(` hits in `packages/workflows` are a DIFFERENT two-argument port, and one
 *         `packages/evals` hit is a test). ⇒ **a SECOND production caller of `synthesize` that does
 *         not resolve posture first would silently void this, and nothing type-checks it.** State it
 *         as a call-path property, because that is what it is (`L141`: reachability is the path PLUS
 *         its trigger — here the trigger is "who may call `synthesize`").
 *  2. ⛔ **THAT IS A PROVENANCE GUARANTEE, NOT A SHAPE GUARANTEE.** Registry-validated proves the id
 *     EXISTS in `workspace_config`; it says nothing about what is IN it. A credential-shaped id sitting
 *     in the config still reaches the durable record below. `packages/policy`'s `visibility.ts` records
 *     the identical residual for its own sibling site.
 *  3. ⛔ **AND THE PROVENANCE ARGUMENT IS CIRCULAR TO THE EXTENT THE CALLER CAN INFLUENCE THE SOURCE** —
 *     it is exactly as strong as WHO MAY WRITE A `workspace_config` ROW. ⭐ **THAT WAS "UNTRACED" WHEN
 *     THIS COMMENT WAS WRITTEN; IT IS NOW TRACED (`#52`, 2026-08-14) AND THE CIRCULARITY IS CONFIRMED.**
 *     `WorkspaceConfigRepository` is the SOLE write gateway (verified at the schema symbol, not by
 *     method name: every production write is inside the two `@sow/db` adapters), and its create path IS
 *     caller-reachable — the `onboarding.createWorkspace` tRPC MUTATION reaches `insertIfAbsent` via
 *     `provisionWorkspace`. ⛔ **`parseCreateWorkspace` admits ANY NON-EMPTY STRING as the id: there is
 *     NO shape validation at the write boundary.**
 *     ⛔⛔ **ERRATUM (2026-08-24/25, PKG-W1) — THIS SENTENCE IS NOW FALSE; SEE THE DATED CORRECTION
 *     BELOW THE `24.83` MEASUREMENT PARAGRAPH.** Task `24.84` landed `WorkspaceIdSchema.safeParse` at
 *     `apps/worker/src/api/procedures/onboarding.ts`'s `parseCreateWorkspace` — the write boundary now
 *     DOES shape-validate. Retained (not deleted) per the erratum discipline; the reasoning that
 *     follows in this paragraph about the CONSEQUENCE of an unvalidated write boundary is history, not
 *     current state.
 *     ⇒ *"registry-validated"* means **"someone inserted
 *     it"**, NOT **"an authority vouched for its shape"** — so a credential-shaped id can be made
 *     registry-valid BY CONSTRUCTION and will pass every gate above on its way into the durable record.
 *     ⚠ **THE OWNER RULING OF 2026-08-14 DOES NOT CLOSE THIS.** That ruling is about the CALLER
 *     (single-owner is correct by design — see `api/auth/sessionAuth.ts`); this residual is about the
 *     STRING, and the two are independent. Rule-7 remedy — shape-validate at the write boundary or at
 *     the audit boundary — is an open MEASUREMENT, deliberately not pre-judged here.
 *     ⭐ **What DOES hold, so this is not read as worse than it is:** `insertIfAbsent` never overwrites
 *     (an existing workspace cannot be hijacked), and `updateProvisioningFields` cannot express a
 *     posture write AT ALL — `ProvisioningOwnedFields` is `{name, markdownRepoPath, gbrainBrainId}`, so
 *     the type makes it unrepresentable. **`#51`** was the rule-4 sibling and is ruled.
 *
 * ⇒ the DURABLE RECORD keeps the raw id notwithstanding (2)/(3) — attribution is the record's whole
 * purpose and `workspaceId` is its WS-8 query key, so scrubbing there would destroy the artifact to
 * protect the sink. The LOG SINK does not carry it: safety rule 7 names log sinks specifically, and the
 * two objects have different jobs.
 *
 * ⛔⛔ CORRECTION (`### 24.83`, 2026-08-14) — THE SENTENCE THAT USED TO END THIS PARAGRAPH IS RETRACTED,
 * AND IT WAS MINE. It read: *"Do NOT harden this by shape-checking the id before logging — the residual
 * class (an employer project codename, a person's name used as an id) is NOT credential-shaped, so such
 * a check would read as coverage of a class it cannot cover."* ⚠ **The reasoning held only while the
 * only conceivable id was an owner-typed codename.** `#52` traced the write path: `parseCreateWorkspace`
 * admits **ANY NON-EMPTY STRING**, so a **credential-shaped id IS in the admissible class** — and a
 * shape check would cover exactly it. **I argued against the remedy the measurement then selected.**
 *
 * ⭐ WHAT THE MEASUREMENT SAYS (`24.83`) — "shape-check" is not one place, and there are THREE, not two.
 * **17 frozen contract models carry `workspaceId`**, which is what decides between them:
 *   • **AUDIT boundary (`persistDenial`) — 1 of 17. REJECTED on coverage.** The id also reaches the
 *     RENDERER via `UiSafeEgressStatus.workspaceId` (`api/procedures/systemHealth.ts`), and safety rule 7
 *     names the renderer explicitly alongside logs — so an audit-only check leaves a rule-7 sink
 *     uncovered **by the rule's own text**, not by anyone's judgement.
 *   • **WRITE boundary (`parseCreateWorkspace`) — the WORKER-SIDE remedy, and a CALL-SITE check.** It is
 *     the sole id-introducing gate *today*: `provisionWorkspace` is its only caller-reachable consumer,
 *     and `provisionDevWorkspace` is handed `{readModels, vault, now}` — the repo dep is not passed, so
 *     it is incapable **by construction**. ⚠ But a call site is bypassable by a FUTURE second create
 *     path; it is not complete-by-construction. ⛔ **And the sharper finding: this parser uses
 *     `isNonEmptyString` and returns `r["id"]` RAW — it never runs `WorkspaceIdSchema` at all.** So the
 *     worker-side work is *stop bypassing the validator that already exists*, not *add a second rule*.
 *     ⛔⛔ **ERRATUM (2026-08-24/25, PKG-W1) — THE WORKER-SIDE WORK NAMED ABOVE IS NOW DONE.** Task
 *     `24.84` closed this leg: `parseCreateWorkspace` (`apps/worker/src/api/procedures/onboarding.ts`)
 *     now calls `WorkspaceIdSchema.safeParse(rawId)` and returns `parsedId.data` (the VALIDATED value,
 *     never the raw re-read `r["id"]`) — verified by reading the current source, not inferred. The
 *     preceding sentence ("this parser uses `isNonEmptyString` and returns `r["id"]` RAW — it never
 *     runs `WorkspaceIdSchema` at all") is retained per the erratum discipline (it was TRUE when
 *     written and is the reasoning that MOTIVATED the fix) but is no longer a description of the
 *     current write boundary. The WRITE-boundary item above is therefore no longer "1 of 17 REJECTED
 *     on coverage" for shape — it is validated at the write site; the AUDIT-boundary (`persistDenial`)
 *     and RENDERER (`UiSafeEgressStatus.workspaceId`) sinks this whole `24.62`/`24.83` block opened
 *     remain open questions, UNCHANGED by this correction (this erratum is scoped to the WRITE
 *     boundary claim only, not a re-audit of the other two boundaries above).
 *   • ⭐⭐ **TYPE boundary (`WorkspaceIdSchema`) — THE CLASS FIX.** It is `brandedIdSchema<WorkspaceId>()`
 *     — `.min(1)` + non-blank, no workspace-specific shape — and **15 of the 17 models validate through
 *     it**. One site, complete-by-construction, inherited by models not yet written. ⛔ NOT worker
 *     territory: it needs its OWN schema rather than a tightened shared factory (which would silently
 *     re-shape `AgentJobId`, `ActionId`, every brand) ⇒ a FROZEN-CONTRACT change, filed separately.
 *
 * ⛔ AND THE DEFINITION QUESTION HAS A THIRD DOOR — do NOT try to define "credential-shaped". We cannot
 * detect a credential reliably: `isRedactionSafe`'s own doc concedes a codename or a person's name
 * passes it, and a denylist here is `worker L73`'s structurally-unwinnable shape. ⭐ **Invert it: do not
 * ask "is this a credential?", ask "is this a well-formed workspace id?"** A bounded positive slug
 * charset makes every credential shape **UNREPRESENTABLE rather than DETECTED** — `L73`'s inversion on a
 * new surface. ⭐ Measured against `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`: all **3 live production ids**
 * (`employer-work`, `personal-business`, `personal-life`) ACCEPT, and it rejects `sk-`/`AKIA`/`ghp_`/PEM/
 * JWT/whitespace/uppercase shapes — **plus `ws/../etc`, so it incidentally closes path-traversal ids,
 * which matters because this id builds vault paths (`24.26`).**
 * ⚠ NOT free: **5 worker TEST fixtures would be rejected** (`MARKERWORKSPACE`, `ws_employer`, `ws-A`,
 * `ws-B`, `ws-OTHER`) — migration work that belongs in the validator's own slice, not a surprise at
 * implementation time.
 * ⚠ **NEITHER boundary closes PRE-EXISTING rows** (a read-time concern, separate remedy), and **2 of the
 * 17 models do not reference the brand** — unidentified, and deliberately not asserted as covered.
 */
export function createAuditPersistPort(deps: {
  readonly audit: AuditRepository;
  readonly now: () => string;
}): AuditPersistPort {
  return {
    persistDenial: async (signal, workspaceId): Promise<void> => {
      // ⛔⛔ CLOSED (DOD-worker-boot task 1, 2026-08-25) — THE SECOND CHANNEL IS GATED. `workspaceId`
      // rides `looksLikeCredentialShape` (`@sow/domain`) — the IDENTIFIER-granularity predicate: the
      // credential-SHAPE nets only, `SENSITIVE_KEYWORD` deliberately excluded.
      //
      // ⛔ CORRECTED (task 24.130 deposit 2, the WORKER-SINK half). This used to ride
      // `auditFieldContainsSecret` (`@sow/knowledge`), which runs the full keyword-inclusive net. A
      // `workspaceId` is a HUMAN-CHOSEN NAME, not a machine-generated audit ref, so under that
      // predicate a person who names their workspace `acme-credential-review` LOSES THE AUDIT ROW —
      // refused by the WORD, with no credential in it anywhere. That is a rule-1-adjacent availability
      // cost paid on a rule-7 gate, and it bought nothing: the shape nets still catch a real key.
      // The knowledge-side sibling `persistDenialAudit` was corrected identically at `c0909f98`
      // (`packages/knowledge/src/gcl/projection.ts:130`), so the two implementations still AGREE — the
      // agreement just moved to the predicate that fits the field. This
      // does NOT close the "AUDIT boundary — 1 of 17, REJECTED on coverage" measurement above in full: it
      // closes the SHAPE gap at THIS sink specifically (never persist a credential-shaped id), which is
      // independent of the WRITE-boundary / TYPE-boundary remedies discussed above (those constrain what a
      // workspaceId CAN be at its point of origin; this constrains what reaches THIS log/persist sink).
      if (!isRedactionSafe(signal) || looksLikeCredentialShape(workspaceId)) {
        // eslint-disable-next-line no-console -- deliberate visibility; 9.33's house rule — DENY the
        // persist, never throw. ⛔ THE NOTICE CARRIES NOTHING DERIVED FROM THE SIGNAL, AND THAT IS THE
        // SAFETY PROPERTY, NOT AN OVERSIGHT (task 24.62). A refusal means at least one of the six
        // scanned fields is unsafe and this handler CANNOT KNOW WHICH — so ANY signal-derived value
        // could be exactly the one the gate refused.
        // ⚠ That includes `event`, which this line used to interpolate under the reasoning "event name
        // only, never a field value". `event` IS one of the six fields `isRedactionSafe` scans, so on
        // THIS path it is a field value of unknown safety — the comment's conclusion happened to hold
        // (every reachable producer passes a literal) while its REASONING was wrong, which is the more
        // dangerous failure: the next producer inherits the reasoning, not the audit.
        // ⚠ And not `denialCode` either — "closed by type" is a compile-time claim about
        // runtime-untrusted data, a provenance argument in a type-system costume (`contracts L147`).
        // Same doctrine `packages/knowledge`'s `GclAuditPersistPort.onRefused` (24.53) discharges by
        // SIGNATURE; here the obligation is held by convention + the pins in `copilotDenialAudit.test.ts`.
        // ⇒ the notice is a COUNTER, not a describer — that the refusal is EMITTABLE AT ALL is its whole
        // function (24.53's "a notice that carries nothing" cost, accepted knowingly). ⚠ The cost WAS
        // real and priced: two concurrent denials on the two Copilot paths were indistinguishable here.
        // ⛔⛔ DONE (task 24.70, shared-task-list `#59`) — the follow-up the next two lines used to name
        // as open is now built. Field NAMES are a closed six-literal set, not content, so naming one is
        // safe: `packages/policy/src/audit-signal-field.ts`'s `firstUnsafeAuditField` recovers WHICH of
        // the six scanned fields tripped by PROBING the exported `isRedactionSafe` (never re-implementing
        // its module-private `looksUnsafe` union — see that sibling file's own header), and structurally
        // never returns anything but one of the six literals or `null`. The two lines below are RETAINED
        // (not deleted) as the reasoning that motivated the fix, per this codebase's erratum discipline —
        // they describe the notice's state BEFORE this task, not its current shape.
        // The follow-up that would fix it is SMALL, not a rewrite — naming WHICH field was unsafe is
        // safe (field NAMES are a closed six-literal set, not content) and is ~5 lines in
        // `packages/policy`'s `audit-signal.ts`, whose `isRedactionSafe` returns a bare boolean today.
        // ⚠ The pins for everything above live in `copilotDenialAudit.test.ts`'s `24.62` block, and
        // each NEGATIVE assertion there was mutation-proved to RED before this comment was written
        // (event · denialCode · workspaceId, three separate mutations) — an unobserved pin is unproven.
        // The 24.70 field-NAME POSITIVE assertion added to that same block was mutation-proved RED the
        // same way before this line started interpolating it.
        // `looksLikeCredentialShape(workspaceId)` is checked FIRST so the field name reported is honest
        // when workspaceId is the one that tripped: `firstUnsafeAuditField` only ever inspects `signal`'s
        // six fields and would report "unknown" for a signal that itself passed. "workspaceId" here is a
        // fixed literal (a channel NAME, not the value — same rule-7 discipline task 24.70 established for
        // the six signal fields), so naming it leaks nothing.
        const unsafeField = looksLikeCredentialShape(workspaceId) ? "workspaceId" : firstUnsafeAuditField(signal);
        console.error(
          `[copilot.denial-audit] REFUSED to persist — a denial signal failed the redaction-safety gate (9.33) — unsafe field: ${unsafeField ?? "unknown"}`,
        );
        return;
      }
      const record = { ...toAuditRecordInput(signal, deps.now()), workspaceId };
      const appended = await deps.audit.append(record);
      if (isErr(appended)) {
        // eslint-disable-next-line no-console -- deliberate, redaction-safe (event + store code ONLY)
        // visibility; see the doc comment above for why this is a log line and not a HealthItem.
        // `event` is emitted HERE and deliberately NOT on the refusal path above. ⛔ THE REASON IS
        // *NOT* "the gate passed, so the fields are clean" — that inference is FALSE and
        // `packages/policy` has already retracted it in full (`audit-signal.ts`, the `isRedactionSafe`
        // doc, task 24.45): it is a **credential-shape HEURISTIC, not a shape allowlist**, so anything
        // matching none of the three patterns passes — "an employer project codename, a person's name,
        // or an internal identifier" included. Gate-passed means ONLY "did not look like a leaked
        // secret", and safety rule 7 covers raw content too, which the heuristic cannot see.
        // ⇒ the real, checkable reason `event` is safe here: it is a STRING LITERAL at every reachable
        // producer — `packages/policy/src/egress.ts` (`egress.denied`), `packages/policy/src/admission.ts`
        // (`job.admission.rejected`), `packages/providers/src/broker/egress-veto.ts`
        // (`egress.veto.route_substituted`). ⚠ THAT IS A CALL-PATH PROPERTY, NOT A TYPE ONE: a future
        // producer interpolating data into `event` would void it, and the heuristic would NOT catch it.
        // Re-derive by backward trace from this line before adding a producer (`L141`).
        // ⛔ `workspaceId` is deliberately ABSENT — it is the UNSCANNED second channel (see "TWO DATA
        // CHANNELS" above). Until task 24.62 this line printed it while this very comment claimed
        // "event/code only"; the comment named two of the three things it emitted.
        console.error(
          `[copilot.denial-audit] AuditRepository.append failed — event="${signal.event}" code="${appended.error.code}"`,
        );
      }
    },
  };
}

/**
 * Build the System-Health query port over the persistent health store. `healthItems`
 * reads the durable @sow/db `health_items` table (via the backends' persistent
 * `HealthItemStore`); a store fault folds to a typed `degraded_unavailable` err
 * (never a throw, §16). `egressStatus` reads the DURABLE per-workspace state and derives
 * `zeroEgressOnly` via {@link isZeroEgressOnlyWorkspace} (§5 option C: routing pins local
 * AND no egress destination is approved) — never from `employerRawEgressAcknowledged`,
 * which is consent, not routing. FAIL-CLOSES to `false` (raw egress OFF, zero-egress
 * NOT ESTABLISHED) on absence OR any store fault — a fault can never PROVE local-only.
 */
export function createSystemHealthQueryPort(backends: ProofSpineBackends): SystemHealthQueryPort {
  // Task 9.38 — the System-Health surface a corrupt stored row mints INTO, over the SAME
  // persistent store the degraded controller's surface binds (backends.healthItems) so a
  // corruption item survives a restart same as any other. Constructed once; `egressStatus`
  // mints on its own corrupt branch below — there is no second, deferred mint path.
  const corruptionSurface: HealthSurface = createHealthSurface(
    createPersistentHealthSurfaceStore(backends.healthItems),
  );
  return {
    async healthItems(): Promise<Result<readonly HealthItem[], FailureVariant>> {
      try {
        const items = await backends.healthItems.list();
        return { ok: true, value: items };
      } catch {
        // Redaction-safe typed degrade — the store fault cause never crosses.
        return {
          ok: false,
          error: {
            kind: "degraded_unavailable",
            message: "health store unavailable",
            retryable: true,
          },
        };
      }
    },
    async egressStatus(wsId: string): Promise<Result<UiSafeEgressStatus, FailureVariant>> {
      // Read the DURABLE per-workspace egress posture (task 9.10-A). Absence OR any store
      // fault ⇒ the FAIL-CLOSED safe default (raw egress OFF, zero-egress NOT ESTABLISHED).
      try {
        const got = await backends.repos.workspaceConfig.get(wsId as WorkspaceId);
        if (!isOk(got)) {
          // Task 9.38 — a stored_row_schema_violation is a DISTINCT, code-only System-Health
          // item (never a change to the fail-closed return below): the operator can now see
          // the corruption. `not_found` (absence) and a thrown/transient outage (the catch
          // below) mint NOTHING, so they stay distinguishable from a genuine corruption. The
          // mint is keyed-upsert on (failureClass, subjectRef) — a recurring poll of the same
          // corrupt row bumps the existing item, never appends. Code-only (safety rule 7): the
          // message is a static string; the raw ZodError in `got.error.cause` is never touched.
          if (got.error.code === "stored_row_schema_violation") {
            // Best-effort, deliberately unchecked (mirrors the L53 credential-unavailable mint):
            // this whole branch sits inside egressStatus's outer try, so even a `record` fault
            // still falls through to the SAME failClosedEgress return below — threading its
            // Result into the response would risk exactly the fail-closed-unchanged violation
            // this slice exists to prevent. Do not "fix" this by checking the Result.
            await corruptionSurface.record({
              failureClass: "schema_rejection",
              subjectRef: `${wsId}:stored_row_schema_violation`,
              message: "workspace config stored row failed re-validation (stored_row_schema_violation)",
              auditRef: WORKSPACE_CONFIG_CORRUPTION_AUDIT_REF,
              now: backends.now(),
            });
          }
          return { ok: true, value: failClosedEgress(wsId) };
        }
        const acknowledged = got.value.egressPolicy.employerRawEgressAcknowledged;
        // 9.22 — DERIVED from the option-C predicate over the full workspace already read above, never
        // from `!acknowledged` (consent is not routing; conflating the two was the original defect).
        return {
          ok: true,
          value: {
            workspaceId: wsId,
            employerRawEgressAcknowledged: acknowledged,
            zeroEgressOnly: isZeroEgressOnlyWorkspace(got.value),
          },
        };
      } catch {
        return { ok: true, value: failClosedEgress(wsId) };
      }
    },
  };
}

// ── the live boot ──────────────────────────────────────────────────────────────

/** The audit ref anchoring the degraded controller's worker_down health items. */
const BOOT_AUDIT_REF: AuditId = auditId("worker-boot:temporal-degraded");
// §13 task 11.3-b — a dedicated audit subject for the GBrain version-pin startup verify degrades
// (distinct from the temporal-degraded subject so audit-by-subject stays precise).
const GBRAIN_VERIFY_AUDIT_REF: AuditId = auditId("worker-boot:gbrain-version-pin");
// Task 9.38 — a dedicated audit subject for a stored workspace-config row failing re-validation
// at the 9.36 read-boundary gate (distinct subject so audit-by-subject stays precise).
const WORKSPACE_CONFIG_CORRUPTION_AUDIT_REF: AuditId = auditId("worker-boot:workspace-config-corruption");

/**
 * §13.10d go-live flag-gating for the read-only VAULT page-read deps. Build them (via `buildDeps`, which
 * receives the narrowed `vaultRoot`) IFF the flag is on AND a `vaultRoot` is configured AND workspace-scoping
 * is active (`scopingActive` = `wsScope !== undefined` — the vault handler needs a per-ask WS-8 scope); any
 * missing precondition ⇒ `undefined` (fail-safe — no vault MCP server wired, the capability is inert). Pure;
 * `buildDeps` is invoked ONLY on the gated-on path, so the fs execs are constructed only when the tool is live.
 * Exported for the boot-gating unit test (`test/boot-copilot-read-gating.test.ts`); it has no other consumer.
 */
export function gateCopilotVaultReadDeps<T>(
  gate: { readonly copilotVaultRead?: boolean; readonly vaultRoot?: string },
  scopingActive: boolean,
  buildDeps: (vaultRoot: string) => T,
  vaultUsable: (root: string) => boolean,
): T | undefined {
  // The 3 flag/config preconditions gate FIRST — so the shipped default (flag off) never touches the fs.
  if (gate.copilotVaultRead !== true || gate.vaultRoot === undefined || !scopingActive) {
    return undefined;
  }
  // §13.10d — offer the read-only tool ONLY when the vault actually has readable content, so the default empty
  // `<userData>/vault` isn't handed an inert tool that can only return SAFE_EMPTY. FAIL-SAFE: a throwing/indeterminate
  // predicate ⇒ inert (never offer a tool we can't confirm is usable). `buildDeps` is invoked ONLY when usable.
  let usable: boolean;
  try {
    usable = vaultUsable(gate.vaultRoot);
  } catch {
    return undefined;
  }
  return usable ? buildDeps(gate.vaultRoot) : undefined;
}

/**
 * §13.10d — the fs usability predicate for {@link gateCopilotVaultReadDeps}: `(root) => boolean`, true IFF `root`
 * exists AND contains ≥1 `.md` FILE, enumerated RECURSIVELY. Mirrors `createCommittedVaultReader`'s reader filter
 * EXACTLY — `e.isFile() && name.endsWith(".md")` (case-sensitive) — so it is true precisely when the reader would
 * find a page to serve: a `.md` nested in subfolders counts, but a DIRECTORY named `notes.md/` does NOT (the reader
 * enumerates zero pages there). Any fault (missing dir / read error / permission) ⇒ `false` (fail-safe — never
 * offer the tool when usability can't be confirmed). Evaluated ONCE at boot: a vault populated AFTER boot needs a
 * restart (matches the gate + auto-ingest model — the owner points at a populated vault, then launches). Pure over
 * `node:fs`; the `.some(...)` short-circuits on the first matching file.
 */
export function createFsVaultUsable(): (root: string) => boolean {
  return (root: string): boolean => {
    try {
      return readdirSync(root, { recursive: true, withFileTypes: true }).some(
        (entry) => entry.isFile() && String(entry.name).endsWith(".md"),
      );
    } catch {
      return false; // missing dir / read error / permission ⇒ fail-safe inert
    }
  };
}

/**
 * 13.8d arming gate for the LIVING-VAULT rewrite (§6 KN-10). Build the wiring (via `buildWiring`, which
 * receives the narrowed `vaultRoot`) IFF the owner opt-in is strictly `true` AND a `vaultRoot` is
 * configured; any missing precondition ⇒ `undefined` (fail-safe — `SourceIngestionDeps.livingVault` stays
 * unbound and source ingestion is byte-equivalent to pre-13.8d).
 *
 * STRICT `=== true`, not truthiness (worker L28 / knowledge L2): this flag reaches the worker through
 * config that is ultimately env/IPC-derived, where `"true"`, `"false"`, and `1` are ALL truthy — and the
 * capability it arms MUTATES the vault beyond the ingested note. A truthy-non-`true` value silently
 * arming that is the exact false-green vector those lessons exist to close.
 *
 * `buildWiring` is a THUNK invoked ONLY on the armed path (worker L2/L16), so the OFF path constructs
 * nothing — no adapter, no knowledge deps, no fs handles. Exported for the boot-gating unit test
 * (`test/boot-living-vault-gating.test.ts`); it has no other consumer.
 */
export function gateLivingVaultRewrite<T>(
  gate: { readonly livingVaultRewrite?: boolean; readonly vaultRoot?: string },
  buildWiring: (vaultRoot: string) => T,
): T | undefined {
  // The vaultRoot half is checked as strictly as the flag: `""` would make the containment check
  // `resolve("")` to the worker's CWD and then cheerfully report every path as "contained", and a
  // null/non-string (plausible from JSON/IPC-derived config) would throw at `resolve`. Neither may arm.
  if (gate.livingVaultRewrite !== true) return undefined;
  if (typeof gate.vaultRoot !== "string" || gate.vaultRoot.length === 0) return undefined;
  return buildWiring(gate.vaultRoot);
}

// ── task 13.23 leg B/C — the entity-ref signal-count health sink ──────────────────────────────────────

/** Injected deps for {@link createEntityRefSignalsHealthSink} — mirrors `ReconcileHealthDeps`'s shape. */
export interface EntityRefSignalsHealthDeps {
  readonly recordFailure: (failure: HealthFailure) => Promise<unknown>;
  readonly now: () => string;
  readonly newAuditId: () => string;
}

/** A SAFE entity-ref-signals health message — the workspace id + the three counts only; safety rule 7
 *  (no raw content, no path, no entity name — just the closed-enum `WithheldReason` keys + counts). */
function entityRefSignalsHealthMessage(health: SignalCountsHealth): string {
  const withheldParts = Object.entries(health.withheldByReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  return (
    `arch_gap:entity-ref-signals — living-vault synthesis withheld entity references for workspace ` +
    `'${health.workspaceId}' (truncated=${health.truncated}, rejected=${health.rejected}` +
    (withheldParts.length > 0 ? `, withheld={${withheldParts}})` : ")")
  );
}

/**
 * Task 13.23 leg B/C — the `LivingVaultAdapterDeps.recordEntityRefSignals` sink: reproject the CA-2
 * entity-ref signal counts (truncated/rejected/withheldByReason) into a `HealthFailure` and route it
 * through the injected `recordFailure` (boot.ts binds this to `HealthSurface.record` — mint/dedupe/
 * audit-link, never a raw store put). No existing `FailureClass` member names "entity-ref signals
 * withheld during synthesis"; `schema_rejection` is the least-wrong member (Lesson 18) — the counts ARE
 * a form of candidate-data rejection/truncation at the synthesis boundary — carrying a greppable
 * `arch_gap:entity-ref-signals` token in the message so this is never mistaken for a genuine
 * schema-rejection producer. `emitEntityRefSignals` (living-vault.ts) already gates the ZERO case (fires
 * only when at least one count is non-zero/non-empty) AND already best-effort-wraps the sink call (never
 * escapes as an unhandled rejection) — this sink itself stays UNWRAPPED and lets a genuine
 * `recordFailure` fault propagate to that existing wrapper, rather than double-swallowing it.
 */
export function createEntityRefSignalsHealthSink(
  deps: EntityRefSignalsHealthDeps,
): (health: SignalCountsHealth) => Promise<unknown> {
  return (health: SignalCountsHealth): Promise<unknown> =>
    deps.recordFailure({
      failureClass: "schema_rejection",
      subjectRef: `entity-ref-signals:${health.workspaceId}`,
      message: entityRefSignalsHealthMessage(health),
      auditRef: deps.newAuditId() as AuditId,
      now: deps.now(),
    });
}

/**
 * task ARM-RESEARCH-3 — the `bootWorker` call site {@link gateLivingVaultRewrite} never had. Attaches
 * a REAL `SourceLivingVaultPort` onto `ProofSpineParams.livingVault` IFF `gateLivingVaultRewrite`'s two
 * preconditions (strict `livingVaultRewrite === true` + a configured `vaultRoot`) pass AND the owner
 * has provisioned the `livingVaultProviders` bundle — a THIRD independent OFF-lock the pure gate
 * itself has no slot for (its `buildWiring` thunk degrades to `undefined` when providers are absent,
 * rather than widening the gate's own signature). Mirrors `withGbrainSyncOutbox`'s shape: `undefined`
 * `proofSpineParams` (nothing to attach to) passes through unchanged; the OFF path (any of the three
 * locks missing) leaves `proofSpineParams.livingVault` UNSET — `createLivingVaultActivity(undefined)`
 * (buildActivities.ts) then yields an empty plan set, byte-equivalent to today. Never throws (§16):
 * `buildIngestRewriteDeps`/`createIngestRewriteAdapter`/`createLivingVaultPort` are pure constructors,
 * not I/O.
 *
 * `recordEntityRefSignals` (task 13.23 leg B, OPTIONAL — 4th param, backward-compatible with every
 * existing 3-arg call, including `test/boot-living-vault-gating.test.ts`'s) threads
 * `createLivingVaultPort`'s CA-2 entity-ref signal-count sink through to the ON path only —
 * `LivingVaultAdapterDeps.recordEntityRefSignals` had nothing constructing it in production (living-
 * vault.ts's own doc comment). Absent (the default) ⇒ `createLivingVaultPort` gets no sink, byte-
 * equivalent to pre-13.23-bind. Threading it here (not widening `gateLivingVaultRewrite`'s own
 * signature) mirrors how `providers` above is already a `withLivingVaultRewrite`-only concern.
 */
export function withLivingVaultRewrite(
  proofSpineParams: ProofSpineParams | undefined,
  gate: { readonly livingVaultRewrite?: boolean; readonly vaultRoot?: string },
  providers: { readonly gbrain: EntityGbrainReadPort; readonly reason: SynthesisReasonPort } | undefined,
  recordEntityRefSignals?: (health: SignalCountsHealth) => Promise<unknown>,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined) return proofSpineParams;
  const livingVault = gateLivingVaultRewrite(gate, (vaultRoot) => {
    // The THIRD OFF-lock — providers absent (the shipped default) ⇒ no adapter, even though the flag
    // + vaultRoot both passed to reach this thunk at all.
    if (providers === undefined) return undefined;
    return createLivingVaultPort({
      vaultRoot,
      rewrite: createIngestRewriteAdapter(
        buildIngestRewriteDeps({ gbrain: providers.gbrain, reason: providers.reason, vaultRoot }),
      ),
      // 13.23 leg B — conditional spread (key ABSENT when unset, never `undefined`-valued) so an
      // omitted sink stays byte-identical to pre-13.23-bind (mirrors this file's own established
      // convention for every other optional dep, e.g. `stubExtraction` at L57/L1204).
      ...(recordEntityRefSignals !== undefined ? { recordEntityRefSignals } : {}),
    });
  });
  if (livingVault === undefined) return proofSpineParams;
  return { ...proofSpineParams, livingVault };
}

/**
 * 13.8f-B arming gate for the MEETING-path living-vault rewrite (§6 KN-10) — the meeting analog of
 * {@link gateLivingVaultRewrite} (13.8d), same shape. Build the wiring (via `buildWiring`) IFF the owner
 * opt-in is strictly `true`; any missing precondition ⇒ `undefined` (fail-safe —
 * `BuildOutputsActivityDeps.meetingVaultRewrite` stays unbound and the meeting closeout is
 * byte-equivalent to pre-13.8f-B). No second precondition (unlike `gateLivingVaultRewrite`'s
 * `vaultRoot`): the meeting adapter performs no realpath containment — see
 * apps/worker/src/composition/meeting-vault.ts's own header for why that's not a gap this slice opens.
 *
 * STRICT `=== true`, not truthiness (worker L28 / knowledge L2) — same reasoning as
 * `gateLivingVaultRewrite`: this flag reaches the worker through env/IPC-derived config where
 * `"true"`/`"false"`/`1` are all truthy, and the capability it arms mutates the vault.
 *
 * `buildWiring` is a THUNK invoked ONLY on the armed path (worker L2/L16), so the OFF path constructs
 * nothing — no adapter, no knowledge deps. Exported for the boot-gating unit test
 * (`test/boot-meeting-vault-gating.test.ts`); it has no other consumer — there is NO `bootWorker` call
 * site yet (nothing constructs the real `MeetingRewriteDeps`), so this gate is dormant by ABSENCE as
 * well as by flag, exactly like `gateLivingVaultRewrite` today.
 */
export function gateMeetingVaultRewrite<T>(
  gate: { readonly meetingVaultRewrite?: boolean },
  buildWiring: () => T,
): T | undefined {
  if (gate.meetingVaultRewrite !== true) return undefined;
  return buildWiring();
}

/**
 * §13.10d go-live flag-gating for the read-only SKILL self-introspection dep. Build it (via `buildDeps`) IFF
 * the flag is on AND workspace-scoping is active; else `undefined` (fail-safe). Needs no vaultRoot/reader (the
 * handler reads the STATIC catalog). Pure; `buildDeps` is invoked ONLY on the gated-on path.
 * Exported for the boot-gating unit test (`test/boot-copilot-read-gating.test.ts`); it has no other consumer.
 */
export function gateCopilotSkillIntrospectionDeps<T>(
  gate: { readonly copilotSkillIntrospection?: boolean },
  scopingActive: boolean,
  buildDeps: () => T,
): T | undefined {
  return gate.copilotSkillIntrospection === true && scopingActive ? buildDeps() : undefined;
}

// ── OPEN-THE-GATES slice 1 (task 11.1) — owner-opt-in auto-ingest boot gating ────────────────────────
// A pure, fail-safe gate (mirror of gateCopilotVaultReadDeps) that activates the built §11.8 vault→ingestion
// loop ONLY when the owner opt-in is ON AND a vaultRoot is present. Default OFF ⇒ today's exact degraded boot.

/** The ingest workspace ingestion binds to when the owner doesn't override it — the CANONICAL personal-business
 *  id the rest of the system provisions (gbrain default + the well-known Copilot scopes), NOT an ad-hoc string. */
export const DEFAULT_INGEST_WORKSPACE: string = DEFAULT_GBRAIN_COPILOT_WORKSPACE;

/** The owner opt-in fields (resolved from env in main/index.ts, threaded via WorkerHostConfig + IPC). */
export interface AutoIngestGateOpts {
  readonly autoIngest?: boolean;
  readonly ingestWorkspaceId?: string;
  readonly ingestSensitivity?: string;
  readonly temporalAddress?: string;
  /**
   * 18.31 — the egress-processor allowlist for the auto-ingest proof-spine `EgressPolicy` (both
   * `allowedProcessors` AND `rawContentAllowedProcessors`, since source ingestion carries raw content, §5). Plain
   * IPC-safe `string[]` (branded to `ProcessorId` worker-side in `buildAutoIngestProofSpineParams`); the desktop
   * forward (18.32) passes `WorkerHostConfig.egressAllowedProcessors` straight through. DEFAULT-ABSENT/empty ⇒ the
   * proof-spine egress policy stays fail-closed empty (byte-equivalent to today) — an armed subscription cloud
   * `{runtime}` route is denied `PROCESSOR_NOT_ALLOWED` until this allowlists its processor. Independent OFF-lock
   * from `subscriptionArm`/`providerTransport` (Lessons 8/27/52): supplying it arms nothing on its own.
   */
  readonly egressAllowedProcessors?: readonly string[];
}

/** The wiring gateAutoIngest augments the bootWorker call with when the opt-in is ON — every field is an
 *  existing BootConfig field, so the worker-host wires them with one spread. */
export interface AutoIngestWiring {
  readonly vaultWatch: { readonly workspaceId: string; readonly sensitivity: string };
  readonly proofSpineParams: ProofSpineParams;
  readonly temporalAddress: string;
  /**
   * CP-3b/18.13b (#13 precondition) — the SOURCE stub seam. The broker's stub provider-runner output the ARMED
   * auto-ingest SOURCE run emits. `stubExtraction` shares its name with the BootConfig field, so the worker-host's
   * existing wiring spread (`...(gateAutoIngest(...) ?? {})`) forwards it STRUCTURALLY when present →
   * `config.stubExtraction` → `assembleBackends` + `makeProofSpineRegisterHook`. OPTIONAL + OMITTED by default: with
   * no stub the `assembleBackends` `{ candidateOutput: {} }` default keeps the source FAIL-CLOSED at the schema gate
   * (byte-equivalent to the shipped default — pinned by `.toStrictEqual` + an `in`-check). A valid stub is PASSED
   * (the optional 4th arg of `gateAutoIngest`) only at ARMING (bundle #4, desktop host); the
   * `outputSchemaId → sow:agent-extraction` switch that makes it normalize to an `agent_extraction` candidate (not
   * the KMP stand-in ⇒ EMPTY ⇒ reject) is arming-bundle scope, NOT this slice.
   */
  readonly stubExtraction?: StubMeetingExtraction;
}

/**
 * Build the auto-ingest wiring IFF the owner opt-in is ON AND a `vaultRoot` is present; any missing
 * precondition ⇒ `undefined` (fail-safe — the shipped default stays byte-equivalent to today's degraded boot:
 * no watcher, no Temporal worker). Pure; `buildProofSpineParams` is a thunk invoked ONLY on the gated-on path,
 * so the ProofSpineParams (+ its in-memory revisions store) are NEVER constructed on the OFF path.
 */
export function gateAutoIngest(
  opts: AutoIngestGateOpts,
  vaultRoot: string | undefined,
  buildProofSpineParams: (workspaceId: string, egressAllowedProcessors?: readonly string[]) => ProofSpineParams,
  stubExtraction?: StubMeetingExtraction,
): AutoIngestWiring | undefined {
  if (opts.autoIngest !== true || vaultRoot === undefined) return undefined;
  const ingestWorkspaceId = opts.ingestWorkspaceId ?? DEFAULT_INGEST_WORKSPACE;
  const sensitivity = opts.ingestSensitivity ?? "normal";
  return {
    vaultWatch: { workspaceId: ingestWorkspaceId, sensitivity },
    // 18.31 — thread the egress allowlist into the proof-spine builder ONLY when a non-empty list is provided (a
    // conditional pass mirroring the `stubExtraction` conditional-spread, L57): the default/OFF-of-the-seam path
    // calls the thunk with a SINGLE arg — byte-identical to the pre-seam call — while a populated allowlist bakes
    // the processor into the EgressPolicy. An empty list is semantically the fail-closed default (both lists empty).
    proofSpineParams:
      opts.egressAllowedProcessors !== undefined && opts.egressAllowedProcessors.length > 0
        ? buildProofSpineParams(ingestWorkspaceId, opts.egressAllowedProcessors)
        : buildProofSpineParams(ingestWorkspaceId),
    temporalAddress: opts.temporalAddress ?? "127.0.0.1:7233",
    // CP-3b/18.13b (#13 precondition) — thread the SOURCE stub seam. OMIT the key when no stub is provided (a
    // conditional spread, never `= undefined`) so the default wiring shape stays byte-identical (pinned by
    // `.toStrictEqual` + an `in`-check) and the `assembleBackends` `{ candidateOutput: {} }` default keeps the source
    // FAIL-CLOSED at the schema gate. A stub is provisioned only at ARMING (bundle #4); it is NOT an arming knob —
    // the gate already AND-locked OFF above (opt-in ON + vaultRoot), so a supplied stub can never arm a disabled gate.
    ...(stubExtraction !== undefined ? { stubExtraction } : {}),
  };
}

// ── reconcile-TRIGGER arc, piece F (F1) — the default-OFF reconcile boot gate (task 13.10) ────────────────────
// A pure gate mirroring gateAutoIngest (Lesson 2/8/16): OFF (owner opt-in unset — the default, OR no vaultRoot) ⇒
// `undefined` + ZERO dep-thunk invocations (byte-equivalent — the factory-spy pin, Lesson 11); ON (armed —
// owner-gated, NEVER the default) ⇒ assemble the reconcile scheduler (piece E) over the driver (D) + the
// never-reject builders (C/B) + a redacted log. The owner-gated GbrainReadGrant transport stays UNBOUND
// (`makeDbAdapter` → undefined) ⇒ the db-projection degrades (`complete=false`) ⇒ even the armed path records a
// DEGRADED report (`coverageComplete=false`, never a false-green). Building the gate crosses NO hard line — the
// arming (flip `reconcile` + provision the transport / signing key / corpora / eval) is the owner's. F2 wires the
// `bootWorker` call site + the real leaf-thunks; this helper is unit-tested directly (the byte-equivalence pin).

/** The owner opt-in + precondition for the reconcile trigger (resolved from env, threaded via BootConfig at F2). */
export interface ReconcileGateOpts {
  readonly reconcile?: boolean;
  readonly vaultRoot?: string;
}

/** The assembled reconcile machinery the ON path returns: `scheduler` (piece E, the burst-collapsing
 *  accumulate+flush primitive) plus `trigger` (task 19.4 — `createReconcileTrigger` bound over the SAME
 *  scheduler instance). `trigger.notify()` is what `reconcileNotifyForCapture` below drives from the
 *  vault-watcher's `onCapture` hook (`fs_watch` origin); a future post-KW-commit hook or schedule can
 *  reuse the same `trigger` (they'd ride the SAME burst-collapsing scheduler). */
export interface ReconcileWiring {
  readonly scheduler: ReconcileScheduler;
  readonly trigger: ReconcileTrigger;
}

/** The leaf collaborators as THUNKS — invoked ONLY on the gated-on path (nothing is constructed on OFF). F2 binds the real ones. */
export interface ReconcileGateDeps {
  /** The committed-vault reader (piece C's input; LOCAL fs — not owner-gated). */
  readonly makeReader: () => CommittedVaultReader;
  /** The gbrain read adapter (piece B's input); `undefined` ⇒ the owner-gated GbrainReadGrant transport is UNBOUND ⇒ degrade. */
  readonly makeDbAdapter: () => GbrainReadAdapter | undefined;
  /** The pass deps (piece A's runReconcilePass: reconcilerDeps + the durable recorder + the health sink). */
  readonly makePassDeps: () => RunReconcilePassDeps;
  /** The redacted, non-throwing log sink (piece E's scheduler routing; F2 binds a health-materializing sink). */
  readonly makeLog: () => (summary: LoggedReconcileOutcome) => void;
}

/**
 * Build the reconcile wiring IFF the owner opt-in is ON AND a `vaultRoot` is present; any missing precondition ⇒
 * `undefined` (fail-safe — the shipped default stays byte-equivalent). Pure; the dep-thunks are invoked ONLY on
 * the gated-on path, so NOTHING (scheduler/driver/reader/adapter) is constructed on the OFF path. Building the
 * gate arms nothing — the transport stays unbound, so even the ON path records DEGRADED (never a false-green).
 */
export function gateReconcile(
  opts: ReconcileGateOpts,
  deps: ReconcileGateDeps,
): ReconcileWiring | undefined {
  if (opts.reconcile !== true || opts.vaultRoot === undefined) return undefined;

  // ON path (owner-gated, never default) — invoke the dep-thunks ONLY here.
  const reader = deps.makeReader();
  const adapter = deps.makeDbAdapter(); // undefined ⇒ owner-gated transport unbound ⇒ degrade
  const passDeps = deps.makePassDeps();
  const log = deps.makeLog();

  const scheduler = createReconcileScheduler({
    runReconcile: (workspaceId, origin) =>
      runReconcileForWorkspace(workspaceId, {
        getCanonicalFactSet: (ws) => buildCanonicalFactSet(reader, ws),
        getDbProjection: (ws) =>
          adapter !== undefined
            ? buildReconcilerDbProjection(adapter)
            : Promise.resolve<ReconcilerDbProjection>({
                workspaceId: ws,
                gbrainSchemaVersion: 0,
                facts: [],
                complete: false, // unbound transport ⇒ no coverage ⇒ degrade (never a false-green)
              }),
        origin,
        runPass: (req) => runReconcilePass(req, passDeps),
      }),
    log,
  });

  // task 19.4 — bind the trigger source over the SAME scheduler instance (previously constructed nowhere in
  // production; ZERO callers). Still fully contained inside this ON path — a caller reaching here already
  // passed the `reconcile === true && vaultRoot !== undefined` gate above, so binding the trigger arms nothing
  // new; it is the missing wiring for an ALREADY-armed path, not a new arming surface.
  const trigger = createReconcileTrigger({ scheduler });

  return { scheduler, trigger };
}

/**
 * Task 19.4 — the pure trigger-source decision: given the (possibly-undefined, default-OFF) armed
 * {@link ReconcileWiring} + the watched workspace + a vault-watcher `CaptureOutcome`, decide whether to fire
 * `trigger.notify()` and return its promise, or `undefined` when there is nothing to do. `undefined` on BOTH
 * the OFF path (`reconcile === undefined` — the shipped default; `.notify` is never even reached) AND a
 * non-"dispatched" outcome (ignored / extract_failed / dispatch_failed / error — nothing NEW landed in the
 * vault, so nothing to reconcile). `origin: "fs_watch"` names the real trigger source `reconcileTrigger.ts`'s
 * header names; `outcome.workflowId` becomes the trigger's `revisionId` (ties the reconcile pass to the
 * dispatch that captured it — the same ROLE `RevisionId` plays everywhere else in this arc, just sourced from
 * the watcher's own dispatch id since a filesystem event carries no vault-committed revision id of its own).
 * Pure + total: never throws. The ON-path notify() promise is the CALLER's to handle — boot.ts's `onCapture`
 * wraps it fail-closed (mirrors every other capture-observer fault in this file, §16); this function itself
 * makes no I/O and swallows nothing, so a test can assert the exact call without a fake clock or fake timers.
 */
export function reconcileNotifyForCapture(
  reconcile: ReconcileWiring | undefined,
  workspaceId: string,
  outcome: CaptureOutcome,
): Promise<void> | undefined {
  if (reconcile === undefined) return undefined;
  if (outcome.kind !== "dispatched") return undefined;
  return reconcile.trigger.notify(workspaceId, "fs_watch", outcome.workflowId);
}

// ── piece F2 — the reconcile health/log sinks bound at the composition root (constraint b/c) ──────────────────

/** Shared deps for the reconcile health/log sinks: an OBS-2 failure recorder (HealthSurface.record at boot —
 *  mint/dedupe/audit-link, NOT a raw store put), a clock, and audit ids. */
export interface ReconcileHealthDeps {
  readonly recordFailure: (failure: HealthFailure) => Promise<unknown>;
  readonly now: () => string;
  readonly newAuditId: () => string;
}

/** A SAFE one-line reconcile-health message — names the class + a code tag + the subject ref; NEVER raw content. */
function reconcileHealthMessage(failureClass: string, code: string, subjectRef: string): string {
  return `Reconcile ${failureClass} (${code}) at ${subjectRef} — quarantined; serving withholds until remediated.`;
}

/**
 * The passDeps `healthSink`: reproject a reconciler-minted {@link HealthItem} → a {@link HealthFailure} → the OBS-2
 * recorder. Uses ONLY safe fields — the frozen `failureClass`, a SYNTHESIZED safe message, and a subjectRef from the
 * item's ids — the item's own free-form message is NEVER forwarded (safety rule 7). A `recordFailure` fault
 * PROPAGATES (rejects) per piece A's ReconcileHealthSink contract (Lesson 18): a health-materialization fault on a
 * real parity defect must be operator-visible, never silently dropped. Piece A routes health AFTER the
 * record-only-on-ok gate, so the propagated fault surfaces through the driver as `pass_faulted` (caught, never an
 * unhandled rejection out of the scheduler's flush). The precise OBS-2 dedupe subjectRef still finalizes at the
 * arming review, when real health items flow. (Item 7a — the dormant-era best-effort swallow, now resolved.)
 */
export function createReconcileHealthSink(deps: ReconcileHealthDeps): ReconcileHealthSink {
  return {
    record: async (item: HealthItem): Promise<void> => {
      const ref = item.factIdentity ?? item.parityReportRef;
      const subjectRef = ref !== undefined ? String(ref) : "reconcile";
      const failure: HealthFailure = {
        failureClass: item.failureClass,
        subjectRef,
        message: reconcileHealthMessage(item.failureClass, "parity", subjectRef),
        auditRef: deps.newAuditId() as AuditId,
        now: deps.now(),
      };
      // PROPAGATE a record fault (Lesson 18) — a trust-defect signal is never silently dropped; the driver catches
      // the rejection into `pass_faulted` (piece D), so the fault becomes an operator-visible health item, not a lost line.
      await deps.recordFailure(failure);
    },
  };
}

/**
 * The scheduler's `log` sink: emit the ALREADY-REDACTED summary (piece E), and on a `skipped_derive_error` OR a
 * `pass_faulted` outcome ALSO materialize a `parity_defect` {@link HealthItem} from the SAFE cause code (never the
 * raw error) — a durable-store / reconcile-pass fault is health-worthy, not log-only (Item 7b, Lesson 18). Sync +
 * UNCONDITIONALLY NEVER throws — the WHOLE body is guarded (piece E's flush relies on `log` being non-throwing
 * regardless of the injected `log`/`recordFailure`): a sync throw OR an async rejection is swallowed (a lost
 * observability line is fail-safe; the reconcile's durable ParityReport already landed).
 */
export function createReconcileLogSink(
  deps: ReconcileHealthDeps & { readonly log: (summary: LoggedReconcileOutcome) => void },
): (summary: LoggedReconcileOutcome) => void {
  // Fire-and-forget mint of a `parity_defect` HealthItem from ONLY safe fields (safety rule 7): a synthesized
  // message over `code` (a safe enum / arch_gap token) + a `ws‖rev` subjectRef. Best-effort (`.catch`) so the log
  // sink stays total; the caller's outer try also guards a synchronous mint fault.
  const mintParityHealth = (workspaceId: string, revisionId: string, code: string): void => {
    const subjectRef = `${workspaceId}‖${revisionId}`;
    const failure: HealthFailure = {
      failureClass: "parity_defect",
      subjectRef,
      message: reconcileHealthMessage("parity_defect", code, subjectRef),
      auditRef: deps.newAuditId() as AuditId,
      now: deps.now(),
    };
    void deps.recordFailure(failure).catch(() => {});
  };
  return (summary) => {
    try {
      deps.log(summary);
      if (summary.kind === "skipped_derive_error") {
        mintParityHealth(summary.workspaceId, summary.revisionId, summary.detail ?? "derive_error");
      } else if (summary.kind === "pass_faulted") {
        // A durable-store / reconcile-pass fault (Item 7b) is health-worthy. The SAFE cause code rides ONLY via
        // redactedCause.causeCode (a typed token; message/stack stay OUT — safety rule 7); `pass_faulted` is the
        // greppable arch_gap tag naming the store-fault cause without inventing a FailureClass member (Lesson 18).
        const causeCode = summary.redactedCause?.causeCode;
        // Truthy guard (not `!== undefined`): a falsy causeCode (`undefined` or an empty string) folds to the clean
        // fixed literal — never a dangling `pass_faulted:` tag in the operator-facing message.
        mintParityHealth(
          summary.workspaceId,
          summary.revisionId,
          causeCode ? `pass_faulted:${causeCode}` : "pass_faulted",
        );
      }
    } catch {
      /* best-effort — the log sink MUST NEVER throw (piece E's flush relies on it); swallow any sink fault. */
    }
  };
}

// ── Task 13.10 (rebuild-oracle producer arc, piece B): the default-OFF gateRebuildOracle boot gate. spec(§6) spec(§12)
//
// The Lesson-23 arming-seam split: this pure helper turns piece A's probeRebuildOracle producer (committed 210e95e)
// into a boot-resolvable `resolveOracleBuild: () => boolean` for createServingCoverageReader — but ONLY when the
// owner has provisioned a real IndexRebuildClient. Byte-equivalent BY CONSTRUCTION: an added, UNREFERENCED exported
// helper — NO bootWorker edit — so it cannot change the shipped boot. Piece C adds the bootWorker call site + the
// async boot-await/cache + the coverage-reader binding.
//
// OFF (the default): the owner-gated real client factory is absent/not-a-function OR no served workspaces ⇒
//   `undefined` + ZERO dep-thunk invocations (the byte-equivalence proof). Type-robust (Lesson 27): a malformed
//   factory value degrades to OFF, never throws at gate time.
// ON (owner-provisioned real client): assemble a bound async `compute` that runs probeRebuildOracle over each served
//   workspace, FOLDS fail-closed (true IFF the served set is non-empty AND EVERY workspace corroborates), caches the
//   boot-global boolean, and exposes a SYNC accessor over it (false until compute runs). The per-ws statuses ride out
//   for piece C to route any rebuild_divergence HealthItem — this helper stays PURE (routes none).
// NO hard line: the real IndexRebuildClient stays UNBOUND by default (the owner provisions the factory at arming).

/** Owner-provided config for the rebuild-oracle gate — the served workspace set (piece C resolves it from config). */
export interface RebuildOracleGateOpts {
  /** The served workspace ids to corroborate. Empty ⇒ gate OFF (nothing to corroborate). */
  readonly servedWorkspaceIds: readonly string[];
}

/** One served workspace's rebuild-oracle status — piece C routes any `diverged` HealthItem from these. */
export interface RebuildOracleWorkspaceStatus {
  readonly workspaceId: string;
  readonly status: RebuildOracleStatus;
}

/** The result of folding the probe over every served workspace. */
export interface RebuildOracleComputeResult {
  readonly oracleBuildOk: boolean;
  readonly statuses: readonly RebuildOracleWorkspaceStatus[];
}

/** The assembled ON-path wiring: a one-shot boot compute + the SYNC accessor createServingCoverageReader consumes. */
export interface RebuildOracleWiring {
  /** Run the probe over every served ws, fold fail-closed, cache the boot-global boolean; returns per-ws statuses. */
  readonly compute: () => Promise<RebuildOracleComputeResult>;
  /** SYNC accessor over the cached fold — the createServingCoverageReader `resolveOracleBuild` seam. `false` until
   *  `compute` has run (fail-closed default — the coverage leg degrades until the boot probe completes). */
  readonly resolveOracleBuild: () => boolean;
}

/** The gate's leaf dep-thunks — all fakeable; the owner-gated real client factory is the arming crossing. */
export interface RebuildOracleGateDeps {
  /** The owner-gated real gbrain scratch-import client FACTORY — UNBOUND by default (absent ⇒ gate OFF). */
  readonly makeRebuildClient?: () => IndexRebuildClient;
  /** The LOCAL committed-vault reader factory (piece A's `readCommittedVault` input; not owner-gated). */
  readonly makeReader: () => CommittedVaultReader;
  /** Injected clock (ISO-8601) — passed to the probe for deterministic rebuild health-item timestamps. */
  readonly now: () => string;
  /** Injected System-Health id minter — passed to the probe. */
  readonly newHealthItemId: () => string;
  /** AuditRecord ref the rebuild_divergence health items link back to. */
  readonly auditRef: string;
}

/**
 * The default-OFF rebuild-oracle boot gate (mirror gateReconcile F1). Byte-equivalent BY CONSTRUCTION (no bootWorker
 * caller). Returns `undefined` (OFF) unless the owner has provisioned a real IndexRebuildClient factory AND there is
 * ≥1 served workspace; on OFF it invokes NONE of its dep thunks. See the block header for the ON-path fold contract.
 */
export function gateRebuildOracle(
  opts: RebuildOracleGateOpts,
  deps: RebuildOracleGateDeps,
): RebuildOracleWiring | undefined {
  // OFF-lock 1 (arming): the owner-gated real client factory must be provisioned. `typeof !== "function"` folds a
  //   malformed/absent value to OFF fail-closed (Lesson 27) — no throw at gate time. Captured in a local so TS
  //   narrows it to a callable for the ON path below.
  const makeRebuildClient = deps.makeRebuildClient;
  if (typeof makeRebuildClient !== "function") return undefined;
  // OFF-lock 2 (precondition): nothing to corroborate ⇒ OFF. BOTH locks are checked BEFORE any thunk fires — THE
  //   byte-equivalence pin (an OFF gate invokes zero dep-thunks, so it cannot change boot).
  if (opts.servedWorkspaceIds.length === 0) return undefined;

  // ON — invoke the thunks ONCE here to bind the probe deps (mirror gateReconcile's construct-at-gate; one reader +
  //   one client serve every workspace, since probeRebuildOracle takes the workspaceId per call).
  const reader = deps.makeReader();
  const rebuildClient = makeRebuildClient();
  const probeDeps: RebuildOracleProbeDeps = {
    readCommittedVault: reader,
    rebuildClient,
    now: deps.now,
    newHealthItemId: deps.newHealthItemId,
    auditRef: deps.auditRef,
  };

  let cached = false; // fail-closed default until the boot compute runs (mirrors resolveRunning's pre-probe state)
  const compute = async (): Promise<RebuildOracleComputeResult> => {
    try {
      const statuses: RebuildOracleWorkspaceStatus[] = [];
      for (const workspaceId of opts.servedWorkspaceIds) {
        statuses.push({ workspaceId, status: await probeRebuildOracle(workspaceId, probeDeps) });
      }
      // Fail-closed AND fold (never a false green): the served set is non-empty AND EVERY workspace corroborates.
      // Strict `=== true` (Lesson 27/28) — any non-corroborated status carries oracleBuildOk:false and sinks the fold;
      // the `statuses.length > 0` guard is belt-and-suspenders over OFF-lock 2 (an empty `every` is vacuously true).
      const oracleBuildOk = statuses.length > 0 && statuses.every((s) => s.status.oracleBuildOk === true);
      cached = oracleBuildOk;
      return { oracleBuildOk, statuses };
    } catch {
      // §16 defense-in-depth: probeRebuildOracle never throws, but a fold fault degrades — never a false green.
      cached = false;
      return { oracleBuildOk: false, statuses: [] };
    }
  };

  return { compute, resolveOracleBuild: () => cached };
}

// ── Task 13.10 (rebuild-oracle arc, piece C — CLOSES the arc): the boot-binding's extracted pieces. spec(§6) spec(§16)

/** Shared deps for the rebuild-oracle health sink: the OBS-2 failure recorder (HealthSurface.record), a clock, audit ids. */
export interface RebuildOracleHealthDeps {
  readonly recordFailure: (failure: HealthFailure) => Promise<unknown>;
  readonly now: () => string;
  readonly newAuditId: () => string;
}

/** Routes a diverged rebuild-oracle status's HealthItem to the OBS-2 surface — reprojected safe-fields-only. */
export interface RebuildOracleHealthSink {
  readonly record: (item: HealthItem, workspaceId: string) => Promise<void>;
}

/** A SAFE one-line rebuild-oracle health message — names the class + subject ref; NEVER the item's free-form content. */
function rebuildOracleHealthMessage(failureClass: string, subjectRef: string): string {
  return `Rebuild-oracle ${failureClass} at ${subjectRef} — serving withholds (oracleBuildOk=false) until remediated.`;
}

/**
 * The rebuild-oracle health sink (mirror {@link createReconcileHealthSink}): reproject a `diverged` status's
 * `rebuild_divergence` {@link HealthItem} → a {@link HealthFailure} → the OBS-2 recorder using ONLY safe fields —
 * the frozen `failureClass`, a SYNTHESIZED safe message, and a subjectRef from the item's ids (falling back to the
 * workspaceId, since a rebuild-oracle item carries no `factIdentity`/`parityReportRef`). The item's own free-form
 * `message` is NEVER forwarded (safety rule 7). A `recordFailure` fault PROPAGATES (Lesson 18) — a trust-defect
 * signal is never silently dropped; the boot caller ({@link computeAndRouteRebuildOracle}) CONTAINS it. The precise
 * OBS-2 dedupe subjectRef finalizes at the arming review, when real rebuild-divergence items flow.
 */
export function createRebuildOracleHealthSink(deps: RebuildOracleHealthDeps): RebuildOracleHealthSink {
  return {
    record: async (item: HealthItem, workspaceId: string): Promise<void> => {
      const ref = item.factIdentity ?? item.parityReportRef;
      const subjectRef = ref !== undefined ? String(ref) : `rebuild-oracle:${workspaceId}`;
      const failure: HealthFailure = {
        failureClass: item.failureClass,
        subjectRef,
        message: rebuildOracleHealthMessage(item.failureClass, subjectRef),
        auditRef: deps.newAuditId() as AuditId,
        now: deps.now(),
      };
      await deps.recordFailure(failure); // PROPAGATE (Lesson 18) — the boot caller contains it (§16)
    },
  };
}

/**
 * Run piece B's one-shot {@link RebuildOracleWiring.compute} ONCE at boot, route ONLY `diverged` statuses to the
 * health sink, and CONTAIN any fault so it never escapes boot as an unhandled rejection (§16) — `resolveOracleBuild`
 * stays `false` (fail-closed) on a fault. The sink PROPAGATES a record fault (Lesson 18) up to here; the boot-time
 * posture is containment (a one-shot dormant probe must never crash boot). `onContainedFault` signals a contained
 * fault (a redacted marker — the callback takes NO args, so no raw content can leak, safety rule 7) so it is not
 * FULLY silent; precise op-visibility of a surface-down fault finalizes at arming.
 */
export async function computeAndRouteRebuildOracle(
  wiring: RebuildOracleWiring,
  sink: RebuildOracleHealthSink,
  onContainedFault?: () => void,
): Promise<void> {
  try {
    const result = await wiring.compute();
    for (const { workspaceId, status } of result.statuses) {
      if (status.outcome === "diverged") await sink.record(status.healthItem, workspaceId);
    }
  } catch {
    // §16 — the contained-fault SIGNAL must itself never throw (mirror createReconcileLogSink's guarded log call): a
    //   throwing onContainedFault (e.g. a broken logger) would defeat the containment and crash boot. Best-effort.
    try {
      onContainedFault?.();
    } catch {
      /* swallow — the fault signal is best-effort; boot must not crash on a probe/health/log fault */
    }
  }
}

/**
 * Build a production ProofSpineParams with a REAL `sourceIngestion` binding (a WS-2 HIGH-confidence bind to
 * `boundWorkspace`) + INERT meeting leaves. The shipped app dispatches ONLY `sourceIngestion` (via the vault
 * watcher); the meeting activities register but are NEVER invoked — so the meeting leaves are fixed
 * deterministic inert values.
 *
 * `revisions` here is an INERT PLACEHOLDER: `bootWorker` REBINDS it to the DURABLE slice-2a
 * KnowledgeRevisionStore (over the operational-store repo) via {@link withDurableRevisions} right after it
 * builds `backends` (the repo does not exist until then), BEFORE the params reach any consumer — so on the ON
 * path the ingestion `sourceCommit` (now a REAL KnowledgeWriter commit, §6/safety rule 1) AND the dormant
 * propose dispatch both persist idempotency DURABLY (survives a worker restart). On the OFF path this thunk is
 * never called (gateAutoIngest returns undefined) ⇒ nothing here is constructed, nothing persists (slice-1
 * default-OFF invariant). Closes the deferred durable-`revisions` residual — both (a) the real durable
 * sourceCommit and (b) the propose-path durability.
 */
export function buildAutoIngestProofSpineParams(
  boundWorkspace: string,
  // 18.31 — the owner/desktop-supplied egress allowlist (plain IPC-safe strings). DEFAULT [] ⇒ the egress policy
  // below stays fail-closed empty (byte-equivalent to the pre-seam hardcoded-empty lists).
  egressAllowedProcessors: readonly string[] = [],
): ProofSpineParams {
  const ws: WorkspaceId = workspaceId(boundWorkspace);
  const inertRevisions: KnowledgeRevisionStore = (() => {
    const byKey = new Map<string, CommittedRevision>();
    return {
      getByIdempotencyKey: (k: string): Promise<CommittedRevision | undefined> => Promise.resolve(byKey.get(k)),
      record: (rev: CommittedRevision): Promise<void> => {
        byKey.set(rev.idempotencyKey, rev);
        return Promise.resolve();
      },
    };
  })();
  const inertRunRef: WorkflowRunRef = {
    workflowId: workflowId("wf-autoingest-inert"),
    trigger: "owner_action",
    state: "running",
    idempotencyKey: "run:autoingest:inert",
    auditRefs: [],
  };
  const inertMeetingJobInputs: MeetingJobInputs = {
    workflowRunId: workflowId("wf-autoingest-inert"),
    workspaceId: ws,
    capability: "meeting.close",
    // 18.2 — the (inert) meeting broker candidate is a KnowledgeMutationPlan stand-in; the real
    // SCHEMA gate validates against this registered schema. The meeting flow registers but is never
    // dispatched here (auto-ingest dispatches SOURCE ingestion). 18.4 — SOURCE ingestion now routes
    // THROUGH the broker (no longer a bypass), so this KMP-schema alignment is realized on that path.
    outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
    maxRuntimeSeconds: 30,
    idempotencyKey: "job:meeting:inert",
  };
  const inertMeetingExtraction: AgentExtraction = {
    fields: { title: { value: "n/a", evidenceRef: "src:inert#0" } },
  };
  // The candidate the (faked) source agent emits — no-inference-safe (owner is evidence-backed, dueDate is the
  // TBD sentinel), so the REAL in-sandbox validate gate PASSES it. This is the one leaf that drives real routing.
  const sourceExtraction: AgentExtraction = {
    fields: {
      owner: { value: "owner", evidenceRef: "source#L1" },
      dueDate: { value: TBD },
    },
    schemaId: "sow:source-ingest-output",
  };
  const resolved: ResolvedWorkspacePolicy = {
    workspaceId: String(ws),
    type: "personal_business",
    dataOwner: "user",
    defaultVisibility: "coordination",
    egressPolicy: {
      workspaceId: ws,
      // 18.31 — brand the (IPC-safe plain) processor strings to `ProcessorId` at this single worker-side site (the
      // desktop forward passes them through untouched, 18.32). Source ingestion carries raw content ⇒ the cloud
      // processor must be in BOTH lists (§5). DEFAULT [] ⇒ two distinct empty arrays, byte-equivalent to the prior
      // hardcoded-empty lists (no aliasing between the two — a downstream mutation of one can't affect the other).
      allowedProcessors: egressAllowedProcessors.map((p) => processorId(p)),
      rawContentAllowedProcessors: egressAllowedProcessors.map((p) => processorId(p)),
      employerRawEgressAcknowledged: false,
    },
    providerMatrix: {
      workspaceId: ws,
      // 18.4 — `ollama` (a LOCAL provider) is allow-listed so the `source.process` loopback-local route below
      // passes route-resolution's provider allowlist. NO cloud provider is listed (a cloud route fails closed).
      allowedProviders: ["ollama"],
      // The meeting.close route is never resolved (the meeting flow registers but never dispatches). 18.4 —
      // SOURCE ingestion now routes THROUGH the broker, so `source.process` resolves to a GENUINE loopback-local
      // route (ollama + 127.0.0.1 + egressClass "local" ⇒ processorOfRoute===null ⇒ the §5 employer-raw veto
      // ALLOWS via the loopback fall-through — rule 5's sanctioned local zero-egress path; a cloud route fails
      // closed). The endpoint mirrors localConfig.allowedLocalEndpoints' default.
      //   ⚠ ARMING-OWED (owner-opt-in completion, NOT the shipped default): the broker's SCHEMA gate also needs a
      //   valid `stubExtraction` (the shipped assembleBackends `{}` default fails it). CP-3b/18.13b THREADED the SEAM
      //   — `gateAutoIngest`'s optional `stubExtraction` → `AutoIngestWiring.stubExtraction` → the worker-host spread
      //   → `assembleBackends` — but the DORMANT default stays EMPTY (no stub provisioned), so an owner who ENABLES
      //   auto-ingest today STILL gets source fail-closed at the schema gate (no note), byte-equivalent to shipped.
      //   Arming (bundle #4, desktop host) supplies a valid stub AND flips `outputSchemaId → sow:agent-extraction`
      //   (so the stub normalizes to an `agent_extraction` candidate, not the KMP stand-in ⇒ EMPTY ⇒ reject); the
      //   -live accept-path proof is SOW_TEMPORAL-gated (sourceIngestion-live.test.ts).
      // 18.24 step-6 item iv — SINGLE-SOURCE the shipped local route (L5/L37): the boot literal,
      // `LOCAL_EXTRACTION_ROUTE`, and `source-extraction.ts` `DEFAULT_ROUTE` are now ONE frozen constant, so a
      // route change can never silently drift the three copies. Byte-equivalent to the prior inline literal.
      // The owner-armed cloud `{runtime}` swap is applied by `withSubscriptionExtractionArming` (dormant).
      capabilityDefaults: {
        "source.process": LOCAL_EXTRACTION_ROUTE,
      } as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
      rawCloudEgressEnabled: false,
    },
  };
  return {
    resolved,
    correlationSignals: { confidence: 0.95, workspaceId: ws },
    meetingJobInputs: inertMeetingJobInputs,
    meetingExtraction: inertMeetingExtraction,
    revisions: inertRevisions,
    commit: {
      actor: "worker:autoingest",
      sourceEventRef: "evt:autoingest",
      workflowRunRef: inertRunRef,
      expectedBaseRevision: computeRevisionId(new Map()),
    },
    sourceRef: { sourceId: sourceId("autoingest-meeting-inert") },
    planIdentity: { closeout: "meeting:inert" },
    sourceIngestion: {
      boundWorkspaceId: ws,
      extraction: sourceExtraction,
      sourceRef: { sourceId: sourceId("autoingest-src") },
      planIdentity: { ingest: "source:autoingest" },
    },
  };
}

/**
 * Rebind the proof-spine params' placeholder `revisions` to the DURABLE slice-2a
 * {@link KnowledgeRevisionStore} over the operational-store repo (§11.1 slice 2b). This runs inside
 * `bootWorker` AFTER `backends` is built (the repo does not exist earlier — the params are assembled at the
 * worker-host before boot), and BEFORE any `proofSpineParams.revisions` consumer, so the ingestion
 * `sourceCommit` and the dormant propose dispatch both persist idempotency durably (survives a worker restart).
 *
 * DEFAULT-OFF PRESERVED (load-bearing): on the OFF/absent-config path `proofSpineParams` is `undefined`, so this
 * returns `undefined` WITHOUT constructing the durable store adapter — nothing is wired, nothing persists (the
 * slice-1 owner-opt-in invariant). The store adapter is created ONLY on the ON path.
 */
export function withDurableRevisions(
  proofSpineParams: ProofSpineParams | undefined,
  revisionRepo: KnowledgeRevisionRepository,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined) return undefined;
  return { ...proofSpineParams, revisions: createKnowledgeRevisionStoreAdapter(revisionRepo) };
}

/**
 * Task 24.1 / REQ-S-NEW-008 — attach the OS ONE-WRITER FENCE probe so the
 * KnowledgeWriter REFUSES a commit whenever this process is not provably the sole
 * writer of the vault.
 *
 * ⛔ THIS IS WHAT MAKES THE LOCK PREVENTIVE. `bootWorker` has acquired the
 * single-owner lock since `68ec73c9`, but nothing consulted it on the write path, so
 * a worker that lost (or never won) the lock still wrote canonical Markdown — the
 * fence was DETECTIVE, which is exactly the distinction `write-fence.ts` exists to
 * erase. The probe is evaluated PER COMMIT at `atomicCommit`, before a byte is
 * staged; a boot-time decision would authorize every later write on a fact that can
 * expire while the process runs.
 *
 * Same `undefined` passthrough as every other `with*` rebind. On the absent path
 * nothing is attached and commits are ungated, byte-identical to before.
 */
export function withWriteFence(
  proofSpineParams: ProofSpineParams | undefined,
  writeFence: () => readonly string[] | undefined,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined) return undefined;
  return { ...proofSpineParams, writeFence };
}

/**
 * Task 19.1 — attach the REAL file-backed {@link GbrainSyncOutboxBinding} (built over
 * `backendsConfig.dbPath`, so it shares the SAME durable file the operational store uses) so the
 * commit-triggered sync — `withGbrainSync` inside `buildProofSpineActivities` — persists across a
 * worker restart. UNLIKE `withDurableRevisions` this is NOT an arming/opt-in gate: the binding itself
 * is harmless internal machinery (a small additive table + a deterministic stub index client), so the
 * only guard here is the SAME `proofSpineParams === undefined` passthrough every other `with*`
 * rebind in this chain already applies (nothing to attach the binding TO when the proof-spine
 * subsystem itself is not provisioned).
 */
export function withGbrainSyncOutbox(
  proofSpineParams: ProofSpineParams | undefined,
  gbrainSyncOutbox: ReturnType<typeof createGbrainSyncOutboxBinding>,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined) return undefined;
  return { ...proofSpineParams, gbrainSyncOutbox };
}

/**
 * Task 19.2 — wrap a `SecretsPort` so a `locked` OR `missing` Keychain resolution ALSO mints a
 * `parity_defect` System-Health item (§16 observability) before returning the SAME fail-closed
 * `secret_unresolved` err unchanged. Mirrors `apps/worker/src/secrets/keychain-boot.ts`'s
 * `createLockRoutingSecretsAccessor` (L41's degraded-by-default lock-routing shape) but over
 * `resolveSigningKey` (the `StamperDeps` shape `stampProvenance` needs), not `getSecret` — the two
 * secrets ports are structurally distinct, so this is a SIBLING wrapper, not a re-use of that one.
 * A health-mint fault is best-effort (never changes the fail-closed secret Result, mirrors
 * L21/L29/L53). Never throws — the underlying port's OWN throw is caught here too, folded to the
 * SAME `secret_unresolved` shape `computeSig` already defends against, so the parity-defect mint
 * still fires on a throwing accessor.
 *
 * The MISSING-key half (this task's own extension): the real `KeychainUnresolvedReason`
 * (apps/worker/src/secrets/keychain-adapter.ts) is a closed set including BOTH `locked` (the
 * Keychain is present but locked) AND `missing` (the key was never provisioned at all) — two
 * DISTINCT degraded causes, previously only the first minted a signal, so an operator saw NOTHING
 * for a never-provisioned key even though the commit degrades the identical way (unstamped, never
 * a crash). The minted message NAMES which condition applies — remediation differs (unlock the
 * Keychain vs. provision the missing key) — never conflating the two.
 */
export function withParityDefectSignalOnLockedKeychain(
  port: SecretsPort,
  healthItems: HealthItemStore,
  now: () => string,
  newHealthItemId: () => string,
): SecretsPort {
  return {
    async resolveSigningKey(ref: SecretRef): Promise<Result<Uint8Array, SecretUnresolved>> {
      let resolved: Result<Uint8Array, SecretUnresolved>;
      try {
        resolved = await port.resolveSigningKey(ref);
      } catch (cause) {
        resolved = {
          ok: false,
          error: {
            code: "secret_unresolved",
            ref,
            reason: cause instanceof Error ? cause.name : "resolve_threw",
          },
        };
      }
      if (!resolved.ok && (resolved.error.reason === "locked" || resolved.error.reason === "missing")) {
        const conditionText =
          resolved.error.reason === "locked"
            ? "the Keychain signing key is LOCKED"
            : "the Keychain signing key is MISSING (never provisioned)";
        try {
          await healthItems.put({
            id: newHealthItemId(),
            failureClass: "parity_defect",
            severity: "warn",
            message:
              `KnowledgeWriter provenance signing degraded: ${conditionText} — ` +
              "the commit proceeds UNSTAMPED (never a crash, never a silent unsigned commit).",
            auditRef: `gbrain-sign-key-${resolved.error.reason}:${ref}` as AuditId,
            openedAt: now(),
            state: "open",
          });
        } catch {
          /* best-effort — a health-mint fault never changes the fail-closed secret Result */
        }
      }
      return resolved;
    },
  };
}

/**
 * Task 19.2 — attach the provenance-signing dep, mirroring `withGbrainSyncOutbox`'s shape: `undefined`
 * `signing` (no provisioning) or `undefined` `proofSpineParams` (nothing to attach to) both pass through
 * unchanged, so the shipped default stays byte-identical.
 */
export function withSigning(
  proofSpineParams: ProofSpineParams | undefined,
  signing: StamperDeps | undefined,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined || signing === undefined) return proofSpineParams;
  return { ...proofSpineParams, signing };
}

/**
 * 21.10 — thin, EXPLICIT structural adapter from the boot-level `SecretsAccessor` facade
 * (`keychain-boot.ts`'s `getSecret`: string-in/string-out, `SecretUnavailableReason =
 * ["missing","locked","denied"]`) to the Tool-Gateway `WriteSecretsAccessor` shape
 * (`adapter-core.ts:91`, the SAME three-token reason set). The two are already structurally
 * assignable (identical shape), but naming the seam here — rather than relying on bare structural
 * assignability at the call site — means a future divergence between the two reason enums surfaces
 * as a visible type error on THIS function, not a silent mismatch. Never resolves/reads the token
 * itself (rule 7) — a pure pass-through of the injected accessor's own call.
 */
function toWriteSecretsAccessor(accessor: SecretsAccessor): WriteSecretsAccessor {
  return { getSecret: (ref) => accessor.getSecret(ref) };
}

/**
 * Task 21.10 — attach the external-write credential-seam accessor, mirroring `withSigning`'s shape:
 * `undefined` `secretsAccessor` (no Keychain provisioning) or `undefined` `proofSpineParams` (nothing
 * to attach to) both pass through UNCHANGED, so the shipped default stays byte-identical —
 * `externalWriteDeps.secrets` stays ABSENT (`credential-seam.test.ts`'s ABSENT-accessor pin).
 */
export function withWriteSecretsAccessor(
  proofSpineParams: ProofSpineParams | undefined,
  secretsAccessor: WriteSecretsAccessor | undefined,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined || secretsAccessor === undefined) return proofSpineParams;
  return { ...proofSpineParams, secretsAccessor };
}

/**
 * Task 21.8 — attach the OPTIONAL card-transport owner gate, mirroring `withWriteSecretsAccessor`
 * immediately above. `cardTransport` UNSET (the shipped default — `config.cardTransport` unset) ⇒
 * params pass through UNCHANGED, so `buildProofSpineActivities`'s `selectCardRenderer(undefined)`
 * keeps the deterministic no-op literal. NOTHING in this slice arms the gate (no `make` bound here).
 */
export function withCardTransport(
  proofSpineParams: ProofSpineParams | undefined,
  cardTransport: CardTransportGate | undefined,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined || cardTransport === undefined) return proofSpineParams;
  return { ...proofSpineParams, cardTransport };
}

/**
 * 18.24 step-6 — the proof-spine post-processor that co-gates the subscription extraction route + ContextRef to
 * the SAME `config.providerTransport` arming signal (`resolveSubscriptionArming.effectiveArmed`; one flip, no
 * split-brain — L52). Mirrors {@link withDurableRevisions}.
 *
 * `armed !== true` (the shipped default — `providerTransport` unset, OR a shadowing-env-refused arm) ⇒ the params
 * are returned UNCHANGED (byte-equivalent: the source.process route stays LOCAL, `sourceIngestion.contextRefs`
 * stays absent). ARMED ⇒ swap `capabilityDefaults["source.process"]` to the cloud `{runtime}` subscription route
 * (re-triggers the §5 egress veto for employer-raw jobs downstream) + stamp EXACTLY ONE
 * `{refKind:"source", ref: sourceRef.sourceId}` ContextRef — the routing-bound ingestion identity (WS-8, never a
 * content field; = the source idempotencyKey id + the parked-reader id) the 18.21 resolver derefs. Pure; total.
 *
 * Reachability-WAIVERED (L11): the armed branch fires ONLY at the owner ENABLE (step 6, HARD STOP) — this slice
 * leaves `config.providerTransport` unset, so boot always passes `armed=false`.
 */
export function withSubscriptionExtractionArming(
  proofSpineParams: ProofSpineParams | undefined,
  armed: boolean,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined || armed !== true) return proofSpineParams;
  const sourceIngestion = proofSpineParams.sourceIngestion;
  return {
    ...proofSpineParams,
    // 18.27 / #13 Finding C — co-gate the outputSchemaId flip (L57) to the SAME arm signal. On the ARMED
    // path source.process emits a first-class `sow:agent-extraction` candidate (its route is swapped to the
    // cloud {runtime} route below) — not the KMP stand-in that discards `evidenceRef` — so validateNoInference
    // runs on the real evidence (GATE-1, L51/L46; the broker SCHEMA gate registers this parser, 18.27
    // backends.ts). meeting.close's outputSchemaId is co-gated for parity, but its cloud route is NOT armed
    // this slice (Finding-F: meeting.close stays local) ⇒ that flip is INERT until meeting.close is separately
    // armed. Unarmed ⇒ this branch is never taken ⇒ both legs stay KMP (byte-equivalent).
    meetingJobInputs: {
      ...proofSpineParams.meetingJobInputs,
      outputSchemaId: AGENT_EXTRACTION_SCHEMA_ID,
    },
    resolved: {
      ...proofSpineParams.resolved,
      providerMatrix: {
        ...proofSpineParams.resolved.providerMatrix,
        capabilityDefaults: {
          ...proofSpineParams.resolved.providerMatrix.capabilityDefaults,
          "source.process": CLOUD_EXTRACTION_ROUTE,
        } as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
      },
    },
    ...(sourceIngestion !== undefined
      ? {
          sourceIngestion: {
            ...sourceIngestion,
            // EXACTLY ONE ref, sourced from the CONFIG binding's `sourceRef.sourceId` (never content — WS-8).
            contextRefs: [
              { refKind: SOURCE_CONTEXT_REF_KIND, ref: String(sourceIngestion.sourceRef.sourceId) },
            ] as readonly ContextRef[],
            // The co-gated source-leg outputSchemaId flip (buildActivities reads `sourceBinding.outputSchemaId`).
            outputSchemaId: AGENT_EXTRACTION_SCHEMA_ID,
          },
        }
      : {}),
  };
}

// ── task 22.1 — the propose precondition gate (five AND-composed preconditions) ────────────────────
//
// Today boot has only two ISOLATED checks — `proposeEnabled: config.copilotProposeMode === true` and
// `knowledgeProposeEnabled: config.copilotProposeKnowledge === true && proofSpineParams !== undefined`
// (the mappings below, inside `agentSynthesisFactory`'s thunk) — no COMPOSITE gate exists. Per the
// plan's own five-precondition text (task 22.1), propose stays OFF unless ALL FIVE hold:
//   (1) content trust is REAL — `deriveCopilotContentTrust` can actually return 'trusted' (Phase 20).
//       Boot-time proxy: the go-live SELECTED serving oracle is live (`servingOracleFactory !==
//       undefined`, i.e. `copilotProvenanceStamping && provenanceBundle && copilotServingOracleGoLive`
//       all hold) — the mechanism the trust-flip depends on per the L580 spec note.
//   (2) the KnowledgeWriter commit / auto-ingest path is provisioned (Phase 18): `proofSpineParams !==
//       undefined`.
//   (3) the Keychain signing key resolves (Phase 17): the boot-computed `signing: StamperDeps |
//       undefined` is bound (task 19.2/22.4's SAME provisioning bundle — no second key source).
//   (4) the real external-write transport is armed (Phase 21): `config.writeTransport?.enabled ===
//       true` (task 22.1 threads this new `BootConfig` field — see its own doc comment).
//   (5) gbrain provenance stamping is REAL, independent of the go-live SELECTION flip (Phase 19):
//       the loader-backed oracle is BUILT (`loaderBackedServingOracle !== undefined`,
//       `copilotProvenanceStamping && provenanceBundle`) — distinct from (1), which additionally
//       requires the go-live arm.
//
// PURE, unit-testable without booting (mirrors `gateReconcile`/`gateRebuildOracle`'s shape): the
// caller resolves each boolean from its own boot-time signal and hands them in as a flat struct — this
// function does no I/O and constructs nothing. Called AHEAD of the `proposeEnabled`/`knowledgeProposeEnabled`
// mappings so NEITHER flag is honored unless all five preconditions pass — first-missing-precondition
// short-circuit, so the OFF verdict names exactly one reason.

/** The five booleans `gateProposeArming` AND-composes, each resolved from an existing boot-time signal. */
export interface ProposeArmingPreconditions {
  readonly contentTrustReal: boolean;
  readonly proofSpineProvisioned: boolean;
  readonly signingKeyResolved: boolean;
  readonly writeTransportArmed: boolean;
  readonly provenanceStampingReal: boolean;
}

/** The FIRST missing precondition, in the fixed check order above — never a set (a caller-visible reason names ONE cause). */
export type ProposeArmingReason =
  | "content_trust_not_real"
  | "proof_spine_not_provisioned"
  | "signing_key_not_resolved"
  | "write_transport_not_armed"
  | "provenance_stamping_not_real";

export type ProposeArmingVerdict =
  | { readonly propose: "OFF"; readonly reason: ProposeArmingReason }
  | { readonly propose: "ON" };

/**
 * The composite propose precondition gate (task 22.1). Any ONE precondition absent ⇒ `{propose:'OFF',
 * reason:<first-missing>}`; all five present ⇒ `{propose:'ON'}` — the caller then (and ONLY then) may
 * honor `config.copilotProposeMode`/`config.copilotProposeKnowledge`. Checked in the fixed order above
 * so the reported reason is deterministic and always names the FIRST unmet precondition, never a
 * summary of several. Never throws; takes only booleans, so it cannot itself construct anything.
 */
export function gateProposeArming(p: ProposeArmingPreconditions): ProposeArmingVerdict {
  if (p.contentTrustReal !== true) return { propose: "OFF", reason: "content_trust_not_real" };
  if (p.proofSpineProvisioned !== true) return { propose: "OFF", reason: "proof_spine_not_provisioned" };
  if (p.signingKeyResolved !== true) return { propose: "OFF", reason: "signing_key_not_resolved" };
  if (p.writeTransportArmed !== true) return { propose: "OFF", reason: "write_transport_not_armed" };
  if (p.provenanceStampingReal !== true) return { propose: "OFF", reason: "provenance_stamping_not_real" };
  return { propose: "ON" };
}

/**
 * 13.8i-B — bind the propose-knowledge-approval port onto the proof-spine params, for BOTH the
 * source-ingestion and meeting-closeout paths (one shared port instance, two registered activity names —
 * the `meetingCommit`/`sourceCommit` convention). Runs HERE, alongside {@link withDurableRevisions} /
 * {@link withSubscriptionExtractionArming} — AFTER `backends` is built — because the fresh sink needs
 * `backends.repos.approvals` / `backends.repos.pendingKnowledgeMutations` / `backends.repos.workspaceConfig`
 * / `backends.now`, none of which exist at `buildAutoIngestProofSpineParams`'s desktop-worker-host call
 * site (session 144's open question resolved empirically: a post-processor, not inline construction).
 *
 * DEFAULT-OFF PRESERVED (mirrors `withDurableRevisions`): `proofSpineParams === undefined` (the OFF/
 * absent-config path) ⇒ returned UNCHANGED — the sink is NEVER constructed, `backends` is never touched.
 *
 * ⛔ UNLIKE `withSubscriptionExtractionArming` / `livingVault` / `meetingVault`, THIS BINDS
 * UNCONDITIONALLY — there is NO separate propose-side arming flag, and that is a deliberate, lead-ruled
 * single-gate design (brief 241 v2 decisions 11–12), not an oversight. Binding the sink here mints
 * NOTHING by itself: the driver only ever calls `.propose()` for a `requiresApproval !== false` plan, and
 * today NOTHING produces one — `livingVault`/`meetingVault` rewrite are THEMSELVES still dormant (always
 * an empty plan set, per their own boot-level gates). ⭐ **THE "DEFAULT BOOT MINTS ZERO APPROVAL CARDS"
 * GUARANTEE THEREFORE RESTS ENTIRELY ON THAT UPSTREAM DORMANCY, NOT ON THIS PORT BEING ABSENT.** The
 * moment living-vault/meeting-vault rewrite are armed to actually produce a PROPOSE-tier plan,
 * propose-to-Approvals is live with no separate gate of its own — an operator arming living-vault must
 * read this comment, not assume a second lock protects them.
 */
export function withProposeKnowledgeApproval(
  proofSpineParams: ProofSpineParams | undefined,
  backends: ProofSpineBackends,
): ProofSpineParams | undefined {
  if (proofSpineParams === undefined) return undefined;
  const sink = createApprovalsKnowledgeProposeSink({
    approvals: backends.repos.approvals,
    pendingKmp: backends.repos.pendingKnowledgeMutations,
    workspaceConfig: backends.repos.workspaceConfig,
    now: backends.now,
  });
  return { ...proofSpineParams, proposeKnowledgeApproval: createProposeKnowledgeApprovalPort(sink) };
}

/**
 * Build the persistent {@link BackendsConfig} from the live-boot {@link BootConfig}. PURE +
 * side-effect-free — extracted from `bootWorker` (18.18a) so the drop-regression guard runs in
 * DEFAULT CI without the SOW_API-gated boot.
 *
 * 18.18a — FLIP-WIRING FORWARD: `providerTransport` is now forwarded via conditional-spread mirroring
 * the sibling fields; before this slice it was SILENTLY DROPPED here, so an owner-armed
 * `ProviderTransportGate` never reached `selectProviderRunner`/`selectHealthSources`. Omitting it
 * (the shipped default) keeps `backendsConfig` byte-equivalent to pre-slice ⇒ the deterministic stub
 * runner. NO hard line crossed — the real client is bound by the gate's `make()` at the owner
 * crossing, never here.
 *
 * L52 (load-bearing): `config.healthSources` is NOT forwarded here at all — like the other
 * non-listed BackendsConfig siblings it is dropped by this reconstruction, which is the FAIL-SAFE
 * direction. The real health source rides `gate.healthSource` under `providerTransport` (AND-locked
 * to the same arming); boot therefore structurally CANNOT bind a green `config.healthSources` that
 * would take `??` precedence at backends.ts:794 and re-open the false-green under a real transport.
 */
export function buildBackendsConfig(config: BootConfig): BackendsConfig {
  return {
    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
    ...(config.vaultRoot !== undefined ? { vaultRoot: config.vaultRoot } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.allowedLocalEndpoints !== undefined
      ? { allowedLocalEndpoints: config.allowedLocalEndpoints }
      : {}),
    ...(config.logSink !== undefined ? { logSink: config.logSink } : {}),
    ...(config.providerTransport !== undefined
      ? { providerTransport: config.providerTransport }
      : {}),
    // task 22.1 — forward the write-transport gate unchanged (mirrors `providerTransport` immediately
    // above). Unset ⇒ key ABSENT ⇒ `assembleBackends` keeps the stub transport, byte-equivalent.
    ...(config.writeTransport !== undefined ? { writeTransport: config.writeTransport } : {}),
  };
}

/**
 * Derive the single-owner lock's file path from the boot config (task 11.1/24.1, REQ-D-005, safety
 * rule 1). PURE aside from the tmpdir `mkdtempSync` side effect on the ephemeral branch (unavoidable —
 * the path itself must be freshly unique, and `mkdtempSync` is the only atomic way to mint one).
 *
 * A durable `dbPath` (a real deployment) yields a STABLE path tied to that exact operational-store
 * file: two real worker processes pointed at the SAME `dbPath` collide on the SAME lock path, so the
 * second is physically refused — the intended safety property (a second instance is refused rather
 * than racing the operational store).
 *
 * An UNSET (or explicit `":memory:"`) `dbPath` — the test/dev default `assembleBackends` itself falls
 * back to (`backends.ts`'s own `config.dbPath ?? ":memory:"`) — yields a FRESH, unique tmpdir path on
 * EVERY call, mirroring `BackendsConfig.vaultRoot`'s own "defaults to a fresh tmpdir" contract. This is
 * load-bearing: the default worker-test suite boots dozens of independent `bootWorker()` instances
 * (often concurrently) with no `dbPath` configured, and a single SHARED default lock path would make
 * them all spuriously refuse each other.
 */
/** The canonical brain the one-writer fence guards. A single-user install has exactly
 *  one canonical brain; the fence uses this only to key its alarms. */
const SOW_CANONICAL_BRAIN_ID = "sow-canonical" as BrainId;

export function deriveSingleOwnerLockPath(config: Pick<BootConfig, "dbPath">): string {
  if (config.dbPath !== undefined && config.dbPath !== ":memory:") {
    return `${config.dbPath}.single-owner.lock`;
  }
  return join(mkdtempSync(join(tmpdir(), "sow-single-owner-lock-")), "single-owner.lock");
}

// ── task 25.5 — the REAL ScheduleClientPort adapter (the boot-level wiring scheduleRegistrar.ts's
// own header names as outside its package's territory) ──────────────────────────────────────────

/** The `{type: 'startWorkflow', ...}` action shape the real `@temporalio/client` Schedule API wants. */
interface RealScheduleAction {
  readonly type: "startWorkflow";
  readonly workflowType: string;
  readonly workflowId: string;
  readonly taskQueue: string;
  readonly args: readonly unknown[];
}

function toRealScheduleAction(action: TemporalScheduleSpec["action"]): RealScheduleAction {
  return {
    type: "startWorkflow",
    workflowType: action.workflowType,
    workflowId: action.workflowId,
    taskQueue: action.taskQueue,
    args: action.args,
  };
}

/**
 * The narrow slice of `@temporalio/client`'s `ScheduleClient` surface {@link createRealScheduleClientPort}
 * drives — never the concrete SDK class injected directly, mirroring `createTemporalClientStartRun`'s own
 * narrow-port convention (dispatchSourceIngestion.ts) and `scheduleRegistrar.ts`'s own stated reason for
 * `ScheduleClientPort` existing at all. A real `new Client({connection}).schedule` instance structurally
 * satisfies this (verified against the installed `@temporalio/client@1.19.0` `.d.ts` — `ScheduleClient.
 * getHandle().describe()`/`.update()` and `ScheduleClient.create()`).
 */
export interface RealScheduleClientSurface {
  getHandle(scheduleId: string): {
    describe(): Promise<{ readonly state: { readonly paused: boolean } }>;
    /**
     * ⛔ task F2 — MEASURED against a real ephemeral Temporal server (twice, independently):
     * `afterCreate.paused=true` → `afterUpdate.paused=false` on the prior `state: {}` shape below.
     * The real `@temporalio/client` `ScheduleHandle.update` (`node_modules/.pnpm/@temporalio+
     * client@1.19.0/…/src/schedule-client.ts:74` — `updateFn: (previous: ScheduleDescription) =>
     * ScheduleUpdateOptions<…>`) calls `updateFn` with the schedule's CURRENT description and then
     * REPLACES the whole server-side schedule with whatever `updateFn` returns — there is no
     * partial-merge. proto3 encodes an ABSENT `paused` as its zero-value (`false`), so a `state: {}`
     * update UNPAUSES a paused schedule. `createRealScheduleClientPort.update` (below) reads
     * `previous.state.paused` and echoes it back — a converge PRESERVES whatever pause state the
     * schedule already had; it must never hardcode `true` (would silently RE-PAUSE a schedule the
     * owner had deliberately unpaused) or `false` (this bug, reversed).
     */
    update(
      updateFn: (previous: { readonly state: { readonly paused: boolean } }) => {
        spec: { intervals: { every: number }[] };
        action: RealScheduleAction;
        state: { paused: boolean };
      },
    ): Promise<void>;
  };
  create(options: {
    scheduleId: string;
    spec: { intervals: { every: number }[] };
    action: RealScheduleAction;
    state: { paused: true };
  }): Promise<unknown>;
}

/**
 * Task 25.5 — the REAL `ScheduleClientPort` adapter. `isNotFoundError` is INJECTED rather than an
 * `instanceof ScheduleNotFoundError` baked in here, so this function needs NO static
 * `@temporalio/client` import — boot.ts's own established convention is that every `@temporalio/client`
 * touch in this file is a LAZY dynamic `await import(...)` (see the vault-watcher block below, and this
 * function's own call site); the real caller supplies `(e) => e instanceof ScheduleNotFoundError` from
 * ITS dynamic import. Pure adapter logic — testable over a fake `RealScheduleClientSurface`, no real
 * Temporal server needed (mirrors `scheduleRegistrar.test.ts`'s own fake-port-only discipline).
 */
export function createRealScheduleClientPort(
  client: RealScheduleClientSurface,
  isNotFoundError: (e: unknown) => boolean,
): ScheduleClientPort {
  return {
    async describe(scheduleId: string) {
      try {
        const desc = await client.getHandle(scheduleId).describe();
        return { paused: desc.state.paused };
      } catch (cause) {
        if (isNotFoundError(cause)) return undefined;
        throw cause;
      }
    },
    async create(spec: TemporalScheduleSpec, opts: { readonly paused: true }) {
      await client.create({
        scheduleId: spec.scheduleId,
        spec: { intervals: [{ every: spec.intervalMs }] },
        action: toRealScheduleAction(spec.action),
        state: { paused: opts.paused },
      });
    },
    async update(spec: TemporalScheduleSpec) {
      // ⛔ task F2 fix — PRESERVE the existing pause state across a converge, never send an empty
      // `state`. The real SDK's update-options shape is a full REPLACE, not a merge (see
      // RealScheduleClientSurface's doc above): a `state: {}` update gets proto3's absent-bool
      // zero-value, silently UNPAUSING a paused schedule on the very next `ensure()` (i.e. the
      // SECOND boot of an armed config). Echoing `previous.state.paused` back keeps an
      // already-paused schedule paused and an already-running one running — never a hardcoded
      // value in either direction (that would fight whatever state the OTHER direction left it in).
      await client.getHandle(spec.scheduleId).update((previous) => ({
        spec: { intervals: [{ every: spec.intervalMs }] },
        action: toRealScheduleAction(spec.action),
        state: { paused: previous.state.paused },
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// WP5 — the static schedule envelopes: registry-derived scopes + the pure spec builder
// ---------------------------------------------------------------------------

/**
 * WP5 — the Global/Coordination workspace identity the dailyBrief/periodReview/
 * crossCalendarScheduling static envelopes target absent an owner override. No production
 * Global/Coordination `WorkspaceId` constant exists yet in this codebase to reuse verbatim —
 * the Global/Coordination REPO is a vault SUBTREE the desktop app resolves under the
 * configured vault root (`apps/desktop/main/index.ts`'s own "a single root covers it" note;
 * IMPLEMENTATION_PLAN.md `4815` confirms it is a SoW-managed product repo, not this
 * checkout, and groups it with the WORKSPACE repos rather than a registered `Workspace`
 * row). The closest EXISTING convention is the literal identity this codebase's own
 * daily-brief / period-review workflow test fixtures already use for this exact concept
 * (`packages/workflows/test/support/{daily-brief,period-review}-fakes.ts`'s
 * `GLOBAL_WS = workspaceId("ws-global-coordination")`) — reused here rather than minting a
 * DIFFERENT one. An owner overrides per-schedule via `globalWorkspaceId` / `organizerWorkspaceId`.
 */
export const DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID: WorkspaceId = workspaceId("ws-global-coordination");

/**
 * WP5 — read the WS-2 workspace registry (`READ_MODEL_KEYS.registry`, task 14.1's fail-closed
 * known-workspace union — the SAME row `resolveKnownWorkspace` reads) and project it to the
 * `ScheduledWorkspaceScope[]` shape the dailyBrief/periodReview static envelopes carry.
 * `brainId` is left unset on every scope — the registry holds only bare workspace ids, never a
 * per-workspace GBrain brain id; an owner who needs one supplies `scopes` explicitly via config
 * instead (see {@link buildOutputWorkflowScheduleSpecs}, which prefers an explicit config list
 * over this derivation).
 *
 * Fails CLOSED to `[]` on any fault, absent registry, or malformed payload — never throws. A
 * single malformed entry is skipped rather than fatal to the rest of the set (never invents an
 * id, never drops every OTHER already-valid one for one bad row). A degrade to `[]` cannot
 * itself cause an unscoped write: an empty `scopes` authorizes nothing, so the schedule reads
 * across nothing regardless of its pause state, until the owner populates the registry or an
 * explicit override.
 *
 * ⛔ This deliberately does NOT lean on "it registers paused." That would be an overclaim on the
 * converge branch — a re-`ensure()` PRESERVES the existing pause state, so converging over a
 * schedule an operator unpaused leaves it live. The safety here comes from the EMPTY SCOPE SET
 * authorizing nothing, which holds on both branches. (Pause state itself is preserved by THIS
 * file's {@link createRealScheduleClientPort}`.update`, not by `scheduleRegistrar.ts`'s port
 * shape — see task F2.)
 */
export async function loadRegisteredWorkspaceScopes(
  readModels: ReadModelRepository,
): Promise<readonly ScheduledWorkspaceScope[]> {
  try {
    const result = await readModels.get(READ_MODEL_KEYS.registry, null);
    if (isErr(result)) return [];
    const data = result.value.data;
    if (typeof data !== "object" || data === null) return [];
    const ids = (data as Record<string, unknown>)["workspaceIds"];
    if (!Array.isArray(ids)) return [];
    const scopes: ScheduledWorkspaceScope[] = [];
    for (const raw of ids) {
      if (typeof raw !== "string" || raw.length === 0) continue;
      try {
        scopes.push({ workspaceId: workspaceId(raw) });
      } catch {
        // A malformed registry entry is skipped — never fatal to the rest of the set.
      }
    }
    return scopes;
  } catch {
    // A store fault degrades to no authorized scopes — never throws, never invents (§16 / rule 2).
    return [];
  }
}

/**
 * ⛔ task F3 — the closed set of families whose static envelope carries an owner-configurable
 * `WorkspaceId` override (`globalWorkspaceId`/`organizerWorkspaceId`). Reported to an injected
 * `onSkip` hook (see {@link buildOutputWorkflowScheduleSpecs}) when that override fails to brand.
 */
export type OutputWorkflowScheduleSkipFamily =
  | "ingestionTriage"
  | "projectSync"
  | "dailyBrief"
  | "periodReviewWeekly"
  | "periodReviewMonthly"
  | "crossCalendarScheduling";

/**
 * ⛔ task F3 — a family's envelope was skipped rather than built; see {@link resolveScheduleWorkspaceId}.
 * ⛔ task D2b extends the closed code set beyond the workspace-id override: `intervalMs` /
 * `catchUpWindowMs` (validated by {@link resolveScheduleDurationMs}) and `scopes` / `sources`
 * (validated by {@link resolveScheduleScopes} / {@link resolveScheduleSources}) get the SAME
 * fail-closed skip treatment — the whole config block is one envelope, so every field that can
 * reach a durable schedule unvalidated needs the same standard, not just the id.
 * ⛔ task M3c extends it once more: `config_access_threw` covers a family whose `*Schedule` config
 * BLOCK itself raised while being read (a hostile/proxied object — a throwing `enabled`/`intervalMs`
 * getter, or a throwing `workspaceId` getter on a `scopes` entry — none reachable from a JSON config
 * file today, so this is defense-in-depth, not a live gap). Every OTHER code names a specific field
 * that failed VALIDATION; this one names a family whose config could not even be READ — the two are
 * kept distinct rather than folding the throw into e.g. `invalid_interval_ms`, since at the point the
 * catch fires this function cannot know which accessor threw.
 */
export interface OutputWorkflowScheduleSkip {
  readonly family: OutputWorkflowScheduleSkipFamily;
  readonly code:
    | "invalid_workspace_id"
    | "invalid_interval_ms"
    | "invalid_catch_up_window_ms"
    | "invalid_scopes"
    | "invalid_sources"
    | "config_access_threw";
}

/**
 * ⛔ task W3b — the accurate, operator-facing message PER skip code. A single hardcoded string
 * ("workspace-id override is malformed") used to fire for all five {@link OutputWorkflowScheduleSkip}
 * codes once task D2b widened the closed set beyond the workspace-id override — naming the WRONG
 * config field for four of them (an `invalid_interval_ms` skip told the operator to fix a workspace
 * id). A closed `Record` keyed by the skip code — TypeScript enforces every code has an entry — so a
 * future sixth code fails to compile rather than silently inheriting the wrong message. No free-text
 * interpolation of owner-supplied config values anywhere (rule 7 — the raw configured value is never
 * named, only which STATIC field failed).
 */
const SCHEDULE_SKIP_MESSAGE: Record<OutputWorkflowScheduleSkip["code"], string> = {
  invalid_workspace_id:
    "An owner-configured schedule workspace-id override is malformed — this schedule family " +
    "registers no durable schedule until the id is corrected (rule 7 — the raw configured id is " +
    "never logged).",
  invalid_interval_ms:
    "An owner-configured schedule interval (intervalMs) is not a safely-representable positive " +
    "integer millisecond count — this schedule family registers no durable schedule until the " +
    "value is corrected (rule 7 — the raw configured value is never logged).",
  invalid_catch_up_window_ms:
    "An owner-configured schedule catch-up window (catchUpWindowMs) is not a safely-representable " +
    "positive integer millisecond count — this schedule family registers no durable schedule until " +
    "the value is corrected (rule 7 — the raw configured value is never logged).",
  invalid_scopes:
    "An owner-configured schedule scopes override is malformed — this schedule family registers " +
    "no durable schedule until the value is corrected (rule 7 — the raw configured value is never " +
    "logged).",
  invalid_sources:
    "An owner-configured schedule sources override is malformed — this schedule family registers " +
    "no durable schedule until the value is corrected (rule 7 — the raw configured value is never " +
    "logged).",
  config_access_threw:
    "An owner-configured schedule config block raised an unexpected error while being read (a " +
    "hostile or proxied config object) — this schedule family registers no durable schedule until " +
    "the config is corrected (rule 7 — no raw error detail is logged).",
};

/** The operator-facing message for one skip code — see {@link SCHEDULE_SKIP_MESSAGE}. */
export function scheduleSkipHealthMessage(code: OutputWorkflowScheduleSkip["code"]): string {
  return SCHEDULE_SKIP_MESSAGE[code];
}

// ⛔ task W3c — a redaction-SAFE representation of an {@link OutputWorkflowScheduleSkip} for the
// structured log line. @sow/domain's field-level redactor (packages/domain/src/redaction) admits a
// `fields.<name>` value ONLY when `<name>` is on its closed field-name allowlist AND the value is a
// PROVABLE member of that field's own frozen vocabulary — this file cannot extend either (both live
// in a package outside this task's owned files). Measured against the ORIGINAL shape
// (`fields: { code: skip.code, family: skip.family }`): `family` is not an allowlisted field name at
// all ⇒ dropped whole (`REDACTED_FIELD`); `code` IS allowlisted, but its vocabulary for the `code`
// field accepts only a `STRUCTURED_CODE`-shaped UPPER_SNAKE token (e.g. `REVISION_STALE`) or a known
// enum member — `skip.code`'s lower_snake literals (`invalid_workspace_id`) match neither ⇒
// `REDACTED_RAW`. Both fields vanish; an operator sees N identical warn lines.
//
// The fix reuses that SAME already-established `code`/STRUCTURED_CODE pass-through — no redactor
// change — by folding BOTH the family and the reason into ONE UPPER_SNAKE `code` value (e.g.
// `DAILY_BRIEF_INVALID_WORKSPACE_ID`). `skip.code`/`skip.family` themselves are UNCHANGED (other
// suites pin their literal lower_snake/camelCase values); this mapping exists only at the log
// boundary. A bare `family` field is deliberately NOT sent — it would still be silently dropped by
// the allowlist gate, so sending it would only add a confusing always-`[REDACTED:field-dropped]` key.
const SCHEDULE_SKIP_FAMILY_LOG_PREFIX: Record<OutputWorkflowScheduleSkipFamily, string> = {
  ingestionTriage: "INGESTION_TRIAGE",
  projectSync: "PROJECT_SYNC",
  dailyBrief: "DAILY_BRIEF",
  periodReviewWeekly: "PERIOD_REVIEW_WEEKLY",
  periodReviewMonthly: "PERIOD_REVIEW_MONTHLY",
  crossCalendarScheduling: "CROSS_CALENDAR_SCHEDULING",
};

const SCHEDULE_SKIP_CODE_LOG_SUFFIX: Record<OutputWorkflowScheduleSkip["code"], string> = {
  invalid_workspace_id: "INVALID_WORKSPACE_ID",
  invalid_interval_ms: "INVALID_INTERVAL_MS",
  invalid_catch_up_window_ms: "INVALID_CATCH_UP_WINDOW_MS",
  invalid_scopes: "INVALID_SCOPES",
  invalid_sources: "INVALID_SOURCES",
  config_access_threw: "CONFIG_ACCESS_THREW",
};

/**
 * Build the redaction-safe combined `code` for one skip (see the block comment above). Both maps
 * are closed, hand-written UPPER_SNAKE literals with no owner-supplied input, so the concatenation
 * is guaranteed BY CONSTRUCTION — not by a runtime regex test here — to match
 * `@sow/domain`'s `STRUCTURED_CODE`; that guarantee is pinned directly against the real redactor in
 * outputWorkflowSchedulesBind.test.ts.
 */
export function scheduleSkipLogCode(skip: OutputWorkflowScheduleSkip): string {
  return `${SCHEDULE_SKIP_FAMILY_LOG_PREFIX[skip.family]}_${SCHEDULE_SKIP_CODE_LOG_SUFFIX[skip.code]}`;
}

// ⛔ task M3a — the SAME `code`/STRUCTURED_CODE pass-through fixes the registrar-side log sites
// (`schedule.ensure_failed` / `schedule.ensured`) that `scheduleSkipLogCode` above already gave the
// builder-side skip. Measured against the ORIGINAL shape (`fields: { code: outcome.error.code,
// scheduleId: spec.scheduleId }` / `fields: { action: outcome.value.action, scheduleId:
// spec.scheduleId } }`): `scheduleId` and `action` are not on @sow/domain's field-name allowlist AT
// ALL ⇒ dropped whole (`REDACTED:field-dropped`) regardless of value; `code`'s frozen vocabulary for
// the `code` field only admits an UPPER_SNAKE `STRUCTURED_CODE` token (or a known enum member) —
// `outcome.error.code` (`"schedule_client_fault"`, lower_snake) matches neither ⇒
// `REDACTED:raw`. An operator watching these two lines could not tell WHICH schedule succeeded,
// failed, or why.
//
// Fold `scheduleId` + the reason (the registrar's error code, or the create/update action) into ONE
// UPPER_SNAKE `code` value, exactly as `scheduleSkipLogCode` does for family+code. `scheduleId`/
// `action`/`ScheduleRegistrarErrorCode` themselves are UNCHANGED — this mapping exists only at the
// log boundary. A bare `scheduleId` field is deliberately NOT also sent (same reasoning as the bare
// `family` field above: the allowlist drops it unconditionally, so sending it only adds a confusing
// always-redacted key).
//
// `spec.scheduleId`'s CONTRACT TYPE ({@link TemporalScheduleSpec.scheduleId}) is a plain `string`,
// not a literal union — this file's OWN builder only ever constructs one of the six SCHEDULE_ID
// constants below, but that is a fact about THIS file's callers, not a compile-time guarantee at
// this function's boundary. So the id→token lookup is a runtime `Map` with a fail-CLOSED fallback
// (`UNKNOWN_SCHEDULE`) for anything outside the closed six — never a pass-through of an arbitrary
// scheduleId string, which (unlike the six hand-written constants) is not provably owner-data-free.
const SCHEDULE_ID_LOG_TOKEN: ReadonlyMap<string, string> = new Map([
  [INGESTION_TRIAGE_SCHEDULE_ID, "INGESTION_TRIAGE"],
  [PROJECT_SYNC_SCHEDULE_ID, "PROJECT_SYNC"],
  [DAILY_BRIEF_SCHEDULE_ID, "DAILY_BRIEF"],
  [PERIOD_REVIEW_WEEKLY_SCHEDULE_ID, "PERIOD_REVIEW_WEEKLY"],
  [PERIOD_REVIEW_MONTHLY_SCHEDULE_ID, "PERIOD_REVIEW_MONTHLY"],
  [CROSS_CALENDAR_SCHEDULING_SCHEDULE_ID, "CROSS_CALENDAR_SCHEDULING"],
]);

/** Fail-closed token for a `scheduleId` outside the known six — never the raw id (rule 7). */
const SCHEDULE_ID_LOG_TOKEN_UNKNOWN = "UNKNOWN_SCHEDULE";

function scheduleIdLogToken(scheduleId: string): string {
  return SCHEDULE_ID_LOG_TOKEN.get(scheduleId) ?? SCHEDULE_ID_LOG_TOKEN_UNKNOWN;
}

// A closed `Record` keyed by the registrar's own closed error-code union — TypeScript enforces every
// member has an UPPER_SNAKE log token, so a future new `ScheduleRegistrarErrorCode` member fails to
// compile here rather than silently falling through to nothing.
const SCHEDULE_REGISTRAR_ERROR_CODE_LOG_SUFFIX: Record<ScheduleRegistrarErrorCode, string> = {
  schedule_client_fault: "SCHEDULE_CLIENT_FAULT",
};

/**
 * Build the redaction-safe combined `code` for a `schedule.ensure_failed` log line — folds WHICH
 * schedule (by its closed identity token) and WHY (the registrar's own closed error-code union)
 * into one UPPER_SNAKE token that survives `@sow/domain`'s field-level redactor under `code`.
 */
export function scheduleEnsureFailedLogCode(scheduleId: string, code: ScheduleRegistrarErrorCode): string {
  return `${scheduleIdLogToken(scheduleId)}_${SCHEDULE_REGISTRAR_ERROR_CODE_LOG_SUFFIX[code]}`;
}

// A closed `Record` keyed by the registrar's own closed action union (`"created" | "updated"`) —
// same exhaustiveness guarantee as the error-code map above.
const SCHEDULE_ENSURE_ACTION_LOG_SUFFIX: Record<EnsureOutcome["action"], string> = {
  created: "CREATED",
  updated: "UPDATED",
};

/**
 * Build the redaction-safe combined `code` for a `schedule.ensured` log line — folds WHICH schedule
 * and the create/update action into one UPPER_SNAKE token, mirroring
 * {@link scheduleEnsureFailedLogCode} exactly.
 */
export function scheduleEnsuredLogCode(scheduleId: string, action: EnsureOutcome["action"]): string {
  return `${scheduleIdLogToken(scheduleId)}_${SCHEDULE_ENSURE_ACTION_LOG_SUFFIX[action]}`;
}

/**
 * ⛔ task F3 fix — resolve a schedule family's optional `WorkspaceId` override WITHOUT ever
 * branding a malformed id on the DISARMED path. The prior shape evaluated
 * `workspaceId(config.X.globalWorkspaceId)` as an ARGUMENT expression feeding the `gate*Schedule`
 * call — JS evaluates every object-literal property before the function itself runs, and the
 * gate's own `enabled !== true` early return lives INSIDE the gate, one level too late — so a
 * `enabled: false` config carrying a malformed override string still threw `InvalidIdError` and
 * crashed `bootWorker()` (measured for `""`, whitespace-only, `"Not A Slug!"`, a `../../etc`
 * traversal string, and a 500-char id, across all three id-bearing families).
 *
 * `enabled !== true` short-circuits BEFORE `workspaceId()` ever runs — a disarmed family's
 * envelope is never branded (mirrors the gate's own `enabled !== true → undefined` guard rather
 * than diverging from it). On the ARMED path a malformed override folds to a typed `{ ok: false }`
 * instead of throwing (§16 — degrade and surface, never crash; worker LESSONS §52) — the caller
 * skips that family's spec (contributing zero schedules for it, not for the others) and reports
 * the skip via the injected `onSkip` hook rather than letting the whole collected build blow up.
 */
function resolveScheduleWorkspaceId(
  enabled: boolean,
  configured: string | undefined,
  fallback: WorkspaceId,
): { readonly ok: true; readonly value: WorkspaceId } | { readonly ok: false } {
  if (enabled !== true || configured === undefined) return { ok: true, value: fallback };
  try {
    return { ok: true, value: workspaceId(configured) };
  } catch {
    return { ok: false };
  }
}

/**
 * ⛔ task D2b fix — resolve a schedule family's `intervalMs`/`catchUpWindowMs` (the SAME numeric
 * shape — both feed a durable schedule's cadence, `intervalMs` directly and `catchUpWindowMs` as
 * the LIFE-2 collapse window) with the identical fail-closed discipline
 * {@link resolveScheduleWorkspaceId} already applies to a workspace-id override: disarmed ⇒ the
 * OWNER-supplied `configured` value is never inspected (mirrors `resolveScheduleWorkspaceId`'s own
 * "never brand on the disarmed path" discipline — a disarmed family's config is never even
 * inspected); armed with an explicit override ⇒ anything other than a finite, positive `number`
 * folds to a typed `{ ok: false }` instead of reaching `spec.intervals[0].every` (the real Temporal
 * schedule's tick cadence) or a derived `catchUpWindowMs` as durable garbage. MEASURED at the real
 * `bootWorker`: `NaN`, `-1`, and `"abc"` (TypeScript's compile-time `number` type is not a runtime
 * guarantee once a config is assembled from parsed/external input, same class of gap F3 closed for
 * the workspace-id override) each previously registered a schedule with a nonsense cadence,
 * silently.
 *
 * ⛔ task W3d — bounded to a SAFELY-REPRESENTABLE integer-millisecond range. Temporal encodes a
 * Duration as an int64 count of NANOSECONDS; converting a millisecond `number` to nanoseconds
 * multiplies by 1e6, and JS represents an integer EXACTLY only up to `Number.MAX_SAFE_INTEGER`
 * (2^53-1) — past {@link MAX_REPRESENTABLE_SCHEDULE_DURATION_MS} the ms→ns conversion itself loses
 * precision, and far past it (MEASURED: `intervalMs: Number.MAX_VALUE`) overflows int64 outright,
 * registering a durable spec of `{ every: 1.7976931348623157e+308 }` — ~290 orders of magnitude past
 * representable. `Number.isSafeInteger` also rejects a fractional millisecond (MEASURED: `1.5`,
 * `0.0001` previously registered unchanged) — this unit has no sub-millisecond representation here.
 *
 * ⛔ task M3b fix — the FALLBACK is validated by the SAME rule, not returned verbatim. The prior
 * shape validated `configured` but returned `fallback` UNCHECKED whenever `configured` was absent —
 * `fallback` is caller-computed, not owner-supplied, but that does not make it automatically safe:
 * the dailyBrief/periodReview call sites below derive their `catchUpWindowMs` fallback as
 * `2 * <this family's own resolved intervalMs>`, so an ARMED family whose resolved `intervalMs`
 * lands in `(MAX_REPRESENTABLE_SCHEDULE_DURATION_MS / 2, MAX_REPRESENTABLE_SCHEDULE_DURATION_MS]`
 * derives a doubled fallback catch-up window PAST the very bound this function exists to enforce —
 * the bound-check on `configured` alone did nothing to stop that, since `catchUpWindowMs` was never
 * configured at all on that path. `candidate` below selects `configured` ONLY when armed AND an
 * override is present — the disarmed short-circuit itself is UNCHANGED, so a disarmed family's
 * hostile `configured` is still never inspected (pinned by
 * scheduleFieldValidation.test.ts's mutation-proven disarmed-path invariant); only the value this
 * function is ABOUT TO RETURN is now always checked against the same bound.
 */
const MAX_REPRESENTABLE_SCHEDULE_DURATION_MS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);

function resolveScheduleDurationMs(
  enabled: boolean,
  configured: number | undefined,
  fallback: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false } {
  const candidate = enabled === true && configured !== undefined ? configured : fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0 ||
    candidate > MAX_REPRESENTABLE_SCHEDULE_DURATION_MS
  ) {
    return { ok: false };
  }
  return { ok: true, value: candidate };
}

/**
 * ⛔ task D2b fix — resolve the dailyBrief/periodReview families' `scopes` override with the same
 * discipline as {@link resolveScheduleWorkspaceId}: disarmed ⇒ never validated (fallback
 * verbatim); armed ⇒ anything other than an array of well-formed {@link ScheduledWorkspaceScope}
 * entries folds to a typed `{ ok: false }` rather than reaching the durable schedule's
 * `action.args` envelope as-is (MEASURED: `scopes: "not-an-array"` reached it unfiltered). Each
 * entry's `workspaceId` is re-branded through the SAME `workspaceId()` guard
 * {@link loadRegisteredWorkspaceScopes} already uses — one malformed entry invalidates the WHOLE
 * override (never a silent partial drop like the registry reader's own best-effort skip; an
 * owner-supplied override is presumed deliberate, so a bad entry inside it is a config error worth
 * surfacing, not quietly discarding).
 */
function resolveScheduleScopes(
  enabled: boolean,
  configured: readonly ScheduledWorkspaceScope[] | undefined,
  fallback: readonly ScheduledWorkspaceScope[],
): { readonly ok: true; readonly value: readonly ScheduledWorkspaceScope[] } | { readonly ok: false } {
  if (enabled !== true || configured === undefined) return { ok: true, value: fallback };
  if (!Array.isArray(configured)) return { ok: false };
  const scopes: ScheduledWorkspaceScope[] = [];
  for (const raw of configured) {
    if (raw === null || typeof raw !== "object") return { ok: false };
    const candidate = raw as Record<string, unknown>;
    const candidateWorkspaceId = candidate["workspaceId"];
    const candidateBrainId = candidate["brainId"];
    if (typeof candidateWorkspaceId !== "string") return { ok: false };
    if (candidateBrainId !== undefined && typeof candidateBrainId !== "string") return { ok: false };
    try {
      scopes.push(
        candidateBrainId === undefined
          ? { workspaceId: workspaceId(candidateWorkspaceId) }
          : { workspaceId: workspaceId(candidateWorkspaceId), brainId: candidateBrainId },
      );
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: scopes };
}

/**
 * ⛔ task D2b fix — resolve the crossCalendarScheduling family's `sources` override. Same
 * discipline as {@link resolveScheduleScopes} (disarmed ⇒ never validated; armed ⇒ a non-array or
 * a malformed entry folds to `{ ok: false }` rather than reaching `action.args` as-is — MEASURED:
 * `sources: "nope"` reached it unfiltered).
 */
function resolveScheduleSources(
  enabled: boolean,
  configured: readonly ScheduledAvailabilitySource[] | undefined,
  fallback: readonly ScheduledAvailabilitySource[],
): { readonly ok: true; readonly value: readonly ScheduledAvailabilitySource[] } | { readonly ok: false } {
  if (enabled !== true || configured === undefined) return { ok: true, value: fallback };
  if (!Array.isArray(configured)) return { ok: false };
  const sources: ScheduledAvailabilitySource[] = [];
  for (const raw of configured) {
    if (raw === null || typeof raw !== "object") return { ok: false };
    const candidate = raw as Record<string, unknown>;
    const candidateSourceId = candidate["sourceId"];
    const candidateWorkspaceId = candidate["workspaceId"];
    if (typeof candidateSourceId !== "string" || candidateSourceId.length === 0) return { ok: false };
    if (typeof candidateWorkspaceId !== "string") return { ok: false };
    try {
      sources.push({ sourceId: candidateSourceId, workspaceId: workspaceId(candidateWorkspaceId) });
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: sources };
}

/**
 * tasks 25.2/25.3/25.4/25.5 (WP5) — pure builder for the collected output-workflow schedule
 * spec set. Each family reads its OWN independent `gate*Schedule` AND-lock (strict `=== true`,
 * worker LESSONS §2/§28) so arming one family never arms another — this function performs NO
 * I/O and constructs nothing beyond what each gate itself decides to build on its own armed
 * path. Extracted as a PURE, side-effect-free function (worker LESSONS §23 — "split the pure
 * helper from the composition-root edit") so the "0 schedules on an unconfigured boot" and "an
 * armed family's static envelope matches config" invariants are unit-testable WITHOUT booting
 * the whole worker (no DB / vault / Temporal connect needed) — `bootWorker` calls this ONCE and
 * only performs the I/O (the `registrar.ensure` loop) over whatever this returns.
 *
 * `registryScopes` is the WS-2 authorized workspace set the composition root's own workspace
 * registry already holds (see {@link loadRegisteredWorkspaceScopes}) — the DEFAULT `scopes` for
 * the dailyBrief/periodReview families absent an explicit owner override. It is NOT read here
 * (I/O stays in `bootWorker`); this function only composes the already-resolved value.
 *
 * `onSkip` (task F3, OPTIONAL — this function stays pure; the hook itself may do I/O, but calling
 * it is a synchronous notification, not a fetch/await this function performs) is invoked once per
 * family whose envelope could not be built because ONE OF ITS CONFIG FIELDS failed validation —
 * originally just the workspace-id override (see {@link resolveScheduleWorkspaceId}), task D2b
 * extends this to every field that can reach a durable schedule unvalidated: `intervalMs` /
 * `catchUpWindowMs` ({@link resolveScheduleDurationMs}) and `scopes` / `sources`
 * ({@link resolveScheduleScopes} / {@link resolveScheduleSources}). Omitted ⇒ the skip is silent
 * but the function still never throws and still contributes zero schedules for that family.
 *
 * ⛔ task M3c — "never throws" is enforced BY the per-family `try`/`catch` wrapping each block
 * below, not merely by the validation helpers' own discipline: `config.<x>Schedule?.<field>` are
 * plain property reads this function does not control, so a hostile/proxied `BootConfig` (a
 * throwing `enabled`/`intervalMs` getter, or a throwing `workspaceId` getter on a `scopes` entry)
 * would otherwise escape past every helper's own never-throwing contract and abort this function —
 * and every family queued AFTER the one that threw — entirely. Each family's catch reports
 * `config_access_threw` for THAT family only and lets the remaining families proceed, mirroring the
 * per-family isolation every other D2b skip already gives a malformed (non-throwing) VALUE. Not
 * reachable from a JSON config file today (defense-in-depth), but this function's own doc claimed
 * "never throws" before this existed, so the claim is now backed by an actual mechanism rather than
 * "no test has found a throw yet."
 *
 * The `ingestionTriage`/`projectSync` gate calls below still build NO static envelope (WP5's scope
 * deliberately excludes those two families — each needs a per-tick fan-out workflow that does not
 * exist yet) — only their `intervalMs` gained D2b's fail-closed validation, same as every other
 * family; the gate calls themselves and their `args: []` shape are otherwise untouched.
 */
export function buildOutputWorkflowScheduleSpecs(
  config: BootConfig,
  taskQueue: SowTaskQueue,
  registryScopes: readonly ScheduledWorkspaceScope[],
  onSkip?: (skip: OutputWorkflowScheduleSkip) => void,
): TemporalScheduleSpec[] {
  const specs: TemporalScheduleSpec[] = [];

  // task 25.5 — ingestionTriage. ⛔ task D2b — intervalMs now gets the SAME fail-closed validation
  // the workspace-id override already had (F3): a non-finite/non-positive/non-number value SKIPS
  // this family (typed onSkip) instead of reaching `spec.intervals[0].every` as durable garbage.
  // ⛔ task M3c — the WHOLE block is wrapped: `config.ingestionTriageSchedule?.enabled`/`.intervalMs`
  // are plain property reads, not calls this function controls — a hostile config object (a throwing
  // getter) would otherwise escape this function entirely (§16), aborting every family that runs
  // AFTER it too. A caught throw here degrades to a typed skip for THIS family only; siblings are
  // unaffected (same per-family isolation every other D2b skip already gives a malformed VALUE).
  try {
    const ingestionTriageEnabled = config.ingestionTriageSchedule?.enabled === true;
    const ingestionTriageIntervalMs = resolveScheduleDurationMs(
      ingestionTriageEnabled,
      config.ingestionTriageSchedule?.intervalMs,
      6 * 60 * 60 * 1000,
    );
    if (!ingestionTriageIntervalMs.ok) {
      onSkip?.({ family: "ingestionTriage", code: "invalid_interval_ms" });
    } else {
      const ingestionTriageScheduleSpec = gateIngestionTriageSchedule({
        enabled: ingestionTriageEnabled,
        taskQueue,
        intervalMs: ingestionTriageIntervalMs.value,
      });
      if (ingestionTriageScheduleSpec !== undefined) specs.push(ingestionTriageScheduleSpec);
    }
  } catch {
    onSkip?.({ family: "ingestionTriage", code: "config_access_threw" });
  }

  // task 25.3 — projectSync. `gateProjectSyncSchedule` + its spec builder landed at `1322f74d`;
  // untouched by WP5 (out of scope this wave, per this function's own header). Same D2b interval
  // validation as ingestionTriage above.
  // ⛔ task M3c — same per-family throw containment as ingestionTriage above.
  try {
    const projectSyncEnabled = config.projectSyncSchedule?.enabled === true;
    const projectSyncIntervalMs = resolveScheduleDurationMs(
      projectSyncEnabled,
      config.projectSyncSchedule?.intervalMs,
      60 * 60 * 1000,
    );
    if (!projectSyncIntervalMs.ok) {
      onSkip?.({ family: "projectSync", code: "invalid_interval_ms" });
    } else {
      const projectSyncScheduleSpec = gateProjectSyncSchedule({
        enabled: projectSyncEnabled,
        taskQueue,
        intervalMs: projectSyncIntervalMs.value,
      });
      if (projectSyncScheduleSpec !== undefined) specs.push(projectSyncScheduleSpec);
    }
  } catch {
    onSkip?.({ family: "projectSync", code: "config_access_threw" });
  }

  // task 25.2 — dailyBrief (daily cadence). WP5: real `catchUpWindowMs`/`globalWorkspaceId`/
  // `scopes` feed the static envelope (§16 frozen contract, scheduleArgs.ts). ⛔ task D2b —
  // `intervalMs`/`catchUpWindowMs`/`scopes` now get the SAME fail-closed validation
  // `globalWorkspaceId` already had (F3) — the four fields are one config envelope; validating
  // only the id left a typo in any of the other three silently registering a durable schedule with
  // a garbage cadence or a malformed `action.args` (MEASURED: NaN/-1/"abc" intervalMs, a
  // non-array scopes).
  // ⛔ task M3c — the WHOLE dailyBrief block is wrapped: this also contains the ONLY call site in
  // this function where a hostile `scopes` ENTRY (a throwing `workspaceId`/`brainId` getter) can
  // surface — `resolveScheduleScopes` iterates the array and reads those properties synchronously,
  // so a throw there propagates up through this same try, caught here rather than escaping the
  // function (no separate wrap needed inside `resolveScheduleScopes` itself).
  try {
    const dailyBriefEnabled = config.dailyBriefSchedule?.enabled === true;
    const dailyBriefIntervalMs = resolveScheduleDurationMs(
      dailyBriefEnabled,
      config.dailyBriefSchedule?.intervalMs,
      24 * 60 * 60 * 1000,
    );
    // ⛔ task F3 — resolved BEFORE the gate call so a malformed override on a DISARMED family is
    // never branded (see resolveScheduleWorkspaceId's own doc).
    const dailyBriefGlobalWorkspaceId = resolveScheduleWorkspaceId(
      dailyBriefEnabled,
      config.dailyBriefSchedule?.globalWorkspaceId,
      DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID,
    );
    // `catchUpWindowMs`'s own default rides the RESOLVED interval (2x) — only computable once
    // `dailyBriefIntervalMs` itself resolved ok; a bad interval short-circuits catchUpWindowMs
    // resolution too rather than defaulting off a garbage base.
    const dailyBriefCatchUpWindowMs: { readonly ok: true; readonly value: number } | { readonly ok: false } =
      dailyBriefIntervalMs.ok
        ? resolveScheduleDurationMs(
            dailyBriefEnabled,
            config.dailyBriefSchedule?.catchUpWindowMs,
            2 * dailyBriefIntervalMs.value,
          )
        : { ok: false };
    const dailyBriefScopes = resolveScheduleScopes(
      dailyBriefEnabled,
      config.dailyBriefSchedule?.scopes,
      registryScopes,
    );

    if (!dailyBriefIntervalMs.ok) {
      onSkip?.({ family: "dailyBrief", code: "invalid_interval_ms" });
    } else if (!dailyBriefGlobalWorkspaceId.ok) {
      onSkip?.({ family: "dailyBrief", code: "invalid_workspace_id" });
    } else if (!dailyBriefCatchUpWindowMs.ok) {
      onSkip?.({ family: "dailyBrief", code: "invalid_catch_up_window_ms" });
    } else if (!dailyBriefScopes.ok) {
      onSkip?.({ family: "dailyBrief", code: "invalid_scopes" });
    } else {
      const dailyBriefScheduleSpec = gateDailyBriefSchedule({
        enabled: dailyBriefEnabled,
        taskQueue,
        intervalMs: dailyBriefIntervalMs.value,
        catchUpWindowMs: dailyBriefCatchUpWindowMs.value,
        globalWorkspaceId: dailyBriefGlobalWorkspaceId.value,
        scopes: dailyBriefScopes.value,
      });
      if (dailyBriefScheduleSpec !== undefined) specs.push(dailyBriefScheduleSpec);
    }
  } catch {
    onSkip?.({ family: "dailyBrief", code: "config_access_threw" });
  }

  // task 25.2 — periodReview, weekly AND monthly cadences. ONE owner flag
  // (`config.periodReviewSchedule.enabled`) arms BOTH — two independent schedule specs (distinct
  // scheduleId, SAME workflowType), never collapsed into one; each cadence's own catch-up window
  // defaults off ITS OWN resolved interval, never the other cadence's (WP5). ⛔ task D2b — same
  // 4-field validation as dailyBrief; EACH cadence resolves its OWN `intervalMs`
  // (`weeklyIntervalMs`/`monthlyIntervalMs` — a bad one skips ONLY that cadence, the two are
  // independent AND-locks per the module's own doc), while `catchUpWindowMs`/`globalWorkspaceId`/
  // `scopes` are SHARED — a malformed shared field skips BOTH cadences (mirrors F3's existing
  // `globalWorkspaceId` behavior).
  // ⛔ task M3c — the WHOLE periodReview block is wrapped. A shared-config throw skips BOTH
  // cadences (mirroring how a shared `invalid_workspace_id`/`invalid_scopes` already skips both
  // above) — the two `onSkip` calls in the `catch` are unconditional rather than trying to guess
  // which cadence's own accessor threw, matching this block's existing shared-field convention.
  try {
    const periodReviewEnabled = config.periodReviewSchedule?.enabled === true;
    const periodReviewWeeklyIntervalMs = resolveScheduleDurationMs(
      periodReviewEnabled,
      config.periodReviewSchedule?.weeklyIntervalMs,
      7 * 24 * 60 * 60 * 1000,
    );
    const periodReviewMonthlyIntervalMs = resolveScheduleDurationMs(
      periodReviewEnabled,
      config.periodReviewSchedule?.monthlyIntervalMs,
      30 * 24 * 60 * 60 * 1000,
    );
    // ⛔ task F3 — BOTH cadences share this one resolved id; a malformed override skips BOTH specs
    // (they'd otherwise disagree on which workspace the review targets).
    const periodReviewGlobalWorkspaceId = resolveScheduleWorkspaceId(
      periodReviewEnabled,
      config.periodReviewSchedule?.globalWorkspaceId,
      DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID,
    );
    const periodReviewScopes = resolveScheduleScopes(
      periodReviewEnabled,
      config.periodReviewSchedule?.scopes,
      registryScopes,
    );

    if (!periodReviewGlobalWorkspaceId.ok) {
      onSkip?.({ family: "periodReviewWeekly", code: "invalid_workspace_id" });
      onSkip?.({ family: "periodReviewMonthly", code: "invalid_workspace_id" });
    } else if (!periodReviewScopes.ok) {
      onSkip?.({ family: "periodReviewWeekly", code: "invalid_scopes" });
      onSkip?.({ family: "periodReviewMonthly", code: "invalid_scopes" });
    } else {
      if (!periodReviewWeeklyIntervalMs.ok) {
        onSkip?.({ family: "periodReviewWeekly", code: "invalid_interval_ms" });
      } else {
        const periodReviewWeeklyCatchUpWindowMs = resolveScheduleDurationMs(
          periodReviewEnabled,
          config.periodReviewSchedule?.catchUpWindowMs,
          2 * periodReviewWeeklyIntervalMs.value,
        );
        if (!periodReviewWeeklyCatchUpWindowMs.ok) {
          onSkip?.({ family: "periodReviewWeekly", code: "invalid_catch_up_window_ms" });
        } else {
          const periodReviewWeeklyScheduleSpec = gatePeriodReviewWeeklySchedule({
            enabled: periodReviewEnabled,
            taskQueue,
            intervalMs: periodReviewWeeklyIntervalMs.value,
            catchUpWindowMs: periodReviewWeeklyCatchUpWindowMs.value,
            globalWorkspaceId: periodReviewGlobalWorkspaceId.value,
            scopes: periodReviewScopes.value,
          });
          if (periodReviewWeeklyScheduleSpec !== undefined) specs.push(periodReviewWeeklyScheduleSpec);
        }
      }

      if (!periodReviewMonthlyIntervalMs.ok) {
        onSkip?.({ family: "periodReviewMonthly", code: "invalid_interval_ms" });
      } else {
        const periodReviewMonthlyCatchUpWindowMs = resolveScheduleDurationMs(
          periodReviewEnabled,
          config.periodReviewSchedule?.catchUpWindowMs,
          2 * periodReviewMonthlyIntervalMs.value,
        );
        if (!periodReviewMonthlyCatchUpWindowMs.ok) {
          onSkip?.({ family: "periodReviewMonthly", code: "invalid_catch_up_window_ms" });
        } else {
          const periodReviewMonthlyScheduleSpec = gatePeriodReviewMonthlySchedule({
            enabled: periodReviewEnabled,
            taskQueue,
            intervalMs: periodReviewMonthlyIntervalMs.value,
            catchUpWindowMs: periodReviewMonthlyCatchUpWindowMs.value,
            globalWorkspaceId: periodReviewGlobalWorkspaceId.value,
            scopes: periodReviewScopes.value,
          });
          if (periodReviewMonthlyScheduleSpec !== undefined) specs.push(periodReviewMonthlyScheduleSpec);
        }
      }
    }
  } catch {
    onSkip?.({ family: "periodReviewWeekly", code: "config_access_threw" });
    onSkip?.({ family: "periodReviewMonthly", code: "config_access_threw" });
  }

  // task 25.4 — crossCalendarScheduling. WP5: real `organizerWorkspaceId`/`sources` feed the
  // static envelope. ⛔ task D2b — `intervalMs`/`sources` now get the SAME fail-closed validation
  // `organizerWorkspaceId` already had (F3).
  // ⛔ task M3c — the WHOLE crossCalendarScheduling block is wrapped, same containment as every
  // other family above.
  try {
    const crossCalendarSchedulingEnabled = config.crossCalendarSchedulingSchedule?.enabled === true;
    const crossCalendarSchedulingIntervalMs = resolveScheduleDurationMs(
      crossCalendarSchedulingEnabled,
      config.crossCalendarSchedulingSchedule?.intervalMs,
      60 * 60 * 1000,
    );
    const crossCalendarSchedulingOrganizerWorkspaceId = resolveScheduleWorkspaceId(
      crossCalendarSchedulingEnabled,
      config.crossCalendarSchedulingSchedule?.organizerWorkspaceId,
      DEFAULT_GLOBAL_COORDINATION_WORKSPACE_ID,
    );
    const crossCalendarSchedulingSources = resolveScheduleSources(
      crossCalendarSchedulingEnabled,
      config.crossCalendarSchedulingSchedule?.sources,
      [],
    );

    if (!crossCalendarSchedulingIntervalMs.ok) {
      onSkip?.({ family: "crossCalendarScheduling", code: "invalid_interval_ms" });
    } else if (!crossCalendarSchedulingOrganizerWorkspaceId.ok) {
      onSkip?.({ family: "crossCalendarScheduling", code: "invalid_workspace_id" });
    } else if (!crossCalendarSchedulingSources.ok) {
      onSkip?.({ family: "crossCalendarScheduling", code: "invalid_sources" });
    } else {
      const crossCalendarSchedulingScheduleSpec = gateCrossCalendarSchedulingSchedule({
        enabled: crossCalendarSchedulingEnabled,
        taskQueue,
        intervalMs: crossCalendarSchedulingIntervalMs.value,
        organizerWorkspaceId: crossCalendarSchedulingOrganizerWorkspaceId.value,
        sources: crossCalendarSchedulingSources.value,
      });
      if (crossCalendarSchedulingScheduleSpec !== undefined) {
        specs.push(crossCalendarSchedulingScheduleSpec);
      }
    }
  } catch {
    onSkip?.({ family: "crossCalendarScheduling", code: "config_access_threw" });
  }

  return specs;
}

/**
 * Boot the live worker control plane. Assembles the persistent backends, stands up
 * the real loopback API transport over the @sow/db port adapters (behind the injected
 * token + allowlist), wires the redacting logger + the Temporal-unavailable degraded
 * controller, and exposes a `connectTemporal()` that drives `bootstrapWorker` with
 * the proof-spine register hook. See the header for the Phase-9/11 residual deferrals.
 */
/**
 * Task 10.6 — how often a backup is DUE (24h), and how often boot re-asks (1h).
 * The two differ on purpose: the cadence is the real policy and is enforced against
 * the persisted marker, while the check interval only decides how promptly a
 * long-running session notices. A cheap "not due" no-op is the common case.
 */
const BACKUP_CADENCE_MS = 24 * 60 * 60 * 1000;
const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export async function bootWorker(config: BootConfig): Promise<BootedWorker> {
  // 0.99) task 11.1/24.1 (REQ-D-005, safety rule 1) — ACQUIRE the real OS-atomic single-owner lock
  //   BEFORE the operational store opens (`assembleBackends` below), so a second worker instance
  //   pointed at the SAME durable `dbPath` is PHYSICALLY refused (O_CREAT|O_EXCL, no TOCTOU window)
  //   rather than racing it. This closes 24.1's own recorded gap — "`acquireSingleOwnerLock` has ZERO
  //   production callers repo-wide … nothing acquires the lock at boot."
  //   NEVER THROWS (§16): `acquireSingleOwnerLock` itself only throws on an unexpected fs fault (never
  //   a false "held" — see that module's own header), and that propagation is caught here so an exotic
  //   fs state degrades the worker rather than crashing it.
  //   BYTE-EQUIVALENT WHEN THE LOCK IS FREE: on a successful acquire (the overwhelmingly common case —
  //   every default-config test boot included) nothing else about `bootWorker`'s observable behavior
  //   changes; the lock is released idempotently at `close()`.
  //   ON REFUSAL/FAULT: never a boot-throw (mirrors this file's `armRefused`/`settingsFault` degrade-
  //   and-surface precedent below, never a hard stop). The worker DOES still boot — restructuring
  //   `bootWorker`'s return contract to hard-refuse serving is a materially larger change than "bind
  //   the lock" and is NOT this slice's scope — but a `worker_down` HealthItem is minted (best-effort,
  //   once `backends` exists below) and the refusal is logged loudly, CODE-ONLY (rule 7 — the other
  //   holder's pid is never rendered raw, matching `singleOwnerLockDoctorCheck.ts`'s own repair-message
  //   discipline: "a repair message names no pid").
  //   ⚠ SCOPE, STATED RATHER THAN IMPLIED: this closes 24.1's "zero production callers" gap (the lock
  //   is now genuinely ACQUIRED at boot) but does NOT bind `resolvePgliteLockHolder` →
  //   `packages/knowledge`'s `evaluateWriteFence` — that binding has NO caller anywhere in this repo
  //   today (measured: zero references outside its own module/tests), so the OS lock is a real
  //   ACQUISITION but not yet the thing that would make a refused write PHYSICALLY blocked at the
  //   gbrain/vault write layer. A separate, larger cross-package task; recorded, not silently assumed.
  const singleOwnerLockPath = deriveSingleOwnerLockPath(config);
  let singleOwnerLockResult: LockAcquireResult | undefined;
  try {
    singleOwnerLockResult = acquireSingleOwnerLock(singleOwnerLockPath);
  } catch {
    singleOwnerLockResult = undefined; // an unexpected fs fault degrades — never a boot crash (§16)
  }
  // 0.8) 18.25 step-6 — CONSTRUCT the subscription-ONLY arm gate from the owner opt-in (`config.subscriptionArm`).
  //   This is the deferred FINDING piece: the subscription runner's `ExtractionContentResolver` needs
  //   `createDurableParkedReader(backends.repos.sourceDisposition)` — a repo that exists ONLY after `assembleBackends`,
  //   while `config.providerTransport` is consumed EAGERLY inside `assembleBackends` (backends.ts:809
  //   `selectProviderRunner` → `gate.make()`). SOLUTION: build the content resolver over a LATE-BOUND reader whose
  //   holder is filled POST-assembly (the resolver's `resolve()` is per-job/late). `createSubscriptionOnlyProviderRunner`
  //   builds NO 5-provider registry, so it needs NONE of the post-assembly `controller`/`now`/`transport` deps.
  //   OFF (opt-in unset / not `enabled === true`) ⇒ `armWiring` undefined ⇒ byte-equivalent (holder never filled).
  // 18.40 — the SINGLE armed-subscription-spawn child-env chokepoint (rule-5 completeness-by-construction). When
  //   the extraction arm OR the §13.10 Copilot real-model path is enabled, EVERY subscription `query()` spawn runs
  //   with a MINIMAL ALLOWLISTED env — no shadow var (known/unknown/CLAUDE_ENV_FILE-injected) can reach the child.
  //   Neither enabled ⇒ undefined ⇒ the spawn omits `env` ⇒ inherits process.env (byte-equivalent shipped default).
  //   Wired at BOTH createClaudeSubscriptionCompletion sites (extraction makeCompletion below + Copilot completion,
  //   :~1774) so no armed spawn inherits raw env. The 18.38 denylist stays as a defense-in-depth pre-run degrade.
  const spawnChildEnv = resolveSubscriptionSpawnChildEnv(
    {
      subscriptionArmEnabled: config.subscriptionArm?.enabled === true,
      copilotRealModel: config.copilotRealModel === true,
    },
    process.env,
  );
  const readerHolder = createReaderHolder();
  const armWiring = buildSubscriptionArmWiring(config.subscriptionArm, {
    readerHolder,
    makeCompletion:
      config.subscriptionArm?.makeCompletion ??
      (() =>
        createClaudeSubscriptionCompletion(spawnChildEnv !== undefined ? { childEnv: spawnChildEnv } : undefined)),
    // 18.35 — bind the effective reachability check behind the INDEPENDENT reachability-enable OFF-lock. The
    //   real spend-free probe (`probeSubscriptionReachability` over the macOS Keychain detector) binds ONLY when
    //   the arm is enabled AND `SOW_SUBSCRIPTION_REACHABILITY_LIVE` is set (strict "1"/"true"); an env-only arm
    //   (enabled alone) STAYS FAIL_CLOSED_REACHABILITY (⇒ HEALTH UNAVAILABLE) by design (L52/L57). The explicit
    //   `config.subscriptionArm?.checkReachable` test/-live seam is still honored first. Shipped default (both
    //   unset) ⇒ FAIL_CLOSED_REACHABILITY, byte-equivalent (the real probe thunk is never constructed). The
    //   worker child inherits main's process.env (index.ts:134 forks with no `env` filter), so the shell-export
    //   ENABLE needs no desktop change. The FLIP stays owner+lead-gated (real cloud egress + spend, HARD LINE).
    checkReachable: resolveArmCheckReachable(config.subscriptionArm, process.env[REACHABILITY_LIVE_ENV_VAR]),
    now: () => Date.now(),
  });

  // 0.9) 18.24 step-6 — resolve the SUBSCRIPTION-EXTRACTION arm from the SINGLE `providerTransport` signal (the SAME
  //   `isProviderTransportArmed` predicate `selectProviderRunner` reads — one flip, no split-brain, L52). The effective
  //   transport is the CONSTRUCTED arm gate (18.25), else `config.providerTransport` (the 18.24 raw-API fallback path).
  //   On the ARMED path a subscription-SHADOWING env var (a stale key / gateway redirect that would displace the ambient
  //   `claude` login) REFUSES the arm: `effectiveArmed=false` ⇒ the transport gate is STRIPPED from the backends config
  //   (extraction degrades to the LOCAL stub route — fail-closed, ZERO cloud extraction) + a boot-visible fault is
  //   surfaced below — NEVER a worker-wide boot-throw (L52: degrade+surface). Shipped default (both unset) ⇒
  //   `effectiveArmed=false`, `authRefused=false` ⇒ byte-equivalent. Also confirm no Claude-Code `apiKeyHelper` API-key
  //   injection (a settings-level shadow this env guard can't see; runbook CHECKPOINT-1 caveat).
  const effectiveProviderTransport = armWiring?.providerTransport ?? config.providerTransport;
  const arming = resolveSubscriptionArming(effectiveProviderTransport, process.env);

  // 0.95) 18.36 — the settings-level key-injection guard. On the EFFECTIVELY-armed path ONLY (no fs read on the
  //   shipped default OR the env-refused path — byte-equivalent), detect a Claude-Code `settings.json` key
  //   injection (`apiKeyHelper` / a settings-`env` shadow / a Bedrock cred script) the 18.28 `process.env` guard
  //   structurally can't see — the Agent SDK `query()` honors settings, so an injected raw key there would make a
  //   "subscription" run silently metered-spend. A detected injection DEGRADES the arm identically to the env-
  //   shadow refusal (strip the transport gate → local/stub) + a boot-visible code-only fault (rule 7) — NEVER a
  //   worker crash (§16/L52). PRESENCE only (the key value / command is never read). Closes a CHECKPOINT-1 residual.
  //   `armRefused` / `armEffective` are THE combined degrade signals — EVERY arm-degrade consumer below (the
  //   transport strip, the reader-holder fill, AND the route/ContextRef/schema arming) reads THESE, never
  //   `arming.*` directly, so a settings injection strips the WHOLE arm in lockstep (no split-brain, L52). The
  //   two boot-visible logs keep their distinct reasons (`arming.authRefused` = env-shadow; `settingsFault` = settings).
  const settingsFault = guardSettingsOnArmedPath(arming.effectiveArmed, readClaudeCodeSettings);
  const armRefused = arming.authRefused || settingsFault !== undefined;
  const armEffective = arming.effectiveArmed && settingsFault === undefined;

  // 1) The persistent composition root (sqlite + genesis migration, vault, the
  //    persistent §9 stores, the redacting logger, the §7 broker).
  const backendsConfig: BackendsConfig = buildBackendsConfig(
    // Degrade the arm on a shadowing-env OR settings-injection refusal — strip the transport gate so extraction stays LOCAL/stub.
    armRefused
      ? { ...config, providerTransport: undefined }
      : { ...config, providerTransport: effectiveProviderTransport },
  );
  const backends = await assembleBackends(backendsConfig, config.stubExtraction);

  // 1.01) task 11.1/24.1 — surface a single-owner-lock refusal/fault now that `backends` exists (the
  //   acquire attempt itself ran BEFORE the store opened, above). Best-effort, never blocks boot.
  if (singleOwnerLockResult === undefined || singleOwnerLockResult.ok === false) {
    const code = singleOwnerLockResult?.ok === false ? "single_owner_lock_held" : "single_owner_lock_fault";
    backends.logger.error("boot.single_owner_lock.refused", { fields: { code } });
    try {
      await backends.healthItems.put({
        id: `single-owner-lock:${backends.now()}`,
        failureClass: "worker_down",
        severity: "warn",
        message:
          "Another process holds the canonical brain/vault lock, or this worker could not acquire it — " +
          "a second write-capable instance may be racing the operational store (REQ-D-005).",
        auditRef: "single-owner-lock:not-held" as AuditId,
        openedAt: backends.now(),
        state: "open",
      });
    } catch {
      /* best-effort — a health-mint fault must never block boot (§16) */
    }
  }

  // 1.02) task 19.1 — the durable GBrain post-commit sync-outbox binding, over the SAME
  //   `backendsConfig.dbPath` the operational store just opened (own connection — see
  //   gbrainSyncOutbox.ts's module header for why that is safe/correct for both a real file
  //   path and the `:memory:` test/dev default). Drain-on-wake: re-drive any rows a PRIOR
  //   boot left held (LIFE-6 catch-up), best-effort — a drain fault never blocks boot.
  const gbrainSyncOutboxBinding = createGbrainSyncOutboxBinding(backendsConfig.dbPath);
  try {
    await drainGbrainSyncOutbox({
      outbox: gbrainSyncOutboxBinding.store,
      snapshotSource: createWorkingTreeMarkdownSource(backends.vault),
      indexClient: backends.indexClient,
      now: backends.now,
      newHealthItemId: (): string =>
        `gbrain-sync:${backends.now()}:${Math.random().toString(36).slice(2)}`,
    });
  } catch {
    /* fail-SAFE: a drain-on-wake fault never blocks boot */
  }

  // 1.03) task 11.3b — give the pure write-through enablement flip-precondition gate
  // (`decideWriteThroughEnablement`) a REAL production caller by evaluating it once at boot and
  // surfacing the refusals through the structured logger (the observable surface — see
  // enablementLegs.ts's module header). NO readers/pin/report are supplied yet (the real bucket-B
  // signal sources are a separate later task), so EVERY boot logs all six legs refusing — that is
  // the honest, expected, non-arming state this slice's deliverable is limited to. Best-effort:
  // an evaluate/surface fault never blocks boot. ⛔ NOTHING ARMS — this call only READS/OBSERVES;
  // no code path here ever sets `writeThroughEnabled`.
  try {
    const enablementDecision = await evaluateWriteThroughEnablement({});
    surfaceEnablementDecision(enablementDecision, backends.logger);
  } catch {
    /* fail-SAFE: an enablement-evaluation fault never blocks boot */
  }

  // 1.05) 18.25 step-6 — FILL the late-bound reader holder POST-`assembleBackends` (only when the arm is
  //   effectively armed): the durable parked reader exists only now. On the dormant/refused path the holder stays
  //   empty (the late-bound reader fails closed — never a real read). This closes the eager-consumption ordering.
  if (armEffective && armWiring !== undefined) {
    readerHolder.reader = createDurableParkedReader(backends.repos.sourceDisposition);
  }

  // 1.1) 18.24 step-6 — surface the armed-path shadowing-env refusal LOUDLY (boot-visible, code-only — rule 7),
  //   so a mis-provisioned armed config can't be mistaken for a working arm (Checkpoint-2 backstops it at ENABLE).
  //   Dormant: never reached on the shipped default (only `config.providerTransport` armed + a shadowing var set).
  if (arming.authRefused) {
    backends.logger.error("subscription.arming.refused", {
      fields: { code: arming.authFault?.code ?? "anthropic_key_set_on_armed_path" },
    });
  }
  // 1.15) 18.36 — surface a settings-level key-injection refusal LOUDLY (boot-visible, code-only — rule 7), with
  //   a DISTINCT code + the file-tier marker so the operator can tell it apart from the env-shadow refusal.
  //   Dormant: never reached on the shipped default (only the effectively-armed path reads settings).
  if (settingsFault !== undefined) {
    backends.logger.error("subscription.arming.refused", {
      fields: { code: settingsFault.code, marker: settingsFault.marker },
    });
  }

  // 1.2) 18.25 step-6 — LOUD warn on an ambiguous both-armed config: the subscription arm
  //   (`config.subscriptionArm`) SILENTLY takes precedence over the 18.24 raw-API `config.providerTransport`
  //   (`?? ` at the effective-transport select). Both set is an owner mis-config at ENABLE (they pick ONE
  //   path) — surface it code-only (rule 7) rather than fail silent. Dormant: never reached on the shipped
  //   default (both unset).
  if (config.subscriptionArm?.enabled === true && config.providerTransport !== undefined) {
    backends.logger.warn("subscription.arming.both_transports_set", {
      fields: { code: "subscription_arm_precedes_provider_transport" },
    });
  }

  // 11.4 Slice 3 / 21.10 — the owner-provisioning gate: build the real Keychain `SecretsPort` +
  // `getSecret` facade ONLY when provisioned (gate absent ⇒ `undefined`, inert — no adapter/backend/
  // `security` process, byte-equivalent). MOVED here (was constructed further down, alongside the
  // C5.4b serving-oracle branch) so the SAME instance can also feed the 21.10 credential-seam rebind
  // below — nothing between here and the original site reads `keychainSecrets`, so this is a pure
  // reordering (still consulted at C5.4b OFF-lock 2 + the provenance-signing resolve, unchanged).
  const keychainSecrets = buildKeychainSecrets(config.keychainSecrets);

  // 1.4) §11.1 slice 2b — DURABLE revisions. Rebind the proof-spine params' placeholder `revisions` to the
  //   durable slice-2a KnowledgeRevisionStore over `backends.repos.knowledgeRevisions` (the repo exists only now;
  //   the params were assembled at the worker-host before boot). This runs BEFORE any `proofSpineParams.revisions`
  //   consumer below (the semantic dispatch + the proof-spine register hook), so the ingestion `sourceCommit` and
  //   the dormant propose dispatch both persist idempotency durably (survives a worker restart). On the OFF path
  //   `config.proofSpineParams` is undefined ⇒ `proofSpineParams` is undefined ⇒ the durable store is NEVER
  //   constructed and NOTHING persists (the slice-1 owner-opt-in invariant is intact).
  //   18.24 step-6 — then co-gate the subscription extraction route + source ContextRef to the SAME effective
  //   arm (dormant: `effectiveArmed=false` on the shipped default ⇒ params UNCHANGED, byte-equivalent).
  // 1.4b) 13.8i-B — bind the propose-knowledge-approval port UNCONDITIONALLY (no separate arming flag;
  //   see withProposeKnowledgeApproval's own doc for why the zero-cards guarantee still holds).
  // 1.4c) 21.10 — thread the credential-seam accessor from the SAME `keychainSecrets` facade above
  //   (`undefined` gate ⇒ `keychainSecrets` is `undefined` ⇒ `withWriteSecretsAccessor` no-ops, byte-
  //   equivalent — no new arming surface). 1.4d) 21.8 — thread `config.cardTransport` (unset by
  //   default ⇒ `withCardTransport` no-ops too). Runs LAST so both always see the fully-assembled
  //   params from every rebind above.
  // task ARM-RESEARCH-3 — `withLivingVaultRewrite` runs OUTERMOST (after every other rebind above) so
  //   it sees the fully-assembled params, mirroring `withCardTransport`'s own "runs LAST" note.
  //   Three independent OFF-locks (flag + vaultRoot inside `gateLivingVaultRewrite`, providers here) —
  //   the shipped default (all three unset) leaves `proofSpineParams.livingVault` UNSET, byte-equivalent.
  // task 13.23 leg B/C — bind `recordEntityRefSignals` so the three CA-2 counts reach a HealthItem
  // (in-process mint, no external effect). `surface` (the `HealthSurface`) is constructed FURTHER DOWN
  // in this function (after the Temporal-unavailable controller setup) — this mutable holder is the SAME
  // late-bound pattern `readerHolder` uses a few lines up (1.05) for exactly this "needed now, built
  // later" ordering; `entityRefSignalsHealthSurfaceHolder.surface` is filled in right after `surface`
  // exists, well before any real living-vault rewrite could ever invoke this sink.
  const entityRefSignalsHealthSurfaceHolder: { surface?: HealthSurface } = {};
  let entityRefSignalsAuditSeq = 0;
  const recordEntityRefSignalsHealth = createEntityRefSignalsHealthSink({
    recordFailure: (failure: HealthFailure): Promise<unknown> =>
      entityRefSignalsHealthSurfaceHolder.surface !== undefined
        ? entityRefSignalsHealthSurfaceHolder.surface.record(failure)
        : Promise.resolve(undefined),
    now: backends.now,
    newAuditId: (): string => auditId(`entity-ref-signals-audit:${(entityRefSignalsAuditSeq += 1)}`),
  });
  // 24.1 / REQ-S-NEW-008 — the OS ONE-WRITER FENCE probe, built from the REAL
  //   `acquireSingleOwnerLock` outcome captured at step 0.99 and consulted PER COMMIT
  //   by the KnowledgeWriter. This is the piece boot.ts previously recorded as MISSING
  //   ("the OS lock is a real ACQUISITION but not yet the thing that would make a
  //   refused write PHYSICALLY blocked"): with it bound, a worker that lost or never
  //   won the lock cannot write canonical Markdown at all — `atomicCommit` refuses
  //   before staging a byte.
  //   ⚠ `workerIsSoleVaultWriter` is stated, not probed: no filesystem-ACL prober
  //   exists in this repo, so it is `true` here (this worker owns its vault directory
  //   by construction in the shipped single-user posture) and the LOCK is the fact
  //   actually being enforced. Named rather than implied — see writeFenceProbe.ts's
  //   header for the full scope, including the absent stray-writer sweep.
  const writeFenceProbe = createWriteFenceProbe({
    lockResult: singleOwnerLockResult,
    // The fence keys its alarms by brain. No BrainId constructor is exported
    // (zod-brands.ts:211), so the canonical id is branded by cast, matching the
    // repo's existing convention for this brand.
    canonicalBrainId: SOW_CANONICAL_BRAIN_ID,
    workerIsSoleVaultWriter: true,
    now: backends.now,
    auditRef: auditId("write-fence-boot"),
  });
  const proofSpineParams = withWriteFence(
    withLivingVaultRewrite(
    withCardTransport(
      withWriteSecretsAccessor(
        withProposeKnowledgeApproval(
          withSubscriptionExtractionArming(
            withGbrainSyncOutbox(
              withDurableRevisions(config.proofSpineParams, backends.repos.knowledgeRevisions),
              gbrainSyncOutboxBinding,
            ),
            // 18.36 — the COMBINED effective arm (settings-injection folded in), NOT `arming.effectiveArmed`: a
            //   settings key-injection must strip the route/ContextRef/schema arming in lockstep with the
            //   transport (L52 no split-brain).
            armEffective,
          ),
          backends,
        ),
        // 21.10 — `undefined` gate (the shipped default) ⇒ `keychainSecrets` is `undefined` ⇒ this whole
        //   expression is `undefined` ⇒ `withWriteSecretsAccessor` no-ops (byte-equivalent).
        keychainSecrets !== undefined ? toWriteSecretsAccessor(keychainSecrets.getSecret) : undefined,
      ),
      // 21.8 — `config.cardTransport` unset (the shipped default) ⇒ `withCardTransport` no-ops.
      config.cardTransport,
    ),
    { livingVaultRewrite: config.livingVaultRewrite, vaultRoot: config.vaultRoot },
    config.livingVaultProviders,
    recordEntityRefSignalsHealth,
    ),
    writeFenceProbe,
  );

  // 1.5) DEV data-unlock (OFF by default). When dev-provision specs are supplied, turn
  //   local vault Markdown into REAL read-model rows so the wired-but-empty surfaces show
  //   genuine content (deterministic parse + fail-closed registry — NOT a seed). Best-effort:
  //   a per-spec failure is logged and skipped; it never blocks the control plane booting.
  if (config.devProvision !== undefined && config.devProvision.length > 0) {
    for (const spec of config.devProvision) {
      try {
        const provisioned = await provisionDevWorkspace(
          { readModels: backends.repos.readModels, vault: backends.vault, now: backends.now },
          spec,
        );
        if (provisioned.ok) {
          backends.logger.info("dev.provision.ok", {
            fields: { workspaceId: spec.workspaceId, notePath: spec.notePath },
          });
        } else {
          backends.logger.warn("dev.provision.skip", {
            fields: { workspaceId: spec.workspaceId, code: provisioned.error.code },
          });
        }
      } catch {
        // Defense-in-depth: even a contract-violating throw from a backend must not block
        // the control plane coming up (the provisioner returns typed Results by contract).
        backends.logger.warn("dev.provision.skip", {
          fields: { workspaceId: spec.workspaceId, code: "threw" },
        });
      }
    }
  }

  // 1.6) DEV demo-seed (OFF by default; STRICT `SOW_DEMO_SEED === "1"`). Vault-FREE representative
  //   read-model fixtures across the WHOLE Global Today so `SOW_DEMO_SEED=1 ./dev.sh` browses a
  //   populated dashboard with ZERO model calls / egress / Keychain. Read-model-ONLY (rebuildable),
  //   never Markdown/KW/secrets. Best-effort: a seed fault is logged + skipped, never blocks the
  //   control plane booting (§16). The forked worker inherits `process.env` from desktop main (L70).
  try {
    const seeded = await maybeSeedDemoData(process.env, {
      readModels: backends.repos.readModels,
      now: backends.now,
    });
    if (seeded !== undefined) {
      if (seeded.ok) backends.logger.info("dev.demoSeed.ok", {});
      else backends.logger.warn("dev.demoSeed.skip", { fields: { code: seeded.error.code } });
    }
  } catch {
    backends.logger.warn("dev.demoSeed.skip", { fields: { code: "threw" } });
  }

  // 2) The REAL @sow/db port adapters behind the query/command surface.
  const readModel: ReadModelQueryPort = createDbReadModelQueryPort({
    readModels: backends.repos.readModels,
    approvals: backends.repos.approvals,
    audit: backends.repos.audit,
  });
  const approvals: ApprovalCommandPort = createDbApprovalCommandPort(backends.repos.approvals);
  const triage: TriagePort = createDbTriagePort(config.triageDispatch);
  // 15.8 — the PRODUCTION reroute-target validator: a `reroute` disposition's explicit
  //   human target is validated against the REAL 14.6 registry (WS-8 — the workspace must
  //   be 14.1-registered; a targeted project must resolve UNDER that workspace) BEFORE the
  //   pipeline re-entry. REQ-F-017 no-inference: a missing/unknown target fails closed
  //   (typed rejection), never a guessed workspace. Mirrors createRegistryValidatedRescope.
  const rerouteTargets: RerouteTargetValidatorPort = createRegistryValidatedRerouteTarget({
    readModels: backends.repos.readModels,
    projectRepo: backends.repos.projectRegistry,
  });
  const systemHealth = createSystemHealthQueryPort(backends);
  // 14.1 — the PRODUCTION onboarding provisioning port: mints a workspace by upserting a
  //   validated safe-default Workspace into the durable config store + unioning its id into
  //   the fail-closed WS-8 registry (the SOLE visibility authority). The real replacement for
  //   the dev-only provisionDevWorkspace fixture; loopback-only, no external network/credential.
  const onboarding: OnboardingCommandPort = createProvisionWorkspacePort({
    workspaceConfig: backends.repos.workspaceConfig,
    readModels: backends.repos.readModels,
    now: backends.now,
  });
  // 14.6 — the PRODUCTION project-registry creation port: mints a durable typed-Project
  //   entry bound to a 14.1-registered workspace (rule-1: writes ONLY the operational
  //   registry row, never KW/Markdown). The projectSync workflow that RESOLVES against the
  //   registry is dormant — binding the production ResolveRegistryPort into a dispatched
  //   runProjectSync is a named spine follow-up (Lesson 11: no dormant-on-dormant wiring).
  const projectRegistry: ProjectRegistryCommandPort = createProjectRegistryCommandPort({
    repo: backends.repos.projectRegistry,
    readModels: backends.repos.readModels,
  });
  // 14.2 — the PRODUCTION connector-config port: register a connector instance bound to a
  //   14.1-registered workspace (config only — an opaque tokenRef REFERENCE, never a credential;
  //   no live vendor call) + enable/pause + set-cadence. The Phase-16/23 consumers of the record
  //   are dormant — not wired here (Lesson 11); the real credential/transport binds at arming.
  const connectorConfig: ConnectorConfigCommandPort = createConnectorConfigCommandPort({
    repo: backends.repos.connectorInstance,
    readModels: backends.repos.readModels,
  });
  // 14.7 — the PRODUCTION cross-workspace-link owner-approval port: create/approve/revoke links
  //   between two 14.1-registered workspaces (the SINGLE sanctioned WS-8 cross-read input, safety
  //   rule 4). The READ gate that consults an approved link (`resolveApprovedCrossWorkspaceSlice`)
  //   is consumed by the coordination/global briefs (25.2/25.4) — NOT wired here (Lesson 11).
  const crossWorkspaceLink: CrossWorkspaceLinkCommandPort = createCrossWorkspaceLinkCommandPort({
    repo: backends.repos.crossWorkspaceLink,
    readModels: backends.repos.readModels,
    now: backends.now,
  });

  // 1c) The egress-ack REVOKE command (9.10-B ⚠ rule-5) — the fail-SAFE OFF direction: an owner-authorized
  //   get→flip-off+clear→upsert→audit over the DURABLE workspace config + audit log. LIVE (not dormant —
  //   the owner invokes it deliberately; it only ever turns egress OFF). The VISIBILITY read stays
  //   `systemHealth.egressStatus` (built above); this is the command half.
  const egressCommand: EgressCommandPort = createEgressCommandPort({
    workspaceConfig: backends.repos.workspaceConfig,
    audit: backends.repos.audit,
    now: backends.now,
  });

  // 2.5) The INTERIM Copilot ask backend (§4.6). The real GBrain/GCL retrieval + the governed LLM
  //   synthesis are deferred (the app runs over stubs; no passage-serving read-model exists yet).
  //   The fixture retrieval returns an EMPTY-but-valid context for each dev-provision SPEC's
  //   workspace (regardless of whether that spec's provisioning succeeded — the context is empty
  //   either way) — so a configured workspace gets an honest "nothing found yet" answer instead of
  //   an error — and fails CLOSED for any other workspace (WS-8). The stub synthesis cites nothing
  //   and never echoes raw content. When devProvision is off, the map is empty (every ask fails
  //   closed — there is genuinely no knowledge wired).
  // Interim per-workspace posture (P1.2b): the egress decision resolves the AUTHORITATIVE posture by
  // workspaceId (server-side). The type is inferred from the well-known scope id; defense-in-depth —
  // label the TYPE correctly so the veto's employer branch (and, on the cloud path, the notice) is never
  // dropped. Authoritative source when real config lands: `workspaceConfig.get(id)` (deferred — the
  // dev-provisioner does not seed workspace_config, and no `copilot.answer` ProviderMatrix route exists).
  // P2.4 — the real Copilot model path is a per-launch flag (OFF by default). ON ⇒ Claude SUBSCRIPTION
  // synthesis over a CLOUD Claude route + the CONSENT posture per workspace (an Employer-Work ask egresses
  // to Anthropic WITH the visible notice — the owner's stated posture). OFF ⇒ the deterministic stub over
  // a genuine LOCAL route (nothing egresses; no notice). The whole real-vs-interim decision lives in the
  // unit-tested `buildCopilotDeps`; the subscription client is constructed only on the real path.
  //
  // ONE shared DCR token provider per `gbrain serve --http` process: both the "http" retrieval exec and the
  // agent-mode MCP grant read the SAME serve, so they share a single OAuth client + token cache/single-flight
  // (never two independent DCR self-registrations against one server). Memoized — constructed on first use,
  // only when a gbrain-http path is actually taken (constructing it does no I/O; registration is on getToken).
  const gbrainHttpBaseUrl = config.copilotGbrainHttpUrl ?? DEFAULT_GBRAIN_HTTP_URL;
  let memoTokenProvider: GbrainTokenProvider | undefined;
  const sharedGbrainTokenProvider = (): GbrainTokenProvider => {
    memoTokenProvider ??= createGbrainDcrTokenProvider({ baseUrl: gbrainHttpBaseUrl });
    return memoTokenProvider;
  };

  // The gbrain read seam (#2): OFF ⇒ fixture stub; ON ⇒ the "http" MCP-over-HTTP grant path (default via
  // DCR self-registration; coexists with a running serve) OR the subprocess CLI. A factory so the chosen
  // transport is constructed only on the gbrain path.
  const gbrainExecFactory: (() => GbrainQueryExec) | undefined =
    config.copilotGbrainRetrieval === true
      ? config.copilotGbrainTransport === "http"
        ? (): GbrainQueryExec =>
            createGbrainHttpExec({ baseUrl: gbrainHttpBaseUrl, tokenProvider: sharedGbrainTokenProvider() })
        : (): GbrainQueryExec => createGbrainCliExec()
      : undefined;

  // The AGENTIC Copilot synthesis (C3): OFF by default. ON ⇒ the model runs as a governed READ-ONLY agent
  // over the AgentRuntimePort with the gbrain `serve --http` MCP endpoint as its read-tool source (auth via
  // the shared #2 DCR token seam). A factory so the runtime/transport is constructed ONLY when the agent path
  // is taken; absent ⇒ the tool-less completion client (the default real path) is unchanged. The runner is
  // bound to the served workspace (WS-8): only that workspace's ask gets the gbrain tool; others run tool-less.
  const agentSynthesisFactory: (() => CopilotSynthesisPort) | undefined =
    config.copilotRealModel === true && config.copilotAgentMode === true
      ? (): CopilotSynthesisPort => {
          const tokenProvider = sharedGbrainTokenProvider();
          // C5.3 — the write-via-Approvals seam. The concrete sink records a PENDING §9.8 Approval via a
          // DIRECT ApprovalRepository write (server-bound workspace registry-validated, first-write-wins,
          // payloadHash-divergence reject). Injecting sink + the SDK MCP-server factory ENABLES the propose
          // tool ONLY for a trusted+scoped_write, SEED-ONLY job (C5.4a). `deriveCopilotContentTrust` is now
          // REAL (per-source provenance) but no live retrieval adapter stamps `knowledge_writer` yet, so every
          // live ask is untrusted ⇒ never propose-capable. Go-live rests on a provenance-stamping adapter
          // (C5.4b) + the §9.8 approvals-inbox workspace-scoping fix.
          const proposeSink = createApprovalsProposeSink({
            approvals: backends.repos.approvals,
            workspaceConfig: backends.repos.workspaceConfig,
            now: backends.now,
          });
          // §13.10a G4b-3 — the SEMANTIC-write propose deps (dormant behind `copilotProposeKnowledge`). Mirror
          // of the external set above: a §9.8 knowledge sink (records the PENDING card + pending-KMP row) + the
          // G3 MCP server factory + a WS-8 existence probe over the served vault (create-vs-patch at call time;
          // a read fault throws and is caught fail-closed upstream) + the evidence sourceRef (REQ-F-006). The
          // runner grants the tool ONLY for a trusted propose_knowledge job — inert today (every live ask is untrusted).
          const knowledgeProposeSink = createApprovalsKnowledgeProposeSink({
            approvals: backends.repos.approvals,
            pendingKmp: backends.repos.pendingKnowledgeMutations,
            workspaceConfig: backends.repos.workspaceConfig,
            now: backends.now,
          });
          const knowledgeNoteExists: CopilotNoteExistsProbe = async (path) =>
            (await backends.vault.read(path)) !== undefined;
          const knowledgeSourceRef: SourceRef = { sourceId: sourceId("copilot.propose_knowledge") };
          // SC8 (§13.10 gate a): when workspace scoping is on, the agent reaches gbrain ONLY through the
          // in-process PROXY — SC5a arg-policing + SC5b result-redaction per call — which REPLACES the raw http
          // gbrain server under the same `gbrain` map key. The exec is the generic MCP-over-HTTP tool-call
          // (raw-envelope) transport (loopback-guarded; mints its own token). NOTE: `copilotWorkspaceScope` is
          // defined below — safe because this factory is LAZY (only invoked post-boot, after that const inits).
          // Option A (MULTI-served): `servedWorkspaceIdStr` is the single-served fallback anchor the runner still
          // takes; when scoping is on we ALSO inject a per-ASK scope resolver that OVERRIDES it, so ANY registered
          // workspace's ask reaches the brain scoped to itself (parity with the multi-served retrieval). `wsScope`
          // is a const ⇒ the `!== undefined` narrowing flows into the resolver closure.
          const servedWorkspaceIdStr = config.copilotGbrainWorkspaceId ?? DEFAULT_GBRAIN_COPILOT_WORKSPACE;
          const wsScope = copilotWorkspaceScope;
          const gbrainProxyRunnerDeps =
            wsScope !== undefined
              ? {
                  // Resolve the per-ASK WS-8 scope for the asked workspace: a workspace REGISTERED in the scope
                  // registry gets a scope bound to ITSELF; an unregistered one ⇒ undefined ⇒ the job runs
                  // tool-less (fail closed). The `as WorkspaceId` cast is pure (never throws §16); `descriptorFor`
                  // is a pure registry-membership check.
                  gbrainProxyScopeFor: (askedWs: string): CopilotWorkspaceScope | undefined => {
                    const descriptor = descriptorFor(wsScope.registry, askedWs as WorkspaceId);
                    return descriptor === undefined
                      ? undefined
                      : {
                          servedWorkspaceId: descriptor.workspaceId,
                          registry: wsScope.registry,
                          policy: wsScope.policy,
                        };
                  },
                  gbrainProxyExec: createGbrainMcpToolCallExec({ baseUrl: gbrainHttpBaseUrl, tokenProvider }),
                  buildGbrainProxyMcpServer: createCopilotGbrainProxyMcpServer,
                }
              : undefined;
          // §13.10d — the read-only VAULT page-read deps. Gated on `copilotVaultRead` (OFF by default) + a
          // configured `vaultRoot` + scoping on (`wsScope`; the vault handler needs a per-ask scope, which the
          // runner binds inside its scoped-proxy branch). All three deps or none — the fs reader is
          // redaction-safe, and the handler path-guards + WS-8-scopes every read. The gate is the pure
          // `gateCopilotVaultReadDeps` helper (fail-safe + unit-tested); the fs execs are constructed inside the
          // thunk so they exist ONLY on the gated-on/live path.
          const vaultRunnerDeps = gateCopilotVaultReadDeps(
            config,
            wsScope !== undefined,
            (vaultRoot) => ({
              buildVaultMcpServer: createCopilotVaultMcpServer,
              vaultReadFile: createFsVaultReadFileExec(),
              vaultRealpath: createFsRealpath(),
              vaultRoot,
            }),
            createFsVaultUsable(), // §13.10d — offer the tool only on a usable vault (empty default ⇒ inert)
          );
          // §13.10d — the read-only SKILL self-introspection dep. Gated on `copilotSkillIntrospection` (OFF by
          // default) + scoping on (`wsScope`; the runner registers it inside the same scoped-proxy branch as
          // vault). Unlike vault it needs NO scope/root/reader — the handler reads the STATIC catalog only, so
          // the single factory is the whole dep. Zero-leak (workspace-agnostic) + never reveals the propose tool.
          const skillsRunnerDeps = gateCopilotSkillIntrospectionDeps(config, wsScope !== undefined, () => ({
            buildSkillsMcpServer: createCopilotSkillsMcpServer,
          }));
          const runner = createClaudeAgentCopilotRunner({
            servedWorkspaceId: servedWorkspaceIdStr,
            gbrainMcpUrl: gbrainMcpEndpoint(gbrainHttpBaseUrl),
            getToken: () => tokenProvider.getToken(false),
            proposeSink,
            buildProposeMcpServer: createCopilotProposeMcpServer,
            knowledgeProposeSink,
            buildKnowledgeProposeMcpServer: createCopilotProposeKnowledgeMcpServer,
            knowledgeNoteExists,
            knowledgeSourceRef,
            ...(gbrainProxyRunnerDeps !== undefined ? gbrainProxyRunnerDeps : {}),
            ...(vaultRunnerDeps !== undefined ? vaultRunnerDeps : {}),
            ...(skillsRunnerDeps !== undefined ? skillsRunnerDeps : {}),
            ...(config.copilotBetas !== undefined ? { betas: config.copilotBetas } : {}),
          });
          // proposeEnabled mirrors the flag; resolveContentTrust is the REAL per-source-provenance derivation
          // (C5.4a). The flag is an AND-term with the trust verdict — so propose stays OFF at runtime until a
          // live retrieval adapter actually stamps `knowledge_writer` provenance (C5.4b), never a flag-only override.
          //
          // task 22.1 — BOTH flags are ADDITIONALLY AND-gated on `proposeArming.propose === "ON"` (the
          // composite five-precondition verdict, computed above): neither flag is honored unless ALL
          // FIVE preconditions pass, regardless of what the owner flag itself says. `proposeArming` is
          // a plain boolean-in-boolean-out `const` closed over here — no I/O, no re-evaluation per ask.
          return createAgentRuntimeCopilotSynthesis(runner, {
            proposeEnabled: proposeArming.propose === "ON" && config.copilotProposeMode === true,
            // §13.10a — COUPLED to the dispatch side: propose_knowledge stays OFF unless proofSpineParams is
            // provisioned (the KnowledgeWriter commit path), so an approved semantic card is always committable
            // (never stranded on the external-only dispatch). Mutually exclusive with proposeEnabled (both on ⇒
            // the capability resolver fails closed to read_only).
            knowledgeProposeEnabled:
              proposeArming.propose === "ON" &&
              config.copilotProposeKnowledge === true &&
              proofSpineParams !== undefined,
            resolveContentTrust: deriveCopilotContentTrust,
            // 24.7 — same durable sink as the completion path below (`copilotAuditPersist`); safe forward
            // reference — this thunk runs only when `buildCopilotDeps` invokes it, after that const inits
            // (identical lazy-closure shape to `copilotWorkspaceScope` just below).
            auditPersist: copilotAuditPersist,
          });
        }
      : undefined;

  // C5.4b: the provenance-stamping serving oracle — the INTERIM (always-degraded) one, so the decorator sits
  // on the live path but stamps NOTHING (⇒ untrusted ⇒ propose OFF). A real admitForServing-backed oracle is
  // a security-review-gated go-live event, NOT a flag flip (a factory, built only when the flag is on).
  // DORMANT: the real loader-backed oracle is constructible behind this seam but NEVER selected today — the
  // selector keeps the interim always-degraded oracle the default until the go-live precondition is armed
  // (a security-review-gated event; the loader-backed path is proven selectable by servingContextLoader.test).
  // C5.4b Slice 3 — construct the REAL loader-backed oracle DORMANT behind three independent OFF-locks and hand
  // it to the selector. Ship UNSET: with no arming flag AND no provisioning bundle (the shipped default), the
  // selector keeps returning the interim always-degraded oracle (behavior byte-equivalent to pre-slice).
  // WS-8 (safety rule 4): map ONLY the single served workspace to the one dev vault; an UNSET
  // `copilotGbrainWorkspaceId` ⇒ an EMPTY map ⇒ every workspace degrades (never a shared/default vault).
  const servedVaultRoots = new Map<string, VaultFs>();
  if (config.copilotGbrainWorkspaceId !== undefined) {
    servedVaultRoots.set(config.copilotGbrainWorkspaceId, backends.vault);
  }
  const provenanceBundle = config.provenanceServingOracle;
  // task 19.2/22.4 — the KnowledgeWriter provenance-signing dep, sourced from the SAME owner-provisioned
  // `keychainSecrets`/`provenanceBundle` pair the C5.4b serving oracle already uses (NO new arming
  // surface). `provenanceBundle` absent, or BOTH secrets sources absent, ⇒ `signing` stays `undefined`
  // ⇒ `knowledgeWriterDeps.signing`/`writerDeps.signing` are unset ⇒ byte-identical unstamped commit at
  // BOTH production supply sites (buildActivities.ts's + semanticApprovalDispatch.ts's conditional-
  // spreads). Present ⇒ a locked Keychain resolution degrades to an unstamped commit AND mints a
  // `parity_defect` HealthItem (never a crash, never silent).
  //
  // ⛔ HOISTED HERE (task 22.4 — closes a CONFIRMED verification finding): previously this const was
  // computed much later (right before `withSigning(proofSpineParams, signing)`) — AFTER the semantic-
  // approval-dispatch call site below had already built its `buildSemanticApprovalDispatch({...})`
  // literal without `signing` in scope at all, so that call site could NEVER receive it. Computing
  // `signing` here (before EITHER production call site) makes it available to both; the 20.2/22.4
  // signing path is now reachable from the semantic-approval-dispatch path, not only the
  // buildActivities.ts path (task 19.2, already wired).
  let signingHealthIdSeq = 0;
  const resolvedSigningSecrets = keychainSecrets?.secrets ?? provenanceBundle?.secrets;
  const signing: StamperDeps | undefined =
    provenanceBundle === undefined || resolvedSigningSecrets === undefined
      ? undefined
      : {
          secrets: withParityDefectSignalOnLockedKeychain(
            resolvedSigningSecrets,
            backends.healthItems,
            backends.now,
            (): string => `gbrain-sign-key-locked-health:${(signingHealthIdSeq += 1)}`,
          ),
          signingKeyRef: provenanceBundle.signingKeyRef,
        };
  // `keychainSecrets` (OFF-lock 2) is now built EARLIER — see its construction site above the
  // `proofSpineParams` assembly (moved for 21.10; same single instance, unchanged behavior here).
  // Task 13.10 piece C (CLOSES the rebuild-oracle arc): the boot binding, constructed in the SAME serving-oracle
  // construction branch. makeRebuildClient is OMITTED ⇒ the owner-gated real gbrain scratch-import stays UNBOUND ⇒
  // gateRebuildOracle returns undefined ⇒ no compute, no health routing, resolveOracleBuild unbound ⇒ oracleBuildOk
  // false ⇒ byte-equivalent shipped default (binding a real client is the owner's arming crossing). `compute()` is
  // awaited ONCE below (after the reconcile binding, where `surface` is in scope); resolveOracleBuild stays false
  // until it completes (fail-closed). The chain bootWorker → gateRebuildOracle → compute → probeRebuildOracle is now
  // STATIC (closes the A+B reachability waivers); it stays dormant at runtime while the client is unbound.
  let rebuildOracleIdSeq = 0;
  const rebuildOracle =
    config.copilotProvenanceStamping === true && provenanceBundle !== undefined
      ? gateRebuildOracle(
          { servedWorkspaceIds: [...servedVaultRoots.keys()] },
          {
            // makeRebuildClient OMITTED — UNBOUND owner-gated real client (the arming crossing).
            makeReader: (): CommittedVaultReader =>
              createCommittedVaultReader({ resolveVault: buildServedVaultResolver(servedVaultRoots) }),
            now: backends.now,
            newHealthItemId: (): string => `rebuild-oracle-health:${(rebuildOracleIdSeq += 1)}`,
            auditRef: auditId("rebuild-oracle-audit:boot"),
          },
        )
      : undefined;
  const loaderBackedServingOracle =
    config.copilotProvenanceStamping === true && provenanceBundle !== undefined
      ? buildLoaderBackedServingOracle({
          resolveVault: buildServedVaultResolver(servedVaultRoots),
          // REAL coverage reader (degrades by reality today — OFF-lock 3): the pin is the pinValid leg, and B4
          // now binds the durable ParityReportStore so the PARITY legs read the latest persisted ParityReport
          // @ head revision (closes the B2 waiver). `oracleBuildOk` stays false (rebuild-oracle leg deferred),
          // so serving still degrades honestly even with a clean report. The store is constructed ONLY inside
          // THIS branch — the construction guard is `copilotProvenanceStamping && provenanceBundle` (2 of the 3
          // OFF-locks); the shipped default (no bundle) builds no store. The 3rd OFF-lock `goLiveArmed` gates
          // SELECTION (`selectServingOracleFactory`), not construction — an unarmed-but-built store is inert.
          readServingCoverage: createServingCoverageReader({
            pin: provenanceBundle.pin,
            resolveRunning: provenanceBundle.resolveRunning ?? ((): RunningGbrainVersion | undefined => undefined),
            now: backends.now,
            store: createParityReportStoreAdapter(backends.repos.parityReports),
            // Task 13.10 piece C — the rebuild-oracle build-status leg. `undefined` by default (real client UNBOUND ⇒
            // `rebuildOracle` undefined ⇒ oracleBuildOk stays false ⇒ serving degrades). AND-composed into
            // `deriveServingCoverage` as ONE leg (never a standalone admit signal), so an armed `true` still requires
            // every other leg green before it can lift the coverage gate.
            resolveOracleBuild: rebuildOracle?.resolveOracleBuild,
          }),
          // OFF-lock 2: the REAL Keychain SecretsPort when provisioned, else the bundle's inline secrets (test),
          // else undefined ⇒ buildLoaderBackedServingOracle returns undefined ⇒ interim/degraded.
          secrets: keychainSecrets?.secrets ?? provenanceBundle.secrets,
          signingKeyRef: provenanceBundle.signingKeyRef,
        })
      : undefined;
  const servingOracleFactory: (() => CopilotServingOracle) | undefined = selectServingOracleFactory({
    provenanceStampingEnabled: config.copilotProvenanceStamping === true,
    loaderBacked: loaderBackedServingOracle,
    goLiveArmed: config.copilotServingOracleGoLive === true, // OFF-lock 1 (default unset ⇒ false)
  });

  // task 22.1 — the composite propose precondition verdict, resolved from the five boot-time signals
  // (see `gateProposeArming`'s own header for the full mapping). All five inputs are ALREADY in scope
  // here — nothing new is constructed to resolve them. Referenced inside `agentSynthesisFactory`'s
  // LAZY thunk (defined above, closes over this `const` — the thunk body executes only per-ask, long
  // after this line runs, so the closure is safe despite the textual ordering) AND used below (once
  // `surface` exists) to mint the operator-visible OFF health item.
  const proposeArming = gateProposeArming({
    // (1) content trust real — the go-live SELECTED serving oracle is live (Phase 20).
    contentTrustReal: servingOracleFactory !== undefined,
    // (2) the KnowledgeWriter commit / auto-ingest path is provisioned (Phase 18).
    proofSpineProvisioned: proofSpineParams !== undefined,
    // (3) the Keychain signing key resolves (Phase 17) — the SAME `signing` task 22.4 threads to both
    // production supply sites.
    signingKeyResolved: signing !== undefined,
    // (4) the real external-write transport is armed (Phase 21).
    writeTransportArmed: config.writeTransport?.enabled === true,
    // (5) gbrain provenance stamping is REAL — the loader-backed oracle is BUILT, independent of the
    // go-live SELECTION flip (Phase 19; distinct from (1) above).
    provenanceStampingReal: loaderBackedServingOracle !== undefined,
  });

  // Workspace set is resolved DECOUPLED from devProvision (which is SURFACE data, not Copilot reachability):
  // an explicit `copilotWorkspaces` wins, else devProvision-derived, else — on the real path — the 3
  // well-known scopes, so the Copilot answers without needing a vault note (#1 app-reachability).
  const copilotWorkspaces = resolveCopilotWorkspaces({
    explicit: config.copilotWorkspaces,
    devProvision: config.devProvision,
    realCopilot: config.copilotRealModel === true,
  });
  // SC3 (§13.10 gate a): the WS-8 scope descriptor — built ONLY when the flag is on. The interim registry
  // maps each resolved workspace to its own slug-prefix; the posture defaults to fail-closed `{deny}`.
  const denyLegacyPolicy: LegacyContentPolicy = { mode: "deny" }; // fail-closed default (excess-prop-checked)
  const copilotWorkspaceScope =
    config.copilotWorkspaceScoping === true
      ? {
          registry: buildInterimCopilotScopeRegistry(copilotWorkspaces),
          policy: config.copilotLegacyContentPolicy ?? denyLegacyPolicy,
        }
      : undefined;
  // 24.7 — the durable, queryable denial-audit sink for BOTH Copilot synthesis paths (completion below,
  // agentic in `agentSynthesisFactory` above). One instance, single-sourced over the same audit repo +
  // clock every other durable write in this boot uses.
  const copilotAuditPersist: AuditPersistPort = createAuditPersistPort({
    audit: backends.repos.audit,
    now: backends.now,
  });
  const copilot = buildCopilotDeps({
    realCopilot: config.copilotRealModel === true,
    auditPersist: copilotAuditPersist,
    workspaces: copilotWorkspaces,
    // 9.10-A — the AUTHORITATIVE store-backed veto posture (reads WorkspaceConfigRepository.egressPolicy):
    //   the SOLE production posture source, retiring the flag-derived cloud-consent fallback (rule 5). The
    //   briefing bundle reuses `copilot.workspacePosture` below, so both consumer reads are single-sourced.
    workspacePosture: createStoreBackedWorkspacePosture(backends.repos.workspaceConfig),
    model: config.copilotModel,
    betas: config.copilotBetas,
    // 18.40 — the §13.10 Copilot real-model path is the 2nd real subscription `query()` spawn; route it through
    //   the SAME `spawnChildEnv` chokepoint (gated on copilotRealModel too) so it never inherits raw process.env.
    completion: () =>
      createClaudeSubscriptionCompletion(spawnChildEnv !== undefined ? { childEnv: spawnChildEnv } : undefined),
    // P3-live: the real gbrain read seam, constructed ONLY when the flag is on (a factory, so the transport
    // isn't built off-path). Absent ⇒ retrieval stays the fixture stub. "http" ⇒ the mandated MCP-over-HTTP
    // grant path (coexists with a running serve); else the subprocess CLI.
    ...(gbrainExecFactory !== undefined ? { gbrainExec: gbrainExecFactory } : {}),
    ...(config.copilotGbrainWorkspaceId !== undefined
      ? { gbrainWorkspaceId: config.copilotGbrainWorkspaceId }
      : {}),
    // SC3: the WS-8 scope descriptor (only when `copilotWorkspaceScoping` is on) — filters the served
    // workspace's raw gbrain hits before normalize. Absent ⇒ passthrough.
    ...(copilotWorkspaceScope !== undefined ? { gbrainWorkspaceScope: copilotWorkspaceScope } : {}),
    // C3: the agentic synthesis factory (only built when the flag is on) REPLACES the completion synthesis.
    ...(agentSynthesisFactory !== undefined ? { agentSynthesis: agentSynthesisFactory } : {}),
    ...(servingOracleFactory !== undefined ? { servingOracle: servingOracleFactory } : {}),
  });

  // C6 §13.10 b-1 — the on-request Copilot BRIEFING deps: REUSE the copilot bundle's governed core
  // (synthesis/posture/routeSelector — the single-sourced veto+gate) + a briefing retrieval over the REAL
  // §9.4 Today read-model (`readModel` structurally satisfies BriefingTodayPort: recentChanges/ingestion/
  // approvalInbox). Read-only + WS-8-scoped by construction; empty-until-producer today (the read-model is
  // real but its producer rows fill in as Phase-9 producers land). Propose bridge untouched.
  // 24.37 — `AuditPersisting<…>` makes the 24.7 gap UNREPRESENTABLE rather than merely fixed: this
  // literal is hand-built (it reuses the copilot bundle field-by-field because briefing swaps in its
  // own retrieval), and omitting `auditPersist` below is now a compile error instead of a silent
  // production gap. See the type's own scope note — this closes the recurrence for THIS port, not the
  // general "hand-built literal drops a later-added optional field" class.
  const briefing: AuditPersisting<CopilotBriefingDeps> = {
    synthesis: copilot.synthesis,
    workspacePosture: copilot.workspacePosture,
    routeSelector: copilot.routeSelector,
    retrieval: createReadModelBriefingRetrieval(readModel),
    // 24.7 — forward the SAME durable denial-audit sink `copilot`/`copilotConcept` use. Omitting this
    // compiled fine (the inner `GovernedCopilotSynthesisDeps.auditPersist` field is optional, deliberately,
    // for hand-built test fixtures) but would have silently left `copilotBriefing`'s egress-veto denials
    // unpersisted in production — the exact gap this task exists to close, on one of its three named entry
    // points. Caught verifying the "is buildCopilotDeps the sole production constructor" assumption.
    auditPersist: copilot.auditPersist,
  };

  // §13.10a G4a — route an APPROVED approval to its subject-specific side effect. A `semantic_mutation`
  // card commits its referenced KMP through KnowledgeWriter (`buildSemanticApprovalDispatch`); everything
  // else (external_action) keeps the injected `config.dispatchApproval`. The semantic branch is wired ONLY
  // when the KnowledgeWriter durable path is provisioned (`config.proofSpineParams` carries the
  // KnowledgeRevisionStore + commit metadata) — the default/Temporal-degraded boot has no writer to commit
  // through, so it stays external-only. Dormant regardless until a semantic card exists (propose is OFF).
  const dispatchApproval: DispatchApprovalFn =
    proofSpineParams !== undefined
      ? createApprovalDispatchRouter({
          semantic: buildSemanticApprovalDispatch({
            vault: backends.vault,
            pendingKmp: backends.repos.pendingKnowledgeMutations,
            revisions: proofSpineParams.revisions,
            audit: backends.repos.audit,
            now: backends.now,
            // APPROVAL-SPECIFIC provenance (audit accuracy): a Copilot-approval commit must NOT be attributed
            // to the proof-spine's meeting-closeout actor/source. `workflowRunRef` reuses the proof-spine run
            // ref as a placeholder — an approval-driven commit runs under no workflow. `sourceEventRef` here is
            // the BASE ref; the composition builds the commit port per-approval and appends `#approval:<id>` so
            // the KnowledgeWriter audit trail (AuditRecord + CommittedRevision) ties each committed KMP to the
            // exact §9.8 approval that authorized it (in addition to the pending-KMP row linkage).
            commit: {
              actor: "copilot-approval",
              sourceEventRef: "copilot.propose_knowledge",
              workflowRunRef: proofSpineParams.commit.workflowRunRef,
            },
            // task 22.4 — the SAME hoisted `signing` instance buildActivities.ts's `knowledgeWriterDeps`
            // already receives (task 19.2). Conditional-spread (key ABSENT, not `undefined`-valued) so
            // the shipped default (no provisioning bundle ⇒ `signing === undefined`) keeps
            // `SemanticApprovalDispatchDeps.signing` unset ⇒ `writerDeps` inside
            // `buildSemanticApprovalDispatch` stays byte-identical to pre-22.4 (its own
            // `deps.signing !== undefined` check reads the same either way; the spread just makes the
            // key-absence explicit + consistent with every other conditional-attach in this file).
            ...(signing !== undefined ? { signing } : {}),
          }),
          external: config.dispatchApproval,
        })
      : config.dispatchApproval;

  // 2b) §13.10a hardening residual #1 — approve→dispatch RECOVERY sweep. `decideApprovalCommand` applies the
  //     approval CAS then dispatches in the SAME call; a crash between them can strand an APPROVED semantic card
  //     with its pending-KMP row still uncommitted. Re-drive the (idempotent) semantic dispatch once at boot to
  //     recover any such card. Gated on the semantic branch being wired (proofSpineParams).
  //
  //     FIRE-AND-FORGET (does NOT gate serving): recovery must never delay boot. `approved` is a TERMINAL
  //     approval status, so `listByStatus("approved")` grows monotonically with history and the sweep's cost is
  //     unbounded — awaiting it would make boot latency scale with the approval log. The executor is idempotent
  //     (step 4 no-ops a committed row; the writer replays by idempotencyKey) and safe alongside early serving,
  //     so a detached sweep is sound. Never rejects (the reconciler returns a Result — we only log).
  //     Dormant today: propose is OFF ⇒ 0 approved semantic cards ⇒ one fast no-op query until go-live.
  //     ⚠ GO-LIVE OPTIMIZATION: narrow the driver to still-`pending` KMP rows (bounded by uncommitted work) via
  //       a targeted query instead of enumerating every historically-approved card.
  if (proofSpineParams !== undefined) {
    void reconcileApprovedSemanticMutations({
      listApproved: () => backends.repos.approvals.listByStatus("approved"),
      dispatch: dispatchApproval,
    }).then((reconciled) => {
      if (isOk(reconciled)) {
        const { scanned, settled, failed } = reconciled.value;
        backends.logger.info("copilot.semantic.reconcile", {
          // Redaction-safe: counts + the DISTINCT stable failure codes (never an approvalId, path, or content).
          fields: { scanned, settled, failed: failed.length, failedCodes: [...new Set(failed.map((f) => f.code))] },
        });
      } else {
        backends.logger.warn("copilot.semantic.reconcile.failed", {
          fields: { code: reconciled.error.cause?.code ?? reconciled.error.kind },
        });
      }
    });
  }

  // 3) The real loopback transport (HTTP + WS) behind the injected token + allowlist.
  //    A non-loopback bind is refused inside `startApiServer` (REQ-NF-004).
  const api = await startApiServer({
    expectedToken: config.sessionToken,
    allowlist: config.allowlist,
    readModel,
    copilot,
    briefing,
    systemHealth,
    approvals,
    dispatchApproval,
    triage,
    rerouteTargets,
    onboarding,
    projectRegistry,
    connectorConfig,
    crossWorkspaceLink,
    egressCommand,
    now: backends.now,
    ...(config.apiHost !== undefined ? { host: config.apiHost } : {}),
    ...(config.apiPort !== undefined ? { port: config.apiPort } : {}),
  });

  // 4) The Temporal-unavailable degraded controller over a HealthSurface. The
  //    `dispatch` is bound to a held-job re-drive that logs (the real Temporal
  //    start-workflow is driven by the supervisor's dispatch path — Phase 9); here
  //    it is a no-op sink so a reconnect drains cleanly without a throw.
  // The degraded controller's HealthSurface PERSISTS to the same migrated sqlite
  // `health_items` table the systemHealth QUERY reads (backends.healthItems) — so a
  // Temporal-unavailable worker_down item is operator-visible, not process-memory.
  const surface: HealthSurface = createHealthSurface(
    createPersistentHealthSurfaceStore(backends.healthItems),
  );
  // task 13.23 leg B/C — fill the late-bound holder now that `surface` exists (see its construction
  // site up at the `withLivingVaultRewrite` call for why this is deferred this far).
  entityRefSignalsHealthSurfaceHolder.surface = surface;
  const degraded: TemporalUnavailabilityController = createTemporalUnavailabilityController({
    surface,
    auditRef: BOOT_AUDIT_REF,
    dispatch: (jobId: string): Promise<void> => {
      backends.logger.info("temporal.degraded.redrive", { fields: { jobId } });
      return Promise.resolve();
    },
    config: DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
  });

  // task 22.1 — surface the propose precondition verdict: an operator-visible HealthItem naming the
  // missing precondition (through the SAME `surface.record` sink every other boot-time health signal
  // in this file uses) + a redacted log line. UNLIKE every other dormant gate in this file (which stays
  // SILENT when OFF — the absence of wiring IS the signal), propose sits behind FIVE preconditions
  // spanning multiple owner-gated phases; an operator working through the arming chain needs to know
  // WHICH one is still missing, not merely that nothing happened. Fires on EVERY boot while any
  // precondition is unmet (today: every default boot, since none of the five are provisioned) — this is
  // diagnostic, never a fault, so it carries no severity escalation. `policy_denial` is the closest
  // existing FailureClass fit (a policy/precondition gate holding a capability closed) — none of the 18
  // closed members names "arming precondition unmet"; a dedicated member is an arch_gap, per Lesson 18's
  // least-wrong-member discipline. Fire-and-forget + best-effort (never blocks/fails boot — a mint fault
  // is swallowed, mirroring every other terminal health sink below).
  if (proposeArming.propose === "OFF") {
    backends.logger.info(`propose=OFF (reason=${proposeArming.reason})`, {
      fields: { reason: proposeArming.reason },
    });
    void surface
      .record({
        failureClass: "policy_denial",
        subjectRef: "copilot-propose-arming",
        message: `Copilot propose held OFF (reason=${proposeArming.reason}) — all five task-22.1 preconditions must pass before propose_action/propose_knowledge are honored.`,
        auditRef: auditId("propose-arming-health:boot"),
        now: backends.now(),
      })
      .catch(() => {
        /* best-effort — a health-mint fault never blocks/fails boot (mirrors every other terminal sink) */
      });
  }

  // ── piece F2 — the reconcile-TRIGGER arc's composition-root gate binding (task 13.10, DORMANT) ──────────────
  // Default-OFF: `config.reconcile` unset ⇒ `gateReconcile` returns undefined (NO reconcile machinery constructed
  // — byte-equivalent; the `reconcile` field is omitted from the returned BootedWorker). On the armed path
  // (owner-gated, NEVER the default) it assembles the scheduler over the never-reject builders; the owner-gated
  // GbrainReadGrant transport stays UNBOUND (`makeDbAdapter → undefined` ⇒ the db-projection degrades ⇒ even the
  // armed path records `coverageComplete=false`, never a false-green). Task 19.4: the trigger source is now
  // BOUND here too — `gateReconcile`'s ON path constructs `trigger` over the SAME scheduler, and the
  // vault-watcher setup below wires its `onCapture` into `trigger.notify()` (`fs_watch` origin) via
  // `reconcileNotifyForCapture`, still gated on the SAME `reconcile !== undefined` check. The flush timing for
  // a FUTURE post-KW-commit hook still binds at the owner's ARMING bundle; the wiring stays exposed on
  // BootedWorker too. NO hard line crossed — the ON path itself stays owner-gated, transport unbound.
  let reconcileIdSeq = 0;
  const reconcileHealthDeps = {
    recordFailure: (failure: HealthFailure): Promise<unknown> => surface.record(failure),
    now: backends.now,
    newAuditId: (): string => auditId(`reconcile-audit:${(reconcileIdSeq += 1)}`),
  };
  const reconcile = gateReconcile(
    {
      reconcile: config.reconcile === true,
      ...(config.vaultRoot !== undefined ? { vaultRoot: config.vaultRoot } : {}),
    },
    {
      makeReader: () => createCommittedVaultReader({ resolveVault: buildServedVaultResolver(servedVaultRoots) }),
      makeDbAdapter: () => undefined, // owner-gated GbrainReadGrant transport UNBOUND ⇒ degrade
      makePassDeps: () => ({
        reconcilerDeps: {
          newReportId: (): string => `reconcile-report:${(reconcileIdSeq += 1)}`,
          newHealthItemId: (): string => `reconcile-health:${(reconcileIdSeq += 1)}`,
          newAuditId: (): string => auditId(`reconcile-audit:${(reconcileIdSeq += 1)}`),
          now: backends.now,
        },
        recorder: createParityReportRecorderAdapter(backends.repos.parityReports, backends.now),
        healthSink: createReconcileHealthSink(reconcileHealthDeps),
      }),
      makeLog: () =>
        createReconcileLogSink({
          ...reconcileHealthDeps,
          log: (summary): void =>
            backends.logger.info("reconcile.outcome", {
              fields: {
                kind: summary.kind,
                workspaceId: summary.workspaceId,
                revisionId: summary.revisionId,
                detail: summary.detail,
              },
            }),
        }),
    },
  );

  // Task 13.10 piece C — run the rebuild-oracle boot probe ONCE (obligation iii), routing any divergence to the
  // health surface (safe-fields-only, rule 7) and CONTAINING any fault so a one-shot boot probe never crashes boot
  // (§16); `resolveOracleBuild` stays false until it completes. DORMANT by default: `rebuildOracle` is undefined
  // unless the owner has provisioned a real client (the arming crossing), so this is a no-op on the shipped path.
  if (rebuildOracle !== undefined) {
    let rebuildOracleHealthSeq = 0;
    await computeAndRouteRebuildOracle(
      rebuildOracle,
      createRebuildOracleHealthSink({
        recordFailure: (failure: HealthFailure): Promise<unknown> => surface.record(failure),
        now: backends.now,
        newAuditId: (): string => auditId(`rebuild-oracle-audit:${(rebuildOracleHealthSeq += 1)}`),
      }),
      (): void =>
        backends.logger.warn("rebuild-oracle.boot-probe: health-routing fault contained (serving degrades)", {
          fields: {},
        }),
    );
  }

  // 5) The operational-backup service — WIRED **AND NOW SCHEDULED** (task 10.6).
  //   Ports come from the caller when supplied (the test seam), else from `backends`,
  //   which builds them over the live connection for a DURABLE store only. An
  //   in-memory store yields neither, so the shipped default for `:memory:` is
  //   byte-equivalent to before.
  const resolvedBackupPorts = config.backupPorts ?? backends.backupPorts;
  const backupService =
    resolvedBackupPorts !== undefined
      ? createOperationalBackupService(resolvedBackupPorts.opDb, resolvedBackupPorts.temporal)
      : undefined;

  // 5a) THE CADENCE. `boot.ts` used to say "service wired, CRON deferred", and the
  //   consequence was that the non-rebuildable operational truth (audit / approvals /
  //   outbox) was NEVER backed up in production.
  //
  //   The cadence check lives in `runOperationalBackup` and reads the PERSISTED
  //   last-run marker, so it is correct to simply ASK on every boot and again on a
  //   long-running interval: "is one due?" A run that is not due is a cheap no-op.
  //   That is why there is no CRON state to keep — the artifacts on disk ARE the
  //   schedule, and it survives a restart for free.
  //
  //   FIRE-AND-FORGET + swallowed: a backup must never delay or fail boot (§16). A
  //   failure is visible in the artifact list not advancing; the ports themselves fail
  //   CLOSED with typed errors rather than reporting a success they did not achieve.
  // ⛔ GUARDED — an unguarded fire-and-forget tick could start a SECOND concurrent backup while the
  // first was still running (a backup slower than the check interval has not written its artifact
  // yet, so the next tick still reads the old timestamp and still sees "due"). The guard lives in
  // `createPeriodicBackupTick` with its own tests; see there for why it SKIPS rather than queues.
  const backupTick = createPeriodicBackupTick({
    service: backupService,
    cadenceMs: BACKUP_CADENCE_MS,
    now: () => new Date(),
  });
  backupTick.tick();
  const backupTimer: ReturnType<typeof setInterval> | undefined =
    backupService !== undefined ? setInterval(backupTick.tick, BACKUP_CHECK_INTERVAL_MS) : undefined;
  // Never hold the process open for a backup check.
  backupTimer?.unref?.();

  // task 19.2/22.4 — `signing` (the KnowledgeWriter provenance-signing dep) is now computed EARLIER
  // (see its construction site right after `provenanceBundle`, above) so BOTH production supply sites —
  // this `proofSpineParamsWithSigning` (→ buildActivities.ts's `knowledgeWriterDeps`) AND the semantic-
  // approval-dispatch call below (→ semanticApprovalDispatch.ts's `writerDeps`) — read the SAME
  // instance. Hoisted, not duplicated: task 22.4 found the semantic-dispatch call site (below) never
  // received `signing` at all (it ran before `signing` existed in scope) — the confirmed finding this
  // hoist closes.
  const proofSpineParamsWithSigning = withSigning(proofSpineParams, signing);

  // The Temporal registration hook: on a successful connect, register the workflows
  // + activities over the resolved proof-spine params (backends re-assembled inside
  // the hook per the registerWorker contract — it owns the connection lifetime).
  // Built ONLY when proof-spine params are supplied; absent them there is no identity
  // to register under and connectTemporal degrades instead (see below).
  const registerHook =
    proofSpineParamsWithSigning !== undefined
      ? makeProofSpineRegisterHook({
          params: proofSpineParamsWithSigning,
          backendsConfig,
          ...(config.stubExtraction !== undefined ? { stubExtraction: config.stubExtraction } : {}),
        })
      : undefined;

  const connectTemporal = (): Promise<Result<BootstrapReady, BootstrapDegraded>> => {
    // No proof-spine identity → nothing to register. Degrade cleanly WITHOUT a real
    // Temporal contact and WITHOUT a throw (§16): the API + backends stay up; the
    // supervisor sees Temporal-unavailable and the pipeline is wired later.
    if (registerHook === undefined) {
      return Promise.resolve(
        decideBootstrap(
          {
            connected: false,
            reason: "proof-spine params not configured — Temporal registration skipped",
          },
          { now: backends.now(), taskQueue: PROOF_SPINE_TASK_QUEUE, attempt: 0 },
        ),
      );
    }
    return bootstrapWorker({
      address: config.temporalAddress ?? "127.0.0.1:7233",
      taskQueue: PROOF_SPINE_TASK_QUEUE,
      now: backends.now,
      maxConnectAttempts: config.maxConnectAttempts ?? 5,
      onConnected: registerHook,
    });
  };

  // §9 make-it-real C3b — the local-vault file-watcher capture trigger (OFF by default).
  // The Temporal Client's FIRST real caller: build a loopback dispatch Client (degraded-
  // safe — a connect fault ⇒ startRun undefined ⇒ every capture fails CLOSED with a
  // surfaced worker_down health item, never a crash), then start a real fs.watch over the
  // vault root. Stopped on close(). This is the SAME `startVaultWatcher` seam the gated
  // e2e drives with a TestWorkflowEnvironment client — no dormant code.
  let vaultWatcher: RunningVaultWatcher | undefined;
  let vaultDispatchConnection: { close(): Promise<void> } | undefined;
  if (config.vaultWatch !== undefined && config.vaultRoot !== undefined) {
    const watchRoot = config.vaultRoot;
    const watchWorkspaceId = config.vaultWatch.workspaceId;
    let startRun: StartWorkflowRun | undefined;
    try {
      const { Client, Connection } = await import("@temporalio/client");
      // LAZY connect — a synchronous handle that NEVER blocks boot on a down Temporal (the
      // dev-server RUN is the owner's separate ops step). A dispatch attempt lazily connects;
      // if Temporal is down it fails CLOSED per-capture (C3a typed err + surfaced health item)
      // and auto-recovers when the server returns — no boot-time connect stall (§16).
      const connection = Connection.lazy({ address: config.temporalAddress ?? "127.0.0.1:7233" });
      vaultDispatchConnection = connection;
      startRun = createTemporalClientStartRun(new Client({ connection }));
    } catch {
      // A client-build fault degrades to startRun=undefined ⇒ each capture fails CLOSED via
      // the degraded dispatch below. Never a crash (§16).
      // task M3a follow-up — UPPER_SNAKE, not lower_snake: a lower_snake `code` value fails
      // @sow/domain's `code`-field STRUCTURED_CODE vocabulary (measured — the exact gap M3a
      // fixed at the three registrar-ensure-loop sites + the `schedule.client_unavailable`
      // sibling below) and renders `[REDACTED:raw]`, dropping this fixed, owner-data-free
      // literal for no reason. This is the ONE site that follow-up missed.
      backends.logger.warn("vault.watch.temporal_client_unavailable", { fields: { code: "CLIENT_BUILD_FAILED" } });
    }
    const vaultDispatchHealth: DispatchHealthSink = async ({
      failureClass,
      subjectRef,
      message,
      auditRef,
    }) => {
      try {
        await backends.healthItems.put({
          id: `${failureClass}:${subjectRef}`,
          failureClass,
          severity: "error",
          message,
          auditRef,
          openedAt: backends.now(),
          state: "open",
        });
      } catch {
        // A health-sink fault must never crash boot (§16).
      }
    };
    const vaultDispatch: VaultDispatch = (input) =>
      dispatchSourceIngestion(input, {
        ...(startRun !== undefined ? { startRun } : {}),
        surfaceHealth: vaultDispatchHealth,
        taskQueue: PROOF_SPINE_TASK_QUEUE,
        auditRef: BOOT_AUDIT_REF,
      });
    vaultWatcher = startVaultWatcher(
      {
        vaultRoot: watchRoot,
        workspaceId: config.vaultWatch.workspaceId,
        sensitivity: config.vaultWatch.sensitivity,
      },
      {
        transport: createFileReadTransport(watchRoot),
        dispatch: vaultDispatch,
        // A synchronous fs.watch start-throw (missing root / fd exhaustion) degrades to a
        // no-op watcher (never crashes boot, §16); surface it as a redaction-safe code.
        onWatchError: () =>
          backends.logger.warn("vault.watch.start_failed", { fields: { code: "watch_unavailable" } }),
        // Observability for a capture that neither dispatched nor was cleanly ignored (an
        // unreadable file / internal fault) — the outcome kind + the RELATIVE vault path only
        // (never the redacted message, which could carry an errno; never content/secret).
        onCapture: (outcome, relPath) => {
          if (outcome.kind !== "dispatched" && outcome.kind !== "ignored") {
            backends.logger.warn("vault.watch.capture_not_dispatched", {
              fields: { kind: outcome.kind, path: relPath },
            });
          }
          // task 19.4 — fire the reconcile trigger on a fresh dispatch (fs_watch origin). `reconcile` is the
          // F2 gate's ON-path wiring — undefined on the shipped default (byte-equivalent; this call never even
          // reaches `.notify`). Fire-and-forget + swallowed: a reconcile-trigger fault must never crash the
          // watcher (§16) — the trigger's own chain (scheduler → driver → pass) already routes every fault to
          // a redacted log + HealthItem (piece E/F1), so silence here loses nothing but a duplicate report.
          void reconcileNotifyForCapture(reconcile, watchWorkspaceId, outcome)?.catch(() => {
            /* best-effort — never crash the watcher on a reconcile-trigger fault */
          });
        },
        ...(config.vaultWatch.debounceMs !== undefined
          ? { debounceMs: config.vaultWatch.debounceMs }
          : {}),
      },
    );
  } else if (config.vaultWatch !== undefined) {
    // `vaultWatch` configured but no `vaultRoot` — a misconfiguration; surface it, don't
    // silently no-op.
    backends.logger.warn("vault.watch.no_vault_root", { fields: { code: "missing_vault_root" } });
  }

  // §13 task 11.3-b — the GBrain version-pin verify (OFF unless configured). FIRE-AND-FORGET +
  // DEGRADED-SAFE: probes the running gbrain against config/gbrain.pin and surfaces the distinct
  // version-pin health item on degrade; a probe / pin-load / surface fault is caught + boot continues
  // (mirrors the reconciler). The ~0.5s `gbrain doctor --json` never gates the control plane. The
  // write-through flip / serving-oracle stay HITL — the only observable effect is the startup HealthItem.
  if (config.gbrainStartupVerify !== undefined) {
    const gv = config.gbrainStartupVerify;
    void gbrainStartupVerify({
      readPinText: () => readFile(gv.pinPath, "utf8"),
      probe: gv.probe ?? createGbrainVersionProbe(),
      surfaceHealth: (item) => backends.healthItems.put(item),
      now: backends.now,
      auditRef: GBRAIN_VERIFY_AUDIT_REF,
      logger: backends.logger,
    });
  }

  // tasks 25.2/25.3/25.4/25.5 — the output-workflow DURABLE schedules (each default-OFF, strict
  // `=== true`). Mirrors the GBrain version-pin verify's own FIRE-AND-FORGET + DEGRADED-SAFE
  // discipline just above (never blocks boot, never crashes it — §16) AND the vault-watcher's
  // LAZY-connect discipline (a down Temporal degrades to a warned no-op, no boot-time connect
  // stall). ⛔ NOTHING ARMS: every `gate*Schedule` call below returns undefined unless the owner
  // has flipped ITS OWN config flag to the STRICT literal `true` (each an independent AND-lock —
  // arming one schedule never arms another), and even on an armed path `ensure()` never ASKS to
  // start a live schedule: it CREATES paused, and a converge PRESERVES whatever pause state the
  // schedule already had.
  // ⛔ Read that second half precisely — a converge over a schedule an operator UNPAUSED leaves it
  // LIVE, by design. So the honest claim is "this code never TRANSITIONS a schedule to live",
  // NOT "no schedule here can be live". Only a human operator makes one live, outside this
  // process; from then on a converge keeps it that way.
  // ⛔ And the guarantee is NOT `scheduleRegistrar.ts`'s port shape. That port omits a `paused`
  // field, and that fact alone guarantees NOTHING — it was MEASURED FALSE (`afterCreate.paused=true`
  // → `afterUpdate.paused=false`, task F2): the SDK's update is a full REPLACE, so proto3 filled the
  // absent bool with `false` and silently unpaused the schedule on the second boot. What actually
  // preserves pause state is THIS file's {@link createRealScheduleClientPort}`.update`, which reads
  // `previous.state.paused` back and echoes it. An absence in a port's TYPE is not an absence on
  // the WIRE. Every gated spec is collected FIRST, then — only
  // if at least one armed — registered over ONE lazily-connected, always-closed Temporal client
  // (amortizing the connect rather than opening one per schedule; 25.5's own per-schedule
  // fire-and-forget/degraded-safe/lazy-connect/always-closed properties all hold identically per
  // spec inside the shared loop).
  // WP5 — the registered-workspace scopes the composition root's own registry holds, used as
  // the DEFAULT `scopes` for the dailyBrief/periodReview families (an explicit owner `scopes`
  // override on either config block takes precedence inside buildOutputWorkflowScheduleSpecs).
  // Only fetched when one of the two scope-consuming families is actually armed —
  // crossCalendarScheduling/projectSync/ingestionTriage need no registry read, so a fully-OFF
  // default boot performs NEITHER this read NOR any construction beyond the pure builder below
  // (byte-equivalent, mirrors the OFF-guard-first discipline every gate here already follows).
  const dailyOrPeriodReviewArmed =
    config.dailyBriefSchedule?.enabled === true || config.periodReviewSchedule?.enabled === true;
  const registryWorkspaceScopes: readonly ScheduledWorkspaceScope[] = dailyOrPeriodReviewArmed
    ? await loadRegisteredWorkspaceScopes(backends.repos.readModels)
    : [];

  const outputWorkflowScheduleSpecs: TemporalScheduleSpec[] = buildOutputWorkflowScheduleSpecs(
    config,
    PROOF_SPINE_TASK_QUEUE,
    registryWorkspaceScopes,
    // ⛔ task F3 — an ARMED family whose owner-configured workspace-id override is malformed lands
    // here instead of throwing: a warned log line + a best-effort HealthItem (never blocks boot,
    // §16 — mirrors the single-owner-lock refusal mint above). That family registers zero
    // schedules this boot; sibling families are unaffected (per-family isolation in the builder).
    (skip) => {
      // task W3c — a combined UPPER_SNAKE code (family + reason) survives the field-level redactor
      // via its EXISTING `code`/STRUCTURED_CODE pass-through; see scheduleSkipLogCode's own doc.
      backends.logger.warn("schedule.envelope_invalid", {
        fields: { code: scheduleSkipLogCode(skip) },
      });
      backends.healthItems
        .put({
          id: `schedule-envelope:${skip.family}:${backends.now()}`,
          failureClass: "worker_down",
          severity: "warn",
          // task W3b — the message is accurate PER CODE (a closed map), not a single hardcoded
          // workspace-id string that named the wrong field for four of the five skip codes.
          message: scheduleSkipHealthMessage(skip.code),
          auditRef: auditId(`worker-boot:schedule-envelope:${skip.family}`),
          openedAt: backends.now(),
          state: "open",
        })
        .catch(() => {
          /* best-effort — a health-mint fault must never block boot (§16) */
        });
    },
  );

  if (outputWorkflowScheduleSpecs.length > 0) {
    const specs = outputWorkflowScheduleSpecs;
    void (async (): Promise<void> => {
      let closeConnection: (() => Promise<void>) | undefined;
      try {
        const { Client, Connection, ScheduleNotFoundError } = await import("@temporalio/client");
        const connection = Connection.lazy({ address: config.temporalAddress ?? "127.0.0.1:7233" });
        closeConnection = (): Promise<void> => connection.close();
        const scheduleClient = new Client({ connection }).schedule;
        const registrar = createTemporalScheduleRegistrar({
          client: createRealScheduleClientPort(
            scheduleClient,
            (e): boolean => e instanceof ScheduleNotFoundError,
          ),
        });
        // Sequential, not Promise.all — a single shared connection is reused per-call; failures
        // are isolated per scheduleId (one schedule's fault never aborts the others' ensure()).
        for (const spec of specs) {
          const outcome = await registrar.ensure(spec);
          if (isErr(outcome)) {
            // task M3a — folds scheduleId+error-code into ONE redaction-safe `code` (see
            // scheduleEnsureFailedLogCode's own doc) — a bare `scheduleId`/raw `code` here would
            // both be silently dropped by the real redactor (measured, task M3a).
            backends.logger.warn("schedule.ensure_failed", {
              fields: { code: scheduleEnsureFailedLogCode(spec.scheduleId, outcome.error.code) },
            });
          } else {
            // task M3a — same fold for the success path (see scheduleEnsuredLogCode's own doc).
            backends.logger.info("schedule.ensured", {
              fields: { code: scheduleEnsuredLogCode(spec.scheduleId, outcome.value.action) },
            });
          }
        }
      } catch {
        // A client-build/connect fault degrades to a warned no-op — never crashes boot (§16),
        // mirrors the vault-watcher's own CLIENT_BUILD_FAILED discipline above (both sites now
        // agree — a prior round's M3a follow-up fixed this site's casing but missed the
        // vault-watcher one, leaving two neighbouring sites disagreeing on redactor survival).
        // ⛔ task M3a — UPPER_SNAKE: lower_snake does NOT match @sow/domain's `code`-field
        // `STRUCTURED_CODE` vocabulary (measured — it fails the same as the three sibling sites
        // above), so it would render `[REDACTED:raw]` same as the sites this task fixes. This is
        // a fixed literal carrying no owner data either way; only the casing needed to change to
        // survive the redactor.
        backends.logger.warn("schedule.client_unavailable", {
          fields: { code: "CLIENT_BUILD_FAILED" },
        });
      } finally {
        try {
          await closeConnection?.();
        } catch {
          /* best-effort close — a teardown fault must never surface (§16) */
        }
      }
    })();
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // task 11.1/24.1 — release the single-owner lock (idempotent by construction; a no-op if this
    // instance never held it). Wrapped defensively even though the primitive documents itself
    // never-throwing — a shutdown path must never itself become a crash (§16).
    if (singleOwnerLockResult?.ok === true) {
      try {
        singleOwnerLockResult.release();
      } catch {
        /* best-effort — a release fault must never block shutdown */
      }
    }
    vaultWatcher?.stop();
    if (vaultDispatchConnection !== undefined) {
      try {
        await vaultDispatchConnection.close();
      } catch {
        // Best-effort — a dispatch-Connection close fault must not block shutdown.
      }
    }
    if (backupTimer !== undefined) clearInterval(backupTimer);
    // ⛔ `clearInterval` stops FUTURE ticks and says NOTHING about the one that may be running.
    // `backends.close()` below severs the very connection the backup engine reads through, so
    // without this await a restart-during-deploy could close the store under a live backup — the
    // moment a pre-shutdown backup matters most. The tick swallows its own errors, so the result
    // would be a silently-lost backup or a half-written artifact restore later trusts.
    // Resolves immediately when idle, so an idle shutdown is not delayed.
    await backupTick.settled();
    await api.close();
    backends.close();
  };

  // 16.1 — compose the connector-engine substrate: all read adapters over the INERT
  //   transport (no real transport, no tokenRef, no secret read). Dormant until Phase 23
  //   binds a real HttpTransport; 16.2 binds the poll registration off `connectors.ports`.
  const connectors = composeConnectors();

  return {
    api,
    backends,
    logger: backends.logger,
    degraded,
    backupService,
    connectTemporal,
    close,
    connectors,
    ...(reconcile !== undefined ? { reconcile } : {}), // present ONLY on the armed path; omitted by default (byte-equivalent)
  };
}

/**
 * Drive the INITIAL Temporal connect and, on the degraded variant, record the outage as
 * an operator-visible worker_down System-Health item via the degraded controller (which
 * persists through the surface → the same `health_items` table the systemHealth query
 * reads). A ready connect does nothing.
 *
 * The DEGRADED verdict is `!result.ok` — the connect Result's error variant IS the
 * degraded state (`BootstrapDegraded`); it is not re-derived from a payload field.
 *
 * Never throws (§16): a health-persist fault inside `onConnectionLost` folds to a typed
 * err the controller owns; this driver still reports `degraded: true` so the supervisor
 * backs off rather than crash-looping. But a persist fault means the worker_down item
 * silently did NOT land — the renderer would still read "All systems healthy" for the
 * exact case this exists to fix — so the fault is WARN-logged (the only observability
 * path; the caller discards the Result). The Phase-9 worker-host awaits this BEFORE
 * announcing readiness, so the item is persisted before the renderer's initial health
 * hydrate (a fresh null-cursor stream subscribe does not replay a pre-subscribe publish).
 */
export async function reportInitialConnect(
  booted: Pick<BootedWorker, "connectTemporal" | "degraded">,
  opts: { readonly now: string; readonly logger: Logger },
): Promise<{ readonly degraded: boolean }> {
  const connect = await booted.connectTemporal();
  if (connect.ok) return { degraded: false };
  // Degraded: record the outage (empty recent-failure ledger → first-probe backoff).
  const recorded = await booted.degraded.onConnectionLost({ now: opts.now, recentFailures: [] });
  if (!recorded.ok) {
    // The item did not persist — surface it so a fail-closed "All systems healthy" is
    // never silent. Only the enum code is logged (no raw content / secret — safety 7).
    opts.logger.warn("worker.degraded.health_record_failed", {
      fields: { code: recorded.error.code },
    });
  }
  return { degraded: true };
}
