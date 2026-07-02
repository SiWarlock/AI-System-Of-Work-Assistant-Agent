// @sow/workflows — task 7.12: CROSS-CALENDAR SCHEDULING — the PURE orchestration
// DRIVER.
//
// This is a sibling of the 7.6 meeting-closeout / 7.10 daily-brief drivers: the
// deterministic control driver that progresses a scheduling run THROUGH a local
// `crossCalendarSchedulingMachine` (defined via the @sow/domain `defineMachine`
// primitive — @sow/domain ships no scheduling machine, so this workflow owns its
// state alphabet, matching how the 6 domain machines are each defined) over the
// INJECTED activity ports (src/ports/crossCalendarScheduling.ts), the injected
// Clock, the 7.5 health sink, and the 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through the injected ports + Clock, so it is Vitest-unit-testable with no Temporal
// server and safe to wrap in a thin @temporalio workflow later (that wrapper + its
// SOW_TEMPORAL integration test are the worker-wiring wave's job — NOT this file).
// Per-step idempotency KEYS + the derived action live in ACTIVITIES (node:crypto
// lives there); the driver only RECEIVES the derived result.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct machine failure STATE and routes it through
// the health sink (inv-5: nothing fails silently). The returned outcome is a
// discriminated-union-friendly record whose `state` is the machine state the pipeline
// finally rested in.
//
// 7.12 safety invariants this driver makes true:
//   inv-1  REQ-F-009: busy/free is read across ALL configured availability sources
//          via the GCL. An omitted/UNREACHABLE source is a TYPED failure
//          (calendar_unreachable) — NEVER silently treated as free. The driver
//          additionally asserts the gathered `readSources` cover the FULL bound set,
//          so a partial read can never let a window be proposed over an unread
//          calendar.
//   inv-2  the propose-windows job runs through the broker port under a read-only
//          tool policy over the SANITIZED availability; an ING-7 admission rejection
//          / provider / egress / budget failure folds to provider_failed — the job
//          never runs / never proposes.
//   inv-3  a validator rejection (no-inference / schema / unsupported) →
//          schema_rejected with NO external write and NO approval record.
//   inv-4  DERIVE-FROM-VALIDATED: the calendar-event action is DERIVED from the
//          VALIDATED proposal (never caller-supplied) + stamped to the organizer's
//          BOUND workspace (WS-2/WS-4); the action payload carries ONLY the chosen
//          window + a GENERIC explanation — no raw cross-workspace detail (Flow 3).
//   inv-5  AUTO-CREATE a private personal event through the Tool Gateway ONLY when
//          the policy predicate (requiresApproval) auto-allows it (private-personal
//          calendar action). A shared/invite/external change ROUTES to the 7.9
//          Approval Inbox instead of auto-applying. External creation reuses the
//          envelope (NO duplicate event on replay); resolveRun reuses a seen run;
//          EVERY failure class surfaces a distinct 7.5 health item.
import { isOk } from "@sow/contracts";
import type {
  Result,
  WorkflowRunRef,
  ExternalWriteEnvelope,
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
  CrossCalendarSchedulingContext,
  GatherAvailabilityPort,
  ProposeWindowsAgentPort,
  ValidateProposalPort,
  BuildSchedulingOutputsPort,
  ClassifyActionPort,
  AutoCreateEventPort,
  RouteToApprovalPort,
  CommitSchedulingNotePort,
  SchedulingHealthSink,
  SchedulingWorkflowFailure,
} from "../ports/crossCalendarScheduling";

// --- local state machine (defineMachine — @sow/domain ships none for 7.12) --

/**
 * The closed cross-calendar-scheduling state alphabet. Happy path:
 *   requested → availability_gathered → proposed → validated → outputs_built →
 *   (event_created | routed_to_approval) → scheduled
 * Failure/park states carry a pinned recovery back-edge (a non-terminal state needs
 * ≥1 outgoing edge) so the machine stays total; the driver walks only happy edges +
 * pinned failure-entry edges.
 */
export const CROSS_CALENDAR_STATES = [
  "requested",
  "availability_gathered",
  "proposed",
  "validated",
  "outputs_built",
  "event_created",
  "routed_to_approval",
  // terminal happy
  "scheduled",
  // failure / park
  "calendar_unreachable",
  "provider_failed",
  "schema_rejected",
  "approval_pending",
  "outbox_retry",
] as const;

