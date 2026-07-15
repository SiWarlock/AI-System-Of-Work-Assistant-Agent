// @sow/workflows — task 7.7 SEAM: the SOURCE-INGESTION activity ports.
//
// This is the port surface every downstream 7.7 slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) + the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts) it is PURE + workflow-safe: it imports NOTHING
// from @temporalio, NOTHING from node:crypto, and calls NO Date.now()/Math.random().
// It declares ONLY types + interfaces (erasable under verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE source-ingestion DRIVER
// (src/workflows/sourceIngestion.ts) calls these ports so it stays unit-testable
// with the in-memory fakes; the ACTIVITIES that implement the ports MAY import the
// real adapters (@sow/integrations registerSource + Tool Gateway, @sow/providers
// Broker, @sow/knowledge KnowledgeWriter + GCL, @sow/policy) and node:crypto — and
// FOLD each adapter's typed rejection onto the CLOSED, enumerable error each port
// here declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the source-ingestion vocabulary the driver reasons in, mapped
// onto the @sow/domain `sourceMachine` states (captured → classified →
// queued_for_review | processing → proposed → applied | rejected |
// failed_retryable | failed_terminal), so the driver never depends on a downstream
// package's error enum.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.
//
// The 7.7 governance seam REUSES the 7.6 derive-from-validated surface: the
// {@link AgentExtraction} / {@link ValidatedExtraction} / {@link ValidateExtractionPort}
// / {@link BuildOutputsPort} / {@link CommitKnowledgePort} / {@link ProposeActionsPort}
// types are imported from the meeting-closeout seam (they are workflow-agnostic —
// candidate-data-in, validated-and-derived-out) rather than re-declared, so the
// no-inference + workspace-stamp guarantees are IDENTICAL to 7.6.

import type {
  Result,
  WorkspaceId,
  SourceEnvelope,
  SourceId,
  AuditId,
  FailureClass,
} from "@sow/contracts";
import type {
  AgentExtraction,
  ValidatedExtraction,
  ValidateExtractionPort,
  ValidationRejection,
  ValidationRejectionCode,
  BuildOutputsPort,
  BuildOutputsFailure,
  BuildOutputsFailureCode,
  MeetingBuiltOutputs,
  MeetingExternalActionInput,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
  ProposeActionsPort,
  ProposeResult,
  ProposeError,
  ProposeErrorCode,
} from "./meetingCloseout";

// Re-export the reused governance surface so a downstream 7.7 slice imports it from
// ONE place (the source-ingestion seam) without reaching into the 7.6 module.
export type {
  AgentExtraction,
  ValidatedExtraction,
  ValidateExtractionPort,
  ValidationRejection,
  ValidationRejectionCode,
  BuildOutputsPort,
  BuildOutputsFailure,
  BuildOutputsFailureCode,
  MeetingBuiltOutputs,
  MeetingExternalActionInput,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
  ProposeActionsPort,
  ProposeResult,
  ProposeError,
  ProposeErrorCode,
};

// ---------------------------------------------------------------------------
// (2c″) SourceBuildOutputsPort — the source build derives a PER-FILE note (task 11.1)
// ---------------------------------------------------------------------------
//
// Source-ingestion's build DIVERGED from the shared `BuildOutputsPort`: it must derive a distinct
// per-file note path + planId from the DROPPED FILE's identity, so many files persist per workspace
// (a fixed path collapses every file to one note). So it takes its OWN port carrying the per-file
// source identity — leaving the shared `BuildOutputsPort` (meeting-closeout, hermes) byte-unchanged
// (hermes has no per-file SourceEnvelope to pass; a required source on the shared port would force a
// dishonest placeholder). This mirrors crossCalendarScheduling / projectSync, which already fork
// their own build-outputs ports when their build stage diverges.

/**
 * The NARROW per-file source identity the note path + planId are keyed on — deliberately narrow
 * (NOT the full {@link SourceEnvelope}) so the path-derivation surface STRUCTURALLY excludes the
 * attacker-influenceable source fields (`origin`, `routingHints`, `sensitivity`); the derivation can
 * only ever see the two fields it legitimately keys on. Both are required `SourceEnvelope` fields,
 * so the driver projects `context.source` trivially.
 */
export interface SourceNoteIdentity {
  readonly sourceId: SourceId;
  readonly contentHash: string;
}

/**
 * Like {@link BuildOutputsPort}, but the build receives the per-file {@link SourceNoteIdentity} so it
 * derives a distinct, traversal-safe, content-addressed note path + planId per dropped file (a
 * same-file same-content re-drop derives the same identity ⇒ the durable revision store replays; an
 * edited file ⇒ a new note). Same return contract as the shared port (a `MeetingBuiltOutputs` plan +
 * external actions, or a typed `BuildOutputsFailure`); never throws (§16).
 */
