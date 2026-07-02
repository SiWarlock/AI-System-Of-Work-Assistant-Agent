// @sow/workflows — task 7.18: HERMES AUTONOMOUS AUTOMATION (Gateway-Routing) —
// PURE orchestration DRIVER.
//
// A sibling of the 7.6 meeting-closeout / 7.7 source-ingestion drivers: same two-
// layer structure (pure driver + injected activity ports), same foundation ports
// (Clock, the WorkflowRun repo, the 7.5 health sink), same idempotency seam
// (resolveRun). It progresses a Hermes-initiated automation run THROUGH a
// workflows-local `hermesAutomationMachine` (defined via the @sow/domain
// `defineMachine` primitive — @sow/domain ships no Hermes machine, matching how the
// workflows-A siblings own their state alphabet) over INJECTED activity ports, an
// injected Clock, and the 7.5 health sink.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through injected ports + Clock; per-step idempotency KEYS + the derived plan/
// actions live in the ACTIVITIES (node:crypto lives there). It is Vitest-unit-
// testable with no Temporal server and safe to wrap in a thin @temporalio workflow
// later (that wrapper + its SOW_TEMPORAL integration test are the worker-wiring
// wave's job — NOT this file). The Hermes-specific routing seam (HermesRoutePort)
// and the Hermes agent-job seam (RunHermesAgentJobPort) are declared HERE; the rest
// of the governed pipeline REUSES the 7.6 derive-from-validated surface
// (ValidateExtractionPort / BuildOutputsPort / CommitKnowledgePort /
// ProposeActionsPort / ReindexGbrainPort / MeetingHealthSink), so the no-inference +
// workspace-stamp + gateway-only guarantees are IDENTICAL to 7.6.
//
// ★★ THE 7.18 INVARIANT (REQ-F-014 / RT-7): Hermes MAY initiate a user-defined
// automation, but it is NOT the product-workflow source of truth — Temporal is. So:
//   1. A Hermes-initiated automation is recorded as a WorkflowRun with
//      trigger=hermes_automation carrying an idempotencyKey (via resolveRun). The
//      driver PINS the trigger to "hermes_automation" — it does not trust a caller
//      to label the run; a run submitted under any other trigger is refused
//      (fail-closed) so a Hermes automation can never masquerade as another trigger.
//   2. EVERY semantic write goes through the KnowledgeWriter commit port; EVERY
//      external side effect goes through the Tool Gateway propose port. There is NO
//      Hermes-direct Markdown or GBrain write path in this driver — the one-writer +
//      external-write-envelope invariants are enforced by the GATEWAYS (the ports),
//      not by trusting Hermes. GBrain re-index runs AFTER the Markdown commit and
//      never rolls it back (no direct GBrain write).
//   3. DERIVE-FROM-VALIDATED: the committed KnowledgeMutationPlan + external-action
//      proposals are DERIVED (via the injected BuildOutputsPort) from the VALIDATED
//      extraction — NEVER caller-supplied — and the plan's workspaceId is STAMPED
//      from the ROUTE-BOUND workspace, never a caller value. An inferred owner/date
//      is rejected at validate, so it can never reach a commit.
//   4. REPLAY: resolveRun reuses a seen run; the whole driver is safe to re-drive
//      from the start (KnowledgeWriter idempotent-replay + Tool Gateway envelope
//      reuse → zero duplicate external action). Every failure class → a distinct 7.5
//      System Health item (nothing silent).
//
// §16 error convention: the driver NEVER throws across a boundary. It folds each
// typed port rejection onto a distinct hermesAutomationMachine state + routes it
// through the health sink, and returns a discriminated-union-friendly outcome whose
// `state` is the machine state the pipeline finally rested in.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  ExternalWriteEnvelope,
  SourceRef,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
// REUSE the 7.6 derive-from-validated governance surface (workflow-agnostic:
// candidate-data-in, validated-and-derived-out) rather than re-declaring it, so the
// no-inference + workspace-stamp + gateway-only guarantees are IDENTICAL to 7.6/7.7.
import type {
  AgentExtraction,
  ValidateExtractionPort,
  BuildOutputsPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  ReindexGbrainPort,
  MeetingHealthSink,
  MeetingWorkflowFailure,
} from "../ports/meetingCloseout";

// Re-export the reused governance surface so the test + a downstream slice import it
// from ONE place (this seam) without reaching into the 7.6 module.
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
  ReindexGbrainPort,
  ReindexError,
  ReindexErrorCode,
} from "../ports/meetingCloseout";