export type CrossCalendarState = (typeof CROSS_CALENDAR_STATES)[number];

// Adjacency table. Terminal `scheduled` maps to []. Failure/park states each carry a
// pinned recovery back-edge so the machine is total. `approval_pending` is the
// terminal-for-this-run park where a shared change was routed to the 7.9 inbox (the
// 7.9 flow drives it thereafter) — it re-enters `requested` on a re-drive.
const crossCalendarTransitions: Readonly<
  Record<CrossCalendarState, readonly CrossCalendarState[]>
> = {
  // requested → gather availability, OR a calendar is unreachable (REQ-F-009).
  requested: ["availability_gathered", "calendar_unreachable"],
  // availability_gathered → propose windows, OR a provider failure.
  availability_gathered: ["proposed", "provider_failed"],
  // proposed → validate, OR a provider failure (defensive), OR schema rejection.
  proposed: ["validated", "provider_failed", "schema_rejected"],
  // validated → derive outputs, OR a derivation rejection (schema_rejected).
  validated: ["outputs_built", "schema_rejected"],
  // outputs_built → auto-create the private event, OR route a shared change to approval.
  outputs_built: ["event_created", "routed_to_approval", "outbox_retry"],
  // event_created → scheduled (happy terminal).
  event_created: ["scheduled"],
  // routed_to_approval → approval_pending (parked; the 7.9 flow drives it).
  routed_to_approval: ["approval_pending", "scheduled"],
  // terminal + park recovery back-edges (each non-terminal state needs ≥1 edge).
  scheduled: [],
  calendar_unreachable: ["requested"],
  provider_failed: ["availability_gathered"],
  schema_rejected: ["proposed"],
  approval_pending: ["requested"],
  outbox_retry: ["outputs_built"],
};

/** The local, PURE + TOTAL scheduling machine (defineMachine — never throws). */
export const crossCalendarSchedulingMachine: StateMachine<CrossCalendarState> =
  defineMachine<CrossCalendarState>(crossCalendarTransitions);

// --- driver input ----------------------------------------------------------

/**
 * The complete input to {@link runCrossCalendarScheduling}. `run` is the trigger
 * submission resolved idempotently through the 7.4 seam (resolveRun); `context` is
 * the initial context (the FULL bound availability-source set + the organizer's bound
 * workspace). The calendar action is NO LONGER caller-supplied — it is DERIVED inside
 * the governed pipeline by {@link BuildSchedulingOutputsPort} from the VALIDATED
 * proposal + the bound workspace, so an inferred value can never reach the action and
 * the write always targets the bound workspace (WS-2/WS-4).
 */
