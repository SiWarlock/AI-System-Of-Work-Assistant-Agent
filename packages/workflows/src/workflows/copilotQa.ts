// @sow/workflows — task 7.17: COPILOT Q&A (read path) — the PURE orchestration DRIVER.
//
// This is a sibling of the 7.6 meeting-closeout driver and the workflows-A drivers
// (dailyBrief / crossCalendarScheduling): the deterministic control driver that
// progresses an owner Q&A run THROUGH a local copilotQaMachine (no illegal edges;
// every transition guarded) over the INJECTED activity ports (src/ports/copilotQa.ts),
// the injected Clock, the 7.5 health sink, and the 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through the
// injected ports + Clock, so it is Vitest-unit-testable with no Temporal server and
// safe to wrap in a thin @temporalio workflow later (that wrapper + its SOW_TEMPORAL
// integration test are the worker-wiring wave's job — NOT this file). Any idempotency
// KEYS + the derived proposal live in ACTIVITIES (node:crypto lives there); the driver
// only RECEIVES the derived result.
//
// The local copilotQaMachine (defined here via the @sow/domain `defineMachine`
// primitive — @sow/domain does not ship a copilot-Q&A machine, so this workflow owns
// its state alphabet, matching how the daily-brief + scheduling drivers each define
// their own) is PURE + TOTAL: legal edges return ok(to), illegal edges return a typed
// err — the machine never throws.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every typed
// port rejection onto a distinct copilotQaMachine failure STATE and routes it through
// the health sink (inv-5: nothing fails silently). Never throws.
//
// 7.17 safety invariants this driver makes true (Section 9.13 / REQ-F-005 / REQ-S-007):
//   inv-1  WS-8 isolation: an owner question resolves to EITHER a workspace-scoped
//          retrieval (ONE bound brain) OR — for a GLOBAL question — the GCL Visibility
//          Gate (RetrieveGlobalPort). The driver NEVER calls the workspace-brain port
//          on a global question and NEVER issues a direct cross-brain query; an
//          ambiguous scope parks in scope_undetermined WITHOUT guessing a workspace.
//   inv-2  READ PATH = NO SIDE EFFECT: the driver NEVER commits Markdown and NEVER
//          applies an external write. It has no commit / dispatch port. The only durable
//          artifact it can produce is a PROPOSAL routed to the 7.9 approval inbox — and
//          ONLY when the owner explicitly asked to act.
//   inv-3  synthesis is SCHEMA-GATED and returns CITATIONS: the answer is candidate data
//          until the synthesize port's gate passes; a validated answer carries ≥1
//          citation (a cite-less answer is a schema_rejected failure inside the port).
//   inv-4  REQ-S-007 budget: a provider failure folds to provider_failed; a budget breach
//          CANCELS in budget_exceeded with NO partial side effect (the read path never
//          mutated anything, so there is nothing to roll back or leak).
//   inv-5  idempotent replay: resolveRun reuses a seen run; a re-drive from the start
//          re-answers with no side effect; EVERY failure class surfaces a distinct 7.5
//          health item.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import type {
  CopilotQaContext,
  ClassifyScopePort,
  RetrieveWorkspacePort,
  RetrieveGlobalPort,
  SynthesizeAnswerPort,
  BuildProposalPort,
  QaRouteToApprovalPort,
  CopilotQaHealthSink,
  CopilotQaFailure,
  RetrievedEvidence,
} from "../ports/copilotQa";

// --- the local copilot-Q&A state machine -----------------------------------

/** The full copilot-Q&A state alphabet. */
export const COPILOT_QA_STATES = [
  // happy path
  "received",
  "scope_classified",
  "retrieved",
  "answered",
  "proposed",
  // failure / park
  "scope_undetermined",
  "retrieval_denied",
  "provider_failed",
  "budget_exceeded",
  "schema_rejected",
  "route_failed",
  // terminal
  "done",
] as const;

