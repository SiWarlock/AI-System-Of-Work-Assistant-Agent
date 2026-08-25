// 13.8e / 26.2 — the SCHEDULED living-vault synthesis activity: the Temporal-scheduled analog of
// osb's /obsidian-synthesize (cross-source patterns, entity convergence, orphan rescue → missing
// links), over the EXISTING `packages/knowledge/src/synthesis` planner (`planSynthesis` — SENSE→
// REASON→EFFECT). VERIFIED (positive control): `dispatchMeetingCloseout` (a real production
// consumer, for contrast) returns hits at `apps/worker/src/temporal/dispatchMeetingCloseout.ts:57`;
// `livingVaultSynthesis`/`LivingVaultSynthesis` returned ZERO hits repo-wide before this module —
// the plan's "register the dormant activity" premise was FALSE (there was nothing to register).
// This file BUILDS it.
//
// dormancy-waiver(13.8e/26.2): this activity is a pure function over injected deps — arming is
// registering it into the §19.12 scheduled bundle behind a default-OFF strict-`=== true` flag
// (`temporal/` territory — PKG-W1's boot/registration hand-off, per the §ARM-RESEARCH step 5 gate)
// AND, separately, the schedule flip itself (§19.13, OWNER-GATED). Neither happens here or anywhere
// in this file: no boot wiring, no Temporal registration, no schedule cadence is set by this module.
//
// TIERED AUTONOMY (§6 KN-10, OWNER DECISION 2026-07-04): additive/derived plans
// (`requiresApproval:false`, from `planSynthesis`'s own tiering) AUTO-apply through the SAME shared
// `CommitKnowledgePort` the meeting/source/project paths already use (never a second commit site —
// contracts L39/L61); a human-relevant claim edit (`requiresApproval:true`) is WITHHELD and routed
// to a PENDING §9.8 Approval through `ProposeKnowledgeApprovalPort` (the SAME port `living-vault.ts`
// already binds for the source path — 13.8i) — NEVER auto-committed. `planSynthesis` itself decides
// the tier; this activity only ROUTES on it, exactly mirroring the source-path sibling-commit loop's
// `requiresApproval !== false` split (13.8f-C's own precedent, IMPLEMENTATION_PLAN.md #### 13.8f).
//
// LIFE-2 (§9 schedule/catch-up): every tick runs the EXACT read→decide→(run)→advance sequence every
// real scheduled driver in this codebase follows (`retentionPrune.ts`, `dailyBrief.ts`,
// `connectorSyncHealth.ts`, `periodReview.ts`) — `deps.schedule.getBookkeeping` →
// `collapsedNextRunFromClock` (the REAL @sow/workflows function, never a hand-rolled stand-in) →
// (run) → `deps.schedule.put(advanceBookkeeping(...))`. Bookkeeping advances ONLY on a successful
// run (mirrors `retentionPrune.ts`'s own every-failure-branch-returns-before-the-put discipline) —
// a synthesis fault is safe to retry within the same catch-up window rather than being silently
// skipped over.
//
// PROVENANCE: `planSynthesis` is called with `provenanceOrigin: "gbrain_proposal"` — the closed
// `@sow/contracts` `ProvenanceOrigin` member for a plan the SYSTEM proposed from its own accumulated
// knowledge (never a specific new external source, which is exactly what a scheduled full-vault pass
// is). `sourceRefs` (REQ-F-006: ≥1 non-empty) is derived from the schedule run itself
// (`schedule:<scheduleId>:<clock-reading>`) — a periodic pass has no external triggering source, so
// the run's OWN identity is its evidentiary basis, the same way `dispatchSourceIngestion`/
// `dispatchMeetingCloseout` derive identity from run metadata rather than accepting arbitrary
// caller input.
//
// §16: never throws. A `planSynthesis` rejection (typed `err`) or an unexpected throw both fold to
// a typed `synthesis_failed` outcome; a per-plan commit/propose fault is recorded in the outcome's
// counts (never silently dropped) without aborting the remaining plans in the same run.
import { isOk } from "@sow/contracts";
import type { WorkspaceId, KnowledgeMutationPlan } from "@sow/contracts";
import { planSynthesis } from "@sow/knowledge";
import type { EntityGbrainReadPort, EntityCandidate } from "@sow/knowledge";
import type { SynthesisReasonPort, SynthesisSectionPort } from "@sow/knowledge";
import type {
  CommitKnowledgePort,
  ProposeKnowledgeApprovalPort,
} from "@sow/workflows";
import type { ScheduleStore, Clock } from "@sow/workflows/ports/operational";
import { collapsedNextRunFromClock } from "@sow/workflows/runtime/catchUpWindow";
import { advanceBookkeeping } from "@sow/workflows/runtime/clock";