export interface SourceBuildOutputsPort {
  build(
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    source: SourceNoteIdentity,
    /**
     * The GATE-VALIDATED note body — the `SourceEnvelope.body` value (15.2), which already cleared
     * the §8 candidate-data gate (Zod `.strict()` + JSON-Schema, string-if-present). ADDITIVE +
     * OPTIONAL (task 15.3, Lesson 15): absent OR empty ⇒ the projection degrades to a safe minimal real note.
     * DELIBERATELY a SEPARATE param from {@link SourceNoteIdentity} — the note PATH derives ONLY from
     * the identity, so an attacker-influenceable `body` can NEVER reach `deriveSourceNotePath`
     * (traversal-safe by construction, WS-8). Backward-compatible: a 3-arg caller/fake stays valid.
     */
    body?: string,
  ): Promise<Result<MeetingBuiltOutputs, BuildOutputsFailure>>;
}

// ---------------------------------------------------------------------------
// (0) The source-ingestion pipeline context
// ---------------------------------------------------------------------------

/**
 * The pipeline state carried between source-ingestion activities. A PLAIN,
 * immutable data record (no methods, no clock, no I/O). Each stage of the driver
 * threads a NEW context with the next field populated:
 *
 *   captured           → { source }                          (SourceEnvelope registered)
 *   classified         → + workspaceId + routing             (WS-2: workspace bound)
 *   processing         → + extraction (CANDIDATE)            (source agent output)
 *   proposed           → + validated + revisionId            (gate PASSED + KW commit)
 *   applied            → + envelopes                          (Tool Gateway receipts)
 *
 * `workspaceId` is ABSENT until classification/routing binds it (inv-1 / REQ-F-002
 * / WS-2): NO durable write may happen while it is undefined; a LOW-confidence
 * routing outcome parks in `queued_for_review` (the Ingestion Inbox) with the
 * workspace STILL unbound.
 */
export interface SourceIngestionContext {
  /** The inbound source register record (populated once registration succeeds). */
  readonly source: SourceEnvelope;
  /** Bound ONLY after a high-confidence route (WS-2) — undefined pre-classification. */
  readonly workspaceId?: WorkspaceId;
  /** The routing result (present once the router ran). */
  readonly routing?: RouteOutcome;
  /** The CANDIDATE agent extraction (present once the source-processing job ran). */
  readonly extraction?: AgentExtraction;
  /** The VALIDATED extraction (present once it cleared the gate). */
  readonly validated?: ValidatedExtraction;
  /** The committed Markdown revision id (present once KnowledgeWriter committed). */
  readonly revisionId?: string;
  /** The external-write envelopes proposed / applied (empty default). */
  readonly envelopes: readonly import("@sow/contracts").ExternalWriteEnvelope[];
}

// ---------------------------------------------------------------------------
// (1) RegisterSourcePort — inv: register BEFORE extraction; contentHash dedupe
// ---------------------------------------------------------------------------

/**
 * The typed outcome of a source registration probe (mirrors the §8
 * `registerSource` result the activity folds onto):
 *   • `registered` — the source passed the gate + is fresh; carries the built,
 *     validated {@link SourceEnvelope} the pipeline processes.
 *   • `dedupe_hit` — the source is well-formed but its `contentHash` is already
 *     known — a NO-OP (no new source minted; the driver ends WITHOUT reprocessing).
 */
export type RegisterOutcome =
  | { readonly outcome: "registered"; readonly envelope: SourceEnvelope }
  | { readonly outcome: "dedupe_hit"; readonly contentHash: string };

/** Closed, enumerable register-gate failure set (§16 — never thrown). */
export type RegisterErrorCode = "malformed_source" | "register_failed";

