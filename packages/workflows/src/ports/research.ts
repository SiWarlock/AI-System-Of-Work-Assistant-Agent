// @sow/workflows — task 13.14: /research + /research-deep GOVERNED FLOWS — the
// shared port surface. This file carries the types + ports common to BOTH the
// simple /research flow (workflows/research.ts) and the 5-phase /research-deep
// flow (workflows/researchDeep.ts): the RES-1 query seam, its candidate dossier
// shape, and the health-sink pair every driver in this package reuses.
//
// ⛔ §ARM-RESEARCH (owner-gated, paid key): the RES-1 research provider (13.13,
// packages/providers/src/model-provider/research-provider.ts) is a REAL cloud-
// egress ModelProviderPort, dormant behind an unbound seam. This file and every
// driver built against it NEVER bind a real provider or a real transport — every
// port below is an INJECTED SEAM the worker composition root binds (production:
// the real provider behind its own broker egress veto + schema gate; tests: a
// faked transport). Building this governed FLOW MACHINERY discharges NOTHING
// about §ARM-RESEARCH — the provider-binding crossing itself stays owner-gated.
//
// Candidate-data gate (safety rule 2): a RunResearchQueryPort implementation is
// expected to run the REAL RES-1 provider's broker egress-veto + schema gate
// BEFORE returning — mirroring copilotQa.ts's SynthesizeAnswerPort exactly (same
// failure-code set: provider_failed / budget_exceeded / egress_vetoed /
// schema_rejected) — so by the time a driver in this package sees a
// ResearchDossier, it is already validated candidate data with ≥1 citation. No
// driver here EVER writes Markdown itself: every note lands through the EXISTING
// {@link CommitKnowledgePort} (KnowledgeWriter, safety rule 1 — no second writer),
// imported below, never re-declared (contracts L119, the `commitFailureClass`/
// `proposeApprovalSurfaceInfo` precedent this file follows).
import type {
  Result,
  WorkspaceId,
  AuditId,
  FailureClass,
  KnowledgeMutationPlan,
} from "@sow/contracts";

export type {
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
} from "./meetingCloseout";
export type {
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalError,
  ProposeKnowledgeApprovalErrorCode,
  ProposeKnowledgeApprovalResult,
} from "./sourceIngestion";

// ---------------------------------------------------------------------------
// (1) RunResearchQueryPort — ONE RES-1 dossier, candidate-gated
// ---------------------------------------------------------------------------

/** One RES-1 query: a workspace-scoped free-text research question/topic. */
export interface ResearchQuery {
  readonly workspaceId: WorkspaceId;
  readonly text: string;
}

/**
 * One citation backing a research dossier — an EXTERNAL web/x source (never a
 * vault SourceRef; RES-1 reads the open web, not the vault). `url` is required;
 * `title`/`snippet` are optional verbatim excerpts (13.13: "citations preserved
 * verbatim" — a driver in this package NEVER rewrites or summarizes a citation,
 * only neutralizes it for the region-marker forgery defense before it lands in
 * Markdown, same as any other model-derived string).
 */
export interface ResearchCitation {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
}

/**
 * A validated RES-1 dossier — candidate data that has ALREADY passed the port's
 * internal schema gate (REQ-S-006: no side effect before validation). `validated:
 * true` is a type-level tripwire mirroring copilotQa's `ValidatedAnswer` — a
 * driver cannot construct one itself, only receive it from
 * {@link RunResearchQueryPort}. `citations` is guaranteed non-empty by the port
 * (a citation-less dossier is a schema rejection, mirroring the ≥1-citation rule
 * Section 9.13 already established for copilot answers).
 */
export interface ResearchDossier {
  readonly validated: true;
  readonly query: string;
  readonly summary: string;
  readonly citations: readonly ResearchCitation[];
}

/**
 * Closed, enumerable RES-1 query failure set (§16 — never thrown), the SAME
 * shape copilotQa.ts's `SynthesizeFailureCode` already established for a
 * schema-gated, egress-classed, budget-capped provider call:
 *   • `provider_failed`  — the provider/runtime failed.
 *   • `budget_exceeded`  — COST-1/REQ-S-007 budget cap breached — CANCEL with NO
 *     partial side effect.
 *   • `egress_vetoed`    — the broker egress veto fired (employer-work raw
 *     content, ack off, no local provider) → fail-closed, NEVER a cloud fallback
 *     (safety rule 5).
 *   • `schema_rejected`  — the candidate dossier failed the schema gate
 *     (malformed OR citation-less).
 */
export type ResearchQueryFailureCode =
  | "provider_failed"
  | "budget_exceeded"
  | "egress_vetoed"
  | "schema_rejected";

export interface ResearchQueryFailure {
  readonly code: ResearchQueryFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run ONE RES-1 research query, candidate-gated. In production this is backed by
 * the 13.13 broker-veto-gated provider (or the free key-less aggregator); tests
 * inject a fake. NEVER throws.
 */
export interface RunResearchQueryPort {
  run(query: ResearchQuery): Promise<Result<ResearchDossier, ResearchQueryFailure>>;
}

// ---------------------------------------------------------------------------
// (2) BuildResearchNotePlanPort — DERIVE the /research KMP FROM the dossier
// ---------------------------------------------------------------------------

/** Closed, enumerable plan-derivation failure set (§16 — never thrown). */
export type BuildResearchNoteFailureCode = "path_escape";

export interface BuildResearchNoteFailure {
  readonly code: BuildResearchNoteFailureCode;
  readonly message: string;
}

/**
 * DERIVE a single-note {@link KnowledgeMutationPlan} FROM a validated
 * {@link ResearchDossier} — the ACTIVITY, not workflow code (may use node:crypto
 * via `@sow/domain`'s key builders, mirroring `buildBriefOutputs.ts`). The plan's
 * `workspaceId` is stamped from the PASSED (bound) workspace, never a
 * caller/model-controlled field (WS-2/WS-4). `path_escape` folds a
 * `researchNotePath` null (an unsafe workspace segment or an empty-after-slug
 * query) to a typed failure — NO commit happens before this step (no-partial-
 * commit, inv-4).
 */
export interface BuildResearchNotePlanPort {
  build(
    dossier: ResearchDossier,
    workspaceId: WorkspaceId,
  ): Promise<Result<KnowledgeMutationPlan, BuildResearchNoteFailure>>;
}

// ---------------------------------------------------------------------------
// (3) The shared research health sink (13.14) — reused by BOTH drivers
// ---------------------------------------------------------------------------

/** A research-flow failure item, the SAME shape every driver in this package surfaces. */
export interface ResearchFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}

/** What surfacing did — proof the failure was routed somewhere (inv-5). */
export interface ResearchSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}

export interface ResearchHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The failure sink BOTH /research and /research-deep route every failure class
 * through (inv-5, and the SAME reuse discipline `commitFailureClass`/
 * `proposeApprovalSurfaceInfo` already established for this package — one port
 * shape, not two independently-drifting copies). Never throws.
 */
export interface ResearchHealthSink {
  surface(failure: ResearchFailure): Promise<Result<ResearchSurfaceOutcome, ResearchHealthSinkError>>;
}
