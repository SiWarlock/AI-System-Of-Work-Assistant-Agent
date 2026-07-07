// @sow/workflows — task 7.13 SEAM: PROJECT-SYNC activity ports.
//
// This is the port surface the 7.13 Project-Sync slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) and the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts) it is PURE + workflow-safe: it imports NOTHING
// from @temporalio, NOTHING from node:crypto, and calls NO Date.now()/Math.random().
// It declares ONLY types + interfaces (erasable under verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE project-sync DRIVER
// (src/workflows/projectSync.ts) calls these ports so it stays unit-testable with
// the in-memory fakes (test/support/project-sync-fakes.ts); the ACTIVITIES that
// implement the ports (e.g. src/activities/deterministicProgress.ts) MAY import the
// real adapters (@sow/integrations Connector Gateway, @sow/knowledge KnowledgeWriter,
// @sow/providers Broker, @sow/policy) and node:crypto — and FOLD each adapter's
// typed rejection onto the CLOSED, enumerable error each port here declares.
//
// ★★ THE DETERMINISTIC-PROGRESS INVARIANT (REQ-F-011 / PRJ-3/4). The numeric
// progress of a project is derived by a DETERMINISTIC parser of checkboxes/status
// from the IMPLEMENTATION_PLAN and/or external PM systems — a MODEL-supplied
// percentage is FORBIDDEN. The synthesis agent only produces prose
// explanation/blockers/next-actions OVER the deterministic facts; the numeric
// progress NEVER comes from the model. The seam enforces this structurally:
//   • {@link ParseProgressPort} returns {@link DeterministicProgress} — the ONLY
//     source of the numeric fields (completedCount/totalCount/percentComplete).
//   • {@link SynthesizeNarrativePort} returns candidate PROSE fields only; it
//     never carries a numeric progress field the commit could read.
//   • {@link BuildSyncOutputsPort} derives the committed plan's progress from the
//     DETERMINISTIC facts (never from the validated narrative), stamped with the
//     BOUND workspace (WS-2/WS-4).
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.
import type {
  Result,
  WorkspaceId,
  KnowledgeMutationPlan,
  ProposedAction,
  ExternalWriteEnvelope,
  AuditId,
  FailureClass,
  ProjectLifecycleState,
} from "@sow/contracts";
import type { ExtractionField, NoInferenceRejection } from "@sow/domain";

// ---------------------------------------------------------------------------
// (1) The pipeline context carried between project-sync activities
// ---------------------------------------------------------------------------

/**
 * One resolved project the sync run operates over. The project REGISTRY resolves
 * a project to its task systems / IMPLEMENTATION_PLAN path / aliases / progress
 * providers (PRJ-3). The `workspaceId` is the BOUND workspace the derived plan
 * commits to (WS-2/WS-4) — it comes from the registry entry, NOT from any
 * caller-controlled field.
 */
export interface ProjectRegistryEntry {
  /** Stable project id (registry key). */
  readonly projectId: string;
  /** The workspace the project belongs to — the durable write targets this (WS-2). */
  readonly workspaceId: WorkspaceId;
  /**
   * The canonical IMPLEMENTATION_PLAN (or equivalent status doc) path the
   * deterministic parser reads checkboxes/status from. Present when the project's
   * progress is (at least partly) plan-backed.
   */
  readonly planPath?: string;
  /**
   * The external PM progress providers feeding this project (e.g. a Linear/Asana
   * connector id + its remote project handle). Each is a deterministic source of
   * checkbox/status facts — NEVER a model. Empty ⇒ plan-only.
   */
  readonly progressProviders: readonly ProgressProvider[];
  /** Optional aliases the registry maps to this project (for cross-referencing). */
  readonly aliases?: readonly string[];
  /**
   * §13.5 — the project's DISPLAY title, canonical note SLUG, and current LIFECYCLE state, added so the
   * sync outputs (the dashboard row + the committed project-status note) can be built without a separate
   * project-note read. The registry is the pipeline's SERVER-RESOLVED identity + workspace-binding authority
   * (never caller-controlled), so these seed the note frontmatter / dashboard fields safely. NOTE (deliberate,
   * scoped): the registry is the INTENT/seed source of `lifecycleState`; the committed note frontmatter is its
   * reflection — coherent for first-sync seeding + stable re-runs. If lifecycle transitions must flow
   * note→dashboard, a later `ResolveProjectPort` (reading the Project frontmatter) supersedes this.
   */
  readonly title: string;
  /** Canonical project note slug (display/frontmatter only — the note PATH is derived from workspaceId, WS-8). */
  readonly slug: string;
  readonly lifecycleState: ProjectLifecycleState;
}

