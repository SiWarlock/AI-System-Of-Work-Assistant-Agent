// @sow/workflows — task 7.10 SEAM: the DAILY-BRIEF activity ports.
//
// This is the port surface the 7.10 Daily-Brief slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) + the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts) it is PURE + workflow-safe: it imports NOTHING
// from @temporalio, NOTHING from node:crypto, and calls NO Date.now()/Math.random().
// It declares ONLY types + interfaces (erasable under verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE daily-brief DRIVER
// (src/workflows/dailyBrief.ts) calls these ports so it stays unit-testable with
// the in-memory fakes (test/support/daily-brief-fakes.ts); the ACTIVITIES that
// implement the ports (e.g. src/activities/buildGclProjection.ts) MAY import the
// real adapters (@sow/integrations connectors, @sow/knowledge KnowledgeWriter +
// GCL Visibility Gate, @sow/providers Broker, @sow/policy) and node:crypto — and
// FOLD each adapter's typed rejection onto the CLOSED, enumerable error each port
// here declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the daily-brief vocabulary the driver reasons in (mapped 1:1 to
// the local dailyBriefMachine failure states — connector_stale / projection_stale /
// provider_failed / write_conflict / notify_failed / outbox_retry), so the driver
// never depends on a downstream package's error enum.
//
// ★★ THE LEAKAGE INVARIANT (REQ-F-005/008, safety rule 4): the GLOBAL/Coordination
// brief is derived by the briefing agent over the GCL GLOBAL scope + ONLY in-scope
// workspace brains (Flow 2). No RAW cross-workspace content reaches the global brief:
// global context arrives ONLY as SANITIZED {@link GclProjection}s that already
// crossed the GCL Visibility Gate (authorizeCrossWorkspaceRawRead). The port shapes
// encode this by construction — the global-brief agent input carries only
// projections, never raw per-workspace bodies.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  GclProjection,
  AuditId,
  FailureClass,
} from "@sow/contracts";
import type { ExtractionField, NoInferenceRejection } from "@sow/domain";

// ---------------------------------------------------------------------------
// (1) The pipeline context carried between daily-brief activities
// ---------------------------------------------------------------------------

/**
 * A single workspace this daily-brief run is authorized to brief over. The run is
 * BOUND to a set of these (WS-2): the driver never briefs a workspace it was not
 * scoped to, and per-workspace briefs commit ONLY to their own workspace repo.
 */
export interface BriefWorkspaceScope {
  readonly workspaceId: WorkspaceId;
  /** The workspace's GBrain brain id (the in-scope brain the agent may query). */
  readonly brainId?: string;
}

/**
 * The candidate agent brief output — the briefing AgentJob output. It is CANDIDATE
 * DATA until it clears the no-inference + schema gate (safety rule 2): `fields` is
 * the abstract evidence-backed extraction-field set the domain no-inference
 * validator (REQ-F-017) operates on, keyed by an opaque field name. `schemaId`
 * names the output schema the candidate was produced under.
 */
export interface BriefDraft {
  /** Evidence-backed brief fields (REQ-F-017 domain shape), keyed by field name. */
  readonly fields: Record<string, ExtractionField<unknown>>;
  /** The output schema id the candidate claims to conform to (§7 candidate-data gate). */
  readonly schemaId?: string;
}

/**
 * The VALIDATED brief — the candidate that PASSED both the no-inference rule and
 * the schema gate. A distinct `readonly validated: true` brand so the driver cannot
 * commit an un-validated candidate: only a {@link ValidateBriefPort} can produce
 * one.
 */
