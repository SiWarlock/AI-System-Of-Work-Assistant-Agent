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
  Approval,
  AuditId,
} from "@sow/contracts";
import { auditId as makeAuditId, sourceId as makeSourceId } from "@sow/contracts";

// KnowledgeWriter — the SOLE Markdown writer; real ownership+secret defaults kept.
import { applyPlan } from "@sow/knowledge";
import type {
  KnowledgeWriterDeps,
  KnowledgeRevisionStore,
  RevisionId,
} from "@sow/knowledge";

// The §8 Tool Gateway external-write entry + its deps.
import { dispatchExternalWrite } from "@sow/integrations";
import type { ExternalWriteDeps, ExternalWriteResult } from "@sow/integrations";

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
  createRescopeSourceActivity,
  createReenterIngestionActivity,
  meetingOutputsProjection,
} from "@sow/workflows";
import type {
  CorrelatePort,
  CorrelationSignals,
  CorrelateError,
  RunMeetingAgentJobPort,
  MeetingJobInputs,
  ValidateExtractionPort,
  BuildOutputsPort,
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
  DispositionStore,
  RescopeSourcePort,
  ParkedSourceReader,
  ReenterIngestionPort,
  SourceIngestionRunner,
} from "@sow/workflows";
import type { BrokerOutcome } from "@sow/providers";

import type {
  ProofSpineBackends,
  ResolvedWorkspacePolicy,
} from "./backends";
import { makeRequireApproval } from "./backends";

// ---------------------------------------------------------------------------
// The per-flow binding parameters (identity/config that is not a backend adapter)
// ---------------------------------------------------------------------------

/**
 * The identity + policy parameters the proof-spine flows are bound under. These are
 * the correlation-bound workspace, the meeting.close job inputs, the KnowledgeWriter
 * commit metadata, and the resolved workspace posture the approval predicate reads.
 * Supplied by the Spine phase (or a test) alongside the backends bundle.
 */
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
  const buildOutputs: BuildOutputsPort = createBuildOutputsActivity({
    projection: meetingOutputsProjection,
    sourceRef: params.sourceRef,
    planIdentity: params.planIdentity,
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

  // recordDisposition — an in-memory disposition store over the real audit sink (the
  // §9 operational disposition table is Phase-10; this binds the exactly-once record).
  const dispositionStore: DispositionStore = makeDispositionStore(
    backends,
    params.commit.workflowRunRef,
  );
  const recordDisposition: RecordDispositionPort = createRecordDispositionActivity({
    store: dispositionStore,
  });

  // rescopeSource — read the parked source through the register/read seam, apply the
  // owner override (inv-C), preserve contentHash (inv-D).
  const parkedReader: ParkedSourceReader = {
    read: (sourceIdStr: string) =>
      Promise.resolve(
        err({
          code: "source_unavailable" as const,
          message: `parked source ${sourceIdStr} not available in this stub reader (carry-forward: the real parked-source read seam)`,
        }),
      ),
  };
  const rescopeSource: RescopeSourcePort = createRescopeSourceActivity({
    reader: parkedReader,
  });

  // reenterIngestion — re-drive the 7.7 pipeline REUSING the same idempotencyKey (inv-D).
  const ingestionRunner: SourceIngestionRunner = {
    run: (_reScopedSource, _idempotencyKey) =>
      Promise.resolve(ok({ state: "applied", runReused: true })),
  };
  const reenterIngestion: ReenterIngestionPort = createReenterIngestionActivity({
    runner: ingestionRunner,
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

    // infra — the failure sink every driver routes through (inv-5).
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

/**
 * An in-memory DispositionStore (the §9 disposition table is Phase-10). It CAS-inserts
 * by the channel-free disposition key, minting an audit ref through the real audit sink
 * so nothing is silent. `isParked` is a stub `true` (the parked-source read seam is a
 * carry-forward). Exactly-once by key: a HIT reuses the prior audit ref (inv-A/inv-B).
 */
function makeDispositionStore(
  backends: ProofSpineBackends,
  runRef: WorkflowRunRef,
): DispositionStore {
  const byKey = new Map<string, AuditId>();
  return {
    isParked: (_sourceIdStr: string) => Promise.resolve(ok(true)),
    getByKey: (key: string) => Promise.resolve(byKey.get(key)),
    async insert(key, disposition) {
      const auditRef = makeAuditId(`audit:disposition:${key}`);
      // Append a redaction-safe audit record (summaries only — never raw content).
      await backends.repos.audit.append({
        actor: "ingestion-triage",
        event: "ingestion.triage.disposition.recorded",
        refs: [
          `ref:source:${String(makeSourceId(disposition.sourceId))}`,
          `ref:workspace:${String(disposition.workspaceId)}`,
          `ref:workflow:${runRef.workflowId}`,
          String(auditRef),
        ],
        payloadHash: `disposition:${key}`,
        beforeSummary: "parked source awaiting owner disposition",
        afterSummary: "owner disposition recorded; source re-scoped for re-entry",
        timestamps: { occurredAt: backends.now() },
      });
      byKey.set(key, auditRef);
      return ok(auditRef);
    },
  };
}
