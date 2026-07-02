// @sow/workflows — task 7.17 SEAM: the COPILOT Q&A (read-path) activity ports.
//
// This is the port surface the 7.17 slice imports. Like the 7.1–7.5 foundation
// (src/ports/operational.ts), the 7.6 meeting-closeout seam
// (src/ports/meetingCloseout.ts), the 7.10 daily-brief seam
// (src/ports/dailyBrief.ts) and the 7.12 scheduling seam
// (src/ports/crossCalendarScheduling.ts) it is PURE + workflow-safe: it imports
// NOTHING from @temporalio, NOTHING from node:crypto, and calls NO
// Date.now()/Math.random(). It declares ONLY types + interfaces (erasable under
// verbatimModuleSyntax).
//
// The two-layer split (root CLAUDE.md ★): the PURE copilot-Q&A DRIVER
// (src/workflows/copilotQa.ts) calls these ports so it stays unit-testable with
// in-memory fakes; the ACTIVITIES that implement the ports (e.g.
// src/activities/scopedRetrieval.ts) MAY import the real adapters (@sow/knowledge
// GCL Visibility Gate + GBrain read, @sow/providers Broker, @sow/policy
// requiresApproval, @sow/integrations Tool Gateway) and node:crypto — and FOLD each
// adapter's typed rejection onto the CLOSED, enumerable error each port here
// declares.
//
// The port error sets are deliberately DECOUPLED from the concrete adapter error
// shapes: they are the copilot-Q&A vocabulary the driver reasons in (mapped 1:1 to
// the local copilotQaMachine states — scope_undetermined / retrieval_denied /
// provider_failed / budget_exceeded / schema_rejected / route_failed), so the driver
// never depends on a downstream package's error enum.
//
// ★★ THE 7.17 SAFETY INVARIANTS the port shapes encode by construction
//    (Section 9.13 / REQ-F-005 / REQ-S-007):
//   (WS-8 isolation) an owner question resolves to EITHER a WORKSPACE-SCOPED
//     retrieval (RetrieveWorkspacePort, bound to ONE workspace) OR — for a GLOBAL
//     question — the GCL Visibility Gate (RetrieveGlobalPort). There is NO port that
//     issues a direct cross-brain GBrain query; the global path returns ONLY
//     sanitized GclProjections that crossed the gate, so no raw cross-workspace
//     content can ride the answer.
//   (READ-PATH = NO SIDE EFFECT) the port set contains NO commit port and NO
//     external-write dispatch port. The workflow NEVER writes Markdown and NEVER
//     applies an external write. If the owner explicitly asks to ACT, the derived
//     ProposedAction is handed to the 7.9 approval path (QaRouteToApprovalPort) as a
//     PROPOSAL — never applied inline.
//   (REQ-S-007 budget) a provider/budget failure is a TYPED failure the driver
//     routes to 7.5; a budget breach CANCELS with NO partial side effect (there is
//     none to leak — the read path never mutated anything).
//   (schema-gated citations) synthesis is SCHEMA-GATED and returns CITATIONS: the
//     answer is candidate data until it clears the gate, and a validated answer
//     carries ≥1 citation back to the retrieved evidence.
//
// §16 error convention: every port method returns a typed Result — NEVER throws
// across the boundary; every failure is a member of a closed union; fail-closed.

import type {
  Result,
  WorkspaceId,
  ProposedAction,
  ExternalWriteEnvelope,
  GclProjection,
  SourceRef,
  AuditId,
  FailureClass,
} from "@sow/contracts";

// ---------------------------------------------------------------------------
// (1) The pipeline context carried between copilot-Q&A activities
// ---------------------------------------------------------------------------

/**
 * The channel the owner question arrived on (Section 9.13). Both resolve through
 * the SAME governed read path — the channel only affects how the answer is
 * rendered back to the owner, never the retrieval scope or the isolation guard.
 */
export type QaChannel = "mac" | "telegram";

/**
 * The owner's question as it enters the read path. `askedWorkspaceId` is the
 * workspace the owner is CURRENTLY IN (their UI context) — the default binding for
 * a workspace-scoped question; a GLOBAL/coordination question is resolved through
 * the GCL gate instead (never a direct cross-brain query off this field).
 * `explicitActRequest` is true ONLY when the owner explicitly asked the copilot to
 * ACT on the answer (e.g. "and send that as a message") — that hands the derived
 * ProposedAction to the 7.9 approval path; the read path itself stays
 * side-effect-free regardless.
 */
export interface CopilotQuestion {
  readonly text: string;
  readonly channel: QaChannel;
  /** The owner's current workspace (default scope for a workspace-scoped question). */
  readonly askedWorkspaceId: WorkspaceId;
  /** True IFF the owner explicitly asked to ACT on the answer (→ 7.9 proposal). */
  readonly explicitActRequest?: boolean;
}