// ---------------------------------------------------------------------------
// (A) The Hermes-automation local state machine
// ---------------------------------------------------------------------------

/**
 * The workflows-local Hermes-automation state alphabet (@sow/domain ships none for
 * 7.18). Failure/park states carry a pinned recovery back-edge to `triggered` so the
 * machine stays TOTAL and a re-drive re-enters the spine; the driver walks only the
 * happy edges + the pinned failure-entry edges.
 *
 *   triggered → routed → agent_ran → validated → outputs_built
 *             → knowledge_committed → external_actions_pending
 *             → external_actions_applied → completed   (happy terminal)
 * FAILURE / PARK: routing_failed | provider_failed | schema_rejected |
 *             write_conflict | approval_pending | outbox_retry.
 */
export const HERMES_AUTOMATION_STATES = [
  "triggered",
  "routed",
  "agent_ran",
  "validated",
  "outputs_built",
  "knowledge_committed",
  "external_actions_pending",
  "external_actions_applied",
  // terminal happy
  "completed",
  // failure / park
  "routing_failed",
  "provider_failed",
  "schema_rejected",
  "write_conflict",
  "approval_pending",
  "outbox_retry",
] as const;

/** A closed Hermes-automation state (element of {@link HERMES_AUTOMATION_STATES}). */
export type HermesAutomationState = (typeof HERMES_AUTOMATION_STATES)[number];

// Adjacency table. The happy terminal `completed` maps to []. Each failure/park
// state carries a pinned back-edge to `triggered` so the machine is total and a
// re-drive re-enters the spine from the start.
const hermesAutomationTransitions: Readonly<
  Record<HermesAutomationState, readonly HermesAutomationState[]>
> = {
  // triggered → routed, OR routing failed / low-confidence (no workspace guess).
  triggered: ["routed", "routing_failed"],
  // routed → run the agent job, OR a provider/admission failure.
  routed: ["agent_ran", "provider_failed"],
  // agent_ran → validate, OR a provider failure (defensive), OR schema rejection.
  agent_ran: ["validated", "provider_failed", "schema_rejected"],
  // validated → derive outputs, OR a derivation rejection (schema_rejected).
  validated: ["outputs_built", "schema_rejected"],
  // outputs_built → commit the derived plan, OR a derivation rejection.
  outputs_built: ["knowledge_committed", "schema_rejected"],
  // knowledge_committed → external stage, OR completed (no external actions), OR a
  // commit conflict (defensively pinned as an entry back-edge).
  knowledge_committed: ["external_actions_pending", "completed", "write_conflict"],
  // external stage: apply each action, OR park on approval, OR hold to the outbox.
  external_actions_pending: ["external_actions_applied", "approval_pending", "outbox_retry"],
  external_actions_applied: ["completed"],
  // Terminal happy.
  completed: [],
  // Failure / park states: each re-enters `triggered` on a re-drive (non-terminal
  // so the machine is total; ≥1 outgoing edge).
  routing_failed: ["triggered"],
  provider_failed: ["triggered"],
  schema_rejected: ["triggered"],
  write_conflict: ["triggered"],
  approval_pending: ["triggered"],
  outbox_retry: ["triggered"],
};

/** The local, PURE + TOTAL Hermes-automation machine (defineMachine — never throws). */
export const hermesAutomationMachine: StateMachine<HermesAutomationState> =
  defineMachine<HermesAutomationState>(hermesAutomationTransitions);

// ---------------------------------------------------------------------------
// (B) The Hermes-automation pipeline context
// ---------------------------------------------------------------------------

/**
 * The descriptor of the Hermes trigger that initiated this automation. `source`
 * classifies the initiator (cron schedule or a Kanban-board transition — the two
 * REQ-F-014 Hermes initiation paths); `automationId` names the user-defined
 * automation; `sourceRef` is the evidence the derived plan cites (REQ-F-006). This
 * is CANDIDATE context — Hermes initiating an automation does not itself authorize a
 * write; the workspace is bound only after a high-confidence route (WS-2).
 */
export interface HermesTrigger {
  /** The Hermes initiation path (open — the §9 Hermes taxonomy is an arch_gap). */
  readonly source: "cron" | "kanban";
  /** The user-defined automation this run executes. */
  readonly automationId: string;
  /** The evidence the derived plan cites (REQ-F-006 — ≥1 sourceRef). */
  readonly sourceRef: SourceRef;
}

