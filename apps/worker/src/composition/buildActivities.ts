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
import { ok, err } from "@sow/contracts";
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
} from "@sow/contracts";
import { planId as makePlanId } from "@sow/contracts";
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
import type {
  KnowledgeWriterDeps,
  KnowledgeRevisionStore,
  RevisionId,
} from "@sow/knowledge";

// The §8 Tool Gateway external-write entry + its deps.
import { dispatchExternalWrite } from "@sow/integrations";
import type { ExternalWriteDeps, ExternalWriteResult } from "@sow/integrations";

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
} from "@sow/workflows";
import type { BrokerOutcome } from "@sow/providers";

import type {
  ProofSpineBackends,
  ResolvedWorkspacePolicy,
} from "./backends";
import { makeRequireApproval } from "./backends";
// The per-file ingestion note-path derivation (traversal-safe, content-addressed) — task 11.1.
import { deriveSourceNotePath, sourceIdentityDigest } from "./sourceNotePath";
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
}

export interface ProofSpineParams {
  /** The resolved workspace posture the fail-closed approval unwrap reads. */
  readonly resolved: ResolvedWorkspacePolicy;
  /** The correlation signals the (stub) correlator resolves — inv-1 threshold-gated. */
  readonly correlationSignals: CorrelationSignals;
  /** The meeting.close AgentJob inputs (READ-ONLY tool policy default; inv-2). */
  readonly meetingJobInputs: MeetingJobInputs;
  /**
   * The candidate meeting extraction the broker outcome maps to. Deterministic here
   * (the stub provider run is fixed) — the real transport streams a model extraction
   * that `mapCandidate` folds instead.
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
}

// ---------------------------------------------------------------------------
// The exported activities shape (what @temporalio/worker registers)
// ---------------------------------------------------------------------------

/**
 * The proof-spine activities as PLAIN ASYNC FUNCTIONS — the shape @temporalio/worker
 * registers. The Spine phase passes this object to `Worker.create({ activities })`.
 * Names are stable, flow-prefixed, and 1:1 with a port method.
 */
export interface ProofSpineActivities {
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
    resolveSignals: (
      _ctx: MeetingCloseoutContext,
    ): Promise<Result<CorrelationSignals, CorrelateError>> =>
      Promise.resolve(ok(params.correlationSignals)),
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
    mapCandidate: (_outcome: BrokerOutcome): AgentExtraction => params.meetingExtraction,
    // Phase-3/5 carry-forward: localConfig is ALWAYS supplied to the broker.
    localConfig: backends.localConfig,
  });

  // (c) validate — no-inference (real) + a deterministic pass-through schema gate.
  const schemaGate: MeetingSchemaGate = () => ok(undefined);
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
  };
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

  // (f) propose — the §8 Tool Gateway (dispatchExternalWrite) over real backends.
  const requireApproval = makeRequireApproval(params.resolved);
  const externalWriteDeps: ExternalWriteDeps = {
    adapter: backends.writeAdapter,
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
  };
  const propose: ProposeActionsPort = createProposeActivity({
    dispatch: (
      env: ExternalWriteEnvelope,
      action: ProposedAction,
      deps: ExternalWriteDeps,
    ): Promise<ExternalWriteResult> => dispatchExternalWrite(env, action, deps),
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

  // surfaceCard — render on BOTH channels with parity (a deterministic renderer that
  // always renders both; the real transport pushes Mac + Telegram cards).
  const cardRenderer: CardRenderer = {
    render: () => Promise.resolve(ok(undefined)),
  };
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
      const outcome = await dispatchExternalWrite(envelope, action, externalWriteDeps);
      switch (outcome.status) {
        case "created":
        case "reused":
          return ok({
            status: outcome.status,
            envelope: { ...envelope, writeReceipt: outcome.receipt },
          });
        case "conflict":
          return err({ code: "conflict", message: outcome.reason });
        case "held":
          return err({ code: "held", message: outcome.reason });
        case "approval_pending":
        case "rejected":
        default:
          return err({
            code: "rejected",
            message:
              outcome.status === "approval_pending"
                ? "external write awaits approval"
                : (outcome as { reason?: string }).reason ?? "external write rejected",
          });
      }
    },
  };
  const dispatchApproved: DispatchApprovedActionPort =
    createDispatchApprovedActivity(approvedGateway);

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
    classify: (): Promise<Result<RouteSignals, RouteError>> =>
      Promise.resolve(
        sourceBinding !== undefined
          ? ok({ confidence: 1, workspaceId: sourceBinding.boundWorkspaceId })
          : ok({ confidence: 0, reason: "no source-ingestion binding (C1)" }),
      ),
  });

  // (c) runAgentJob — a DETERMINISTIC accepted candidate (the real broker/model path is
  // C2/C3). Absent binding → a fail-closed unsupported_type rejection.
  const sourceAgent: RunSourceAgentJobPort = {
    run: (): Promise<Result<AgentExtraction, SourceAgentFailure>> =>
      Promise.resolve(
        sourceBinding !== undefined
          ? ok(sourceBinding.extraction)
          : err({ code: "unsupported_type", message: "no source-ingestion binding (C1)" }),
      ),
  };

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
            // Minimal identity-derived traceability frontmatter (no longer `{}`) — from the same
            // path-keying identity (no attacker-influenceable field). Deeper source-metadata
            // frontmatter (origin/type/sensitivity) is a deferred follow-up (needs more threading).
            frontmatter: { source: String(source.sourceId), contentHash: source.contentHash },
          },
        ],
        patches: [],
        linkMutations: [],
        frontmatterUpdates: [],
        externalActionProposals: [],
        confidence: 1,
        requiresApproval: false,
        provenanceOrigin: "ingestion",
      };
      return Promise.resolve(ok({ plan, actions: [] }));
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
  // dispatchExternalWrite, defined in §f-meeting above) — REPLACING the in-memory `ext-source-N` receipt
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

  // ── the plain-async-function object Temporal registers ───────────────────────
  return {
    // meeting-closeout
    meetingCorrelate: (ctx) => correlate.correlate(ctx),
    meetingRunAgentJob: (ctx) => runAgentJob.run(ctx),
    meetingValidate: (extraction) => validate.validate(extraction),
    meetingBuildOutputs: (validated: import("@sow/workflows").ValidatedExtraction, workspaceId: WorkspaceId) =>
      buildOutputs.build(validated, workspaceId),
    meetingCommit: (plan) => commit.commit(plan),
    meetingPropose: (action, env) => propose.propose(action, env),
    meetingReindex: (revisionId) => reindex.reindex(revisionId),
    meetingPark: (source, idempotencyKey) => meetingParkPort.park(source, idempotencyKey),

    // approval-flow
    approvalRecordPending: (ctx) => recordPending.record(ctx),
    approvalSurfaceCard: (approval) => surfaceCard.surface(approval),
    approvalApply: (approval, decision) => applyTransition.apply(approval, decision),
    approvalDispatchApproved: (action, env) => dispatchApproved.dispatch(action, env),

    // ingestion-triage
    triageRecordDisposition: (disposition) => recordDisposition.record(disposition),
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
    sourceCommit: (plan) => sourceCommit.commit(plan),
    sourcePropose: (action, env) => propose.propose(action, env),
    sourceIndex: (revisionId) => sourceIndexPort.index(revisionId),

    // infra — the failure sink every driver routes through (inv-5).
    // 16.2 — poll one connector (dormant in the shipped default; the resolve binds the real 16.1 adapters).
    connectorPoll: (connector) => connectorPollPort.poll(connector),
    surfaceFailure: (failure) => surfaceWorkflowFailure(failure, surfaceDeps),
  };
}

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

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