export interface ValidatedBrief {
  readonly validated: true;
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/**
 * The proof an external write was applied (or reused on replay). Mirrors the §8
 * Tool-Gateway outcome vocabulary the notify port emits: `created` on a fresh
 * exactly-once write, `reused` when the envelope's receipt already existed (replay
 * → zero duplicate external write, safety rule 3 / inv-5).
 */
export interface NotifyResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * The pipeline context carried between daily-brief activities. A PLAIN, immutable
 * data record (no methods, no clock, no I/O). Each stage threads a NEW context with
 * the next field populated:
 *
 *   scheduled              → { scopes }                    (bound workspace set, WS-2)
 *   connectors_refreshed   → + refreshedConnectors         (connector sync ran)
 *   projections_updated    → + projections                 (SANITIZED GCL projections)
 *   briefed                → + globalDraft + workspaceDrafts (CANDIDATE agent output)
 *   *_committed            → + revisions                   (KnowledgeWriter commits)
 *   notified               → + notifyEnvelope              (Tool Gateway telegram)
 *
 * The bound `scopes` are set at admission (WS-2): NO durable write may target a
 * workspace absent from this set.
 */
export interface DailyBriefContext {
  /** The workspaces this run is authorized to brief over (WS-2 bound at admission). */
  readonly scopes: readonly BriefWorkspaceScope[];
  /** The connector ids refreshed for this run (present once refresh ran). */
  readonly refreshedConnectors?: readonly string[];
  /**
   * The SANITIZED GCL projections that crossed the Visibility Gate — the ONLY
   * cross-workspace context the global brief may read (REQ-F-005/008). Present once
   * projections were updated. NEVER carries raw workspace bodies (leakage-safe).
   */
  readonly projections?: readonly GclProjection[];
  /** The committed workspace-brief revision ids, keyed by workspaceId (present once committed). */
  readonly workspaceRevisions?: Readonly<Record<string, string>>;
  /** The committed global-brief revision id (present once committed to Global/Coordination). */
  readonly globalRevisionId?: string;
  /** The telegram-summary envelope proposed/applied (present once notify ran). */
  readonly notifyEnvelope?: ExternalWriteEnvelope;
}

// ---------------------------------------------------------------------------
// (2a) RefreshConnectorsPort — stale connector → connector_stale
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable connector-refresh failure set (§16 — never thrown):
 *   • `connector_unreachable` — a connector could not be reached (network / auth).
 *   • `connector_stale`       — a connector's cursor is stale beyond the freshness
 *     bound and could not be advanced (LIFE-2 freshness) → state connector_stale.
 */
export type RefreshConnectorsErrorCode =
  | "connector_unreachable"
  | "connector_stale";

export interface RefreshConnectorsError {
  readonly code: RefreshConnectorsErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** The result of a connector refresh — the ids that were refreshed this run. */
export interface RefreshConnectorsResult {
  readonly refreshedConnectors: readonly string[];
}

/**
 * Refresh the connectors feeding the bound workspaces' brains before briefing. The
 * activity advances each connector cursor (ConnectorCursorRepository) through the
 * Connector Gateway. A stale/unreachable connector folds to a typed error the
 * driver maps to connector_stale → 7.5 (nothing silent). Never throws.
 */
export interface RefreshConnectorsPort {
  refresh(
    ctx: DailyBriefContext,
  ): Promise<Result<RefreshConnectorsResult, RefreshConnectorsError>>;
}

// ---------------------------------------------------------------------------
// (2b) UpdateProjectionsPort — refresh the SANITIZED GCL projections
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable projection-update failure set (§16 — never thrown):
 *   • `projection_stale`     — a workspace's sanitized projection could not be
 *     refreshed / is stale beyond bound → state projection_stale.
 *   • `gate_rejected`        — a candidate projection FAILED the GCL Visibility Gate
 *     (raw content present / visibility exceeds source) — the leakage HARD reject
 *     (safety rule 4). It is REFUSED, never downgraded-and-stored.
 */
export type UpdateProjectionsErrorCode = "projection_stale" | "gate_rejected";

export interface UpdateProjectionsError {
  readonly code: UpdateProjectionsErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Update (and re-gate) the sanitized cross-workspace GCL projections for the bound
 * workspaces. The activity runs each candidate projection through the GCL
 * Visibility Gate (authorizeCrossWorkspaceRawRead / admitProjection) so ONLY
 * sanitized, visibility-validated projections are returned — a candidate carrying
 * raw content is HARD-rejected (`gate_rejected`), never leaked. The returned
 * projections are the ONLY cross-workspace context the global brief may read
 * (REQ-F-005/008). Never throws.
 */
export interface UpdateProjectionsPort {
  update(
    ctx: DailyBriefContext,
  ): Promise<Result<readonly GclProjection[], UpdateProjectionsError>>;
}

// ---------------------------------------------------------------------------
// (2c) RunBriefingAgentPort — Flow 2: global scope + in-scope brains
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable briefing-agent failure set (§16 — never thrown). Distinct
 * codes so each maps to a DISTINCT dailyBriefMachine failure state + a distinct
 * System Health item (inv-5, nothing silent):
 *   • `provider_failed` — the provider/runtime failed (→ state provider_failed).
 *   • `schema_rejected` — the broker's internal candidate-data gate rejected output.
 *   • `egress_vetoed`   — the egress veto fired (employer-work raw content, ack off,
 *     no local provider) → fail-closed, never a cloud fallback (safety rule 5).
 *   • `budget_exceeded` — COST-1 budget cap breached.
 */
export type BriefingAgentFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface BriefingAgentFailure {
  readonly code: BriefingAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The briefing agent's full output: ONE global/coordination brief draft + a
 * per-workspace brief draft keyed by workspaceId. Both are CANDIDATE data until
 * validated. The global draft was produced over the GCL GLOBAL scope +
 * ONLY-in-scope brains (Flow 2) — the agent read cross-workspace context ONLY
 * through the sanitized projections handed to it, so no raw cross-workspace content
 * can appear in `global` (leakage-safe by construction).
 */
export interface BriefingAgentOutput {
  readonly global: BriefDraft;
  readonly workspaceDrafts: Readonly<Record<string, BriefDraft>>;
}

/**
 * Run the briefing AgentJob (Flow 2). The activity builds a READ-ONLY-ToolPolicy
 * job with an outputSchemaId + budget caps + an idempotencyKey and dispatches it
 * through the @sow/providers Broker (which enforces ING-7 admission, the egress
 * veto, the budget, and the schema gate internally). It hands the agent the
 * SANITIZED projections (the only cross-workspace context) + the in-scope brains —
 * NEVER raw cross-workspace bodies. Returns CANDIDATE {@link BriefingAgentOutput}
 * on acceptance. Never throws.
 */
export interface RunBriefingAgentPort {
  run(
    ctx: DailyBriefContext,
  ): Promise<Result<BriefingAgentOutput, BriefingAgentFailure>>;
}

// ---------------------------------------------------------------------------
// (2d) ValidateBriefPort — no-inference + schema, no partial
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable validation-rejection set (§16 — never thrown). The gate is a
 * composition (Lesson §3): the no-inference rule (REQ-F-017) AND the ajv+Zod schema
 * gate. A rejection HARD-STOPS the pipeline (→ state schema_rejected) with NO
 * partial commit.
 */
export type BriefValidationRejectionCode =
  | "no_inference_violation"
  | "schema_rejected"
  | "unsupported_claim";

export interface BriefValidationRejection {
  readonly code: BriefValidationRejectionCode;
  readonly message: string;
  /** Present for `no_inference_violation`: the per-field REQ-F-017 rejections. */
  readonly rejections: readonly NoInferenceRejection[];
}

/**
 * Validate a candidate brief draft (no-inference + schema) — synchronous + pure.
 * Returns a {@link ValidatedBrief} (the only way to produce one) on success; a
 * {@link BriefValidationRejection} otherwise. NO side effect — no Markdown write,
 * no external write — happens on a rejected draft (safety rule 2). Never throws.
 */
export interface ValidateBriefPort {
  validate(
    draft: BriefDraft,
  ): Result<ValidatedBrief, BriefValidationRejection>;
}

// ---------------------------------------------------------------------------
// (2e) BuildGlobalBriefPort — derive the committed outputs FROM validated data
// ---------------------------------------------------------------------------

/**
 * The derived semantic outputs of the daily brief: the KnowledgeMutationPlan the
 * KnowledgeWriter commits to the GLOBAL/Coordination repo + a DASHBOARD read-model
 * record derived from the same validated brief + the (already-sanitized)
 * projections + a Telegram-summary external-action proposal. BOTH the plan and the
 * action are DERIVED from the {@link ValidatedBrief} — never caller-supplied — so a
 * no-inference bypass is impossible by construction and the write always targets
 * the GLOBAL workspace (`plan.workspaceId` is stamped from the passed globalWorkspaceId,
 * not any caller-controlled field). The dashboard read-model is SUMMARY-only.
 *
 * LEAKAGE-SAFE: the plan/dashboard/telegram summary are built ONLY from validated
 * brief fields + sanitized projections — never from raw cross-workspace bodies.
 */
export interface GlobalBriefOutputs {
  readonly plan: KnowledgeMutationPlan;
  /** A SUMMARY-only dashboard read-model payload (rebuildable; no raw content). */
  readonly dashboard: Record<string, unknown>;
  /** The Telegram summary external action (present when a summary is to be sent). */
  readonly notify?: DailyBriefExternalAction;
}

/**
 * One external-action proposal to run through the Tool Gateway notify port. The
 * `action` is the §8 ProposedAction and `envelope` its derived
 * ExternalWriteEnvelope; the envelope's `idempotencyKey` drives replay reuse
 * (inv-5). Keys are computed in the buildGlobalBrief ACTIVITY (node:crypto lives
 * there), never in the pure driver.
 */
export interface DailyBriefExternalAction {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * Closed, enumerable buildGlobalBrief failure set (§16 — never thrown). Deriving
 * the plan/dashboard/notify can only fail for a shape reason the driver folds to
 * `schema_rejected` (NO partial commit):
 *   • `unmappable_brief` — a validated field set the deriver cannot map onto the
 *     global-brief primitives (fail-closed, never a guessed plan).
 *   • `build_failed`     — the derivation failed for another reason.
 */
export type BuildGlobalBriefFailureCode = "unmappable_brief" | "build_failed";

export interface BuildGlobalBriefFailure {
  readonly code: BuildGlobalBriefFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the global-brief outputs (the KnowledgeMutationPlan targeting the GLOBAL
 * workspace + the dashboard read-model + the Telegram summary) FROM a
 * {@link ValidatedBrief}, the sanitized projections, and the passed
 * globalWorkspaceId. The governance seam: outputs are built HERE from validated,
 * evidence-backed, non-inferred fields — NOT accepted from the caller — so an
 * inferred value can never reach the plan, and `plan.workspaceId` is stamped from
 * the passed global workspace (WS-2/WS-4). Never throws.
 */
export interface BuildGlobalBriefPort {
  build(
    validated: ValidatedBrief,
    projections: readonly GclProjection[],
    globalWorkspaceId: WorkspaceId,
  ): Promise<Result<GlobalBriefOutputs, BuildGlobalBriefFailure>>;
}

// ---------------------------------------------------------------------------
// (2f) BuildWorkspaceBriefPort — derive a per-workspace committed plan
// ---------------------------------------------------------------------------

/**
 * DERIVE a per-workspace brief KnowledgeMutationPlan FROM the validated
 * workspace-specific draft + the bound workspaceId. The plan's workspaceId is
 * stamped from the passed (bound) workspaceId so a per-workspace brief commits ONLY
 * to its own workspace repo (WS-2/WS-4). Never accepts a caller-supplied plan.
 * Never throws — a derivation failure is a typed {@link BuildGlobalBriefFailure}
 * the driver folds to schema_rejected with NO partial commit.
 */
export interface BuildWorkspaceBriefPort {
  build(
    validated: ValidatedBrief,
    workspaceId: WorkspaceId,
  ): Promise<Result<KnowledgeMutationPlan, BuildGlobalBriefFailure>>;
}

// ---------------------------------------------------------------------------
// (2g) CommitBriefPort — KnowledgeWriter, idempotent replay
// ---------------------------------------------------------------------------

/**
 * The successful commit outcome. `revisionId` is the committed Markdown revision.
 * `replayed` is true when the commit was an idempotent REPLAY of a prior commit
 * under the same idempotencyKey (no second write, no second audit — inv-5).
 */
export interface BriefCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}

/**
 * Closed, enumerable KnowledgeWriter commit failure set (§16 — never thrown),
 * mirroring the @sow/knowledge WriteFailure variants the activity folds onto.
 */
export type BriefCommitFailureCode =
  | "schema_rejected"
  | "write_conflict"
  | "ownership_violation"
  | "secret_found"
  | "commit_failed";

export interface BriefCommitFailure {
  readonly code: BriefCommitFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit a derived brief plan through the KnowledgeWriter (safety rule 1: the SOLE
 * Markdown writer). IDEMPOTENT by `plan`'s identity (inv-5): a prior commit returns
 * `replayed:true` with the SAME revisionId — no second write, no second audit. A
 * compare-revision clash is `write_conflict`. Never throws.
 */
export interface CommitBriefPort {
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<BriefCommitSuccess, BriefCommitFailure>>;
}

// ---------------------------------------------------------------------------
// (2h) UpdateDashboardPort — the read-model view (rebuildable, summary-only)
// ---------------------------------------------------------------------------

/** Closed, enumerable dashboard-update failure set (§16 — never thrown). */
export type UpdateDashboardErrorCode = "dashboard_failed";

export interface UpdateDashboardError {
  readonly code: UpdateDashboardErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Update the rebuildable dashboard read-model with the global brief summary. This
 * is a REBUILDABLE projection (§4/§16) — SUMMARY/metadata only, never raw content.
 * It runs AFTER the global-brief Markdown commit; a dashboard-update failure
 * surfaces a health item but does NOT roll the commit back (like the 7.6 reindex).
 * Never throws.
 */
export interface UpdateDashboardPort {
  update(
    payload: Record<string, unknown>,
  ): Promise<Result<void, UpdateDashboardError>>;
}

// ---------------------------------------------------------------------------
// (2i) NotifyPort — Tool Gateway telegram summary, envelope reuse
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable notify (external-write) failure set (§16 — never thrown),
 * mirroring the §8 Tool-Gateway non-terminal / rejection outcomes:
 *   • `held`             — the gateway FAILED CLOSED; re-hold via the outbox
 *     (→ outbox_retry).
 *   • `approval_pending` — the write awaits approval (→ notify_failed park); NO write.
 *   • `conflict`         — the vendor rejected on a precondition clash.
 *   • `rejected`         — the vendor/gate refused (validation/auth).
 */
export type NotifyErrorCode = "held" | "approval_pending" | "conflict" | "rejected";

export interface NotifyError {
  readonly code: NotifyErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Send the daily-brief Telegram summary through the §8 Tool Gateway (safety rule 3:
 * the ONLY external-write path). Reserve-then-create with a mandatory pre-write
 * existence check; a REPLAY with the same idempotencyKey REUSES the receipt
 * (`status:'reused'`) → zero duplicate external write (inv-5). Never throws.
 */
export interface NotifyPort {
  notify(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<NotifyResult, NotifyError>>;
}

// ---------------------------------------------------------------------------
// (3) DailyBriefHealthSink — inv-5: the failure sink (reuses 7.5 shape)
// ---------------------------------------------------------------------------

/**
 * A daily-brief failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure class through the sink so
 * nothing fails silently (inv-5 / §16).
 */
export interface DailyBriefFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface DailyBriefSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface DailyBriefHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every daily-brief failure class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`; the
 * driver depends only on this narrow port so it stays pure + injected-testable.
 * Never throws.
 */
export interface DailyBriefHealthSink {
  surface(
    failure: DailyBriefFailure,
  ): Promise<Result<DailyBriefSurfaceOutcome, DailyBriefHealthSinkError>>;
}