/**
 * The canonical project identity BOTH sync outputs (dashboard row + committed note) need. Carries NO
 * `workspaceId` — that stays a SEPARATE, server-bound param so an identity value can never smuggle a redirected
 * workspace (WS-8). Every field is server-resolved from the registry entry (never caller-controlled).
 */
export interface ProjectIdentity {
  readonly projectId: string;
  readonly title: string;
  /** Display/frontmatter slug ONLY — the committed note's physical path is rooted at workspaceId, never this. */
  readonly slug: string;
  readonly lifecycleState: ProjectLifecycleState;
}

/**
 * One external progress provider mapping for a project. `connectorId` names the
 * Connector Gateway connector; `remoteHandle` the remote PM object the connector
 * reads deterministic status from. A missing/unmapped provider is a typed failure
 * (provider_unmapped), NEVER a guessed source (fail-closed).
 */
export interface ProgressProvider {
  readonly connectorId: string;
  readonly remoteHandle: string;
}

/**
 * The pipeline state carried between project-sync activities. A PLAIN, immutable
 * data record (no methods, no clock, no I/O). Each stage threads a NEW context
 * with the next field populated:
 *
 *   scheduled          → { projectRef }                        (the project to sync)
 *   registry_resolved  → + registry                            (PRJ-3 resolved entry)
 *   progress_parsed    → + progress                            (DETERMINISTIC facts)
 *   briefed            → + narrative (CANDIDATE prose)         (synthesis agent)
 *   synced_committed   → + revisionId                          (KnowledgeWriter commit)
 *
 * `registry.workspaceId` binds the durable write target (WS-2): NO commit may
 * happen before the registry resolves it.
 */
export interface ProjectSyncContext {
  /** The project to sync — a registry key (or alias) resolved at registry_resolved. */
  readonly projectRef: string;
  /** The resolved registry entry (present once the registry resolved it, PRJ-3). */
  readonly registry?: ProjectRegistryEntry;
  /** The DETERMINISTIC parsed progress (present once the parser ran) — the ONLY numeric source. */
  readonly progress?: DeterministicProgress;
  /** The CANDIDATE synthesis narrative (present once the agent ran) — prose only. */
  readonly narrative?: ProgressNarrativeDraft;
  /** The committed Markdown revision id (present once KnowledgeWriter committed). */
  readonly revisionId?: string;
}

// ---------------------------------------------------------------------------
// (2a) ResolveRegistryPort — PRJ-3: resolve the project registry entry
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable registry-resolution failure set (§16 — never thrown):
 *   • `project_unknown`    — the projectRef/alias resolves to no registry entry.
 *   • `provider_unmapped`  — the project has a declared progress provider with NO
 *     mapping (no connectorId/remoteHandle) — a missing provider mapping is a HARD
 *     failure (→ provider_unmapped), never a guessed source (PRJ-3/4, fail-closed).
 */
export type ResolveRegistryErrorCode = "project_unknown" | "provider_unmapped";

