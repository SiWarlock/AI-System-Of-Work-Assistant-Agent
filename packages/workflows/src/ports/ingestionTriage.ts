// @sow/workflows — task 7.8 SEAM: the INGESTION-INBOX TRIAGE activity ports.
//
// This is the port surface the 7.8 triage slice imports. Like the 7.1–7.5
// foundation (src/ports/operational.ts) + the 7.6/7.7 seams it is PURE +
// workflow-safe: it imports NOTHING from @temporalio, NOTHING from node:crypto,
// and calls NO Date.now()/Math.random(). It declares ONLY types + interfaces
// (erasable under verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE triage DRIVER
// (src/workflows/ingestionTriage.ts) calls these ports so it stays unit-testable
// with in-memory fakes; the ACTIVITY that implements them
// (src/activities/disposition.ts) MAY import node:crypto (to compute the stable
// disposition key that drives exactly-once recording) + the real adapters (the
// operational store for the disposition record, the §8 audit sink). Each adapter's
// typed rejection FOLDS onto the CLOSED, enumerable error each port here declares.
//
// WHAT 7.8 DOES (ARCHITECTURE.md §9 workflow 5 — resolves the ING-4 dead-end):
// a parked SourceEnvelope sits in the Ingestion Inbox (source state
// `queued_for_review`) because 7.7 routing was low-confidence and NEVER guessed a
// workspace (inv-1). The OWNER, from Mac OR Telegram, dispositions it: re-classify
// workspace/project, apply a routing override, set sensitivity. Triage then
// RE-ENTERS the 7.7 ingestion pipeline REUSING THE SAME idempotencyKey so
// re-processing is replay-safe and produces NO duplicate downstream write.
//
// The four 7.8 safety invariants this seam supports:
//   inv-A  a disposition is RECORDED EXACTLY ONCE with an audit ref; a re-submitted
//          IDENTICAL disposition is a NO-OP (idempotent by a stable disposition key
//          the activity computes from (source, dispositionInput) — node:crypto).
//   inv-B  Mac + Telegram dispositions CONVERGE on a SINGLE state transition — both
//          channels compute the SAME disposition key → the SAME record → one
//          transition; there is NO divergent inbox state across channels.
//   inv-C  the routing override RE-SCOPES the source (workspace/project/sensitivity)
//          BEFORE re-processing — the re-entered pipeline sees the OVERRIDDEN source,
//          not the parked one.
//   inv-D  re-entry REUSES the SAME idempotencyKey → resolveRun reuses the run and
//          the downstream KnowledgeWriter commit / Tool Gateway external write are
//          idempotent-replayed → zero duplicate downstream write.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  SourceEnvelope,
  AuditId,
  FailureClass,
} from "@sow/contracts";

// ---------------------------------------------------------------------------
// (0) The channel a disposition arrived on — Mac + Telegram parity (inv-B)
// ---------------------------------------------------------------------------

/**
 * The surface the owner dispositioned the parked source from. Mac + Telegram are
 * PEERS (REQ-F-012 parity): the SAME disposition from EITHER channel converges on
 * the SAME record + SAME transition (inv-B) — the channel is carried for the audit
 * trail, NOT to fork behaviour.
 */
export type TriageChannel = "mac" | "telegram";

// ---------------------------------------------------------------------------
// (1) The owner disposition — the human decision on a parked source
// ---------------------------------------------------------------------------

/**
 * The owner's triage decision on a parked {@link SourceEnvelope} (inv-C). It
 * RE-CLASSIFIES the source: it binds a workspace (the routing override — the human
 * makes the call the low-confidence router would not, inv-1), optionally binds a
 * project, and MAY set the sensitivity. The `channel` records which surface it came
 * from (Mac/Telegram) for the audit ref (inv-B); it NEVER changes the outcome.
 *
 * The bound `workspaceId` is the OWNER's explicit routing override — this is the
 * ONLY way a parked source escapes the Ingestion Inbox with a workspace, and it is
 * an authorized human decision, not an inference (inv-C / REQ-F-002 / WS-2).
 */
export interface TriageDisposition {
  /** The parked source's id (the inbox row being dispositioned). */
  readonly sourceId: string;
  /** WS-2 routing override: the workspace the owner binds the source to. */
  readonly workspaceId: WorkspaceId;
  /** Optional project binding (the owner may scope to a project). */
  readonly projectId?: string;
  /** Optional sensitivity override (the owner may re-classify sensitivity). */
  readonly sensitivity?: string;
  /** Which surface the disposition arrived on (Mac/Telegram) — audit only (inv-B). */
  readonly channel: TriageChannel;
}

// ---------------------------------------------------------------------------
// (2) RecordDispositionPort — inv-A/inv-B: exactly-once record + audit ref
// ---------------------------------------------------------------------------

/**
 * The outcome of recording a disposition. `recorded` is the FIRST time this
 * disposition (by its stable key) was recorded — a real state transition happened,
 * carrying a fresh {@link AuditId}. `noop` is an IDEMPOTENT re-submit of the SAME
 * disposition (inv-A) OR the CONVERGING second channel (inv-B): NO second record,
 * NO second transition; the PRIOR auditRef is returned so the driver can still cite
 * it. Both variants carry the audit ref (proof nothing was silent, inv-5-style).
 */
export type RecordDispositionOutcome =
  | { readonly outcome: "recorded"; readonly auditRef: AuditId }
  | { readonly outcome: "noop"; readonly auditRef: AuditId };

/** Closed, enumerable disposition-record failure set (§16 — never thrown). */
export type RecordDispositionErrorCode =
  | "not_parked" // the source is not in queued_for_review — nothing to disposition
  | "record_failed"; // the operational-store write of the record failed

