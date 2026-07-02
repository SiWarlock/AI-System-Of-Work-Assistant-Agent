// @sow/workflows — task 7.6 SEAM: the MEETING-CLOSEOUT activity ports.
//
// This is the port surface every downstream 7.6 slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) it is PURE + workflow-safe: it imports
// NOTHING from @temporalio, NOTHING from node:crypto, and calls NO
// Date.now()/Math.random(). It declares ONLY types + interfaces (erasable under
// verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE meeting-closeout DRIVER
// (src/workflows/meetingCloseout.ts, a later slice) calls these ports so it stays
// unit-testable with the in-memory fakes here; the ACTIVITIES that implement the
// ports (a later slice) MAY import the real adapters (@sow/providers Broker,
// @sow/knowledge KnowledgeWriter, @sow/integrations Tool Gateway, @sow/policy) and
// node:crypto — and FOLD each adapter's typed rejection onto the CLOSED,
// enumerable error each port here declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the meeting-closeout vocabulary the driver reasons in (mapped
// 1:1 to the meetingCloseoutMachine failure states — provider_failed /
// schema_rejected / write_conflict / needs_routing_review / approval_pending /
// outbox_retry), so the driver never depends on a downstream package's error enum.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  SourceEnvelope,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  AuditId,
  FailureClass,
} from "@sow/contracts";
import type { ExtractionField, NoInferenceRejection } from "@sow/domain";

// ---------------------------------------------------------------------------
// (1) The pipeline context carried between meeting-closeout activities
// ---------------------------------------------------------------------------

/**
 * The candidate agent extraction — the meeting.close AgentJob output (task 7.6
 * inv-2/inv-3). It is CANDIDATE DATA until it clears the no-inference +
 * schema gate (safety rule 2): `fields` is the abstract evidence-backed
 * extraction-field set the domain no-inference validator (REQ-F-017) operates on,
 * keyed by an opaque field name. `schemaId` names the output schema the candidate
 * was produced under (the AgentJob.outputSchemaId the schema gate checks).
 */
export interface AgentExtraction {
  /** Evidence-backed extraction fields (REQ-F-017 domain shape), keyed by field name. */
  readonly fields: Record<string, ExtractionField<unknown>>;
  /** The output schema id the candidate claims to conform to (§7 candidate-data gate). */
  readonly schemaId?: string;
}

/**
 * The VALIDATED extraction — the candidate that PASSED both the no-inference rule
 * and the schema gate. A distinct nominal-ish type (a `readonly validated: true`
 * brand) so the driver cannot commit an un-validated candidate: only a
 * {@link ValidateExtractionPort} can produce one.
 */
