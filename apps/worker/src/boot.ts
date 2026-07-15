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
import { auditId, sourceId, isOk, workspaceId, workflowId } from "@sow/contracts";
import type {
  Result,
  FailureVariant,
  HealthItem,
  AuditId,
  SourceRef,
  WorkspaceId,
  WorkflowRunRef,
  GbrainPin,
} from "@sow/contracts";
import { descriptorFor } from "@sow/policy";
import type { SessionToken, LegacyContentPolicy, CopilotWorkspaceScope, ResolvedWorkspacePolicy } from "@sow/policy";
import { TBD } from "@sow/domain";
import type { MeetingJobInputs, AgentExtraction } from "@sow/workflows";

import {
  assembleBackends,
  type ProofSpineBackends,
  type BackendsConfig,
  type StubMeetingExtraction,
} from "./composition/backends";
import type { WorkerOriginAllowlist } from "./api/auth/originAllowlist";
import { startApiServer, type RunningApiServer } from "./api/mount";
import { createDbReadModelQueryPort } from "./api/adapters/readModel";
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
import {
  buildCopilotDeps,
  resolveCopilotWorkspaces,
  buildInterimCopilotScopeRegistry,
} from "./api/procedures/copilotClaudeSynthesis";
import type { CopilotWorkspace } from "./api/procedures/copilotClaudeSynthesis";
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
import { readdirSync } from "node:fs";
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
import type { CopilotNoteExistsProbe } from "./api/procedures/copilotProposeKnowledge";
import type { CopilotServingOracle } from "./api/procedures/copilotProvenanceStamp";
import { selectServingOracleFactory } from "./api/procedures/servingContextLoader";
import type { CommittedVaultReader } from "./api/procedures/servingContextLoader";
import { createReconcileScheduler } from "./composition/reconcileScheduler";
import type { LoggedReconcileOutcome, ReconcileScheduler } from "./composition/reconcileScheduler";
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
import type { CopilotSynthesisPort } from "./api/procedures/copilot";
import { createReadModelBriefingRetrieval, type CopilotBriefingDeps } from "./api/procedures/copilotBriefing";
import { createClaudeSubscriptionCompletion } from "@sow/providers";
import type { SystemHealthQueryPort, UiSafeEgressStatus } from "./api/procedures/systemHealth";
import type {
  ApprovalCommandPort,
  DispatchApprovalFn,
  TriagePort,
} from "./api/procedures/commands";
import type { Logger } from "./observability/logger";
import { createHealthSurface, type HealthSurface, type HealthFailure } from "./health/surface";
import { createPersistentHealthSurfaceStore } from "./composition/store-adapters";
import { provisionDevWorkspace, type DevProvisionSpec } from "./composition/provisionDev";
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
import { bootstrapWorker, decideBootstrap } from "./temporal/worker";
import type { BootstrapReady, BootstrapDegraded } from "./temporal/worker";
import {
  makeProofSpineRegisterHook,
  PROOF_SPINE_TASK_QUEUE,
} from "./temporal/registerWorker";
import type { ProofSpineParams } from "./composition/buildActivities";
// §11.1 slice 2b — the durable KnowledgeRevisionStore adapter (over the 2a operational-store repo),
// rebound into the proof-spine params post-backends so the ingestion sourceCommit + propose dispatch
// persist idempotency across a worker restart. Kept OFF the OFF-config path (see withDurableRevisions).
import { createKnowledgeRevisionStoreAdapter } from "./composition/knowledgeRevisionStore";
// C5.4b B4 — the durable ParityReportStore read-adapter, bound into the serving-coverage reader inside the
// triple-locked loaderBackedServingOracle branch (closes the B2 store-consuming reachability waiver).
import { createParityReportStoreAdapter } from "./composition/parityReportStore";
import type { KnowledgeRevisionRepository } from "@sow/db";
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
} from "./watch/vaultWatcher";
// §13 task 11.3-b — the GBrain version-pin BOOT verify step (closes the 11.3-a reachability waiver).
import { readFile } from "node:fs/promises";
import { createGbrainVersionProbe, computeRevisionId, type GbrainVersionProbe, type KnowledgeRevisionStore, type CommittedRevision, type SecretsPort, type SecretRef, type RunningGbrainVersion, type VaultFs, type GbrainReadAdapter, type ReconcilerDbProjection, type IndexRebuildClient } from "@sow/knowledge";
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
   * Real GBrain retrieval (P3-live — OFF by default; requires `copilotRealModel` too). When true, the ONE
   * served workspace (`copilotGbrainWorkspaceId`, default personal-business) reads the LOCAL gbrain via the
   * `gbrain call query` CLI instead of the empty fixture stub; every OTHER workspace stays on the fixture
   * (WS-8 by construction — only the served workspace ever reads the single local brain). The worker needs
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
   * wrapper). NOTE: the `getSecret` provider facade + the Keychain-locked degraded routing land in a Slice-4 follow-up.
   */
  readonly keychainSecrets?: KeychainSecretsGate;
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
  /** The reconcile-TRIGGER wiring (task 13.10) — present ONLY on the armed path (`config.reconcile === true`); the
   *  shipped default omits it (byte-equivalent). The owner's arming-era trigger source binds to `scheduler`. */
  readonly reconcile?: ReconcileWiring;
}