export interface LivingVaultSynthesisDeps {
  readonly workspaceId: WorkspaceId;
  /** The durable LIFE-2 bookkeeping key for this pass (one per workspace/pass, caller-assigned). */
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  /** 13.8e/26.2 — the REAL, injected LIFE-2 schedule port. NEVER a hand-rolled stand-in: the
   *  catch-up DECISION runs through the real `collapsedNextRunFromClock`, this store only supplies
   *  the durable bookkeeping row it reads/writes. */
  readonly schedule: ScheduleStore;
  readonly clock: Clock;
  // SENSE→REASON ports (planSynthesis's own SynthesisDeps) — the REASON port is a real model call
  // bound by the caller (provider territory, not this composition module's — mirrors
  // buildIngestRewriteDeps's ARM-RESEARCH-3 gbrain/reason posture).
  readonly gbrain: EntityGbrainReadPort;
  readonly reason: SynthesisReasonPort;
  readonly sections: SynthesisSectionPort;
  readonly newPlanId: () => string;
  readonly linkCandidates?: readonly EntityCandidate[];
  readonly confidence?: number;
  /** AUTO tier (§6 KN-10) — the SAME shared KnowledgeWriter commit port every other pipeline binds. */
  readonly commit: CommitKnowledgePort;
  /** PROPOSE tier (§9.8 Approvals) — the SAME port living-vault.ts's source path already binds (13.8i). */
  readonly propose: ProposeKnowledgeApprovalPort;
}

export type LivingVaultSynthesisOutcome =
  | { readonly kind: "no_run_due" }
  | {
      readonly kind: "ran";
      /** True iff this run collapsed >1 missed occurrence (LIFE-2). */
      readonly collapsed: boolean;
      readonly autoApplied: number;
      readonly autoFailed: number;
      readonly proposed: number;
      readonly proposeFailed: number;
      readonly planIds: readonly string[];
    }
  | { readonly kind: "synthesis_failed"; readonly message: string };

/** The provenance origin for a scheduled full-vault pass — see the module header. */
const SYNTHESIS_PROVENANCE_ORIGIN = "gbrain_proposal" as const;

/**
 * Route ONE plan by its OWN `requiresApproval` tier (`planSynthesis` decides the tier; this
 * function only routes on it) — AUTO commits through `deps.commit`, PROPOSE routes through
 * `deps.propose`. A commit/propose fault is counted, never thrown, never blocks the remaining plans.
 */
async function applyPlan(
  plan: KnowledgeMutationPlan,
  deps: Pick<LivingVaultSynthesisDeps, "commit" | "propose" | "workspaceId">,
): Promise<"auto_applied" | "auto_failed" | "proposed" | "propose_failed"> {
  if (plan.requiresApproval === false) {
    try {
      const committed = await deps.commit.commit(plan);
      return isOk(committed) ? "auto_applied" : "auto_failed";
    } catch {
      return "auto_failed";
    }
  }
  // Every OTHER tier value (true, or anything else) is treated as PROPOSE — fail-closed: an
  // absent/malformed flag is NEVER treated as auto-committable (mirrors 13.8f-C's own
  // `requiresApproval !== false` split precedent).
  try {
    const proposed = await deps.propose.propose(plan, deps.workspaceId);
    return isOk(proposed) ? "proposed" : "propose_failed";
  } catch {
    return "propose_failed";
  }
}

