// @sow/workflows — task 13.14: /research-deep — the vault-first 5-phase governed
// research flow, the PURE orchestration DRIVER.
//
// A sibling of research.ts + the 7.6-template drivers: the deterministic control
// driver that progresses ONE deep-research run THROUGH a local
// researchDeepMachine (no illegal edges; every transition guarded) over the
// INJECTED activity ports (src/ports/researchDeep.ts), the shared 13.14 health
// sink (src/ports/research.ts), and the 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER
// @temporalio NOR node:crypto and calls NO Date.now()/Math.random(). All time +
// I/O arrive through the injected ports + Clock.
//
// ⛔ §ARM-RESEARCH: phases 2-4 are egress-classed RES-1 calls, owner-gated
// behind a paid key (13.13). This driver NEVER binds a real provider — every
// phase port is an INJECTED SEAM (unbound/dormant in production until arming;
// faked in tests). Phase 5's grounding (13.8a EntityResolver) + planning (13.8c
// planner) are BOTH `packages/knowledge` territory, reached ONLY through the
// injected `PropagateResearchPort` — this driver never re-derives a plan or a
// resolved path itself.
//
// 13.14 safety invariants this driver makes true (§7 RES-2, §6 KN-10):
//   inv-1  PHASE 1 IS ZERO-EGRESS: `deps.scan` runs even with employer-work
//          egress ack OFF — it is never gated by the broker veto (it never
//          calls a cloud provider at all).
//   inv-2  EGRESS VETO fail-closed on EVERY egress-classed phase (2-4, safety
//          rule 5): an `egress_vetoed` failure at ANY of those phases parks
//          immediately — NO later phase runs, NEVER a cloud fallback.
//   inv-3  CANDIDATE-DATA GATE (safety rule 2): the driver never writes
//          Markdown itself. Every candidate plan phase 5 emits is
//          entity-grounded + schema-derived by the injected port; this driver
//          only ROUTES it (AUTO commit vs PROPOSE approval vs surfaced
//          withhold) — it never assembles or fabricates a plan.
//   inv-4  ONE WRITER (safety rule 1): a grounded AUTO plan commits through the
//          EXISTING `CommitKnowledgePort` (KnowledgeWriter) — never a second
//          writer. A PROPOSE plan NEVER reaches commit (§6 KN-10 tier split,
//          mirroring sourceIngestion.ts's sibling-plan loop verbatim).
//   inv-5  NEVER FABRICATE A PATH (13.8a "ground before write", the governed
//          analog of osb's rule): a `withheld` phase-5 outcome (an ambiguous/
//          lossy entity resolution) is NEVER converted into a commit — it is
//          surfaced instead, and the run still reaches `done` (best-effort;
//          one unresolved entity does not fail the whole deep-research run).
//   inv-6  idempotent replay + nothing silent: resolveRun reuses a seen run;
//          EVERY failure class (port-level AND per-update) routes through the
//          health sink.
import { isOk } from "@sow/contracts";
import type { Result, WorkspaceId, WorkflowRunRef, FailureClass, AuditId, KnowledgeMutationPlan } from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { commitFailureClass, proposeApprovalSurfaceInfo } from "./sourceIngestion";
import type {
  CommitKnowledgePort,
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
  ResearchHealthSink,
  ResearchFailure,
} from "../ports/research";
import type {
  ScanVaultPort,
  AnalyzeGapsPort,
  FillGapsPort,
  SynthesizeDeltaPort,
  PropagateResearchPort,
} from "../ports/researchDeep";

// --- the local /research-deep state machine ----------------------------------

/** The full /research-deep state alphabet (one state per phase boundary). */
export const RESEARCH_DEEP_STATES = [
  // happy path — one state per completed phase
  "received",
  "scanned", // phase 1 done (zero-egress)
  "gaps_identified", // phase 2 done
  "gaps_filled", // phase 3 done
  "synthesized", // phase 4 done
  "propagated", // phase 5 done (best-effort — see inv-5)
  // failure / park
  "scan_failed",
  "gap_analysis_failed",
  "gap_fill_failed",
  "synthesis_failed",
  "propagation_failed",
  // terminal
  "done",
] as const;

