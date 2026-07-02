// @sow/workflows — task 7.12 SEAM: the CROSS-CALENDAR-SCHEDULING activity ports.
//
// This is the port surface the 7.12 slice imports. Like the 7.1–7.5 foundation
// (src/ports/operational.ts), the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts), and the 7.10 daily-brief seam
// (src/ports/dailyBrief.ts) it is PURE + workflow-safe: it imports NOTHING from
// @temporalio, NOTHING from node:crypto, and calls NO Date.now()/Math.random(). It
// declares ONLY types + interfaces (erasable under verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE cross-calendar-scheduling DRIVER
// (src/workflows/crossCalendarScheduling.ts) calls these ports so it stays
// unit-testable with in-memory fakes; the ACTIVITIES that implement the ports (e.g.
// src/activities/proposeWindows.ts) MAY import the real adapters (@sow/knowledge GCL
// Visibility Gate + availability projections, @sow/providers Broker, @sow/policy
// requiresApproval, @sow/integrations Tool Gateway dispatchExternalWrite) and
// node:crypto — and FOLD each adapter's typed rejection onto the CLOSED, enumerable
// error each port here declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the scheduling vocabulary the driver reasons in (mapped 1:1 to
// the local crossCalendarSchedulingMachine failure states — calendar_unreachable /
// provider_failed / schema_rejected / approval_pending / outbox_retry), so the
// driver never depends on a downstream package's error enum.
//
// ★★ THE TWO 7.12 SAFETY INVARIANTS the port shapes encode by construction:
//   (Flow 3 leakage) a cross-workspace scheduling proposal carries GENERIC conflict
//     explanations ONLY — NO raw work/event detail. Availability arrives ONLY as
//     SANITIZED busy/free windows that crossed the GCL Visibility Gate
//     (authorizeCrossWorkspaceRawRead); the proposal/action carry generic reasons,
//     never a raw title/attendee/body.
//   (REQ-F-009 no-silent-free) an omitted / UNREACHABLE availability source is a
//     TYPED failure (calendar_unreachable) — NEVER silently treated as free. The
//     gather port returns a typed error the driver folds to calendar_unreachable, so
//     a window can never be proposed over an unread calendar.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  ProposedAction,
  ExternalWriteEnvelope,
  KnowledgeMutationPlan,
  AuditId,
  FailureClass,
} from "@sow/contracts";
import type { ExtractionField, NoInferenceRejection } from "@sow/domain";

// ---------------------------------------------------------------------------
// (1) The pipeline context carried between scheduling activities
// ---------------------------------------------------------------------------

/**
 * One availability source this scheduling run must read busy/free over. The run is
 * BOUND to a set of these; REQ-F-009 requires busy/free be read across ALL of them.
 * `sourceId` names the connector/calendar; `workspaceId` is the workspace the source
 * belongs to (a personal calendar and an employer calendar are distinct workspaces).
 */
export interface AvailabilitySource {
  readonly sourceId: string;
  readonly workspaceId: WorkspaceId;
}

/**
 * A SANITIZED busy/free window read from ONE availability source (REQ-F-009). It
 * carries ONLY the busy interval + a GENERIC, sanitized conflict reason — NEVER a
 * raw event title/attendee/body (Flow 3 leakage rule): a window read from another
 * workspace's calendar surfaces only "busy" with a generic reason. The window's
 * `sourceId` records which bound source it came from (proof the source WAS read —
 * an unread source is a typed gather failure, never an empty/free assumption).
 */
export interface BusyWindow {
  readonly sourceId: string;
  /** ISO-8601 start of the busy interval. */
  readonly start: string;
  /** ISO-8601 end of the busy interval. */
  readonly end: string;
  /** A GENERIC sanitized reason ("busy" / "tentative") — NEVER raw event detail. */
  readonly genericReason?: string;
}

/**
 * The gathered availability across ALL bound sources (REQ-F-009). `readSources` is
 * the set of sources that were successfully read — the driver asserts it covers the
 * FULL bound set, so an omitted source can never be silently treated as free.
 * `busyWindows` is the union of sanitized busy intervals across those sources.
 */
export interface GatheredAvailability {
  readonly readSources: readonly string[];
  readonly busyWindows: readonly BusyWindow[];
}