// ── the health/egress query port over the persistent store ────────────────────

/** A fail-closed egress status: raw Employer-Work egress OFF + zero-egress ON (safe default). */
function failClosedEgress(workspaceId: string): UiSafeEgressStatus {
  return { workspaceId, employerRawEgressAcknowledged: false, zeroEgressOnly: true };
}

/**
 * Build the System-Health query port over the persistent health store. `healthItems`
 * reads the durable @sow/db `health_items` table (via the backends' persistent
 * `HealthItemStore`); a store fault folds to a typed `degraded_unavailable` err
 * (never a throw, §16). `egressStatus` returns the FAIL-CLOSED default (raw egress
 * OFF, zero-egress ON) — the real per-workspace egress-policy read is Phase-9
 * workspace-settings territory; the safe default never over-permits.
 */
function createSystemHealthQueryPort(backends: ProofSpineBackends): SystemHealthQueryPort {
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
    egressStatus(workspaceId: string): Result<UiSafeEgressStatus, FailureVariant> {
      return { ok: true, value: failClosedEgress(workspaceId) };
    },
  };
}

// ── the live boot ──────────────────────────────────────────────────────────────

/** The audit ref anchoring the degraded controller's worker_down health items. */
const BOOT_AUDIT_REF: AuditId = auditId("worker-boot:temporal-degraded");
// §13 task 11.3-b — a dedicated audit subject for the GBrain version-pin startup verify degrades
// (distinct from the temporal-degraded subject so audit-by-subject stays precise).
const GBRAIN_VERIFY_AUDIT_REF: AuditId = auditId("worker-boot:gbrain-version-pin");

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
}

/** The wiring gateAutoIngest augments the bootWorker call with when the opt-in is ON — every field is an
 *  existing BootConfig field, so the worker-host wires all three with one spread. */