export type ResearchDeepState = (typeof RESEARCH_DEEP_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Each failure/park state carries a
// pinned recovery back-edge (a non-terminal state needs ≥1 outgoing edge) so the
// machine is total; the driver only walks the happy edges + the pinned
// failure-entry edges. `propagation_failed` is the PORT-LEVEL failure only
// (the propagate() call itself erroring) — a per-update withhold is NOT a
// machine failure state (inv-5: best-effort, still reaches `propagated`→`done`).
const researchDeepTransitions: Readonly<Record<ResearchDeepState, readonly ResearchDeepState[]>> = {
  received: ["scanned", "scan_failed"],
  scanned: ["gaps_identified", "gap_analysis_failed"],
  gaps_identified: ["gaps_filled", "gap_fill_failed"],
  gaps_filled: ["synthesized", "synthesis_failed"],
  synthesized: ["propagated", "propagation_failed"],
  propagated: ["done"],
  // park / recovery back-edges (non-terminal → ≥1 outgoing edge).
  scan_failed: ["received"],
  gap_analysis_failed: ["scanned"],
  gap_fill_failed: ["gaps_identified"],
  synthesis_failed: ["gaps_filled"],
  propagation_failed: ["synthesized"],
  // terminal
  done: [],
};

export const researchDeepMachine: StateMachine<ResearchDeepState> =
  defineMachine<ResearchDeepState>(researchDeepTransitions);

// --- driver input ------------------------------------------------------------

/** The complete input to {@link runResearchDeep}. */
export interface ResearchDeepInput {
  readonly run: ResolveRunInput;
  readonly workspaceId: WorkspaceId;
  readonly topic: string;
}

// --- injected dependencies ----------------------------------------------------

/**
 * The injected dependency set — one port per phase, plus the reused `commit` /
 * `proposeKnowledgeApproval` ports (safety rule 1: never a second writer).
 * `proposeKnowledgeApproval` is OPTIONAL (unbound in production until 13.8i-B
 * wires it here) — mirroring sourceIngestion.ts's sibling-plan loop exactly: an
 * unbound port, a rejected mint, and a thrown propose are ALL the SAME safe
 * outcome (the plan stays withheld, NEVER downgraded to auto-commit).
 */
export interface ResearchDeepDeps {
  readonly scan: ScanVaultPort;
  readonly analyzeGaps: AnalyzeGapsPort;
  readonly fillGaps: FillGapsPort;
  readonly synthesizeDelta: SynthesizeDeltaPort;
  readonly propagate: PropagateResearchPort;
  readonly commit: CommitKnowledgePort;
  readonly proposeKnowledgeApproval?: ProposeKnowledgeApprovalPort;
  readonly health: ResearchHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome ------------------------------------------------------------

/**
 * The result of a /research-deep drive. `committed`/`queuedForApproval`/
 * `withheld` are the phase-5 per-update outcomes, keyed by `entityName` (never
 * a path — 13.8a governs grounding). Never throws.
 */
export interface ResearchDeepOutcome {
  readonly state: ResearchDeepState;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly committed: readonly string[];
  readonly queuedForApproval: readonly string[];
  readonly withheld: readonly string[];
  readonly surfaced?: ResearchFailure;
}

// --- machine-transition helper -------------------------------------------------

function advance(from: ResearchDeepState, through: readonly ResearchDeepState[]): ResearchDeepState {
  let cursor = from;
  for (const to of through) {
    const step = researchDeepMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-6: distinct health item per failure class) -----

/** Map an egress-classed phase (2-4) failure code to a §16 FailureClass — SAME set research.ts uses. */
function egressPhaseFailureClass(
  code: "provider_failed" | "budget_exceeded" | "egress_vetoed" | "schema_rejected",
): FailureClass {
  switch (code) {
    case "budget_exceeded":
      return "budget_breach";
    case "egress_vetoed":
      return "egress_denied";
    case "schema_rejected":
      return "schema_rejection";
    case "provider_failed":
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the /research-deep pipeline as a pure, replay-safe driver.
 *
 * Order:
 *   1. resolveRun (7.4 seam).
 *   2. PHASE 1 — SCAN the workspace-scoped GBrain baseline (zero-egress, inv-1).
 *   3. PHASE 2 — ANALYZE GAPS via ONE RES-1 call over the baseline (egress-
 *      classed, inv-2). Produces the gap queries phase 3 fills.
 *   4. PHASE 3 — FILL every gap query via RES-1 (egress-classed, inv-2).
 *   5. PHASE 4 — SYNTHESIZE a delta over the baseline + gap dossiers (egress-
 *      classed, inv-2).
 *   6. PHASE 5 — PROPAGATE: entity-ground + plan every recommended update
 *      (13.8a/13.8c, behind ONE injected port). For each per-update outcome:
 *        - `withheld` → surfaced, NEVER committed (inv-5). Best-effort:
 *          continues to the next update.
 *        - `grounded` with `requiresApproval !== false` → routed to §9.8
 *          approval via `proposeKnowledgeApproval` (inv-4's PROPOSE tier);
 *          NEVER falls through to commit regardless of the mint outcome.
 *        - `grounded` with `requiresApproval === false` → commits through the
 *          EXISTING `CommitKnowledgePort` (inv-4's AUTO tier). A per-plan
 *          commit failure is surfaced but does NOT fail the run (degrade-not-
 *          fail, mirroring sourceIngestion.ts's sibling-plan loop).
 *      A PORT-LEVEL `propagation_failed` (the propagate() call itself erroring,
 *      distinct from a per-update withhold) IS terminal.
 *
 * Every failure/park branch AND every per-update non-success routes through the
 * health sink (inv-6). Never throws.
 */
export async function runResearchDeep(
  input: ResearchDeepInput,
  deps: ResearchDeepDeps,
): Promise<ResearchDeepOutcome> {
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: ResearchDeepState = "received";
  const committed: string[] = [];
  const queuedForApproval: string[] = [];
  const withheld: string[] = [];

  const surface = async (
    failState: ResearchDeepState,
    failureClass: FailureClass,
    message: string,
  ): Promise<ResearchDeepOutcome> => {
    const failure: ResearchFailure = {
      failureClass,
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(failure);
    return { state: failState, run: runResult, runReused, committed, queuedForApproval, withheld, surfaced: failure };
  };

  // PHASE 1 — SCAN (zero-egress, inv-1). NEVER gated by the egress veto — it
  // never calls a cloud provider.
  const scanned = await deps.scan.scan(input.workspaceId, input.topic);
  if (!isOk(scanned)) {
    state = advance(state, ["scan_failed"]);
    return surface(state, "write_through_failed", `vault baseline scan failed: ${scanned.error.code}`);
  }
  const baseline = scanned.value;
  state = advance(state, ["scanned"]);

  // PHASE 2 — ANALYZE GAPS (egress-classed, inv-2). An egress veto fails
  // closed HERE — no fill/synthesize/propagate call is ever made.
  const gaps = await deps.analyzeGaps.analyze(baseline, input.topic);
  if (!isOk(gaps)) {
    state = advance(state, ["gap_analysis_failed"]);
    return surface(state, egressPhaseFailureClass(gaps.error.code), `gap analysis failed: ${gaps.error.code}`);
  }
  const gapQueries = gaps.value;
  state = advance(state, ["gaps_identified"]);

  // PHASE 3 — FILL GAPS (egress-classed, inv-2).
  const filled = await deps.fillGaps.fill(gapQueries);
  if (!isOk(filled)) {
    state = advance(state, ["gap_fill_failed"]);
    return surface(state, egressPhaseFailureClass(filled.error.code), `gap fill failed: ${filled.error.code}`);
  }
  const gapDossiers = filled.value;
  state = advance(state, ["gaps_filled"]);

  // PHASE 4 — SYNTHESIZE DELTA (egress-classed, inv-2).
  const synthesized = await deps.synthesizeDelta.synthesize(baseline, gapDossiers, input.topic);
  if (!isOk(synthesized)) {
    state = advance(state, ["synthesis_failed"]);
    return surface(
      state,
      egressPhaseFailureClass(synthesized.error.code),
      `synthesis delta failed: ${synthesized.error.code}`,
    );
  }
  const delta = synthesized.value;
  state = advance(state, ["synthesized"]);

  // PHASE 5 — PROPAGATE (13.8a/13.8c behind ONE port, inv-3). A PORT-LEVEL
  // failure is terminal; a PER-UPDATE outcome is best-effort (inv-5).
  const propagated = await deps.propagate.propagate(delta, input.workspaceId);
  if (!isOk(propagated)) {
    state = advance(state, ["propagation_failed"]);
    return surface(
      state,
      "write_through_failed",
      `propagation failed: ${propagated.error.code}`,
    );
  }
  state = advance(state, ["propagated"]);

  for (const outcome of propagated.value) {
    if (outcome.kind === "withheld") {
      // inv-5 — NEVER fabricate a commit for an unresolved entity. Surfaced,
      // never silent; the run continues (best-effort).
      withheld.push(outcome.entityName);
      await deps.health.surface({
        failureClass: "conflict_review",
        subjectRef: `${input.run.workflowId}:${outcome.entityName}`,
        message: `recommended update for "${outcome.entityName}" withheld (unresolved entity, never fabricated): ${outcome.reason}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
      continue;
    }

    const plan: KnowledgeMutationPlan = outcome.plan;
    if (plan.requiresApproval !== false) {
      // PROPOSE tier — routed to §9.8 approval, mirroring sourceIngestion.ts's
      // sibling-plan loop verbatim. NEVER falls through to commit regardless
      // of the mint outcome below.
      let proposed: Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError> | undefined;
      try {
        proposed =
          deps.proposeKnowledgeApproval === undefined
            ? undefined
            : await deps.proposeKnowledgeApproval.propose(plan, input.workspaceId);
      } catch {
        proposed = undefined;
      }
      if (proposed !== undefined && isOk(proposed)) {
        queuedForApproval.push(outcome.entityName);
      } else {
        const { reason, failureClass } = proposeApprovalSurfaceInfo(proposed);
        await deps.health.surface({
          failureClass,
          subjectRef: `${input.run.workflowId}:${outcome.entityName}`,
          message: `recommended update for "${outcome.entityName}" could not be queued for approval (withheld, never committed): ${reason}`,
          auditRef: input.run.workflowId as unknown as AuditId,
        });
      }
      continue;
    }

    // AUTO tier — commits through the EXISTING KnowledgeWriter port (inv-4).
    const result = await deps.commit.commit(plan);
    if (!isOk(result)) {
      // Best-effort (degrade-not-fail, mirroring sourceIngestion.ts step 7b):
      // one plan's rejection is surfaced and the run continues.
      await deps.health.surface({
        failureClass: commitFailureClass(result.error.code),
        subjectRef: `${input.run.workflowId}:${outcome.entityName}`,
        message: `recommended update for "${outcome.entityName}" commit failed: ${result.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
      continue;
    }
    committed.push(outcome.entityName);
  }

  state = advance(state, ["done"]);
  return { state, run: runResult, runReused, committed, queuedForApproval, withheld };
}
