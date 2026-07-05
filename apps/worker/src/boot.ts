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
import { auditId } from "@sow/contracts";
import type {
  Result,
  FailureVariant,
  HealthItem,
  AuditId,
} from "@sow/contracts";
import type { SessionToken } from "@sow/policy";

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
import { buildCopilotDeps, resolveCopilotWorkspaces } from "./api/procedures/copilotClaudeSynthesis";
import type { CopilotWorkspace } from "./api/procedures/copilotClaudeSynthesis";
import {
  createGbrainCliExec,
  DEFAULT_GBRAIN_COPILOT_WORKSPACE,
} from "./api/procedures/copilotGbrainSubprocess";
import type { GbrainQueryExec } from "./api/procedures/copilotGbrainSubprocess";
import {
  createGbrainHttpExec,
  createGbrainDcrTokenProvider,
  DEFAULT_GBRAIN_HTTP_URL,
} from "./api/procedures/copilotGbrainHttp";
import type { GbrainTokenProvider } from "./api/procedures/copilotGbrainHttp";
import {
  createAgentRuntimeCopilotSynthesis,
  createClaudeAgentCopilotRunner,
  deriveCopilotContentTrust,
  gbrainMcpEndpoint,
} from "./api/procedures/copilotAgentSynthesis";
import { createApprovalsProposeSink } from "./api/procedures/copilotProposeSink";
import { createCopilotProposeMcpServer } from "@sow/providers";
import type { CopilotSynthesisPort } from "./api/procedures/copilot";
import { createClaudeSubscriptionCompletion } from "@sow/providers";
import type { SystemHealthQueryPort, UiSafeEgressStatus } from "./api/procedures/systemHealth";
import type {
  ApprovalCommandPort,
  DispatchApprovalFn,
  TriagePort,
} from "./api/procedures/commands";
import type { Logger } from "./observability/logger";
import { createHealthSurface, type HealthSurface } from "./health/surface";
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
   * Explicit Copilot workspace set (id + type). Decoupled from `devProvision` (which is SURFACE data).
   * When omitted: devProvision-derived if present, else — on the real path — the 3 well-known scopes
   * (so the Copilot is reachable without a vault note). See `resolveCopilotWorkspaces`.
   */
  readonly copilotWorkspaces?: readonly CopilotWorkspace[];
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
          // tool ONLY for a trusted+scoped_write job — but `deriveCopilotContentTrust` is fail-closed
          // ('untrusted'), so a live ask never becomes propose-capable. Real go-live is a C5.4 gate.
          const proposeSink = createApprovalsProposeSink({
            approvals: backends.repos.approvals,
            workspaceConfig: backends.repos.workspaceConfig,
            now: backends.now,
          });
          const runner = createClaudeAgentCopilotRunner({
            servedWorkspaceId: config.copilotGbrainWorkspaceId ?? DEFAULT_GBRAIN_COPILOT_WORKSPACE,
            gbrainMcpUrl: gbrainMcpEndpoint(gbrainHttpBaseUrl),
            getToken: () => tokenProvider.getToken(false),
            proposeSink,
            buildProposeMcpServer: createCopilotProposeMcpServer,
            ...(config.copilotBetas !== undefined ? { betas: config.copilotBetas } : {}),
          });
          // proposeEnabled mirrors the flag; resolveContentTrust is the fail-closed interim (propose stays
          // structurally OFF at runtime regardless of the flag until C5.4 plumbs real per-content provenance).
          return createAgentRuntimeCopilotSynthesis(runner, {
            proposeEnabled: config.copilotProposeMode === true,
            resolveContentTrust: deriveCopilotContentTrust,
          });
        }
      : undefined;

  // Workspace set is resolved DECOUPLED from devProvision (which is SURFACE data, not Copilot reachability):
  // an explicit `copilotWorkspaces` wins, else devProvision-derived, else — on the real path — the 3
  // well-known scopes, so the Copilot answers without needing a vault note (#1 app-reachability).
  const copilot = buildCopilotDeps({
    realCopilot: config.copilotRealModel === true,
    workspaces: resolveCopilotWorkspaces({
      explicit: config.copilotWorkspaces,
      devProvision: config.devProvision,
      realCopilot: config.copilotRealModel === true,
    }),
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
    // C3: the agentic synthesis factory (only built when the flag is on) REPLACES the completion synthesis.
    ...(agentSynthesisFactory !== undefined ? { agentSynthesis: agentSynthesisFactory } : {}),
  });

  // 3) The real loopback transport (HTTP + WS) behind the injected token + allowlist.
  //    A non-loopback bind is refused inside `startApiServer` (REQ-NF-004).
  const api = await startApiServer({
    expectedToken: config.sessionToken,
    allowlist: config.allowlist,
    readModel,
    copilot,
    systemHealth,
    approvals,
    dispatchApproval: config.dispatchApproval,
    triage,
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
    config.proofSpineParams !== undefined
      ? makeProofSpineRegisterHook({
          params: config.proofSpineParams,
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

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await api.close();
    backends.close();
  };

  return { api, backends, logger: backends.logger, degraded, backupService, connectTemporal, close };
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