export interface ValidatedExtraction {
  readonly validated: true;
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/**
 * The proof an external write was applied (or reused on replay). Mirrors the §8
 * Tool-Gateway outcome vocabulary the propose port emits: `created` on a fresh
 * exactly-once write, `reused` when the envelope's receipt already existed (replay
 * → zero duplicate external write, safety rule 3 / inv-5). The `envelope` carries
 * the write receipt once committed.
 */
export interface ProposeResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * The pipeline state carried between meeting-closeout activities. A PLAIN,
 * immutable data record (no methods, no clock, no I/O). Each stage of the driver
 * threads a NEW context with the next field populated:
 *
 *   detected          → { source }                           (transcript registered)
 *   correlated        → + workspaceId + correlation          (WS-2: workspace bound)
 *   agent_extracted   → + extraction (CANDIDATE)             (broker output)
 *   validated         → + validated (gate PASSED)            (no-inference + schema)
 *   knowledge_committed → + revisionId                       (KnowledgeWriter commit)
 *   external_actions_* → + envelopes (proposed / receipts)   (Tool Gateway)
 *
 * `workspaceId` is ABSENT until correlation binds it (inv-1 / REQ-F-002 / WS-2):
 * NO durable write may happen while it is undefined.
 */
export interface MeetingCloseoutContext {
  /** The inbound transcript/source register record (detected state). */
  readonly source: SourceEnvelope;
  /** Bound ONLY after a high-confidence correlation (WS-2) — undefined pre-correlation. */
  readonly workspaceId?: WorkspaceId;
  /** The correlation result (present once correlation ran). */
  readonly correlation?: CorrelationOutcome;
  /** The CANDIDATE agent extraction (present once the meeting.close job ran). */
  readonly extraction?: AgentExtraction;
  /** The VALIDATED extraction (present once it cleared the gate). */
  readonly validated?: ValidatedExtraction;
  /** The committed Markdown revision id (present once KnowledgeWriter committed). */
  readonly revisionId?: string;
  /**
   * The external-write envelopes proposed / applied for this closeout (present as
   * the external-action stage runs; each carries its receipt once committed). An
   * empty list is the default (no external actions).
   */
  readonly envelopes: readonly ExternalWriteEnvelope[];
}

// ---------------------------------------------------------------------------
// (2a) CorrelatePort — inv-1: low-confidence routes to needs_routing_review
// ---------------------------------------------------------------------------

/**
 * The correlation confidence signal. `high` = the source was confidently bound to
 * a workspace/project; `low` = ambiguous — route to the Ingestion Inbox
 * (needs_routing_review). The workspace binding lives ONLY on the `high` variant
 * so the type SYSTEM forbids reading a workspaceId off a low-confidence outcome
 * (inv-1: never guesses a workspace).
 */
export type CorrelationOutcome =
  | {
      readonly confidence: "high";
      /** WS-2: the bound workspace (present ONLY on high confidence). */
      readonly workspaceId: WorkspaceId;
      /** The bound project, when correlated (optional — not every source maps to a project). */
      readonly projectId?: string;
    }
  | {
      readonly confidence: "low";
      /**
       * The routing-review marker (inv-1): a low-confidence correlation routes to
       * the Ingestion Inbox (state needs_routing_review) — it NEVER carries a
       * workspaceId, so no durable write can guess a workspace off it.
       */
      readonly routingReview: true;
      /** Optional human-facing reason surfaced in the inbox. */
      readonly reason?: string;
    };

/** Closed, enumerable CorrelatePort failure set (§16 — never thrown). */
export type CorrelateErrorCode =
  | "correlation_source_unavailable" // the correlation input/source could not be read
  | "correlation_failed"; // the correlator itself failed (not a low-confidence result)

export interface CorrelateError {
  readonly code: CorrelateErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Correlate an inbound source to a workspace/project (inv-1 / REQ-F-002 / WS-2).
 * A LOW-confidence correlation is a SUCCESS carrying a routing_review marker (the
 * driver routes it to needs_routing_review) — NOT an error. A `CorrelateError` is
 * only for a correlator/source failure. Never throws.
 */
export interface CorrelatePort {
  correlate(
    ctx: MeetingCloseoutContext,
  ): Promise<Result<CorrelationOutcome, CorrelateError>>;
}

// ---------------------------------------------------------------------------
// (2b) RunMeetingAgentJobPort — inv-2: broker + ING-7 admission
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable meeting-agent failure set (§16 — never thrown). Distinct
 * codes so each maps to a DISTINCT meetingCloseoutMachine failure state + a
 * distinct System Health item (inv-5, nothing silent):
 *   • `admission_rejected` — ING-7: the job declared a MUTATING tool policy on the
 *     untrusted transcript and was REJECTED at job admission (never run).
 *   • `provider_failed`    — the provider/runtime failed (→ state provider_failed).
 *   • `schema_rejected`    — the broker's internal candidate-data gate rejected the
 *     output (→ state schema_rejected).
 *   • `egress_vetoed`      — the egress veto fired (employer-work raw content, ack
 *     off, no local provider) → fail-closed, never a cloud fallback (safety rule 5).
 *   • `budget_exceeded`    — COST-1 budget cap breached.
 */
export type MeetingAgentFailureCode =
  | "admission_rejected"
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface MeetingAgentFailure {
  readonly code: MeetingAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run the meeting.close AgentJob on the UNTRUSTED transcript (inv-2). The activity
 * builds a READ-ONLY-ToolPolicy job with an outputSchemaId + budget caps + an
 * idempotencyKey and dispatches it through the @sow/providers Broker (which
 * enforces ING-7 admission, the egress veto, the budget, and the schema gate
 * internally). Returns a CANDIDATE {@link AgentExtraction} on acceptance; a
 * mutating-tool declaration is `admission_rejected` (never run). Never throws.
 */
export interface RunMeetingAgentJobPort {
  run(
    ctx: MeetingCloseoutContext,
  ): Promise<Result<AgentExtraction, MeetingAgentFailure>>;
}

// ---------------------------------------------------------------------------
// (2c) ValidateExtractionPort — inv-3: no-inference + schema, no partial
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable validation-rejection set (§16 — never thrown). The gate is a
 * composition (Lesson §3): the no-inference rule (REQ-F-017) AND the ajv+Zod
 * schema gate. A rejection HARD-STOPS the pipeline (→ state schema_rejected) with
 * NO partial commit.
 *   • `no_inference_violation` — carries the per-field domain rejection list
 *     (inferred owner/date OR missing evidence).
 *   • `schema_rejected`        — the candidate failed the JSON-Schema gate.
 *   • `unsupported_claim`      — a claim with no backing evidence (inv-3).
 *   • `ambiguous_routing`      — the extraction's routing is ambiguous (inv-3).
 */
export type ValidationRejectionCode =
  | "no_inference_violation"
  | "schema_rejected"
  | "unsupported_claim"
  | "ambiguous_routing";

export interface ValidationRejection {
  readonly code: ValidationRejectionCode;
  readonly message: string;
  /** Present for `no_inference_violation`: the per-field REQ-F-017 rejections. */
  readonly rejections: readonly NoInferenceRejection[];
}

/**
 * Validate a candidate extraction (inv-3) — synchronous + pure (the underlying
 * `validateNoInference` + schema gate are pure). Returns a
 * {@link ValidatedExtraction} (the only way to produce one) on success; a
 * {@link ValidationRejection} otherwise. NO side effect — no Markdown write, no
 * external write — happens on a rejected extraction (safety rule 2). Never throws.
 */
export interface ValidateExtractionPort {
  validate(
    extraction: AgentExtraction,
  ): Result<ValidatedExtraction, ValidationRejection>;
}

// ---------------------------------------------------------------------------
// (2c′) BuildOutputsPort — derive the committed outputs FROM validated data
// ---------------------------------------------------------------------------

/**
 * One external-action proposal to run through the Tool Gateway propose port. The
 * `action` is the §8 ProposedAction and `envelope` its derived
 * ExternalWriteEnvelope (linkage pinned by @sow/contracts `envelopeMatchesAction`);
 * the envelope's `idempotencyKey` drives replay reuse (inv-5). Keys are computed in
 * the buildOutputs ACTIVITY (node:crypto lives there), never in the pure driver.
 */
export interface MeetingExternalActionInput {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * The derived semantic outputs of a meeting closeout: the KnowledgeMutationPlan
 * KnowledgeWriter commits + the external-action proposals dispatched afterward.
 * BOTH are DERIVED from the {@link ValidatedExtraction} — never caller-supplied —
 * so a no-inference bypass is impossible by construction (an inferred owner/date
 * was rejected at validate, so it can never reach the plan) and the write always
 * targets the correlation-bound workspace (`plan.workspaceId` is stamped from the
 * passed workspaceId, not from any caller-controlled field).
 */
export interface MeetingBuiltOutputs {
  readonly plan: KnowledgeMutationPlan;
  readonly actions: readonly MeetingExternalActionInput[];
}

/**
 * Closed, enumerable buildOutputs failure set (§16 — never thrown). Deriving the
 * plan/actions can only fail for a shape reason the driver folds to
 * `schema_rejected` (NO partial commit — inv-3):
 *   • `unmappable_extraction` — a validated field set the deriver cannot map onto
 *     the meeting note primitives (a shape the validator passed but the deriver
 *     does not know how to project — fail-closed, never a guessed plan).
 *   • `build_failed`          — the derivation failed for another reason.
 */
export type BuildOutputsFailureCode = "unmappable_extraction" | "build_failed";

export interface BuildOutputsFailure {
  readonly code: BuildOutputsFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the committed outputs (the KnowledgeMutationPlan + external-action
 * proposals) FROM a {@link ValidatedExtraction} and the correlation-bound
 * `workspaceId`. This is the governance seam that closes the no-inference /
 * workspace-isolation bypass: the outputs are built HERE from validated,
 * evidence-backed, non-inferred fields — NOT accepted from the caller — so
 *   • an inferred owner/date can NEVER reach the plan (it was rejected at validate);
 *   • `plan.workspaceId` is stamped from the passed (correlation-bound) workspaceId,
 *     so a caller cannot redirect the durable write to another workspace (WS-2/WS-4).
 * The plan/envelope idempotency + canonical-object keys are computed in the
 * ACTIVITY (node:crypto) so the driver's idempotent replay (inv-5) holds. Never
 * throws — a derivation failure is a typed {@link BuildOutputsFailure} the driver
 * folds to schema_rejected with NO partial commit.
 */
export interface BuildOutputsPort {
  build(
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
  ): Promise<Result<MeetingBuiltOutputs, BuildOutputsFailure>>;
}

// ---------------------------------------------------------------------------
// (2d) CommitKnowledgePort — inv-4/inv-5: KnowledgeWriter, idempotent replay
// ---------------------------------------------------------------------------

/**
 * The successful commit outcome. `revisionId` is the committed Markdown revision
 * (modeled as a plain string so the pure port stays decoupled from the
 * @sow/knowledge RevisionId brand — the activity maps it). `replayed` is true when
 * the commit was an idempotent REPLAY of a prior commit under the same
 * idempotencyKey (no second write, no second audit — inv-5).
 */
export interface KnowledgeCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}

/**
 * Closed, enumerable KnowledgeWriter commit failure set (§16 — never thrown),
 * mirroring the @sow/knowledge WriteFailure variants the activity folds onto:
 *   • `schema_rejected`    — the plan failed the schema gate (→ schema_rejected).
 *   • `write_conflict`     — a compare-revision precondition clash (→ write_conflict).
 *   • `ownership_violation`— cross-workspace ownership breach (WS isolation).
 *   • `secret_found`       — a secret leaked into the candidate Markdown (rule 7).
 *   • `commit_failed`      — the underlying commit failed for another reason.
 */
export type KnowledgeCommitFailureCode =
  | "schema_rejected"
  | "write_conflict"
  | "ownership_violation"
  | "secret_found"
  | "commit_failed";

export interface KnowledgeCommitFailure {
  readonly code: KnowledgeCommitFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit the validated semantic output through the KnowledgeWriter (safety rule 1:
 * the SOLE Markdown writer). IDEMPOTENT by `plan`'s idempotencyKey (inv-5): a
 * prior commit returns `replayed:true` with the SAME revisionId — no second write,
 * no second audit. A compare-revision clash is `write_conflict`. Never throws.
 */
export interface CommitKnowledgePort {
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>>;
}

// ---------------------------------------------------------------------------
// (2e) ProposeActionsPort — inv-4/inv-5: Tool Gateway, envelope reuse
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable external-proposal failure set (§16 — never thrown), mirroring
 * the §8 Tool-Gateway non-terminal / rejection outcomes the activity folds:
 *   • `held`             — the gateway FAILED CLOSED (could not confirm safe
 *     dispatch); the caller re-holds via the outbox (→ outbox_retry).
 *   • `approval_pending` — the write awaits approval (→ approval_pending); NO write.
 *   • `conflict`         — the vendor rejected on a precondition clash (never a
 *     blind overwrite).
 *   • `rejected`         — the vendor/gate refused (validation/auth).
 */
export type ProposeErrorCode = "held" | "approval_pending" | "conflict" | "rejected";

export interface ProposeError {
  readonly code: ProposeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Propose (and, when auto-approved, apply) an external write through the §8 Tool
 * Gateway (safety rule 3: the ONLY external-write path). Reserve-then-create with
 * a mandatory pre-write existence check; a REPLAY with the same idempotencyKey
 * REUSES the receipt (`status:'reused'`) → zero duplicate external write (inv-5).
 * An approval-required action FAILS CLOSED with `approval_pending` (no write).
 * Never throws.
 */
export interface ProposeActionsPort {
  propose(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ProposeResult, ProposeError>>;
}

// ---------------------------------------------------------------------------
// (2f) ReindexGbrainPort — inv-4: async, idempotent, AFTER the commit
// ---------------------------------------------------------------------------

/** Closed, enumerable GBrain re-index failure set (§16 — never thrown). */
export type ReindexErrorCode = "reindex_failed" | "revision_unavailable";

export interface ReindexError {
  readonly code: ReindexErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Re-index the committed revision into GBrain (inv-4): runs AFTER the Markdown
 * commit, ASYNC + IDEMPOTENT (re-indexing the same revision is a no-op). It NEVER
 * runs before the commit and NEVER rolls a commit back — a reindex failure is a
 * typed err the caller surfaces (and retries), while the durable Markdown commit
 * stands. Never throws.
 */
export interface ReindexGbrainPort {
  reindex(revisionId: string): Promise<Result<void, ReindexError>>;
}

// ---------------------------------------------------------------------------
// (3) MeetingHealthSink — inv-5: the failure sink (reuses 7.5 surfacing shape)
// ---------------------------------------------------------------------------

/**
 * A meeting-closeout failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam (src/workflows/systemHealthSurfacing.ts) — the driver
 * routes EVERY failure class through the sink so nothing fails silently (inv-5 /
 * §16). `retry` (an outbox re-drive entry) is carried by the 7.5 seam; the
 * meeting-closeout driver builds it from the failing external action when the
 * failure is retryable. Kept here as a light alias so a downstream slice can widen
 * to the full 7.5 `WorkflowFailure` without re-declaring the shape.
 */
export interface MeetingWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface MeetingSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface MeetingHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every meeting-closeout failure class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`
 * (HealthItemStore + outbox); the driver depends only on this narrow port so it
 * stays pure + injected-testable. Never throws.
 */
export interface MeetingHealthSink {
  surface(
    failure: MeetingWorkflowFailure,
  ): Promise<Result<MeetingSurfaceOutcome, MeetingHealthSinkError>>;
}