/**
 * The retrieved evidence a copilot answer is synthesized FROM. It is one of two
 * shapes, discriminated by `scope`, so the type SYSTEM forbids mixing a
 * workspace-scoped retrieval with a global one:
 *   • `workspace` — evidence from ONE bound workspace's own brain (SourceRefs into
 *     that workspace). No cross-workspace content is present.
 *   • `global` — SANITIZED {@link GclProjection}s that crossed the GCL Visibility
 *     Gate (WS-8). NO raw cross-workspace body is present — only the gate-validated,
 *     summary-only projections the global read is allowed to see.
 */
export type RetrievedEvidence =
  | {
      readonly scope: "workspace";
      readonly workspaceId: WorkspaceId;
      readonly sourceRefs: readonly SourceRef[];
    }
  | {
      readonly scope: "global";
      /** ONLY gate-validated sanitized projections (WS-8) — never raw bodies. */
      readonly projections: readonly GclProjection[];
    };

/**
 * The pipeline state carried between copilot-Q&A activities. A PLAIN, immutable
 * data record (no methods, no clock, no I/O). Each stage threads a NEW context with
 * the next field populated:
 *
 *   received          → { question }                     (owner question in)
 *   scope_classified  → + scope                          (workspace | global)
 *   retrieved         → + evidence                       (scoped OR gated evidence)
 *   answered          → + answer                          (VALIDATED, cited)
 *   proposed          → + proposal                        (only on an act-request)
 *
 * There is NO revisionId / envelope-receipt field: the read path NEVER commits and
 * NEVER applies an external write (Section 9.13). The only durable artifact it can
 * produce is a PROPOSAL routed to the 7.9 approval inbox — recorded here as
 * `proposalRef`, not as an applied write receipt.
 */
export interface CopilotQaContext {
  readonly question: CopilotQuestion;
  /** The resolved retrieval scope (present once classification ran). */
  readonly scope?: QaScope;
  /** The retrieved evidence (present once retrieval ran). */
  readonly evidence?: RetrievedEvidence;
  /** The VALIDATED, cited answer (present once synthesis cleared the gate). */
  readonly answer?: ValidatedAnswer;
  /** The 7.9 approval-inbox ref for a routed act-request proposal (present iff routed). */
  readonly proposalRef?: string;
}

// ---------------------------------------------------------------------------
// (2a) ClassifyScopePort — WS-8: workspace-scoped vs GLOBAL (GCL gate)
// ---------------------------------------------------------------------------

/**
 * The resolved retrieval scope of an owner question (WS-8 / REQ-F-005). A
 * `workspace` question is answered from ONE bound workspace's own brain; a `global`
 * question spans workspaces and MUST route through the GCL Visibility Gate — never
 * a direct cross-brain query. The bound workspace lives ONLY on the `workspace`
 * variant so the type SYSTEM forbids reading a workspaceId off a global scope
 * (there is no single workspace a global answer belongs to).
 */
export type QaScope =
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "global" };