export interface ResolveRegistryError {
  readonly code: ResolveRegistryErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Resolve a project (by key/alias) to its registry entry — its task systems /
 * IMPLEMENTATION_PLAN path / aliases / progress providers + its BOUND workspace
 * (PRJ-3). A missing provider mapping folds to `provider_unmapped` (fail-closed).
 * Never throws.
 */
export interface ResolveRegistryPort {
  resolve(
    ctx: ProjectSyncContext,
  ): Promise<Result<ProjectRegistryEntry, ResolveRegistryError>>;
}

// ---------------------------------------------------------------------------
// (2b) ParseProgressPort — REQ-F-011/PRJ-3/4: the DETERMINISTIC progress source
// ---------------------------------------------------------------------------

/**
 * The DETERMINISTIC parsed progress for a project — the ONLY source of the numeric
 * progress (REQ-F-011 / PRJ-3/4). Derived by a deterministic parser of
 * checkboxes/status from the IMPLEMENTATION_PLAN and/or the external PM systems.
 * NO field here ever comes from a model. `percentComplete` is a pure function of
 * completedCount/totalCount (computed by the parser, not synthesized). `perProvider`
 * carries the per-source breakdown for auditability.
 */
export interface DeterministicProgress {
  /** Deterministically-counted completed checkboxes/tasks (never model-supplied). */
  readonly completedCount: number;
  /** Deterministically-counted total checkboxes/tasks (never model-supplied). */
  readonly totalCount: number;
  /** Integer percent ∈ [0,100], computed from the counts (0 when totalCount === 0). */
  readonly percentComplete: number;
  /** Per-source breakdown (plan + each external provider) — audit trail. */
  readonly perProvider: readonly ProgressProviderCount[];
}

/** One deterministic per-source progress count. `source` is 'plan' or a connectorId. */
export interface ProgressProviderCount {
  readonly source: string;
  readonly completedCount: number;
  readonly totalCount: number;
}

/**
 * Closed, enumerable parse failure set (§16 — never thrown):
 *   • `parse_failed`      — the plan/provider status could not be parsed (malformed
 *     checkboxes, unreadable doc) → state parse_failed. Fail-closed: NO guessed number.
 *   • `connector_stale`   — an external progress provider's cursor is stale beyond
 *     the freshness bound (LIFE-2) — the status is not current → state connector_stale.
 *   • `ambiguous_status`  — a task's status is ambiguous (neither clearly done nor
 *     open; conflicting sources) → state ambiguous_status. The parser refuses to
 *     guess (PRJ-4) rather than silently pick a number.
 */
export type ParseProgressErrorCode =
  | "parse_failed"
  | "connector_stale"
  | "ambiguous_status";

export interface ParseProgressError {
  readonly code: ParseProgressErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Parse the DETERMINISTIC progress of a project from its plan checkboxes and/or
 * external PM status (REQ-F-011 / PRJ-3/4). This is the SOLE producer of the
 * numeric progress — no model is involved. A parse failure / stale connector /
 * ambiguous status folds to a typed error the driver maps to a distinct failure
 * state → 7.5 (nothing silent, PRJ-4 fail-closed). Never throws.
 */
export interface ParseProgressPort {
  parse(
    ctx: ProjectSyncContext,
  ): Promise<Result<DeterministicProgress, ParseProgressError>>;
}

// ---------------------------------------------------------------------------
// (2c) SynthesizeNarrativePort — prose OVER the deterministic facts (candidate)
// ---------------------------------------------------------------------------

/**
 * The CANDIDATE synthesis narrative — the status-synthesis AgentJob output. It is
 * CANDIDATE DATA until it clears the no-inference + schema gate (safety rule 2):
 * `fields` is the abstract evidence-backed extraction-field set the domain
 * no-inference validator (REQ-F-017) operates on (explanation / blockers /
 * next-actions), keyed by an opaque field name. `schemaId` names the output schema.
 *
 * ★ IT CARRIES NO NUMERIC PROGRESS FIELD. The agent synthesizes prose OVER the
 * deterministic facts it is handed; the numeric progress is NOT part of its output
 * and is NEVER read from here (REQ-F-011). Even if a field named "percent" slipped
 * into `fields`, the driver never sources the committed number from the narrative —
 * {@link BuildSyncOutputsPort} derives it from {@link DeterministicProgress}.
 */
export interface ProgressNarrativeDraft {
  /** Evidence-backed prose fields (REQ-F-017 domain shape), keyed by field name. */
  readonly fields: Record<string, ExtractionField<unknown>>;
  /** The output schema id the candidate claims to conform to (§7 candidate-data gate). */
  readonly schemaId?: string;
}

/**
 * The VALIDATED synthesis narrative — the candidate that PASSED both the
 * no-inference rule and the schema gate. A distinct `readonly validated: true`
 * brand so the driver cannot commit an un-validated candidate: only a
 * {@link ValidateNarrativePort} can produce one. STILL prose-only — no number.
 */
export interface ValidatedNarrative {
  readonly validated: true;
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/**
 * Closed, enumerable synthesis-agent failure set (§16 — never thrown). Each code
 * maps to a DISTINCT failure state + a distinct System Health item (inv-5):
 *   • `provider_failed` — the provider/runtime failed (→ state provider_failed).
 *   • `schema_rejected` — the broker's internal candidate-data gate rejected the output.
 *   • `egress_vetoed`   — the egress veto fired (employer-work raw content, ack off,
 *     no local provider) → fail-closed, never a cloud fallback (safety rule 5).
 *   • `budget_exceeded` — COST-1 budget cap breached.
 */
export type ProjectSyncSynthesizeFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface ProjectSyncSynthesizeFailure {
  readonly code: ProjectSyncSynthesizeFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run the status-synthesis AgentJob OVER the DETERMINISTIC facts (REQ-F-011). The
 * activity builds a READ-ONLY-ToolPolicy job that is handed the deterministic
 * progress + project context and dispatches it through the @sow/providers Broker
 * (which enforces ING-7 admission, the egress veto, the budget, and the schema gate
 * internally). It returns a CANDIDATE {@link ProgressNarrativeDraft} (prose only) on
 * acceptance. The agent NEVER produces the numeric progress. Never throws.
 */
export interface SynthesizeNarrativePort {
  synthesize(
    ctx: ProjectSyncContext,
    progress: DeterministicProgress,
  ): Promise<Result<ProgressNarrativeDraft, ProjectSyncSynthesizeFailure>>;
}

// ---------------------------------------------------------------------------
// (2d) ValidateNarrativePort — inv-3: no-inference + schema, no partial
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable validation-rejection set (§16 — never thrown). The gate is a
 * composition (Lesson §3): the no-inference rule (REQ-F-017) AND the ajv+Zod schema
 * gate. A rejection HARD-STOPS the pipeline (→ state schema_rejected) with NO
 * partial commit.
 */
export type NarrativeRejectionCode =
  | "no_inference_violation"
  | "schema_rejected"
  | "unsupported_claim";

export interface NarrativeRejection {
  readonly code: NarrativeRejectionCode;
  readonly message: string;
  /** Present for `no_inference_violation`: the per-field REQ-F-017 rejections. */
  readonly rejections: readonly NoInferenceRejection[];
}

/**
 * Validate the candidate narrative (no-inference + schema) — synchronous + pure.
 * Returns a {@link ValidatedNarrative} (the only way to produce one) on success; a
 * {@link NarrativeRejection} otherwise. NO side effect — no Markdown write, no
 * external write — happens on a rejected narrative (safety rule 2). Never throws.
 */
export interface ValidateNarrativePort {
  validate(
    draft: ProgressNarrativeDraft,
  ): Result<ValidatedNarrative, NarrativeRejection>;
}

// ---------------------------------------------------------------------------
// (2e) BuildSyncOutputsPort — derive committed outputs FROM validated + facts
// ---------------------------------------------------------------------------

/**
 * One external-action proposal to run through the Tool Gateway propose port (e.g.
 * a Telegram status ping). The `action` is the §8 ProposedAction and `envelope` its
 * derived ExternalWriteEnvelope; the envelope's `idempotencyKey` drives replay reuse
 * (inv-5). Keys are computed in the buildSyncOutputs ACTIVITY (node:crypto), never
 * in the pure driver.
 */
export interface ProjectSyncExternalAction {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * The derived semantic outputs of a project sync: the KnowledgeMutationPlan the
 * KnowledgeWriter commits to the project's status sections + a rebuildable dashboard
 * read-model payload (SUMMARY-only) + optional external-action proposals.
 *
 * ★ DERIVE-FROM-VALIDATED + DETERMINISTIC-PROGRESS: the plan is DERIVED from BOTH
 * the {@link ValidatedNarrative} (prose) AND the {@link DeterministicProgress}
 * (numbers) — never caller-supplied. The committed numeric progress comes ONLY from
 * the DETERMINISTIC facts (REQ-F-011); the prose comes from the validated narrative.
 * `plan.workspaceId` is stamped from the passed (registry-bound) workspaceId — a
 * caller cannot redirect the durable write to another workspace (WS-2/WS-4).
 */
export interface ProjectSyncOutputs {
  readonly plan: KnowledgeMutationPlan;
  /** SUMMARY-only dashboard read-model payload (rebuildable; no raw content). */
  readonly dashboard: Record<string, unknown>;
  /** External-action proposals (present when a status ping is to be sent). */
  readonly actions: readonly ProjectSyncExternalAction[];
}

/**
 * Closed, enumerable buildSyncOutputs failure set (§16 — never thrown). Deriving
 * the plan only fails for a shape reason the driver folds to `schema_rejected` (NO
 * partial commit — inv-3):
 *   • `unmappable_progress` — the validated narrative + facts cannot be projected
 *     onto the project-status primitives (fail-closed, never a guessed plan).
 *   • `build_failed`        — the derivation failed for another reason.
 */
export type BuildSyncOutputsFailureCode = "unmappable_progress" | "build_failed";

export interface BuildSyncOutputsFailure {
  readonly code: BuildSyncOutputsFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the committed outputs (the KnowledgeMutationPlan + dashboard payload +
 * external actions) FROM the {@link ValidatedNarrative}, the
 * {@link DeterministicProgress}, and the registry-bound `workspaceId`. This is the
 * governance seam that closes the no-inference / workspace-isolation / model-percent
 * bypass:
 *   • the committed numeric progress comes ONLY from the DETERMINISTIC facts — a
 *     model-supplied percentage can NEVER become the committed number (REQ-F-011);
 *   • the prose fields come from the validated (evidence-backed) narrative — an
 *     inferred owner/date was rejected at validate, so it can never reach the plan;
 *   • `plan.workspaceId` is stamped from the passed (registry-bound) workspaceId,
 *     so a caller cannot redirect the durable write to another workspace (WS-2/WS-4).
 * The plan/envelope idempotency + canonical-object keys are computed in the ACTIVITY
 * (node:crypto) so the driver's idempotent replay (inv-5) holds. Never throws.
 */
export interface BuildSyncOutputsPort {
  build(
    validated: ValidatedNarrative,
    progress: DeterministicProgress,
    workspaceId: WorkspaceId,
    /** §13.5 — the server-resolved project identity both outputs need (registry-derived, WS-8-safe). */
    identity: ProjectIdentity,
    /** ISO-8601 sync instant — the dashboard row's `updatedAt` + the note's "last synced" line (the pure
     *  projection + builder are clockless; the driver supplies the wall-clock reading from its Clock). */
    updatedAt: string,
  ): Promise<Result<ProjectSyncOutputs, BuildSyncOutputsFailure>>;
}

// ---------------------------------------------------------------------------
// (2e-bis) NoteExistsReader — §13.5 create-vs-patch: does the canonical note exist yet?
// ---------------------------------------------------------------------------

/** Closed, enumerable note-exists probe failure set (§16 — never thrown). */
export type NoteExistsErrorCode = "read_failed";

export interface NoteExistsError {
  readonly code: NoteExistsErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * WS-8-scoped note-exists probe backing the projectSync create-vs-patch decision (§13.5). `path` is the
 * workspace-rooted `projects/<workspaceId>/<leaf>.md` derived by the SINGLE `projectNotePath` authority the
 * build activity + projection share — so the probe is INHERENTLY workspace-scoped (it can only ever ask about
 * a path inside the bound workspace) and can never disagree with the mutation's target. Returns `true` IFF the
 * canonical project-status note already exists:
 *   • false → the build derives a full {@link ProjectSyncOutputs} NoteCreate (first sync);
 *   • true  → the build derives a region-scoped NotePatch (re-sync — preserves the human scaffold + any
 *     content outside the `kw:region:project-status` region; a NoteCreate over an existing note would blindly
 *     OVERWRITE the whole file at the KnowledgeWriter's project step).
 * A read failure is a TYPED error, and the build activity fails CLOSED on it (→ build_failed, NO commit): under
 * uncertainty we NEVER guess create-vs-patch — a wrong NoteCreate clobbers human content, a wrong NotePatch on a
 * missing note writes a markers-only file. Never throws.
 */
export interface NoteExistsReader {
  exists(path: string): Promise<Result<boolean, NoteExistsError>>;
}

// ---------------------------------------------------------------------------
// (2f) CommitStatusPort — inv-4/inv-5: KnowledgeWriter, idempotent replay
// ---------------------------------------------------------------------------

/**
 * The successful commit outcome. `revisionId` is the committed Markdown revision;
 * `replayed` is true when the commit was an idempotent REPLAY of a prior commit
 * under the same idempotencyKey (no second write, no second audit — inv-5).
 */
export interface StatusCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}

/**
 * Closed, enumerable KnowledgeWriter commit failure set (§16 — never thrown),
 * mirroring the @sow/knowledge WriteFailure variants the activity folds onto.
 */
export type StatusCommitFailureCode =
  | "schema_rejected"
  | "write_conflict"
  | "ownership_violation"
  | "secret_found"
  | "commit_failed";

export interface StatusCommitFailure {
  readonly code: StatusCommitFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Commit the derived project-status plan through the KnowledgeWriter (safety rule 1:
 * the SOLE Markdown writer) to the project's status sections. IDEMPOTENT by the
 * plan's idempotencyKey (inv-5): a prior commit returns `replayed:true` with the
 * SAME revisionId — no second write, no second audit. A compare-revision clash is
 * `write_conflict`. Never throws.
 */
export interface CommitStatusPort {
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<StatusCommitSuccess, StatusCommitFailure>>;
}

// ---------------------------------------------------------------------------
// (2g) ProjectSyncUpdateDashboardPort — the read-model updates FROM the committed Markdown
// ---------------------------------------------------------------------------

/** Closed, enumerable dashboard-update failure set (§16 — never thrown). */
export type ProjectSyncUpdateDashboardErrorCode = "dashboard_failed";

export interface ProjectSyncUpdateDashboardError {
  readonly code: ProjectSyncUpdateDashboardErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Update the rebuildable dashboard read-model from the COMMITTED project status.
 * This is a REBUILDABLE projection (§4/§16) — SUMMARY/metadata only, never raw
 * content — that updates FROM the committed Markdown (so it can be rebuilt from the
 * canonical truth). It runs AFTER the Markdown commit; a dashboard-update failure
 * surfaces a health item but does NOT roll the commit back (like 7.6 reindex).
 * Never throws.
 */
export interface ProjectSyncUpdateDashboardPort {
  update(
    payload: Record<string, unknown>,
  ): Promise<Result<void, ProjectSyncUpdateDashboardError>>;
}

// ---------------------------------------------------------------------------
// (2h) ProjectSyncProposeActionsPort — inv-4/inv-5: Tool Gateway, envelope reuse
// ---------------------------------------------------------------------------

/** The proof an external write was applied (or reused on replay). */
export interface ProjectSyncProposeResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * Closed, enumerable external-proposal failure set (§16 — never thrown), mirroring
 * the §8 Tool-Gateway non-terminal / rejection outcomes:
 *   • `held`             — the gateway FAILED CLOSED; re-hold via the outbox (→ outbox_retry).
 *   • `approval_pending` — the write awaits approval (→ outbox_retry park); NO write.
 *   • `conflict`         — the vendor rejected on a precondition clash.
 *   • `rejected`         — the vendor/gate refused (validation/auth).
 */
export type ProjectSyncProposeErrorCode = "held" | "approval_pending" | "conflict" | "rejected";

export interface ProjectSyncProposeError {
  readonly code: ProjectSyncProposeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Propose (and, when auto-approved, apply) an external write through the §8 Tool
 * Gateway (safety rule 3: the ONLY external-write path). Reserve-then-create with a
 * mandatory pre-write existence check; a REPLAY with the same idempotencyKey REUSES
 * the receipt (`status:'reused'`) → zero duplicate external write (inv-5). Never
 * throws.
 */
export interface ProjectSyncProposeActionsPort {
  propose(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ProjectSyncProposeResult, ProjectSyncProposeError>>;
}

// ---------------------------------------------------------------------------
// (3) ProjectSyncHealthSink — inv-5: the failure sink (reuses 7.5 shape)
// ---------------------------------------------------------------------------

/**
 * A project-sync failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure class through the sink so
 * nothing fails silently (inv-5 / §16).
 */
export interface ProjectSyncFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface ProjectSyncSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface ProjectSyncHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every project-sync failure class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`; the
 * driver depends only on this narrow port so it stays pure + injected-testable.
 * Never throws.
 */
export interface ProjectSyncHealthSink {
  surface(
    failure: ProjectSyncFailure,
  ): Promise<Result<ProjectSyncSurfaceOutcome, ProjectSyncHealthSinkError>>;
}