export interface RecordDispositionError {
  readonly code: RecordDispositionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Record the owner disposition EXACTLY ONCE (inv-A) and mint its audit ref. The
 * activity computes a STABLE disposition key from (sourceId + the disposition's
 * routing fields) — node:crypto — and CAS-inserts the record: the FIRST write wins
 * (`recorded`) and moves the inbox row through its single transition; a re-submit of
 * the IDENTICAL disposition, OR the CONVERGING second channel (Mac after Telegram or
 * vice-versa), hits the existing key and is a `noop` reusing the SAME auditRef
 * (inv-B: one transition, no divergent inbox state across channels). Never throws.
 */
export interface RecordDispositionPort {
  record(
    disposition: TriageDisposition,
  ): Promise<Result<RecordDispositionOutcome, RecordDispositionError>>;
}

// ---------------------------------------------------------------------------
// (3) RescopeSourcePort — inv-C: apply the routing override BEFORE re-processing
// ---------------------------------------------------------------------------

/** Closed, enumerable re-scope failure set (§16 — never thrown). */
export type RescopeErrorCode =
  | "source_unavailable" // the parked source could not be read to re-scope it
  | "rescope_failed"; // applying the override to the source failed

export interface RescopeError {
  readonly code: RescopeErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Apply the owner's routing override to the parked source, producing the RE-SCOPED
 * {@link SourceEnvelope} the 7.7 pipeline re-enters on (inv-C). The returned
 * envelope carries the OWNER-BOUND workspaceId (WS-2 override), the optional project
 * (via routingHints), and the optional sensitivity override — so the re-entered
 * pipeline processes the RE-CLASSIFIED source, never the parked one. The
 * source's `contentHash` is PRESERVED (the re-entry is the SAME logical source, so
 * its downstream idempotency identity is unchanged — inv-D). Never throws.
 */
export interface RescopeSourcePort {
  rescope(
    disposition: TriageDisposition,
  ): Promise<Result<SourceEnvelope, RescopeError>>;
}

// ---------------------------------------------------------------------------
// (4) ReenterIngestionPort — inv-C/inv-D: re-enter 7.7 with the SAME key
// ---------------------------------------------------------------------------

/**
 * The disposition of a re-entered ingestion run, as the TRIAGE driver observes it.
 * `state` is the 7.7 source-machine state the re-entered pipeline rested in
 * (`applied` on success, or a park/failure state); `runReused` is true when the
 * re-entry hit the SAME idempotencyKey and reused the existing run (inv-D). The
 * downstream commit/external write are idempotent-replayed inside 7.7, so a
 * re-entry never duplicates a durable write.
 */
export interface ReenterOutcome {
  readonly state: string;
  readonly runReused: boolean;
}

/** Closed, enumerable re-entry failure set (§16 — never thrown). */
export type ReenterErrorCode =
  | "reentry_failed"; // the re-entered 7.7 pipeline could not be driven

export interface ReenterError {
  readonly code: ReenterErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * RE-ENTER the 7.7 source-ingestion pipeline on the RE-SCOPED source, REUSING the
 * SAME idempotencyKey the parked source was first submitted under (inv-D). Because
 * the key is reused, 7.7's resolveRun returns the EXISTING run (no duplicate run)
 * and the downstream KnowledgeWriter commit + Tool Gateway external write are
 * idempotent — so a re-entry produces ZERO duplicate downstream writes. The routing
 * now succeeds HIGH-confidence off the owner's override, so the pipeline advances
 * past the ING-4 dead-end. Never throws.
 */
export interface ReenterIngestionPort {
  reenter(
    reScopedSource: SourceEnvelope,
    idempotencyKey: string,
  ): Promise<Result<ReenterOutcome, ReenterError>>;
}

// ---------------------------------------------------------------------------
// (5) TriageHealthSink — inv-5: the failure sink (reuses the 7.5 surfacing shape)
// ---------------------------------------------------------------------------

/**
 * A triage failure to surface. Structurally a subset of the 7.5 `WorkflowFailure`
 * seam — the driver routes EVERY failure/park class through the sink so nothing
 * fails silently (inv-5 / §16). Kept as a light alias so a downstream slice can
 * widen to the full 7.5 `WorkflowFailure` without re-declaring the shape.
 */
export interface TriageWorkflowFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface TriageSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface TriageHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every triage failure/park class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`
 * (HealthItemStore + outbox); the driver depends only on this narrow port so it
 * stays pure + injected-testable. Never throws.
 */
export interface TriageHealthSink {
  surface(
    failure: TriageWorkflowFailure,
  ): Promise<Result<TriageSurfaceOutcome, TriageHealthSinkError>>;
}

// ---------------------------------------------------------------------------
// (6) The triage pipeline context
// ---------------------------------------------------------------------------

/**
 * The pipeline state carried through the triage driver. A PLAIN, immutable data
 * record. Threaded stage by stage:
 *
 *   disposition        → { disposition }                (the owner decision + channel)
 *   recorded           → + auditRef + dispositionNoop   (exactly-once record, inv-A/B)
 *   reScoped           → + reScopedSource               (override applied, inv-C)
 *   reentered          → + reenter                      (7.7 re-entry outcome, inv-D)
 */
export interface IngestionTriageContext {
  /** The owner disposition being applied (present from the start). */
  readonly disposition: TriageDisposition;
  /** The audit ref of the (single) recorded disposition (present once recorded). */
  readonly auditRef?: AuditId;
  /** True when the record was a no-op (idempotent re-submit / converging channel). */
  readonly dispositionNoop?: boolean;
  /** The RE-SCOPED source the pipeline re-enters on (present once the override applied). */
  readonly reScopedSource?: SourceEnvelope;
  /** The 7.7 re-entry outcome (present once the pipeline was re-entered). */
  readonly reenter?: ReenterOutcome;
}
