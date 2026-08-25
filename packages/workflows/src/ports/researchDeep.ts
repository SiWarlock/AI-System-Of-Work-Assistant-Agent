// @sow/workflows — task 13.14: /research-deep — the 5-phase vault-first governed
// research flow's port surface.
//
// (1) SCAN a workspace-scoped GBrain baseline (zero-egress) → (2) ANALYZE gaps
// via ONE RES-1 call, producing 3-5 web/x queries (egress-gated) → (3) FILL each
// gap query (egress-gated, RES-1) → (4) SYNTHESIZE a delta over the baseline +
// gap dossiers (egress-gated) → (5) PROPAGATE: each "Recommended Vault Update"
// is entity-grounded (13.8a EntityResolver) + planned (13.8c planner) — BOTH IN
// `packages/knowledge` (OUT of this package's territory) — behind ONE injected
// {@link PropagateResearchPort}. This driver's own job at phase 5 is ONLY tier
// routing: an AUTO-tier grounded plan commits through the EXISTING
// {@link CommitKnowledgePort}; a PROPOSE-tier plan routes to the EXISTING
// {@link ProposeKnowledgeApprovalPort} (sourceIngestion.ts's sibling-plan
// pattern, reused verbatim); a `withheld` (unresolved-entity) item is NEVER
// silently fabricated into a create — it is surfaced instead (13.8a's own
// "ground the path before writing" contract, enforced at this boundary).
//
// ⛔ §ARM-RESEARCH: every provider-shaped port below (`analyzeGaps`,
// `fillGaps`, `synthesizeDelta`) is dormant/unbound in production until the
// RES-1 provider (13.13) arms. This file NEVER binds a real provider.
import type { Result, WorkspaceId, KnowledgeMutationPlan } from "@sow/contracts";
import type { ResearchCitation, ResearchDossier, ResearchQueryFailure } from "./research";

export type { ResearchCitation, ResearchDossier, ResearchQueryFailure } from "./research";

// ---------------------------------------------------------------------------
// (1) ScanVaultPort — phase 1, zero-egress local/GBrain baseline
// ---------------------------------------------------------------------------

/** One existing note the zero-egress baseline scan surfaced. */
export interface VaultBaselineNote {
  readonly path: string;
  readonly summary: string;
}

/** The zero-egress vault baseline for a research topic — NO provider call, NO egress. */
export interface VaultBaseline {
  readonly notes: readonly VaultBaselineNote[];
}