export interface AutoIngestWiring {
  readonly vaultWatch: { readonly workspaceId: string; readonly sensitivity: string };
  readonly proofSpineParams: ProofSpineParams;
  readonly temporalAddress: string;
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
  buildProofSpineParams: (workspaceId: string) => ProofSpineParams,
): AutoIngestWiring | undefined {
  if (opts.autoIngest !== true || vaultRoot === undefined) return undefined;
  const ingestWorkspaceId = opts.ingestWorkspaceId ?? DEFAULT_INGEST_WORKSPACE;
  const sensitivity = opts.ingestSensitivity ?? "normal";
  return {
    vaultWatch: { workspaceId: ingestWorkspaceId, sensitivity },
    proofSpineParams: buildProofSpineParams(ingestWorkspaceId),
    temporalAddress: opts.temporalAddress ?? "127.0.0.1:7233",
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

/** The assembled reconcile machinery the ON path returns (F2 holds it; a future trigger source drives its flush). */
export interface ReconcileWiring {
  readonly scheduler: ReconcileScheduler;
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

  return { scheduler };
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
export function buildAutoIngestProofSpineParams(boundWorkspace: string): ProofSpineParams {
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
    outputSchemaId: "sow:meeting.close.output",
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
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    },
    providerMatrix: {
      workspaceId: ws,
      allowedProviders: [],
      // Empty inert — the meeting.close route is never resolved (the meeting flow registers but never dispatches).
      capabilityDefaults: {} as ResolvedWorkspacePolicy["providerMatrix"]["capabilityDefaults"],
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
 * Boot the live worker control plane. Assembles the persistent backends, stands up
 * the real loopback API transport over the @sow/db port adapters (behind the injected
 * token + allowlist), wires the redacting logger + the Temporal-unavailable degraded
 * controller, and exposes a `connectTemporal()` that drives `bootstrapWorker` with
 * the proof-spine register hook. See the header for the Phase-9/11 residual deferrals.
 */
export async function bootWorker(config: BootConfig): Promise<BootedWorker> {
  // 1) The persistent composition root (sqlite + genesis migration, vault, the
  //    persistent §9 stores, the redacting logger, the §7 broker).
  const backendsConfig: BackendsConfig = {
    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
    ...(config.vaultRoot !== undefined ? { vaultRoot: config.vaultRoot } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
    ...(config.allowedLocalEndpoints !== undefined
      ? { allowedLocalEndpoints: config.allowedLocalEndpoints }
      : {}),
    ...(config.logSink !== undefined ? { logSink: config.logSink } : {}),
  };
  const backends = await assembleBackends(backendsConfig, config.stubExtraction);

  // 1.4) §11.1 slice 2b — DURABLE revisions. Rebind the proof-spine params' placeholder `revisions` to the
  //   durable slice-2a KnowledgeRevisionStore over `backends.repos.knowledgeRevisions` (the repo exists only now;
  //   the params were assembled at the worker-host before boot). This runs BEFORE any `proofSpineParams.revisions`
  //   consumer below (the semantic dispatch + the proof-spine register hook), so the ingestion `sourceCommit` and
  //   the dormant propose dispatch both persist idempotency durably (survives a worker restart). On the OFF path
  //   `config.proofSpineParams` is undefined ⇒ `proofSpineParams` is undefined ⇒ the durable store is NEVER
  //   constructed and NOTHING persists (the slice-1 owner-opt-in invariant is intact).
  const proofSpineParams = withDurableRevisions(
    config.proofSpineParams,
    backends.repos.knowledgeRevisions,
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

  // 2) The REAL @sow/db port adapters behind the query/command surface.
  const readModel: ReadModelQueryPort = createDbReadModelQueryPort({
    readModels: backends.repos.readModels,
    approvals: backends.repos.approvals,
  });
  const approvals: ApprovalCommandPort = createDbApprovalCommandPort(backends.repos.approvals);
  const triage: TriagePort = createDbTriagePort(config.triageDispatch);
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
          return createAgentRuntimeCopilotSynthesis(runner, {
            proposeEnabled: config.copilotProposeMode === true,
            // §13.10a — COUPLED to the dispatch side: propose_knowledge stays OFF unless proofSpineParams is
            // provisioned (the KnowledgeWriter commit path), so an approved semantic card is always committable
            // (never stranded on the external-only dispatch). Mutually exclusive with proposeEnabled (both on ⇒
            // the capability resolver fails closed to read_only).
            knowledgeProposeEnabled: config.copilotProposeKnowledge === true && proofSpineParams !== undefined,
            resolveContentTrust: deriveCopilotContentTrust,
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
  // 11.4 Slice 3 — the owner-provisioning gate: build the real Keychain `SecretsPort` ONLY when provisioned (gate
  // absent ⇒ `undefined`, inert — no adapter/backend/`security` process, byte-equivalent). Sources OFF-lock 2.
  const keychainSecrets = buildKeychainSecrets(config.keychainSecrets);
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
  const copilot = buildCopilotDeps({
    realCopilot: config.copilotRealModel === true,
    workspaces: copilotWorkspaces,
    model: config.copilotModel,
    betas: config.copilotBetas,
    completion: createClaudeSubscriptionCompletion,
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
  const briefing: CopilotBriefingDeps = {
    synthesis: copilot.synthesis,
    workspacePosture: copilot.workspacePosture,
    routeSelector: copilot.routeSelector,
    retrieval: createReadModelBriefingRetrieval(readModel),
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
    onboarding,
    projectRegistry,
    connectorConfig,
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
  const degraded: TemporalUnavailabilityController = createTemporalUnavailabilityController({
    surface,
    auditRef: BOOT_AUDIT_REF,
    dispatch: (jobId: string): Promise<void> => {
      backends.logger.info("temporal.degraded.redrive", { fields: { jobId } });
      return Promise.resolve();
    },
    config: DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG,
  });

  // ── piece F2 — the reconcile-TRIGGER arc's composition-root gate binding (task 13.10, DORMANT) ──────────────
  // Default-OFF: `config.reconcile` unset ⇒ `gateReconcile` returns undefined (NO reconcile machinery constructed
  // — byte-equivalent; the `reconcile` field is omitted from the returned BootedWorker). On the armed path
  // (owner-gated, NEVER the default) it assembles the scheduler over the never-reject builders; the owner-gated
  // GbrainReadGrant transport stays UNBOUND (`makeDbAdapter → undefined` ⇒ the db-projection degrades ⇒ even the
  // armed path records `coverageComplete=false`, never a false-green). The trigger source + flush timing bind at
  // the owner's ARMING bundle — NOT here; the wiring is exposed on BootedWorker so the arming-era source reaches
  // it. NO hard line crossed — nothing armed, transport unbound.
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

  // 5) The operational-backup service — WIRED but NOT scheduled (the CRON is Phase-11).
  const backupService =
    config.backupPorts !== undefined
      ? createOperationalBackupService(config.backupPorts.opDb, config.backupPorts.temporal)
      : undefined;

  // The Temporal registration hook: on a successful connect, register the workflows
  // + activities over the resolved proof-spine params (backends re-assembled inside
  // the hook per the registerWorker contract — it owns the connection lifetime).
  // Built ONLY when proof-spine params are supplied; absent them there is no identity
  // to register under and connectTemporal degrades instead (see below).
  const registerHook =
    proofSpineParams !== undefined
      ? makeProofSpineRegisterHook({
          params: proofSpineParams,
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
      backends.logger.warn("vault.watch.temporal_client_unavailable", { fields: { code: "client_build_failed" } });
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

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    vaultWatcher?.stop();
    if (vaultDispatchConnection !== undefined) {
      try {
        await vaultDispatchConnection.close();
      } catch {
        // Best-effort — a dispatch-Connection close fault must not block shutdown.
      }
    }
    await api.close();
    backends.close();
  };

  return {
    api,
    backends,
    logger: backends.logger,
    degraded,
    backupService,
    connectTemporal,
    close,
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