/**
 * The pipeline context threaded between cross-calendar-scheduling activities. A
 * PLAIN, immutable data record (no methods, no clock, no I/O). Each stage threads a
 * NEW context with the next field populated:
 *
 *   requested             → { sources, organizerWorkspaceId }   (bound sources, WS-2)
 *   availability_gathered → + availability                      (SANITIZED busy/free)
 *   proposed              → + proposal (CANDIDATE)              (agent-proposed windows)
 *   validated             → + validated (gate PASSED)          (no-inference + schema)
 *   *                     → + action/envelope                  (Tool Gateway dispatch)
 *
 * `organizerWorkspaceId` is the BOUND/AUTHORIZED workspace the created event belongs
 * to (WS-2) — every durable write targets it, never a caller-controlled value.
 */
export interface CrossCalendarSchedulingContext {
  /** REQ-F-009: the FULL set of availability sources busy/free MUST be read across. */
  readonly sources: readonly AvailabilitySource[];
  /** WS-2: the bound workspace the auto-created private event belongs to. */
  readonly organizerWorkspaceId: WorkspaceId;
  /** The gathered sanitized availability (present once gather ran). */
  readonly availability?: GatheredAvailability;
  /** The CANDIDATE agent-proposed windows (present once the propose job ran). */
  readonly proposal?: ProposedWindows;
  /** The VALIDATED proposal (present once it cleared the gate). */
  readonly validated?: ValidatedProposal;
  /** The dispatched external-write envelope (present ONLY on an auto-created event). */
  readonly envelope?: ExternalWriteEnvelope;
}

// ---------------------------------------------------------------------------
// (2a) GatherAvailabilityPort — REQ-F-009: read ALL sources; unreachable = typed
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable availability-gather failure set (§16 — never thrown). Distinct
 * codes so each maps to a DISTINCT crossCalendarSchedulingMachine failure state + a
 * distinct System Health item (nothing silent):
 *   • `calendar_unreachable` — a configured availability source could NOT be read
 *     (connector down / auth / omitted). REQ-F-009: this is a HARD typed failure —
 *     the source is NEVER treated as free. The driver folds it to
 *     calendar_unreachable and parks (no window proposed over an unread calendar).
 *   • `gate_rejected`        — a candidate availability projection FAILED the GCL
 *     Visibility Gate (raw event detail present) — the Flow-3 leakage HARD reject.
 *     It is REFUSED, never downgraded-and-stored.
 */
export type GatherAvailabilityErrorCode = "calendar_unreachable" | "gate_rejected";

export interface GatherAvailabilityError {
  readonly code: GatherAvailabilityErrorCode;
  readonly message: string;
  /** The source ids that COULD be read (present on a partial failure — for the health item). */
  readonly readSources?: readonly string[];
  readonly cause?: unknown;
}

/**
 * Read busy/free across ALL configured availability sources through the GCL
 * Visibility Gate (REQ-F-009 / safety rule 4). The activity reads each source's
 * SANITIZED busy/free projection (authorizeCrossWorkspaceRawRead) — a cross-workspace
 * calendar surfaces only busy intervals + a generic reason, never raw event detail.
 * If ANY configured source cannot be read it returns `calendar_unreachable` (the
 * source is NEVER assumed free); a candidate projection carrying raw detail is
 * `gate_rejected`. On success `readSources` MUST cover the full bound source set (the
 * driver asserts this). Never throws.
 */