/**
 * Build the scheduled living-vault synthesis activity. Each call is ONE tick: LIFE-2 catch-up
 * decide → (on a due tick) `planSynthesis` → route every plan by tier → advance bookkeeping ONLY on
 * a successful run. Never throws (§16); dormant until a caller wires + registers + arms it (this
 * module does neither).
 */
export function createLivingVaultSynthesisActivity(
  deps: LivingVaultSynthesisDeps,
): () => Promise<LivingVaultSynthesisOutcome> {
  return async (): Promise<LivingVaultSynthesisOutcome> => {
    try {
      // 1. LIFE-2 catch-up: collapse missed occurrences to a SINGLE run. A first-ever run (no
      //    bookkeeping) skips catch-up and proceeds — the same convention every real scheduled
      //    driver in this codebase follows (retentionPrune.ts step 2, mirrored verbatim).
      let collapsed = false;
      const bookkeeping = await deps.schedule.getBookkeeping(deps.scheduleId);
      if (bookkeeping !== undefined) {
        const catchUp = collapsedNextRunFromClock(bookkeeping, deps.clock, {
          intervalMs: deps.intervalMs,
          catchUpWindowMs: deps.catchUpWindowMs,
        });
        if (catchUp.nextRun === null) {
          return { kind: "no_run_due" };
        }
        collapsed = catchUp.collapsed;
      }

      // 2. SENSE→REASON→EFFECT over the existing planner. The schedule run itself is the
      //    evidentiary basis (REQ-F-006) — see the module header.
      const runSourceId = `schedule:${deps.scheduleId}:${deps.clock.now()}`;
      const outcome = await planSynthesis(
        {
          workspaceId: deps.workspaceId,
          provenanceOrigin: SYNTHESIS_PROVENANCE_ORIGIN,
          sourceRefs: [{ sourceId: runSourceId }],
          ...(deps.confidence !== undefined ? { confidence: deps.confidence } : {}),
          ...(deps.linkCandidates !== undefined ? { linkCandidates: deps.linkCandidates } : {}),
        },
        {
          gbrain: deps.gbrain,
          reason: deps.reason,
          sections: deps.sections,
          newPlanId: deps.newPlanId,
        },
      );
      if (!isOk(outcome)) {
        // A synthesis fault: bookkeeping is NOT advanced (see the module header) — safe to retry
        // within the same catch-up window rather than being silently skipped over.
        return { kind: "synthesis_failed", message: `planSynthesis rejected: ${outcome.error.code}` };
      }

      // 3. Route every plan by its OWN tier — AUTO applies, PROPOSE routes to Approvals.
      let autoApplied = 0;
      let autoFailed = 0;
      let proposed = 0;
      let proposeFailed = 0;
      const planIds: string[] = [];
      for (const plan of outcome.value.plans) {
        planIds.push(plan.planId);
        const applied = await applyPlan(plan, deps);
        if (applied === "auto_applied") autoApplied += 1;
        else if (applied === "auto_failed") autoFailed += 1;
        else if (applied === "proposed") proposed += 1;
        else proposeFailed += 1;
      }

      // 4. Advance the durable schedule bookkeeping ONLY on a successful run.
      await deps.schedule.put(advanceBookkeeping(deps.scheduleId, deps.clock));

      return { kind: "ran", collapsed, autoApplied, autoFailed, proposed, proposeFailed, planIds };
    } catch (cause) {
      // TOTAL never-throws (§16): a rogue synchronous/asynchronous fault anywhere in the tick
      // (including a throwing planSynthesis) folds to the same typed failure — bookkeeping is NOT
      // advanced (fail-safe: retry next tick).
      const message = cause instanceof Error ? cause.message : "living-vault synthesis tick failed";
      return { kind: "synthesis_failed", message };
    }
  };
}