export type CopilotQaState = (typeof COPILOT_QA_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Failure/park states each carry a
// pinned recovery back-edge (a non-terminal state needs ≥1 outgoing edge) so the
// machine is total; the driver only walks the happy edges + the pinned failure-entry
// edges.
const copilotQaTransitions: Readonly<Record<CopilotQaState, readonly CopilotQaState[]>> = {
  // received → classify scope, OR park (ambiguous, WS-8 fail-closed).
  received: ["scope_classified", "scope_undetermined"],
  // scope_classified → retrieval succeeded, OR a denied/gate-refused read.
  scope_classified: ["retrieved", "retrieval_denied"],
  // retrieved → a validated cited answer, OR a provider/budget/schema failure.
  retrieved: ["answered", "provider_failed", "budget_exceeded", "schema_rejected"],
  // answered → route an act-request proposal to 7.9, OR (no act-request) done, OR a
  // proposal-derivation failure (schema_rejected) / a route failure.
  answered: ["proposed", "done", "schema_rejected", "route_failed"],
  // proposed → done (the proposal was handed to 7.9 — the read path ends).
  proposed: ["done"],
  // park / recovery back-edges (non-terminal → ≥1 outgoing edge).
  scope_undetermined: ["received"],
  retrieval_denied: ["scope_classified"],
  provider_failed: ["retrieved"],
  budget_exceeded: ["retrieved"],
  schema_rejected: ["retrieved"],
  route_failed: ["answered"],
  // terminal
  done: [],
};

export const copilotQaMachine: StateMachine<CopilotQaState> =
  defineMachine<CopilotQaState>(copilotQaTransitions);

// --- driver input ----------------------------------------------------------

/**
 * The complete input to {@link runCopilotQa}. `run` is the trigger submission
 * (an owner_action) resolved idempotently through the 7.4 seam. `context` is the
 * initial pre-classification context (just the owner question).
 *
 * There is NO caller-supplied answer / proposal: the answer is SYNTHESIZED (schema-
 * gated) inside the pipeline and any act-request proposal is DERIVED from the
 * validated answer — never caller-supplied — so the read path cannot be steered into
 * emitting an un-cited claim or a smuggled action.
 */
export interface CopilotQaInput {
  readonly run: ResolveRunInput;
  readonly context: CopilotQaContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the copilot-Q&A activity ports, the 7.5 health sink,
 * the 7.4 WorkflowRun repository (resolveRun), and the injected Clock. Every
 * dependency is a narrow port so the driver stays pure and fully injected-testable
 * (no GBrain / GCL gate / broker / Tool Gateway / Temporal).
 *
 * ★ inv-2: there is DELIBERATELY no commit port and no external-write dispatch port
 * in this set — the read path cannot write Markdown and cannot apply an external
 * write. The strongest side effect available is `route` (hand a proposal to 7.9).
 */
export interface CopilotQaDeps {
  readonly classify: ClassifyScopePort;
  readonly retrieveWorkspace: RetrieveWorkspacePort;
  readonly retrieveGlobal: RetrieveGlobalPort;
  readonly synthesize: SynthesizeAnswerPort;
  readonly buildProposal: BuildProposalPort;
  readonly route: QaRouteToApprovalPort;
  readonly health: CopilotQaHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a copilot-Q&A drive. `state` is the machine state the pipeline
 * rested in (`answered` when the owner only asked, `proposed` when an act-request was
 * routed to 7.9, or a failure/park state). `context` is the final threaded context.
 * `run` is the resolveRun result; `runReused` mirrors its `reused` flag. `surfaced`
 * names the health failure routed on a failure/park branch (undefined on the happy
 * path). Never throws.
 */
export interface CopilotQaOutcome {
  readonly state: CopilotQaState;
  readonly context: CopilotQaContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: CopilotQaFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws); an
 * illegal edge stops the cursor at the last legal state rather than crashing, keeping
 * the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: CopilotQaState,
  through: readonly CopilotQaState[],
): CopilotQaState {
  let cursor = from;
  for (const to of through) {
    const step = copilotQaMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a copilot-Q&A failure state to a §16 FailureClass for the health sink. */
function failureClassFor(state: CopilotQaState): FailureClass {
  switch (state) {
    case "scope_undetermined":
      return "conflict_review";
    case "retrieval_denied":
      return "conflict_review";
    case "provider_failed":
      return "write_through_failed";
    case "budget_exceeded":
      return "budget_breach";
    case "schema_rejected":
      return "schema_rejection";
    case "route_failed":
      return "conflict_review";
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the copilot-Q&A read pipeline as a pure, replay-safe, SIDE-EFFECT-FREE driver.
 *
 * Order:
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run (inv-5).
 *   2. classify the question's scope (WS-8, inv-1). Ambiguous ⇒ scope_undetermined
 *      with NO workspace guess and NO retrieval.
 *   3. retrieve evidence: a `workspace` scope hits the ONE bound brain
 *      (RetrieveWorkspacePort); a `global` scope goes THROUGH the GCL Visibility Gate
 *      (RetrieveGlobalPort). A denial/gate-refusal folds to retrieval_denied.
 *   4. synthesize a SCHEMA-GATED, CITED answer over ONLY the retrieved evidence
 *      (inv-3). A provider failure ⇒ provider_failed; a budget breach ⇒
 *      budget_exceeded (REQ-S-007 cancel, no partial side effect); an egress veto ⇒
 *      provider_failed (fail-closed); an uncited/malformed answer ⇒ schema_rejected.
 *   5. if — and ONLY if — the owner explicitly asked to ACT: DERIVE a ProposedAction
 *      from the validated answer and ROUTE it to the 7.9 approval inbox as a PROPOSAL
 *      (inv-2 — never applied inline). A derivation failure ⇒ schema_rejected; a route
 *      failure ⇒ route_failed. Otherwise the read path ends at `answered`.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runCopilotQa(
  input: CopilotQaInput,
  deps: CopilotQaDeps,
): Promise<CopilotQaOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run —
  //    the whole read pipeline is safe to re-drive from the start (inv-5).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: CopilotQaState = "received";
  let context: CopilotQaContext = input.context;

  const surface = async (
    failState: CopilotQaState,
    message: string,
  ): Promise<CopilotQaOutcome> => {
    const failure: CopilotQaFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed).
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, surfaced: failure };
  };

  // 2. Classify the question's scope (WS-8 / inv-1). An ambiguous scope parks in
  //    scope_undetermined WITHOUT guessing a workspace and WITHOUT any retrieval — a
  //    wrong-brain read on a coin-flip would be an isolation breach.
  const classified = await deps.classify.classify(context.question);
  if (!isOk(classified)) {
    state = advance(state, ["scope_undetermined"]);
    return surface(state, `scope classification failed: ${classified.error.code}`);
  }
  const scope = classified.value;
  state = advance(state, ["scope_classified"]);
  context = { ...context, scope };

  // 3. Retrieve evidence via the SCOPE-APPROPRIATE path (inv-1). A workspace question
  //    reads ONLY the ONE bound brain; a global question rides the GCL Visibility Gate
  //    (never a direct cross-brain query). A denial / gate-refusal folds to
  //    retrieval_denied — no answer is synthesized over an unauthorized read.
  let evidence: RetrievedEvidence;
  if (scope.kind === "workspace") {
    const retrieved = await deps.retrieveWorkspace.retrieve(scope.workspaceId, context.question);
    if (!isOk(retrieved)) {
      state = advance(state, ["retrieval_denied"]);
      return surface(state, `workspace retrieval failed: ${retrieved.error.code}`);
    }
    evidence = retrieved.value;
  } else {
    const retrieved = await deps.retrieveGlobal.retrieve(context.question);
    if (!isOk(retrieved)) {
      state = advance(state, ["retrieval_denied"]);
      return surface(state, `global (GCL gate) retrieval failed: ${retrieved.error.code}`);
    }
    evidence = retrieved.value;
  }
  state = advance(state, ["retrieved"]);
  context = { ...context, evidence };

  // 4. Synthesize the SCHEMA-GATED, CITED answer over ONLY the retrieved evidence
  //    (inv-3). The synthesize port runs a read-only AgentJob through the broker
  //    (ING-7 admission, egress veto, budget cap, schema gate) and validates the ≥1-
  //    citation rule internally. A budget breach CANCELS with NO partial side effect
  //    (inv-4 / REQ-S-007) — the read path never mutated anything.
  const synthesized = await deps.synthesize.synthesize(evidence, context.question);
  if (!isOk(synthesized)) {
    const code = synthesized.error.code;
    if (code === "budget_exceeded") {
      state = advance(state, ["budget_exceeded"]);
      return surface(state, "synthesis cancelled: budget breach (no partial side effect)");
    }
    if (code === "schema_rejected") {
      state = advance(state, ["schema_rejected"]);
      return surface(state, "synthesized answer rejected: uncited or malformed");
    }
    // provider_failed OR egress_vetoed → provider_failed (fail-closed, never a cloud
    // fallback for an egress veto).
    state = advance(state, ["provider_failed"]);
    return surface(state, `answer synthesis rejected: ${code}`);
  }
  const answer = synthesized.value;
  state = advance(state, ["answered"]);
  context = { ...context, answer };

  // 5. No explicit act-request ⇒ the read path ends here (inv-2: no side effect at
  //    all — the answer is rendered back to the owner by the channel adapter, which
  //    is NOT a durable write).
  if (context.question.explicitActRequest !== true) {
    return { state, context, run: runResult, runReused };
  }

  // 5a. The owner explicitly asked to ACT. DERIVE a ProposedAction from the VALIDATED
  //     answer (never caller-supplied — inv-2/inv-3) and hand it to the 7.9 approval
  //     path as a PROPOSAL. A derivation failure folds to schema_rejected. NOTHING is
  //     applied inline here.
  const built = await deps.buildProposal.build(answer, context.question);
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `act-request proposal derivation failed: ${built.error.code}`);
  }

  // 5b. ROUTE the proposal to the 7.9 Approval Inbox (idempotent by the envelope key).
  //     The route port RECORDS a pending card and hands off to 7.9 — it NEVER performs
  //     the external write itself (inv-2, fail-closed). A route failure ⇒ route_failed
  //     (still no applied write).
  const routed = await deps.route.route(built.value.action, built.value.envelope);
  if (!isOk(routed)) {
    state = advance(state, ["route_failed"]);
    return surface(state, `act-request routing failed: ${routed.error.code}`);
  }
  state = advance(state, ["proposed"]);
  context = { ...context, proposalRef: routed.value.approvalRef };

  return { state, context, run: runResult, runReused };
}