export interface CrossCalendarSchedulingInput {
  readonly run: ResolveRunInput;
  readonly context: CrossCalendarSchedulingContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the scheduling activity ports, the 7.5 health sink,
 * the 7.4 WorkflowRun repository (resolveRun), and the injected Clock. Every
 * dependency is a narrow port so the driver stays pure + fully injected-testable (no
 * GCL gate / broker / Tool Gateway / policy / Temporal). `commit` is OPTIONAL — a
 * scheduling run may or may not write a decision note.
 */
export interface CrossCalendarSchedulingDeps {
  readonly gather: GatherAvailabilityPort;
  readonly agent: ProposeWindowsAgentPort;
  readonly validate: ValidateProposalPort;
  readonly buildOutputs: BuildSchedulingOutputsPort;
  readonly classify: ClassifyActionPort;
  readonly autoCreate: AutoCreateEventPort;
  readonly routeToApproval: RouteToApprovalPort;
  readonly commit?: CommitSchedulingNotePort;
  readonly health: SchedulingHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a scheduling drive. `state` is the machine state the pipeline rested
 * in (happy terminal `scheduled`, or a failure/park state). `context` is the final
 * threaded context. `run`/`runReused` mirror resolveRun. `route` is the routing
 * verdict (present once classification ran). `approvalRef` is the 7.9 inbox ref (on a
 * routed-to-approval branch). `surfaced` names the routed health failure on a
 * failure/park branch. Never throws.
 */
export interface CrossCalendarSchedulingOutcome {
  readonly state: CrossCalendarState;
  readonly context: CrossCalendarSchedulingContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly route?: "auto_create" | "route_to_approval";
  readonly approvalRef?: string;
  readonly surfaced?: SchedulingWorkflowFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws); an
 * illegal edge stops the cursor at the last legal state rather than crashing, keeping
 * the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: CrossCalendarState,
  through: readonly CrossCalendarState[],
): CrossCalendarState {
  let cursor = from;
  for (const to of through) {
    const stepped = crossCalendarSchedulingMachine.transition(cursor, to);
    if (!isOk(stepped)) return cursor;
    cursor = stepped.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a scheduling failure state to a §16 FailureClass for the health sink. */
function failureClassFor(state: CrossCalendarState): FailureClass {
  switch (state) {
    case "calendar_unreachable":
      return "connector_unreachable";
    case "provider_failed":
      return "write_through_failed";
    case "schema_rejected":
      return "schema_rejection";
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
 * Run the cross-calendar-scheduling pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. gather availability across ALL bound sources via the GCL (inv-1) — an
 *      unreachable/omitted source, a partial read, or a gate rejection folds to
 *      calendar_unreachable (NEVER treated as free).
 *   3. run the propose-windows AgentJob through the broker (inv-2) — a rejection
 *      folds to provider_failed (no proposal).
 *   4. validate the candidate (inv-3) — a rejection → schema_rejected, NO side effect.
 *   4b. DERIVE the action + envelope from the validated proposal + the bound
 *      workspace (inv-4) — a derivation failure → schema_rejected.
 *   5. classify the action (inv-5) — auto_create ONLY for a private-personal action;
 *      else route_to_approval.
 *   6a. auto_create: dispatch through the Tool Gateway envelope (replay-safe) — a
 *      hold/conflict/rejected → outbox_retry.
 *   6b. route_to_approval: record the pending action in the 7.9 inbox (idempotent) →
 *      approval_pending (parked; the 7.9 flow drives it). NO auto-write.
 *   7. (optional) commit the scheduling-decision note through KnowledgeWriter.
 *   8. scheduled.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runCrossCalendarScheduling(
  input: CrossCalendarSchedulingInput,
  deps: CrossCalendarSchedulingDeps,
): Promise<CrossCalendarSchedulingOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run —
  //    the whole pipeline is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: CrossCalendarState = "requested";
  let context: CrossCalendarSchedulingContext = input.context;

  const surface = async (
    failState: CrossCalendarState,
    message: string,
  ): Promise<CrossCalendarSchedulingOutcome> => {
    const failure: SchedulingWorkflowFailure = {
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

  // 2. Gather availability across ALL bound sources via the GCL (inv-1 / REQ-F-009).
  //    An unreachable/omitted source or a gate rejection is a HARD typed failure — a
  //    source is NEVER assumed free.
  const gathered = await deps.gather.gather(context);
  if (!isOk(gathered)) {
    state = advance(state, ["calendar_unreachable"]);
    return surface(
      state,
      `availability gather failed: ${gathered.error.code}`,
    );
  }
  // inv-1 completeness guard: the gathered read-set MUST cover the FULL bound source
  // set. A partial read (a source silently missing from readSources) is treated
  // EXACTLY like an unreachable source — never silently assumed free.
  const readSet = new Set(gathered.value.readSources);
  const missing = context.sources.filter((s) => !readSet.has(s.sourceId));
  if (missing.length > 0) {
    state = advance(state, ["calendar_unreachable"]);
    return surface(
      state,
      `availability incomplete — ${missing.length} configured source(s) unread (never assumed free)`,
    );
  }
  state = advance(state, ["availability_gathered"]);
  context = { ...context, availability: gathered.value };

  // 3. Run the propose-windows AgentJob through the broker (inv-2). Any admission /
  //    provider / egress / budget rejection folds to provider_failed — no proposal.
  const proposed = await deps.agent.run(context);
  if (!isOk(proposed)) {
    state = advance(state, ["provider_failed"]);
    return surface(state, `propose-windows job rejected: ${proposed.error.code}`);
  }
  state = advance(state, ["proposed"]);
  context = { ...context, proposal: proposed.value };

  // 4. Validate the candidate (inv-3). A no-inference / schema / unsupported
  //    rejection HARD-STOPS at schema_rejected with NO external write + NO approval.
  const validated = deps.validate.validate(proposed.value);
  if (!isOk(validated)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `proposal rejected: ${validated.error.code}`);
  }
  state = advance(state, ["validated"]);
  context = { ...context, validated: validated.value };

  // 4b. DERIVE the action + envelope FROM the validated proposal + the BOUND
  //     workspace (inv-4). The action is NEVER caller-supplied; its payload carries
  //     only the chosen window + a GENERIC explanation (Flow 3), and it targets the
  //     organizer's bound workspace (WS-2/WS-4). A derivation failure folds to
  //     schema_rejected with NO side effect (buildOutputs runs BEFORE any write).
  const built = await deps.buildOutputs.build(
    validated.value,
    context.organizerWorkspaceId,
  );
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `action derivation failed: ${built.error.code}`);
  }
  state = advance(state, ["outputs_built"]);
  const { action, envelope } = built.value;

  // 5. Classify the derived action (inv-5). auto_create ONLY for a private-personal
  //    calendar action (the policy predicate says requiresApproval:false); every
  //    shared/invite/external change fails closed to route_to_approval.
  const classified = await deps.classify.classify(action, context.organizerWorkspaceId);
  if (!isOk(classified)) {
    // A classify failure is fail-closed: we do NOT auto-create. Route to approval.
    state = advance(state, ["routed_to_approval"]);
    const routed = await deps.routeToApproval.route(action, envelope);
    if (!isOk(routed)) {
      state = advance(state, ["approval_pending"]);
      return surface(state, `classify failed and approval routing failed: ${routed.error.code}`);
    }
    state = advance(state, ["approval_pending"]);
    const parked = await surface(state, "classify failed — routed to approval (fail-closed)");
    return { ...parked, route: "route_to_approval", approvalRef: routed.value.approvalRef };
  }
  const route = classified.value;

  if (route === "route_to_approval") {
    // 6b. Shared/invite/external change → the 7.9 Approval Inbox. NO auto-write; the
    //     external write happens later, after human approval, on the 7.9 flow.
    //     Idempotent by the envelope's key (a re-drive raises no second card).
    state = advance(state, ["routed_to_approval"]);
    const routed = await deps.routeToApproval.route(action, envelope);
    if (!isOk(routed)) {
      state = advance(state, ["approval_pending"]);
      return surface(state, `approval routing failed: ${routed.error.code}`);
    }
    state = advance(state, ["approval_pending"]);
    const parked = await surface(
      state,
      "shared/invite change routed to the Approval Inbox (not auto-applied)",
    );
    return { ...parked, route, approvalRef: routed.value.approvalRef };
  }

  // 6a. auto_create: a PRIVATE personal event via the Tool Gateway envelope (inv-5).
  //     REPLAY reuses the receipt → zero duplicate event.
  const created = await deps.autoCreate.create(action, envelope);
  if (!isOk(created)) {
    // A held/conflict/rejected auto-create holds to the outbox for a re-drive.
    state = advance(state, ["outbox_retry"]);
    const parked = await surface(state, `auto-create held: ${created.error.code}`);
    return { ...parked, route };
  }
  const appliedEnvelope: ExternalWriteEnvelope = created.value.envelope;
  state = advance(state, ["event_created"]);
  context = { ...context, envelope: appliedEnvelope };

  // 7. OPTIONAL: commit the scheduling-decision note through KnowledgeWriter (safety
  //    rule 1). A commit failure surfaces a health item but does NOT roll the created
  //    event back (the event stands, like the 7.6 reindex) — the closeout continues.
  if (deps.commit !== undefined && built.value.plan !== undefined) {
    const committed = await deps.commit.commit(built.value.plan);
    if (!isOk(committed)) {
      const noteFailure: SchedulingWorkflowFailure = {
        failureClass: "write_through_failed",
        subjectRef: input.run.workflowId,
        message: `scheduling-note commit failed (event stands): ${committed.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      };
      await deps.health.surface(noteFailure);
      // Fall through — the event is durable.
    }
  }

  // 8. scheduled (happy terminal).
  state = advance(state, ["scheduled"]);
  return { state, context, run: runResult, runReused, route };
}

// Re-export envelope type consumers may reference on the outcome context.
export type { ExternalWriteEnvelope };