/**
 * The pipeline state carried between Hermes-automation activities. A PLAIN,
 * immutable data record (no methods, no clock, no I/O). Each stage threads a NEW
 * context with the next field populated:
 *
 *   triggered           → { trigger }                        (Hermes initiated it)
 *   routed              → + workspaceId                       (WS-2: workspace bound)
 *   agent_ran           → + extraction (CANDIDATE)            (agent output)
 *   validated           → + validated (gate PASSED)           (no-inference + schema)
 *   knowledge_committed → + revisionId                        (KnowledgeWriter commit)
 *   external_actions_*  → + envelopes                          (Tool Gateway receipts)
 *
 * `workspaceId` is ABSENT until routing binds it (inv-1 / REQ-F-002 / WS-2): NO
 * durable write may happen while it is undefined.
 */
export interface HermesAutomationContext {
  /** The Hermes trigger descriptor (triggered state). */
  readonly trigger: HermesTrigger;
  /** Bound ONLY after a high-confidence route (WS-2) — undefined pre-route. */
  readonly workspaceId?: WorkspaceId;
  /** The routing result (present once routing ran). */
  readonly routing?: HermesRouteOutcome;
  /** The CANDIDATE agent extraction (present once the automation job ran). */
  readonly extraction?: AgentExtraction;
  /** The VALIDATED extraction (present once it cleared the gate). */
  readonly validated?: import("../ports/meetingCloseout").ValidatedExtraction;
  /** The committed Markdown revision id (present once KnowledgeWriter committed). */
  readonly revisionId?: string;
  /** The external-write envelopes proposed / applied (empty default). */
  readonly envelopes: readonly ExternalWriteEnvelope[];
}

// ---------------------------------------------------------------------------
// (C) HermesRoutePort — inv-1: route the automation to a workspace/target
// ---------------------------------------------------------------------------

/**
 * The routing confidence signal. `high` = the automation was confidently routed to a
 * workspace/target; `low` = ambiguous — the automation cannot bind a workspace, so
 * it FAILS CLOSED (routing_failed) rather than guess (inv-1: Hermes never guesses a
 * workspace to write into). The workspace binding lives ONLY on the `high` variant so
 * the type SYSTEM forbids reading a workspaceId off a low-confidence outcome.
 */
export type HermesRouteOutcome =
  | {
      readonly confidence: "high";
      /** WS-2: the bound workspace (present ONLY on high confidence). */
      readonly workspaceId: WorkspaceId;
      /** The bound project, when routed (optional). */
      readonly projectId?: string;
    }
  | {
      readonly confidence: "low";
      /**
       * The routing-review marker (inv-1): a low-confidence route NEVER carries a
       * workspaceId, so no durable write can guess a workspace off it. The Hermes
       * automation fails closed to routing_failed.
       */
      readonly routingReview: true;
      /** Optional human-facing reason. */
      readonly reason?: string;
    };

/** Closed, enumerable HermesRoutePort failure set (§16 — never thrown). */
export type HermesRouteErrorCode =
  | "route_source_unavailable" // the routing input/automation definition could not be read
  | "route_failed"; // the router itself failed (not a low-confidence result)

