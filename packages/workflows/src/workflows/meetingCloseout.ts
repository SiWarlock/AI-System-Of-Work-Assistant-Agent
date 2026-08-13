// @sow/workflows — task 7.6: MEETING CLOSEOUT — the PURE orchestration DRIVER.
//
// This is the "proof spine": the deterministic control driver that progresses a
// meeting-closeout run THROUGH the @sow/domain `meetingCloseoutMachine` (no illegal
// edges; every transition guarded) over the INJECTED activity ports
// (src/ports/meetingCloseout.ts), the injected Clock, the 7.5 health sink, and the
// 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through the
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and
// safe to wrap in a thin @temporalio workflow later (that wrapper + its SOW_TEMPORAL
// integration test are the worker-wiring wave's job — NOT this file). Per-step
// idempotency KEYS are computed in ACTIVITIES (node:crypto lives there). The
// committed outputs (KnowledgeMutationPlan + external-action proposals) are DERIVED
// inside the pipeline by the injected BuildOutputsPort FROM the validated extraction
// + the correlation-bound workspace — they are NOT caller-supplied — so an inferred
// owner/date can never reach the commit and the write always targets the bound
// workspace; the driver only RECEIVES that derived result and passes it downstream.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct meetingCloseoutMachine failure STATE and routes
// it through the health sink (inv-5: nothing fails silently). The returned outcome is a
// discriminated-union-friendly record whose `state` is the machine state the pipeline
// finally rested in.
//
// 7.6 safety invariants this driver makes true:
//   inv-1  low-confidence correlation → needs_routing_review; NEVER guesses a workspace;
//          the workspace is bound (from the high-confidence outcome) before any durable
//          write (REQ-F-002 / WS-2).
//   inv-2  the meeting.close job runs through the broker port under a read-only tool
//          policy on the untrusted transcript; an ING-7 admission rejection (mutating
//          tool declared) folds to provider_failed — the job never runs / never commits.
//   inv-3  a validator rejection (no-inference / schema / unsupported / ambiguous) →
//          schema_rejected with NO KnowledgeWriter commit and NO external write (no
//          partial commit).
//   inv-4  semantic output ONLY through the commit port (KnowledgeWriter); external
//          writes ONLY through the propose port (Tool Gateway); GBrain re-index runs
//          AFTER the Markdown commit, and a re-index failure never rolls the commit back.
//   inv-5  a mid-pipeline restart re-driven from the start produces NO duplicate commit
//          and NO duplicate external write (commit idempotent-replay by the plan's key;
//          Tool Gateway envelope reuse by the envelope's idempotencyKey), and EVERY
//          failure class surfaces a distinct 7.5 health item.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  ExternalWriteEnvelope,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import type { MeetingCloseoutState } from "@sow/domain";
import { meetingCloseoutMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import type {
  CorrelatePort,
  RunMeetingAgentJobPort,
  ValidateExtractionPort,
  BuildOutputsPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  ReindexGbrainPort,
  MeetingHealthSink,
  MeetingParkPort,
  MeetingCloseoutContext,
  MeetingWorkflowFailure,
} from "../ports/meetingCloseout";
// 13.8f-C — reuse 13.8i's propose-routing port DIRECTLY (its shape is generic over any
// KnowledgeMutationPlan + WorkspaceId): one propose sink, one mechanism, never a meeting-path analog.
import type {
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
} from "../ports/sourceIngestion";
// 13.8f-C — share the SAME KnowledgeCommitFailureCode → FailureClass taxonomy the source path uses for
// its own living-vault sibling-commit loop, rather than a second, independently-drifting copy (L119).
// 13.8i-B — same precedent for the propose-approval reason/failureClass mapping.
import { commitFailureClass, proposeApprovalSurfaceInfo } from "./sourceIngestion";

// NOTE: `MeetingExternalActionInput` now lives on the port seam
// (src/ports/meetingCloseout.ts) — it is part of the buildOutputs result — and is
// re-exported through the package barrel from there. The driver no longer declares
// or re-exports it (a second `export *` of the same name would be an ambiguous
// re-export).

// --- driver input ----------------------------------------------------------

/**
 * The complete input to {@link runMeetingCloseout}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam (resolveRun); `context` is the initial
 * pre-correlation context (a registered source, no bound workspace).
 *
 * The semantic outputs (the KnowledgeMutationPlan + external-action proposals) are
 * NO LONGER caller-supplied — they are DERIVED inside the governed pipeline by
 * {@link BuildOutputsPort} from the VALIDATED extraction + the correlation-bound
 * workspace, so an inferred owner/date can never reach the commit and the write
 * always targets the bound workspace (WS-2/WS-4). A caller cannot inject a plan
 * that bypasses the no-inference gate or redirects the durable write.
 */
export interface MeetingCloseoutInput {
  readonly run: ResolveRunInput;
  readonly context: MeetingCloseoutContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the six meeting-closeout activity ports, the 7.5 health
 * sink, the 7.4 WorkflowRun repository (for resolveRun's idempotency seam), and the
 * injected Clock. Every dependency is a narrow port so the driver stays pure and
 * fully injected-testable (no broker / KnowledgeWriter / Tool Gateway / Temporal).
 */
export interface MeetingCloseoutDeps {
  readonly correlate: CorrelatePort;
  readonly agent: RunMeetingAgentJobPort;
  readonly validate: ValidateExtractionPort;
  readonly buildOutputs: BuildOutputsPort;
  readonly commit: CommitKnowledgePort;
  readonly propose: ProposeActionsPort;
  readonly reindex: ReindexGbrainPort;
  readonly health: MeetingHealthSink;
  /** G5: durably PARK an un-routable (low-confidence) meeting into the Ingestion Inbox (workspace-UNBOUND). */
  readonly park: MeetingParkPort;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
  /**
   * 13.8f-C — OPTIONAL routing of a withheld PROPOSE-tier sibling entity-page plan into a PENDING §9.8
   * Approval, reusing 13.8i's EXISTING port + composition-root sink (never a second one). Subordinate to
   * `buildOutputs.siblingPlans` (only ever consulted when that's non-empty), mirroring `livingVault`'s
   * own optionality on the source path. UNBOUND ⇒ a withheld sibling's mint attempt degrades to a typed
   * failure (surfaced, never a silent drop, never a downgrade to auto-commit).
   */
  readonly proposeKnowledgeApproval?: ProposeKnowledgeApprovalPort;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a meeting-closeout drive. `state` is the machine state the pipeline
 * rested in (a happy terminal `summarized`, or a failure/park state). `context` is the
 * final threaded context (workspace stays undefined on a low-confidence park — inv-1).
 * `run` is the resolveRun result (an existing run on a replay, a fresh one otherwise);
 * `runReused` mirrors resolveRun's `reused` flag. `surfaced` names the health failure
 * routed on a failure/park branch (undefined on the happy path). Never throws.
 */
export interface MeetingCloseoutOutcome {
  readonly state: MeetingCloseoutState;
  readonly context: MeetingCloseoutContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: MeetingWorkflowFailure;
  /**
   * 13.8f-C — the ordered ids of the sibling entity-page (AUTO-tier) plans this run actually COMMITTED
   * (the one-action batch-undo unit) — NOT every plan the rewrite emitted, which would also include a
   * withheld PROPOSE plan's id even though nothing was written for it. Empty when the rewrite leg is
   * unbound or emitted nothing committable. Named identically to `SourceIngestionOutcome`'s own field so
   * both paths report the same shape.
   */
  readonly livingVaultPlanIds: readonly string[];
}

// --- machine-transition helper ---------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws); an
 * illegal edge returns a typed error. Since the driver only ever walks edges the
 * DOMAIN_MODEL pins (verified against the adjacency table), a rejection here is a
 * programming error, not a runtime condition — we surface it as the failure state
 * itself rather than crash, keeping the driver total. Returns the last legal state
 * reached (so a mis-pinned edge cannot silently "teleport" the cursor).
 */
function advance(
  from: MeetingCloseoutState,
  through: readonly MeetingCloseoutState[],
): MeetingCloseoutState {
  let cursor = from;
  for (const to of through) {
    const step = meetingCloseoutMachine.transition(cursor, to);
    if (!isOk(step)) {
      // Defensive: an unpinned edge stops the cursor at the last legal state. The
      // driver walks only DOMAIN_MODEL-pinned edges, so this is unreachable in
      // practice; keeping it total (no throw) honors §16.
      return cursor;
    }
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) -

/** Map a meeting-closeout failure state to a §16 FailureClass for the health sink. */
function failureClassFor(state: MeetingCloseoutState): FailureClass {
  switch (state) {
    case "needs_routing_review":
      return "conflict_review";
    case "provider_failed":
      return "write_through_failed";
    case "schema_rejected":
      return "schema_rejection";
    case "write_conflict":
      return "conflict_review";
    case "approval_pending":
      return "conflict_review";
    case "outbox_retry":
      return "write_through_failed";
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the meeting-closeout pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. correlate — HIGH binds the workspace before any durable write (inv-1); LOW or a
 *      correlator error parks in needs_routing_review with NO workspace guess + NO write.
 *   3. run the meeting.close AgentJob through the broker port (inv-2) — a rejection
 *      folds to provider_failed (no commit).
 *   4. validate the candidate (inv-3) — a rejection → schema_rejected, NO partial commit.
 *   4b. DERIVE the outputs (plan + external actions) from the validated extraction +
 *      the bound workspace (BuildOutputsPort) — a derivation failure → schema_rejected,
 *      NO partial commit. The plan is NEVER caller-supplied (no-inference + WS-2/WS-4).
 *   5. commit the DERIVED plan through KnowledgeWriter (inv-4) — a conflict →
 *      write_conflict; success mints a revision (idempotent replay reuses it).
 *   6. re-index GBrain AFTER the commit (inv-4) — a re-index failure surfaces but NEVER
 *      rolls the commit back.
 *   7. dispatch external actions through the Tool Gateway (inv-4/inv-5) — approval →
 *      approval_pending; hold → outbox_retry; success advances to external_actions_applied.
 *   8. summarize.
 *
 * Every failure/park branch routes through the health sink (inv-5) and returns the
 * resting machine state. Never throws.
 */
export async function runMeetingCloseout(
  input: MeetingCloseoutInput,
  deps: MeetingCloseoutDeps,
): Promise<MeetingCloseoutOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the existing
  //    run — the whole pipeline is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  // Machine cursor starts at the initial state.
  let state: MeetingCloseoutState = "detected";
  let context: MeetingCloseoutContext = input.context;

  // 13.8f-C — the ordered ids of sibling entity-page plans this run actually COMMITS (populated in the
  // sibling loop after step 5, below). A plain mutable array so `surface`'s closure (defined before that
  // loop runs) always reads whatever has been accumulated by the time any return fires — empty on every
  // branch that exits before the loop, which is exactly correct (nothing committed yet).
  const livingVaultPlanIds: string[] = [];

  const surface = async (
    failState: MeetingCloseoutState,
    message: string,
  ): Promise<MeetingCloseoutOutcome> => {
    const failure: MeetingWorkflowFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed); the sink's
    // own error is the 7.5 seam's concern, not a reason to lose the machine state.
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, surfaced: failure, livingVaultPlanIds };
  };

  // 2. Correlate (inv-1 / WS-2). A correlator error OR a low-confidence outcome parks
  //    in needs_routing_review with NO workspace guess and NO durable write.
  const correlated = await deps.correlate.correlate(context);
  if (!isOk(correlated)) {
    state = advance(state, ["correlated", "needs_routing_review"]);
    return surface(state, `correlation failed: ${correlated.error.code}`);
  }
  const outcome = correlated.value;
  if (outcome.confidence === "low") {
    // G5: inv-1 — NO workspace guess. Durably PARK the un-routable meeting into the Ingestion Inbox
    // (routing-target workspace stays UNBOUND — a human reroutes it via triage, 15.8). The park is
    // first-write-wins by the source identity, so a re-driven low-confidence meeting parks EXACTLY ONCE
    // (rule 3 / L36); the meeting idempotencyKey rides the parked row for a replay-safe re-enter (inv-D).
    state = advance(state, ["correlated", "needs_routing_review"]);
    const parked = await deps.park.park(context.source, input.run.workflowId);
    if (!isOk(parked)) {
      // FAIL-SAFE: the durable park FAILED — surface a DISTINCT `write_through_failed` health signal so an
      // operator sees the item did NOT durably reach the inbox; still resolve needs_routing_review (never a
      // false "parked", never a silent loss). §16: even a sink error never loses the machine state.
      const parkFailure: MeetingWorkflowFailure = {
        failureClass: "write_through_failed",
        subjectRef: input.run.workflowId,
        message: `low-confidence meeting park failed: ${parked.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      };
      await deps.health.surface(parkFailure);
      return { state, context, run: runResult, runReused, surfaced: parkFailure, livingVaultPlanIds };
    }
    // Parked to the Ingestion Inbox — the normal routing-review signal (nothing silent, inv-5).
    return surface(state, "correlation low-confidence — parked to the Ingestion Inbox");
  }
  // HIGH confidence: bind the workspace BEFORE any durable write (inv-1 / WS-2).
  // Capture the bound workspace in a local so the derived plan's workspace is
  // provably the correlation-bound one (not a caller-controlled value) — this is
  // the WS-2/WS-4 anchor buildOutputs stamps onto the plan.
  const boundWorkspaceId = outcome.workspaceId;
  state = advance(state, ["correlated"]);
  context = {
    ...context,
    workspaceId: boundWorkspaceId,
    correlation: outcome,
  };

  // context_loaded (transcript + bound-workspace context assembled for the job).
  state = advance(state, ["context_loaded"]);

  // 3. Run the meeting.close AgentJob through the broker port (inv-2). An ING-7
  //    admission rejection (mutating tool on the untrusted transcript), a provider
  //    failure, egress veto, or budget breach all fold to provider_failed — the job
  //    never produced a committable extraction, so NO commit happens.
  const extracted = await deps.agent.run(context);
  if (!isOk(extracted)) {
    state = advance(state, ["agent_extracted", "provider_failed"]);
    return surface(state, `meeting.close job rejected: ${extracted.error.code}`);
  }
  state = advance(state, ["agent_extracted"]);
  context = { ...context, extraction: extracted.value };

  // 4. Validate the candidate (inv-3). A no-inference / schema / unsupported /
  //    ambiguous-routing rejection HARD-STOPS the pipeline at schema_rejected with NO
  //    KnowledgeWriter commit and NO external write (no partial commit).
  const validated = deps.validate.validate(extracted.value);
  if (!isOk(validated)) {
    state = advance(state, ["validated", "schema_rejected"]);
    return surface(state, `extraction rejected: ${validated.error.code}`);
  }
  state = advance(state, ["validated"]);
  context = { ...context, validated: validated.value };

  // 4b. DERIVE the committed outputs FROM the validated extraction + the
  //     correlation-bound workspace (inv-3 governance seam). This is what closes
  //     the no-inference / workspace-isolation bypass: the plan + external actions
  //     are BUILT from validated, evidence-backed, non-inferred fields — never
  //     accepted from the caller — and `plan.workspaceId` is stamped from the bound
  //     `context.workspaceId`. An inferred owner/date was already rejected at
  //     validate, so it can NEVER reach the plan; a caller cannot redirect the write
  //     to another workspace. A derivation failure folds to schema_rejected with NO
  //     partial commit (buildOutputs runs BEFORE any durable write).
  const built = await deps.buildOutputs.build(validated.value, boundWorkspaceId);
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `output derivation failed: ${built.error.code}`);
  }
  const plan = built.value.plan;
  const actions = built.value.actions;

  // 4c. 13.8f-C — the meeting-vault rewrite (embedded in the buildOutputs ACTIVITY, unlike the source
  //     path where it runs directly in this workflow) may have THROWN and degraded to no link mutations
  //     / no sibling plans. That degrade is best-effort by design (the meeting note's own commit must
  //     never depend on it) but is never silent (inv-5): surface it here, before the main commit, then
  //     continue — mirroring this file's OWN reindex-failure convention (write_through_failed: a
  //     derived/secondary leg failed, the primary output stands).
  if (built.value.meetingVaultRewriteFault !== undefined) {
    await deps.health.surface({
      failureClass: "write_through_failed",
      subjectRef: input.run.workflowId,
      message: `meeting-vault rewrite degraded (meeting note stands): ${built.value.meetingVaultRewriteFault}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    });
  }

  // 5. Commit the DERIVED semantic output through KnowledgeWriter (inv-4: the SOLE
  //    Markdown writer). IDEMPOTENT by the plan's key (inv-5): a replay reuses the
  //    prior revision (no second write / audit). A compare-revision clash →
  //    write_conflict.
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) {
    state = advance(state, ["knowledge_committed", "write_conflict"]);
    return surface(state, `knowledge commit failed: ${committed.error.code}`);
  }
  state = advance(state, ["knowledge_committed"]);
  context = { ...context, revisionId: committed.value.revisionId };

  // 5b. 13.8f-C — commit the sibling entity-page (person/project) plans through the SAME
  //     KnowledgeWriter port, mirroring 13.8i's source-path loop (sourceIngestion.ts step 7b). Ordered
  //     AFTER the meeting note's own commit so a later fault here can never leave a sibling plan
  //     durably committed while the same build() call reports an error (the hazard 13.8f-B's own
  //     scoping ruled out putting this loop in the activity). Each plan is individually idempotent, so
  //     a re-drive replays.
  //
  //     ⛔ AUTO TIER ONLY. A sibling plan marked `requiresApproval !== false` belongs to the §9.8
  //     Approvals surface — committing it here would auto-apply exactly the class of edit the approval
  //     gate exists to hold. It is WITHHELD instead — NEVER falls through to commit regardless of what
  //     happens next. Strict `!== false`: an absent/unknown flag withholds (fail-closed).
  //
  //     Completing the tier split exactly as 13.8i does: a withheld plan is ROUTED into a PENDING §9.8
  //     Approval via the injected `proposeKnowledgeApproval` port (reusing the EXISTING
  //     copilotProposeKnowledgeSink minting — never a second sink). UNBOUND port, a rejected mint, OR a
  //     throw are ALL the same safe OUTCOME (the plan stays withheld and the fault is surfaced — never a
  //     downgrade to auto-commit), but 13.8i-B DISTINGUISHES them at the SURFACED failureClass — see
  //     sourceIngestion.ts step 7b's comment for the full write_through_blocked/write_through_failed
  //     rationale (identical here; the meeting and source paths share ONE port instance).
  let queuedForApproval = 0;
  for (const sibling of built.value.siblingPlans) {
    if (sibling.requiresApproval !== false) {
      let proposed: Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError> | undefined;
      try {
        proposed =
          deps.proposeKnowledgeApproval === undefined
            ? undefined
            : await deps.proposeKnowledgeApproval.propose(sibling, boundWorkspaceId);
      } catch {
        proposed = undefined;
      }
      if (proposed !== undefined && isOk(proposed)) {
        queuedForApproval += 1;
      } else {
        const { reason, failureClass } = proposeApprovalSurfaceInfo(proposed);
        await deps.health.surface({
          failureClass,
          // 24.58 — PER-PLAN identity. The health dedupe key is `failureClass|subjectRef` AND
          // doubles as the item's `id`, so a per-RUN subjectRef on a per-PLAN failure makes N
          // sibling plans collapse onto ONE item (last message wins, N-1 lost) — including N
          // failures of the SAME code. Run-anchored composite, NOT a bare planId: `newPlanId`
          // has no production binding yet, so a bare id would inherit whatever it is bound to
          // at arming. Mirrors sourceIngestion's own loop (the shared 13.8f-C shape).
          // ⛔ The three obligations this composite puts on `newPlanId`'s eventual binding —
          // injective-within-a-run, bounded length, derived from nothing content-bearing — are
          // stated in full at sourceIngestion.ts's matching site. NONE is enforced today.
          subjectRef: `${input.run.workflowId}:${String(sibling.planId)}`,
          message: `meeting sibling PROPOSE plan could not be queued for approval (withheld, never committed): ${reason}`,
          auditRef: input.run.workflowId as unknown as AuditId,
        });
      }
      continue; // NEVER falls through to commit, regardless of the mint outcome above
    }
    const extra = await deps.commit.commit(sibling);
    if (!isOk(extra)) {
      // BEST-EFFORT, matching the reindex-failure convention below: the meeting note's own revision is
      // already durable and a sibling plan is an enrichment of it, so a failure here is surfaced
      // (inv-5) and the closeout continues rather than failing a run whose primary output succeeded.
      await deps.health.surface({
        failureClass: commitFailureClass(extra.error.code),
        // 24.58 — PER-PLAN identity; see the propose branch above for the full reasoning.
        // Sharpest case here: `ownership_violation` and `workspace_path_violation` BOTH map
        // to `isolation_breach`, so two distinct breaches in one run previously produced the
        // identical key and the second silently upserted the first.
        subjectRef: `${input.run.workflowId}:${String(sibling.planId)}`,
        message: `meeting sibling commit failed (meeting note stands): ${extra.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
    } else {
      // The batch-undo unit reflects what was ACTUALLY COMMITTED, not what the producer merely
      // emitted (a withheld PROPOSE plan has no revision to undo — mirrors 13.8i's own ruling).
      livingVaultPlanIds.push(String(sibling.planId));
    }
  }
  if (queuedForApproval > 0) {
    await deps.health.surface({
      failureClass: "conflict_review",
      subjectRef: input.run.workflowId,
      message: `meeting closeout queued ${queuedForApproval} sibling plan(s) for §9.8 approval`,
      auditRef: input.run.workflowId as unknown as AuditId,
    });
  }

  // 6. Re-index GBrain AFTER the Markdown commit (inv-4): async + idempotent. A
  //    re-index failure surfaces a health item but NEVER rolls the commit back — the
  //    durable Markdown commit stands. We do not change the machine state on a reindex
  //    failure (the commit already landed); we only route the failure to health.
  const reindexed = await deps.reindex.reindex(committed.value.revisionId);
  if (!isOk(reindexed)) {
    const reindexFailure: MeetingWorkflowFailure = {
      // 24.58 CATEGORY 2 — ACCEPTED COLLAPSE, recorded rather than fixed (L82: not an
      // oversight). The DECISION is that run-level "the primary output stands, a derived leg
      // failed" degrades share a run-scoped identity — unlike the per-PLAN sibling-loop
      // failures above, which got per-plan identities.
      //
      // ⛔ THE COLLAPSE SET IS NOT CLOSED AND IS NOT ALL ARMING-GATED. Three sites emit
      // `write_through_failed` with this run's subjectRef:
      //   • the meeting-vault rewrite degrade earlier in this driver — ARMING-GATED (it needs
      //     `meetingVaultRewriteFault`, which only a rewrite that actually RAN can set);
      //   • THIS site (reindex);
      //   • the terminal `surface()` helper, via `failureClassFor("outbox_retry")`, reached in
      //     the external-action stage BELOW — ⚠ NOT GATED BY ANYTHING. A run that fails the
      //     reindex and then holds an external action collapses these two, and the OUTBOX
      //     message wins because it is surfaced LAST. (An earlier draft of this comment said
      //     "only this message survives" — that was wrong in exactly the direction a reader
      //     would trust; corrected via the 24.58 security review.)
      // ⇒ do NOT treat meeting-vault arming as the tripwire for this whole set; it is the
      //   tripwire for the FIRST bullet only.
      //
      // ⚠ `conflict_review` has its own pair on this driver (queued-for-approval vs
      // `failureClassFor("approval_pending")`), so this record is one instance, not the census.
      failureClass: "write_through_failed",
      subjectRef: input.run.workflowId,
      message: `gbrain re-index failed (commit stands): ${reindexed.error.code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(reindexFailure);
    // Fall through — the commit is durable, so the closeout continues.
  }

  // No external actions ⇒ summarize straight from knowledge_committed.
  if (actions.length === 0) {
    state = advance(state, ["summarized"]);
    return { state, context, run: runResult, runReused, livingVaultPlanIds };
  }

  // 7. External-action stage (inv-4/inv-5): every external write goes through the Tool
  //    Gateway propose port. Enter external_actions_pending, then dispatch each action.
  state = advance(state, ["external_actions_pending"]);
  const appliedEnvelopes: ExternalWriteEnvelope[] = [];
  for (const item of actions) {
    const proposed = await deps.propose.propose(item.action, item.envelope);
    if (!isOk(proposed)) {
      const code = proposed.error.code;
      if (code === "approval_pending") {
        // Fail-closed: the action needs approval — park, NO external write.
        state = advance(state, ["approval_pending"]);
        return surface(state, "external action requires approval");
      }
      // held / conflict / rejected → hold to the outbox for re-drive (non-terminal).
      state = advance(state, ["outbox_retry"]);
      return surface(state, `external action held: ${code}`);
    }
    appliedEnvelopes.push(proposed.value.envelope);
  }
  context = { ...context, envelopes: [...context.envelopes, ...appliedEnvelopes] };
  state = advance(state, ["external_actions_applied"]);

  // 8. Summarize (happy terminal).
  state = advance(state, ["summarized"]);
  return { state, context, run: runResult, runReused, livingVaultPlanIds };
}