export interface RegisterError {
  readonly code: RegisterErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Register the inbound source as a {@link SourceEnvelope} BEFORE any extraction
 * (Flow 4 / REQ-F-010). The activity runs the §8 candidate gate (ajv structural +
 * Zod `.strict()`) + the contentHash dedupe probe. A `dedupe_hit` is a SUCCESS
 * carrying the offending hash (the driver treats it as a no-op — no reprocessing).
 * A malformed candidate is a `RegisterError` (→ failed_terminal). Never throws.
 */
export interface RegisterSourcePort {
  register(
    ctx: SourceIngestionContext,
  ): Promise<Result<RegisterOutcome, RegisterError>>;
}

// ---------------------------------------------------------------------------
// (2) RouteSourcePort — inv-1: LOW confidence parks in queued_for_review
// ---------------------------------------------------------------------------

/**
 * The classification/routing confidence signal. `high` = the source was confidently
 * classified + bound to a workspace/project; `low` = ambiguous — park in the
 * Ingestion Inbox (queued_for_review). The workspace binding lives ONLY on the
 * `high` variant so the type SYSTEM forbids reading a workspaceId off a
 * low-confidence outcome (inv-1: the router NEVER auto-routes / guesses a workspace).
 */
export type RouteOutcome =
  | {
      readonly confidence: "high";
      /** WS-2: the bound workspace (present ONLY on high confidence). */
      readonly workspaceId: WorkspaceId;
      /** The bound project, when classified (optional). */
      readonly projectId?: string;
      /** The classified sensitivity/type disposition (open — §8 taxonomy arch_gap). */
      readonly disposition?: string;
    }
  | {
      readonly confidence: "low";
      /**
       * The Ingestion-Inbox marker (inv-1): a low-confidence route parks in
       * queued_for_review — it NEVER carries a workspaceId, so no durable write can
       * guess a workspace off it.
       */
      readonly queuedForReview: true;
      /** Optional human-facing reason surfaced in the inbox. */
      readonly reason?: string;
    };

/** Closed, enumerable RouteSourcePort failure set (§16 — never thrown). */
export type RouteErrorCode =
  | "route_source_unavailable" // the classification input could not be read
  | "route_failed"; // the router itself failed (not a low-confidence result)

export interface RouteError {
  readonly code: RouteErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Classify + route a registered source to a workspace/project (inv-1 / REQ-F-002 /
 * WS-2). A LOW-confidence route is a SUCCESS carrying a queued_for_review marker
 * (the driver parks it in the Ingestion Inbox) — NOT an error, and NEVER an
 * auto-route. A `RouteError` is only for a router/source failure. Never throws.
 */
export interface RouteSourcePort {
  route(
    ctx: SourceIngestionContext,
  ): Promise<Result<RouteOutcome, RouteError>>;
}

// ---------------------------------------------------------------------------
// (3) RunSourceAgentJobPort — inv: READ-ONLY admission (ING-7); no external write
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable source-agent failure set (§16 — never thrown). Distinct codes
 * so each maps to a DISTINCT sourceMachine failure state + a distinct System Health
 * item (nothing silent):
 *   • `admission_rejected` — ING-7: the job declared a MUTATING tool policy on the
 *     untrusted/imported source and was REJECTED at job admission (never run). The
 *     source-processing agent runs READ-ONLY and may emit ONLY a plan / proposal —
 *     never drive an external write itself.
 *   • `injection_detected` — prompt-injection / untrusted-content attack detected in
 *     the source; the job fails closed (→ failed_terminal, distinct health item).
 *   • `unsupported_type`   — the source type has no processing path (→ failed_terminal).
 *   • `provider_failed`    — the provider/runtime failed (→ failed_retryable).
 *   • `schema_rejected`    — the broker's internal candidate-data gate rejected the
 *     output (→ rejected).
 *   • `egress_vetoed`      — the egress veto fired (employer-work raw content, ack
 *     off, no local provider) → fail-closed (safety rule 5) (→ failed_terminal).
 *   • `budget_exceeded`    — COST-1 budget cap breached (→ failed_retryable).
 */
export type SourceAgentFailureCode =
  | "admission_rejected"
  | "injection_detected"
  | "unsupported_type"
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface SourceAgentFailure {
  readonly code: SourceAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run the source-processing AgentJob on the UNTRUSTED/imported source. The activity
 * builds a READ-ONLY-ToolPolicy job (ING-7) with an outputSchemaId + budget caps +
 * an idempotencyKey and dispatches it through the @sow/providers Broker. The job may
 * emit ONLY a KnowledgeMutationPlan / ProposedAction (via the derive-from-validated
 * path) — it may NEVER drive an external write directly (the sourceMachine has no
 * processing→external_write edge). Returns a CANDIDATE {@link AgentExtraction} on
 * acceptance; a mutating-tool declaration is `admission_rejected` (never run); a
 * detected injection is `injection_detected`. Never throws.
 */
export interface RunSourceAgentJobPort {
  run(
    ctx: SourceIngestionContext,
  ): Promise<Result<AgentExtraction, SourceAgentFailure>>;
}

// ---------------------------------------------------------------------------
// (4) IndexGbrainPort — after commit, idempotent (GBrain index; NotebookLM sync)
// ---------------------------------------------------------------------------

/** Closed, enumerable GBrain-index / NotebookLM-sync failure set (§16 — never thrown). */
export type IndexErrorCode = "index_failed" | "revision_unavailable" | "sync_failed";

export interface IndexError {
  readonly code: IndexErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Index the committed revision into GBrain + optionally sync to NotebookLM — runs
 * strictly AFTER the Markdown commit, ASYNC + IDEMPOTENT (re-indexing / re-syncing
 * the same revision is a no-op). It NEVER runs before the commit and NEVER rolls a
 * commit back — an index/sync failure is a typed err the caller surfaces (and
 * retries), while the durable Markdown commit stands. Never throws.
 */
export interface IndexGbrainPort {
  index(revisionId: string): Promise<Result<void, IndexError>>;
}

// ---------------------------------------------------------------------------
// (5) SourceHealthSink — inv-5: the failure sink (reuses the 7.5 surfacing shape)
// ---------------------------------------------------------------------------

/**
 * A source-ingestion failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure/park class through the
 * sink so nothing fails silently (inv-5 / §16). Kept here as a light alias so a
 * downstream slice can widen to the full 7.5 `WorkflowFailure` without re-declaring
 * the shape.
 */
export interface SourceWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface SourceSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface SourceHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every source-ingestion failure/park class
 * through (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`
 * (HealthItemStore + outbox); the driver depends only on this narrow port so it
 * stays pure + injected-testable. Never throws.
 */
export interface SourceHealthSink {
  surface(
    failure: SourceWorkflowFailure,
  ): Promise<Result<SourceSurfaceOutcome, SourceHealthSinkError>>;
}