/** Closed, enumerable classify failure set (§16 — never thrown). */
export interface ClassifyScopeError {
  /**
   * The question's scope could not be resolved (ambiguous between workspace and
   * global) — fail-closed: the driver parks in scope_undetermined and does NOT
   * guess a workspace (WS-8: never a wrong-brain read on a coin-flip).
   */
  readonly code: "scope_undetermined";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Classify an owner question as workspace-scoped or global (WS-8 / REQ-F-005). The
 * activity delegates to the intent classifier; an ambiguous question fails closed
 * (scope_undetermined) rather than defaulting to a workspace guess — a wrong-brain
 * read is an isolation breach. Never throws.
 */
export interface ClassifyScopePort {
  classify(
    question: CopilotQuestion,
  ): Promise<Result<QaScope, ClassifyScopeError>>;
}

// ---------------------------------------------------------------------------
// (2b) RetrieveWorkspacePort — workspace-scoped retrieval (one brain)
// ---------------------------------------------------------------------------

/** Closed, enumerable workspace-retrieval failure set (§16 — never thrown). */
export type RetrieveWorkspaceErrorCode =
  | "retrieval_failed" // the workspace brain read failed
  | "retrieval_denied"; // the read was refused (e.g. the bound workspace is not readable)

export interface RetrieveWorkspaceError {
  readonly code: RetrieveWorkspaceErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Retrieve evidence from ONE bound workspace's own brain (WS-8). The activity
 * queries ONLY the passed workspace's GBrain — never another workspace's brain,
 * never a cross-brain federation query. It returns a `workspace`-scoped
 * {@link RetrievedEvidence} (SourceRefs into that workspace). A failed/denied read
 * folds to a typed error the driver maps to retrieval_denied → 7.5. Never throws.
 */
export interface RetrieveWorkspacePort {
  retrieve(
    workspaceId: WorkspaceId,
    question: CopilotQuestion,
  ): Promise<Result<RetrievedEvidence, RetrieveWorkspaceError>>;
}

// ---------------------------------------------------------------------------
// (2c) RetrieveGlobalPort — GLOBAL question → the GCL Visibility Gate ONLY
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable global-retrieval failure set (§16 — never thrown):
 *   • `gate_denied`     — the GCL Visibility Gate REFUSED a candidate projection
 *     (raw content present / visibility exceeds source) — a leakage HARD reject
 *     (safety rule 4). It is refused, never downgraded-and-served.
 *   • `retrieval_failed` — the global read failed for another reason.
 */
export type RetrieveGlobalErrorCode = "gate_denied" | "retrieval_failed";

export interface RetrieveGlobalError {
  readonly code: RetrieveGlobalErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Retrieve global/coordination evidence through the GCL Visibility Gate (WS-8 /
 * REQ-F-005 / safety rule 4 — the SINGLE cross-workspace read path). The activity
 * gathers candidate cross-workspace context and admits each through the gate
 * (@sow/knowledge admitProjection); it NEVER issues a direct cross-brain GBrain
 * query and NEVER returns a raw workspace body — ONLY gate-validated, sanitized
 * {@link GclProjection}s ride the returned `global`-scoped evidence. A projection
 * that fails the gate is HARD-rejected (gate_denied), not downgraded. Never throws.
 */
export interface RetrieveGlobalPort {
  retrieve(
    question: CopilotQuestion,
  ): Promise<Result<RetrievedEvidence, RetrieveGlobalError>>;
}

// ---------------------------------------------------------------------------
// (2d) SynthesizeAnswerPort — schema-gated synthesis, returns CITATIONS
// ---------------------------------------------------------------------------

/**
 * One citation backing a synthesized answer (Section 9.13: synthesis RETURNS
 * CITATIONS). Each citation points back to a piece of the RETRIEVED evidence — a
 * SourceRef for a workspace answer, or a sanitized-projection ref for a global
 * answer — so the owner can trace every claim. `snippet` is an OPTIONAL short,
 * summary-only quote (never raw cross-workspace content on a global answer — that
 * was already stripped by the gate).
 */
export interface AnswerCitation {
  readonly sourceRef: SourceRef;
  readonly snippet?: string;
}

/**
 * The VALIDATED synthesized answer — the candidate that PASSED the schema gate AND
 * carries ≥1 citation. A distinct `readonly validated: true` brand so the driver
 * cannot return an un-validated / uncited answer: only a {@link SynthesizeAnswerPort}
 * can produce one. `citations` is guaranteed non-empty by the port (a cite-less
 * answer is a schema rejection).
 */
export interface ValidatedAnswer {
  readonly validated: true;
  readonly text: string;
  readonly citations: readonly AnswerCitation[];
}

/**
 * Closed, enumerable synthesis failure set (§16 — never thrown). Distinct codes so
 * each maps to a DISTINCT copilotQaMachine failure state + a distinct 7.5 health
 * item (inv-5, nothing silent):
 *   • `provider_failed`  — the provider/runtime failed (→ state provider_failed).
 *   • `budget_exceeded`  — COST-1 / REQ-S-007 budget cap breached — CANCEL with NO
 *     partial side effect (the read path never mutated anything).
 *   • `egress_vetoed`    — the egress veto fired (employer-work raw content, ack
 *     off, no local provider) → fail-closed, never a cloud fallback (safety rule 5).
 *   • `schema_rejected`  — the candidate answer failed the schema gate (malformed
 *     OR uncited — a cite-less answer is refused, Section 9.13).
 */
export type SynthesizeFailureCode =
  | "provider_failed"
  | "budget_exceeded"
  | "egress_vetoed"
  | "schema_rejected";

export interface SynthesizeFailure {
  readonly code: SynthesizeFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Synthesize the answer FROM the retrieved evidence, SCHEMA-GATED, returning
 * CITATIONS (Section 9.13). The activity runs a READ-ONLY-ToolPolicy AgentJob
 * through the @sow/providers Broker (which enforces ING-7 admission, the egress
 * veto, the budget cap, and the schema gate internally) over ONLY the passed
 * evidence — never a fresh cross-brain read. The candidate answer is validated
 * against the answer schema AND the ≥1-citation rule before a {@link ValidatedAnswer}
 * is returned. A budget breach is `budget_exceeded` (REQ-S-007 cancel). Never
 * throws.
 */
export interface SynthesizeAnswerPort {
  synthesize(
    evidence: RetrievedEvidence,
    question: CopilotQuestion,
  ): Promise<Result<ValidatedAnswer, SynthesizeFailure>>;
}

// ---------------------------------------------------------------------------
// (2e) BuildProposalPort — DERIVE a ProposedAction FROM the validated answer
// ---------------------------------------------------------------------------

/**
 * The derived act-request proposal: the §8 {@link ProposedAction} + its
 * {@link ExternalWriteEnvelope}, to be HANDED to the 7.9 approval path (never
 * applied inline). BOTH are DERIVED from the {@link ValidatedAnswer} — never
 * caller-supplied — so a no-inference bypass is impossible by construction and the
 * proposal is anchored to the same validated, cited answer the owner saw. The
 * envelope's canonicalObjectKey + idempotencyKey are computed in the ACTIVITY
 * (node:crypto), never in the pure driver.
 */
export interface QaProposalOutputs {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * Closed, enumerable proposal-derivation failure set (§16 — never thrown). Deriving
 * a proposal can only fail for a shape reason the driver folds to schema_rejected
 * (NO side effect — a read-path proposal never mutates anything):
 *   • `unmappable_answer` — the validated answer has no proposable action (fail-closed,
 *     never a guessed action).
 *   • `build_failed`      — the derivation failed for another reason.
 */
export type BuildProposalFailureCode = "unmappable_answer" | "build_failed";

export interface BuildProposalFailure {
  readonly code: BuildProposalFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * DERIVE the act-request proposal (a {@link ProposedAction} + envelope) FROM the
 * {@link ValidatedAnswer}. Called ONLY when the owner explicitly asked to act. The
 * action is DERIVED here (never caller-supplied), so the proposal cannot smuggle an
 * inferred / un-cited claim past the answer gate. The keys are computed in the
 * ACTIVITY (node:crypto). Never throws — a derivation failure is a typed
 * {@link BuildProposalFailure} the driver folds to schema_rejected.
 */
export interface BuildProposalPort {
  build(
    answer: ValidatedAnswer,
    question: CopilotQuestion,
  ): Promise<Result<QaProposalOutputs, BuildProposalFailure>>;
}

// ---------------------------------------------------------------------------
// (2f) QaRouteToApprovalPort — hand the act-request to the 7.9 approval inbox
// ---------------------------------------------------------------------------

/** Proof an act-request proposal was routed to the 7.9 Approval Inbox. */
export interface QaRouteToApprovalResult {
  /** The approval-inbox record ref the proposal was raised under (idempotent by envelope key). */
  readonly approvalRef: string;
  /** false when a pending record already existed (idempotent re-drive — no second card). */
  readonly created: boolean;
}

/** Closed, enumerable route-to-approval failure set (§16 — never thrown). */
export type QaRouteToApprovalErrorCode = "precondition_failed" | "route_failed";

export interface QaRouteToApprovalError {
  readonly code: QaRouteToApprovalErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Route the derived act-request PROPOSAL to the 7.9 Approval Inbox WITHOUT applying
 * it (Section 9.13). This RECORDS a pending approval card (idempotent on re-drive by
 * the envelope's idempotencyKey — no duplicate card) and hands off to the 7.9 flow;
 * the port NEVER performs the external write itself (fail-closed — the read path is
 * side-effect-free, the ONLY durable artifact is the pending card). Never throws.
 */
export interface QaRouteToApprovalPort {
  route(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<QaRouteToApprovalResult, QaRouteToApprovalError>>;
}

// ---------------------------------------------------------------------------
// (3) CopilotQaHealthSink — inv-5: the failure sink (reuses the 7.5 shape)
// ---------------------------------------------------------------------------

/**
 * A copilot-Q&A failure to surface. Structurally a subset of the 7.5
 * `WorkflowFailure` seam — the driver routes EVERY failure class through the sink so
 * nothing fails silently (inv-5 / §16).
 */
export interface CopilotQaFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface CopilotQaSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

/** Closed, enumerable health-sink failure set (§16 — never thrown). */
export interface CopilotQaHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink the driver routes every copilot-Q&A failure class through
 * (inv-5). In production this is backed by the 7.5 `surfaceWorkflowFailure`; the
 * driver depends only on this narrow port so it stays pure + injected-testable.
 * Never throws.
 */
export interface CopilotQaHealthSink {
  surface(
    failure: CopilotQaFailure,
  ): Promise<Result<CopilotQaSurfaceOutcome, CopilotQaHealthSinkError>>;
}
