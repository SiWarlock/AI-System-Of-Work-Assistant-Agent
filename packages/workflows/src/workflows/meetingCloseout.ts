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
  MeetingCloseoutContext,
  MeetingWorkflowFailure,
} from "../ports/meetingCloseout";

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
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
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
    return { state: failState, context, run: runResult, runReused, surfaced: failure };
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
    // Parked in the Ingestion Inbox — workspace stays UNBOUND (inv-1).
    state = advance(state, ["correlated", "needs_routing_review"]);
    return surface(state, "correlation low-confidence — routed to Ingestion Inbox");
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

  // 6. Re-index GBrain AFTER the Markdown commit (inv-4): async + idempotent. A
  //    re-index failure surfaces a health item but NEVER rolls the commit back — the
  //    durable Markdown commit stands. We do not change the machine state on a reindex
  //    failure (the commit already landed); we only route the failure to health.
  const reindexed = await deps.reindex.reindex(committed.value.revisionId);
  if (!isOk(reindexed)) {
    const reindexFailure: MeetingWorkflowFailure = {
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
    return { state, context, run: runResult, runReused };
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
  return { state, context, run: runResult, runReused };
}