export interface HermesRouteError {
  readonly code: HermesRouteErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Route a Hermes-initiated automation to a workspace/target (inv-1 / REQ-F-002 /
 * WS-2). A LOW-confidence route is a SUCCESS carrying a routing_review marker (the
 * driver fails it closed to routing_failed) — NOT an error, and NEVER an auto-route.
 * A `HermesRouteError` is only for a router/source failure. Never throws.
 */
export interface HermesRoutePort {
  route(
    ctx: HermesAutomationContext,
  ): Promise<Result<HermesRouteOutcome, HermesRouteError>>;
}

// ---------------------------------------------------------------------------
// (D) RunHermesAgentJobPort — the Hermes automation agent job (ING-7 read-only)
// ---------------------------------------------------------------------------

/**
 * Closed, enumerable Hermes-agent failure set (§16 — never thrown). Distinct codes so
 * each maps to a DISTINCT machine failure state + a distinct System Health item:
 *   • `admission_rejected` — ING-7: the automation job declared a MUTATING tool
 *     policy and was REJECTED at admission (never run). The agent may emit ONLY a
 *     plan/proposal — it can NEVER drive an external write itself (there is no
 *     Hermes-direct external-write path; the Tool Gateway is the only one).
 *   • `provider_failed`    — the provider/runtime failed.
 *   • `schema_rejected`    — the broker's internal candidate-data gate rejected it.
 *   • `egress_vetoed`      — the egress veto fired (employer-work raw content, ack
 *     off, no local provider) → fail-closed, never a cloud fallback (safety rule 5).
 *   • `budget_exceeded`    — COST-1 budget cap breached.
 */
export type HermesAgentFailureCode =
  | "admission_rejected"
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

export interface HermesAgentFailure {
  readonly code: HermesAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Run the Hermes automation AgentJob. The activity builds a READ-ONLY-ToolPolicy job
 * (ING-7) with an outputSchemaId + budget caps + an idempotencyKey and dispatches it
 * through the @sow/providers Broker (which enforces ING-7 admission, the egress veto,
 * the budget, and the schema gate internally). Returns a CANDIDATE
 * {@link AgentExtraction} on acceptance; a mutating-tool declaration is
 * `admission_rejected` (never run). The job may emit ONLY a plan/proposal via the
 * derive-from-validated path — it may NEVER drive a Markdown/GBrain/external write
 * directly. Never throws.
 */
export interface RunHermesAgentJobPort {
  run(
    ctx: HermesAutomationContext,
  ): Promise<Result<AgentExtraction, HermesAgentFailure>>;
}

// ---------------------------------------------------------------------------
// (E) Driver input / deps / outcome
// ---------------------------------------------------------------------------

/**
 * The complete input to {@link runHermesAutomation}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam — its `trigger` MUST be
 * `hermes_automation` (the driver pins it; a run under any other trigger is refused,
 * so a Hermes automation cannot masquerade as another trigger). `context` is the
 * initial pre-route context (the Hermes trigger descriptor, no bound workspace).
 *
 * The semantic outputs (plan + external actions) are NOT caller-supplied — they are
 * DERIVED inside the governed pipeline by {@link BuildOutputsPort} from the VALIDATED
 * extraction + the route-bound workspace, so an inferred owner/date can never reach a
 * commit and the write always targets the bound workspace (WS-2/WS-4).
 */
export interface HermesAutomationInput {
  readonly run: ResolveRunInput;
  readonly context: HermesAutomationContext;
}

/**
 * The injected dependency set: the Hermes routing + agent-job ports, the reused
 * derive-from-validated governance ports, the 7.5 health sink, the 7.4 WorkflowRun
 * repository (for resolveRun's idempotency seam), and the injected Clock. Every
 * dependency is a narrow port so the driver stays pure and fully injected-testable
 * (no router / broker / KnowledgeWriter / Tool Gateway / Temporal).
 */
export interface HermesAutomationDeps {
  readonly route: HermesRoutePort;
  readonly agent: RunHermesAgentJobPort;
  readonly validate: ValidateExtractionPort;
  readonly buildOutputs: BuildOutputsPort;
  readonly commit: CommitKnowledgePort;
  readonly propose: ProposeActionsPort;
  readonly reindex: ReindexGbrainPort;
  readonly health: MeetingHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

/**
 * The result of a Hermes-automation drive. `state` is the machine state the pipeline
 * rested in (the happy terminal `completed`, or a failure/park state). `context` is
 * the final threaded context (workspace stays undefined on a routing_failed park —
 * inv-1). `run` is the resolveRun result; `runReused` mirrors resolveRun's `reused`
 * flag. `surfaced` names the health failure routed on a failure/park branch. Never
 * throws.
 */
export interface HermesAutomationOutcome {
  readonly state: HermesAutomationState;
  readonly context: HermesAutomationContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: MeetingWorkflowFailure;
}

// ---------------------------------------------------------------------------
// (F) machine-transition helper + failure-class mapping
// ---------------------------------------------------------------------------

/**
 * Walk an ORDERED list of successor states, asserting each edge is legal. The domain
 * machine is pure + total (never throws); an illegal edge stops the cursor at the
 * last legal state rather than crashing, keeping the driver total (§16). Returns the
 * last legal state reached.
 */
function advance(
  from: HermesAutomationState,
  through: readonly HermesAutomationState[],
): HermesAutomationState {
  let cursor = from;
  for (const to of through) {
    const step = hermesAutomationMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

/** Map a Hermes-automation failure/park state to a §16 FailureClass for the sink. */
function failureClassFor(state: HermesAutomationState): FailureClass {
  switch (state) {
    case "routing_failed":
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

// ---------------------------------------------------------------------------
// (G) driver
// ---------------------------------------------------------------------------

/**
 * Run the Hermes-automation pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay):
 *   0. PIN the trigger to hermes_automation (fail-closed if the caller submitted a
 *      different trigger — a Hermes automation cannot masquerade as another trigger).
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run. The run
 *      is recorded as a WorkflowRun with trigger=hermes_automation (Temporal is the
 *      source of truth; Hermes only initiated it).
 *   2. route — HIGH binds the workspace before any durable write (inv-1 / WS-2); LOW
 *      or a router error fails closed to routing_failed with NO workspace guess + NO
 *      write.
 *   3. run the automation AgentJob through the broker port (ING-7 read-only) — a
 *      rejection folds to provider_failed (no commit).
 *   4. validate the candidate — an inferred/schema rejection → schema_rejected, NO
 *      partial commit.
 *   4b. DERIVE the outputs (plan + external actions) from the validated extraction +
 *      the bound workspace (BuildOutputsPort) — a derivation failure → schema_rejected,
 *      NO partial commit. The plan is NEVER caller-supplied (no-inference + WS-2/WS-4).
 *   5. commit the DERIVED plan through KnowledgeWriter (the SOLE Markdown writer) —
 *      a conflict → write_conflict; success mints a revision (idempotent replay).
 *   6. re-index GBrain AFTER the commit — a re-index failure surfaces but NEVER rolls
 *      the commit back (no direct GBrain write).
 *   7. dispatch external actions through the Tool Gateway (the ONLY external-write
 *      path) — approval → approval_pending; hold → outbox_retry; success advances to
 *      external_actions_applied.
 *   8. completed.
 *
 * Every failure/park branch routes through the health sink (nothing silent). Never
 * throws.
 */
export async function runHermesAutomation(
  input: HermesAutomationInput,
  deps: HermesAutomationDeps,
): Promise<HermesAutomationOutcome> {
  // 0. PIN the trigger. A Hermes-initiated automation is ALWAYS recorded under
  //    trigger=hermes_automation — the driver does not trust the caller's label. A
  //    submission under any other trigger is refused (fail-closed) so a Hermes
  //    automation can never masquerade as a schedule/connector/owner-action run.
  const pinnedRun: ResolveRunInput = { ...input.run, trigger: "hermes_automation" };

  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the existing
  //    run — the whole pipeline is safe to re-drive from the start (RT-7 / LIFE-3).
  const resolved = await resolveRun(pinnedRun, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  // The machine cursor starts at the initial state.
  let state: HermesAutomationState = "triggered";
  let context: HermesAutomationContext = input.context;

  const surface = async (
    failState: HermesAutomationState,
    message: string,
  ): Promise<HermesAutomationOutcome> => {
    const failure: MeetingWorkflowFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: pinnedRun.workflowId,
      message,
      auditRef: pinnedRun.workflowId as unknown as AuditId,
    };
    // Route the failure through the 7.5 health sink (nothing fails silently). We
    // fail-closed on the machine state regardless of the sink's own result.
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, surfaced: failure };
  };

  // 2. Route the automation (inv-1 / WS-2). A router error OR a low-confidence outcome
  //    fails CLOSED to routing_failed with NO workspace guess and NO durable write.
  const routed = await deps.route.route(context);
  if (!isOk(routed)) {
    state = advance(state, ["routing_failed"]);
    return surface(state, `hermes routing failed: ${routed.error.code}`);
  }
  const routing = routed.value;
  if (routing.confidence === "low") {
    // Fail closed — the automation cannot bind a workspace, so it never guesses one.
    state = advance(state, ["routing_failed"]);
    return surface(state, "hermes routing low-confidence — no workspace bound (fail-closed)");
  }
  // HIGH confidence: bind the workspace BEFORE any durable write (inv-1 / WS-2). We
  // capture the bound workspace in a local so the derived plan's workspace is provably
  // the route-bound one (not a caller value) — the WS-2/WS-4 anchor buildOutputs
  // stamps onto the plan.
  const boundWorkspaceId = routing.workspaceId;
  state = advance(state, ["routed"]);
  context = { ...context, workspaceId: boundWorkspaceId, routing };

  // 3. Run the automation AgentJob through the broker port (ING-7 read-only). Any
  //    admission / provider / egress / budget rejection folds to provider_failed — the
  //    job never produced a committable extraction, so NO commit happens.
  const extracted = await deps.agent.run(context);
  if (!isOk(extracted)) {
    state = advance(state, ["provider_failed"]);
    return surface(state, `hermes automation job rejected: ${extracted.error.code}`);
  }
  state = advance(state, ["agent_ran"]);
  context = { ...context, extraction: extracted.value };

  // 4. Validate the candidate. A no-inference / schema / unsupported / ambiguous
  //    rejection HARD-STOPS at schema_rejected with NO KnowledgeWriter commit and NO
  //    external write (no partial commit).
  const validated = deps.validate.validate(extracted.value);
  if (!isOk(validated)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `extraction rejected: ${validated.error.code}`);
  }
  state = advance(state, ["validated"]);
  context = { ...context, validated: validated.value };

  // 4b. DERIVE the committed outputs FROM the validated extraction + the route-bound
  //     workspace (the governance seam — closes the no-inference / workspace-isolation
  //     bypass). The plan is NEVER caller-supplied; `plan.workspaceId` is stamped from
  //     boundWorkspaceId. A derivation failure folds to schema_rejected with NO partial
  //     commit (buildOutputs runs BEFORE any durable write).
  const built = await deps.buildOutputs.build(validated.value, boundWorkspaceId);
  if (!isOk(built)) {
    state = advance(state, ["outputs_built", "schema_rejected"]);
    return surface(state, `output derivation failed: ${built.error.code}`);
  }
  const plan = built.value.plan;
  const actions = built.value.actions;
  state = advance(state, ["outputs_built"]);

  // 5. Commit the DERIVED semantic output through KnowledgeWriter (the SOLE Markdown
  //    writer — there is NO Hermes-direct Markdown write path). IDEMPOTENT by the
  //    plan's key: a replay reuses the prior revision. A conflict → write_conflict.
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) {
    state = advance(state, ["knowledge_committed", "write_conflict"]);
    return surface(state, `knowledge commit failed: ${committed.error.code}`);
  }
  state = advance(state, ["knowledge_committed"]);
  context = { ...context, revisionId: committed.value.revisionId };

  // 6. Re-index GBrain AFTER the Markdown commit — async + idempotent (there is NO
  //    Hermes-direct GBrain write path; the index runs off the committed revision). A
  //    re-index failure surfaces a health item but NEVER rolls the commit back.
  const reindexed = await deps.reindex.reindex(committed.value.revisionId);
  if (!isOk(reindexed)) {
    const reindexFailure: MeetingWorkflowFailure = {
      failureClass: "write_through_failed",
      subjectRef: pinnedRun.workflowId,
      message: `gbrain re-index failed (commit stands): ${reindexed.error.code}`,
      auditRef: pinnedRun.workflowId as unknown as AuditId,
    };
    await deps.health.surface(reindexFailure);
    // Fall through — the commit is durable, so the automation continues.
  }

  // No external actions ⇒ complete straight from the commit.
  if (actions.length === 0) {
    state = advance(state, ["completed"]);
    return { state, context, run: runResult, runReused };
  }

  // 7. External-action stage: every external write goes through the Tool Gateway
  //    propose port (the ONLY external-write path — there is NO Hermes-direct external
  //    write). A REPLAY with the same idempotencyKey reuses the receipt → zero
  //    duplicate external action (RT-7). An approval-required action FAILS CLOSED to
  //    approval_pending (no write); held/conflict/rejected → outbox_retry (re-drivable).
  state = advance(state, ["external_actions_pending"]);
  const appliedEnvelopes: ExternalWriteEnvelope[] = [];
  for (const item of actions) {
    const proposed = await deps.propose.propose(item.action, item.envelope);
    if (!isOk(proposed)) {
      const code = proposed.error.code;
      if (code === "approval_pending") {
        state = advance(state, ["approval_pending"]);
        return surface(state, "external action requires approval (fail-closed)");
      }
      state = advance(state, ["outbox_retry"]);
      return surface(state, `external action held: ${code}`);
    }
    appliedEnvelopes.push(proposed.value.envelope);
  }
  context = { ...context, envelopes: [...context.envelopes, ...appliedEnvelopes] };
  state = advance(state, ["external_actions_applied"]);

  // 8. completed (happy terminal).
  state = advance(state, ["completed"]);
  return { state, context, run: runResult, runReused };
}

// Re-export the envelope type consumers may reference on the outcome context.
export type { ExternalWriteEnvelope };