export type ScanVaultFailureCode = "scan_failed";
export interface ScanVaultFailure {
  readonly code: ScanVaultFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Phase 1: scan the WORKSPACE-SCOPED (WS-8) GBrain baseline for a topic. Local/
 * zero-egress — NEVER calls a cloud provider (this phase runs even with
 * employer-work egress ack OFF). Never throws.
 */
export interface ScanVaultPort {
  scan(workspaceId: WorkspaceId, topic: string): Promise<Result<VaultBaseline, ScanVaultFailure>>;
}

// ---------------------------------------------------------------------------
// (2) AnalyzeGapsPort — phase 2, ONE RES-1 call → 3-5 gap queries
// ---------------------------------------------------------------------------

/** One gap query the analysis phase wants filled (phase 3). */
export interface GapQuery {
  readonly text: string;
}

/**
 * Closed, enumerable gap-analysis failure set (§16 — never thrown), the SAME
 * shape `ResearchQueryFailure` uses (an egress-classed RES-1 call): reused, not
 * redeclared.
 */
export type AnalyzeGapsFailureCode = ResearchQueryFailure["code"];
export interface AnalyzeGapsFailure {
  readonly code: AnalyzeGapsFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Phase 2: gap-analysis. ONE RES-1 call over the phase-1 baseline, producing
 * 3-5 web/x queries phase 3 fills. Egress-classed — a `budget_exceeded`/
 * `egress_vetoed`/`schema_rejected`/`provider_failed` folds to a distinct
 * driver failure state. Never throws.
 */
export interface AnalyzeGapsPort {
  analyze(
    baseline: VaultBaseline,
    topic: string,
  ): Promise<Result<readonly GapQuery[], AnalyzeGapsFailure>>;
}

// ---------------------------------------------------------------------------
// (3) FillGapsPort — phase 3, gap-fill (Perplexity web + Grok x)
// ---------------------------------------------------------------------------

/**
 * Phase 3: fill every phase-2 gap query via RES-1 (Perplexity web + Grok x
 * Live Search, per 13.13). Returns ONE dossier per query, in order. A single
 * query's failure fails the WHOLE phase (fail-closed — a partial gap-fill is
 * not silently treated as complete); the caller sees exactly which query
 * failed via the returned failure's `message`. Never throws.
 */
export interface FillGapsPort {
  fill(queries: readonly GapQuery[]): Promise<Result<readonly ResearchDossier[], ResearchQueryFailure>>;
}

// ---------------------------------------------------------------------------
// (4) SynthesizeDeltaPort — phase 4, synthesis delta over baseline + gap-fill
// ---------------------------------------------------------------------------

/**
 * ONE "Recommended Vault Update" the synthesis delta proposes. `entityName` is
 * SYNTHESIS-NAMED — a free-text label the model chose, NEVER a vault path (13.8a
 * governs grounding; this driver package NEVER treats `entityName` as a path).
 */
export interface RecommendedVaultUpdate {
  readonly entityName: string;
  readonly change: string;
  readonly citations: readonly ResearchCitation[];
}

/** The phase-4 synthesis output: a summary + the recommended updates phase 5 propagates. */
export interface SynthesisDelta {
  readonly summary: string;
  readonly recommendedUpdates: readonly RecommendedVaultUpdate[];
}

export type SynthesizeDeltaFailureCode = ResearchQueryFailure["code"];
export interface SynthesizeDeltaFailure {
  readonly code: SynthesizeDeltaFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Phase 4: synthesize a delta over the phase-1 baseline + the phase-3 gap
 * dossiers. Egress-classed (the SAME failure-code set as `AnalyzeGapsPort`/
 * `RunResearchQueryPort`). Never throws.
 */
export interface SynthesizeDeltaPort {
  synthesize(
    baseline: VaultBaseline,
    gapDossiers: readonly ResearchDossier[],
    topic: string,
  ): Promise<Result<SynthesisDelta, SynthesizeDeltaFailure>>;
}

// ---------------------------------------------------------------------------
// (5) PropagateResearchPort — phase 5, entity-grounded planning (13.8a/13.8c)
// ---------------------------------------------------------------------------

/**
 * The per-update outcome of grounding + planning ONE `RecommendedVaultUpdate`:
 *   • `grounded` — the entity resolved (or a stub was created, 13.8a) and the
 *     13.8c planner emitted a real `KnowledgeMutationPlan` targeting it. This
 *     driver routes it AUTO (commit) or PROPOSE (approval) by
 *     `plan.requiresApproval` — it NEVER re-derives the plan itself.
 *   • `withheld` — the entity resolution was ambiguous/lossy (13.8a's own
 *     "ground before write" contract) — NO plan exists for this update, and
 *     this driver MUST NEVER fabricate one. It is surfaced instead.
 */
export type PropagatedUpdateOutcome =
  | { readonly kind: "grounded"; readonly entityName: string; readonly plan: KnowledgeMutationPlan }
  | { readonly kind: "withheld"; readonly entityName: string; readonly reason: string };

export type PropagateResearchFailureCode = "propagation_failed";
export interface PropagateResearchFailure {
  readonly code: PropagateResearchFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Phase 5: PROPAGATE the synthesis delta's recommended updates into candidate
 * `KnowledgeMutationPlan`s, entity-grounded via 13.8a + planned via 13.8c — BOTH
 * implemented in `packages/knowledge` (out of this package's territory) BEHIND
 * this ONE port. Returns ONE outcome per recommended update, in order (never
 * drops an update silently — a per-update result is always present, `grounded`
 * or `withheld`). The port-LEVEL `propagation_failed` is reserved for the call
 * itself erroring (not a per-update grounding refusal, which is `withheld`).
 * Never throws.
 */
export interface PropagateResearchPort {
  propagate(
    delta: SynthesisDelta,
    workspaceId: WorkspaceId,
  ): Promise<Result<readonly PropagatedUpdateOutcome[], PropagateResearchFailure>>;
}