export interface GatherAvailabilityPort {
  gather(
    ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<GatheredAvailability, GatherAvailabilityError>>;
}

// ---------------------------------------------------------------------------
// (2b) ProposeWindowsAgentPort — broker: propose windows, generic reasons only
// ---------------------------------------------------------------------------

/**
 * A single proposed meeting window. It carries ONLY the interval + a GENERIC,
 * sanitized conflict explanation (Flow 3 leakage rule) — NEVER raw event detail
 * from a conflicting calendar. The generic explanation is what surfaces in a
 * cross-workspace proposal ("conflicts with a busy block", not the raw title).
 */
export interface ProposedWindow {
  readonly start: string;
  readonly end: string;
  /** GENERIC conflict explanation ONLY — no raw work/event detail leaks (Flow 3). */
  readonly genericExplanation?: string;
}

/**
 * The candidate agent proposal — the propose-windows AgentJob output. It is
 * CANDIDATE DATA until it clears the no-inference + schema gate (safety rule 2):
 * `fields` is the abstract evidence-backed extraction-field set the domain
 * no-inference validator (REQ-F-017) operates on, keyed by an opaque field name;
 * `windows` are the proposed intervals (generic explanations only). `schemaId` names
 * the output schema the candidate was produced under.
 */
export interface ProposedWindows {
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly windows: readonly ProposedWindow[];
  readonly schemaId?: string;
}

/**
 * The VALIDATED proposal — the candidate that PASSED both the no-inference rule and
 * the schema gate. A distinct `readonly validated: true` brand so the driver cannot
 * derive an action from an un-validated candidate: only a {@link ValidateProposalPort}
 * can produce one.
 */
export interface ValidatedProposal {
  readonly validated: true;
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly windows: readonly ProposedWindow[];
  readonly schemaId?: string;
}

/**
 * Closed, enumerable propose-agent failure set (§16 — never thrown). Distinct codes
 * so each maps to a DISTINCT machine failure state + a distinct health item:
 *   • `provider_failed`    — the provider/runtime failed (→ state provider_failed).
 *   • `schema_rejected`    — the broker's internal candidate-data gate rejected output.
 *   • `admission_rejected` — ING-7: a mutating tool declared on untrusted content →
 *     rejected at admission (never run) → provider_failed.
 *   • `egress_vetoed`      — the egress veto fired (safety rule 5) → fail-closed.
 *   • `budget_exceeded`    — COST-1 budget cap breached.
 */
export type ProposeAgentFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "admission_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface ProposeAgentFailure {
  readonly code: ProposeAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run the propose-windows AgentJob (Flow 3). The activity builds a READ-ONLY-ToolPolicy
 * job with an outputSchemaId + budget caps + an idempotencyKey and dispatches it
 * through the @sow/providers Broker (which enforces ING-7 admission, the egress veto,
 * the budget, and the schema gate internally). It hands the agent the SANITIZED
 * availability (the only cross-workspace context) — NEVER raw event bodies — so the
 * proposed windows carry only GENERIC conflict explanations. Returns a CANDIDATE
 * {@link ProposedWindows} on acceptance. Never throws.
 */
export interface ProposeWindowsAgentPort {
  run(
    ctx: CrossCalendarSchedulingContext,
  ): Promise<Result<ProposedWindows, ProposeAgentFailure>>;
}

// ---------------------------------------------------------------------------
// (2c) ValidateProposalPort — no-inference + schema, no partial
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable validation-rejection set (§16 — never thrown). The gate is a
 * composition (Lesson §3): the no-inference rule (REQ-F-017) AND the ajv+Zod schema
 * gate. A rejection HARD-STOPS the pipeline (→ state schema_rejected) with NO
 * external side effect.
 */
export type ProposalValidationRejectionCode =
  | "no_inference_violation"
  | "schema_rejected"
  | "unsupported_claim";

export interface ProposalValidationRejection {
  readonly code: ProposalValidationRejectionCode;
  readonly message: string;
  /** Present for `no_inference_violation`: the per-field REQ-F-017 rejections. */
  readonly rejections: readonly NoInferenceRejection[];
}

/**
 * Validate a candidate proposal (no-inference + schema) — synchronous + pure.
 * Returns a {@link ValidatedProposal} (the only way to produce one) on success; a
 * {@link ProposalValidationRejection} otherwise. NO side effect — no external write,
 * no approval record — happens on a rejected proposal (safety rule 2). Never throws.
 */
export interface ValidateProposalPort {
  validate(
    proposal: ProposedWindows,
  ): Result<ValidatedProposal, ProposalValidationRejection>;
}

// ---------------------------------------------------------------------------
// (2d) BuildSchedulingOutputsPort — derive the action FROM validated data
// ---------------------------------------------------------------------------

/**
 * The derived outputs of a cross-calendar scheduling run: the §8 calendar-event
 * ProposedAction + its ExternalWriteEnvelope (dispatched on auto-create OR gated by
 * approval), plus an OPTIONAL KnowledgeMutationPlan noting the scheduling decision.
 * ALL are DERIVED from the {@link ValidatedProposal} — never caller-supplied — so a
 * no-inference bypass is impossible by construction and the write always targets the
 * organizer's BOUND workspace (`action`/`plan.workspaceId` stamped from the passed
 * organizerWorkspaceId, not any caller-controlled field). The action payload carries
 * ONLY the chosen window + a GENERIC explanation — never raw cross-workspace detail
 * (Flow 3).
 */
export interface SchedulingBuiltOutputs {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
  /** OPTIONAL semantic note of the scheduling decision (committed via KnowledgeWriter). */
  readonly plan?: KnowledgeMutationPlan;
}

/**
 * Closed, enumerable buildOutputs failure set (§16 — never thrown). Deriving the
 * action can only fail for a shape reason the driver folds to `schema_rejected` (NO
 * side effect):
 *   • `unmappable_proposal` — a validated proposal the deriver cannot map onto a
 *     calendar-event action (e.g. no proposable window) — fail-closed, no guess.
 *   • `build_failed`        — the derivation failed for another reason.
 */
export type BuildSchedulingFailureCode = "unmappable_proposal" | "build_failed";

export interface BuildSchedulingFailure {
  readonly code: BuildSchedulingFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the scheduling outputs (the calendar-event ProposedAction + envelope +
 * optional plan) FROM a {@link ValidatedProposal} and the organizer's BOUND
 * workspaceId. The governance seam: outputs are built HERE from validated,
 * evidence-backed, non-inferred fields — NOT accepted from the caller — so an
 * inferred value can never reach the action, and the action targets the BOUND
 * workspace (WS-2/WS-4). The action payload carries only the chosen window + a
 * generic explanation (Flow 3). The envelope's canonicalObjectKey + idempotencyKey
 * are computed in the ACTIVITY (node:crypto) so the driver's idempotent replay holds.
 * Never throws — a derivation failure is a typed {@link BuildSchedulingFailure} the
 * driver folds to schema_rejected with NO side effect.
 */
export interface BuildSchedulingOutputsPort {
  build(
    validated: ValidatedProposal,
    organizerWorkspaceId: WorkspaceId,
  ): Promise<Result<SchedulingBuiltOutputs, BuildSchedulingFailure>>;
}

// ---------------------------------------------------------------------------
// (2e) ClassifyActionPort — reuse @sow/policy requiresApproval (auto-private-only)
// ---------------------------------------------------------------------------

/**
 * The routing verdict for a derived calendar action. `auto_create` is emitted ONLY
 * for a PRIVATE, policy-allowed PERSONAL calendar action (dataOwner user, isolated
 * visibility, auto_private policy) — the SOLE Flow-3 auto-create path. Everything
 * else — a shared/invite/external-message change — is `route_to_approval` (the
 * action is gated by the 7.9 Approval Inbox, never auto-applied).
 */
export type SchedulingRoute = "auto_create" | "route_to_approval";

/** Closed, enumerable classify failure set (§16 — never thrown). */
export interface ClassifyActionError {
  readonly code: "classify_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Classify a derived calendar action as auto-create-eligible or approval-required.
 * The activity delegates to @sow/policy `requiresApproval` against the organizer's
 * RESOLVED workspace policy: it returns `auto_create` ONLY when the policy predicate
 * says `requiresApproval: false` (a private, policy-allowed personal calendar action)
 * — every shared/invite/external change fails closed to `route_to_approval`. Never
 * throws.
 */
export interface ClassifyActionPort {
  classify(
    action: ProposedAction,
    organizerWorkspaceId: WorkspaceId,
  ): Promise<Result<SchedulingRoute, ClassifyActionError>>;
}

// ---------------------------------------------------------------------------
// (2f) AutoCreateEventPort — Tool Gateway envelope, replay reuse (auto-create path)
// ---------------------------------------------------------------------------

/**
 * The proof a private event was auto-created (or reused on replay). `status` is
 * `created` on a fresh exactly-once external write, `reused` when the envelope's
 * receipt already existed (replay → zero duplicate event — safety rule 3 / inv-5).
 */
export interface AutoCreateResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}

/** Closed, enumerable auto-create failure set (§16 — never thrown). */
export type AutoCreateErrorCode = "held" | "conflict" | "rejected";

export interface AutoCreateError {
  readonly code: AutoCreateErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Auto-create a PRIVATE personal calendar event through the §8 Tool Gateway (safety
 * rule 3: the ONLY external-write path). Reserve-then-create with a mandatory
 * pre-write existence check; a REPLAY with the same idempotencyKey REUSES the receipt
 * (`status:'reused'`) → zero duplicate event (inv-5). Only ever called after the
 * action classified as `auto_create` (a private, policy-allowed personal action) —
 * a shared/invite change routes to approval and NEVER reaches this port. Never throws.
 */
export interface AutoCreateEventPort {
  create(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<AutoCreateResult, AutoCreateError>>;
}

// ---------------------------------------------------------------------------
// (2g) RouteToApprovalPort — shared/invite change → the 7.9 Approval Inbox
// ---------------------------------------------------------------------------

/** Proof a shared/invite scheduling change was routed to the 7.9 Approval Inbox. */
export interface RouteToApprovalResult {
  /** The approval-inbox record ref the card was raised under (idempotent by envelope key). */
  readonly approvalRef: string;
  /** false when the pending record already existed (idempotent re-drive — no second card). */
  readonly created: boolean;
}

/** Closed, enumerable route-to-approval failure set (§16 — never thrown). */
export type RouteToApprovalErrorCode = "precondition_failed" | "route_failed";

export interface RouteToApprovalError {
  readonly code: RouteToApprovalErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Route a shared/invite/external-message scheduling change to the 7.9 Approval
 * Inbox instead of auto-applying it. The activity records the pending action through
 * the Tool Gateway (the 7.9 RecordPendingPort seam) so the approval card is raised —
 * IDEMPOTENT by the envelope's idempotencyKey (a re-drive returns `created:false`, no
 * second card). The external write happens ONLY later, after human approval, on the
 * 7.9 flow — this port NEVER performs the write itself (fail-closed). Never throws.
 */
export interface RouteToApprovalPort {
  route(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<RouteToApprovalResult, RouteToApprovalError>>;
}

// ---------------------------------------------------------------------------
// (2h) CommitSchedulingNotePort — OPTIONAL: KnowledgeWriter, idempotent replay
// ---------------------------------------------------------------------------

/**
 * The successful commit outcome for the scheduling note. `revisionId` is the
 * committed Markdown revision; `replayed` is true on an idempotent REPLAY.
 */
export interface SchedulingCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}

/** Closed, enumerable KnowledgeWriter commit failure set (§16 — never thrown). */
export type SchedulingCommitFailureCode =
  | "schema_rejected"
  | "write_conflict"
  | "ownership_violation"
  | "secret_found"
  | "commit_failed";

export interface SchedulingCommitFailure {
  readonly code: SchedulingCommitFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit the OPTIONAL scheduling-decision note through the KnowledgeWriter (safety
 * rule 1: the SOLE Markdown writer). IDEMPOTENT by `plan`'s identity (inv-5): a prior
 * commit returns `replayed:true` with the SAME revisionId. A compare-revision clash
 * is `write_conflict`. Never throws.
 */
export interface CommitSchedulingNotePort {
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<SchedulingCommitSuccess, SchedulingCommitFailure>>;
}

// ---------------------------------------------------------------------------
// (3) SchedulingHealthSink — inv-5: the failure sink (reuses 7.5 shape)
// ---------------------------------------------------------------------------

/**
 * A cross-calendar-scheduling failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure class through the sink so
 * nothing fails silently (inv-5 / §16). `calendar-connector-unavailable` +
 * `approval-pending` are typed states routed here.
 */
export interface SchedulingWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface SchedulingSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface SchedulingHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every scheduling failure class through (inv-5).
 * In production this is backed by the 7.5 `surfaceWorkflowFailure`; the driver
 * depends only on this narrow port so it stays pure + injected-testable. Never throws.
 */
export interface SchedulingHealthSink {
  surface(
    failure: SchedulingWorkflowFailure,
  ): Promise<Result<SchedulingSurfaceOutcome, SchedulingHealthSinkError>>;
}
