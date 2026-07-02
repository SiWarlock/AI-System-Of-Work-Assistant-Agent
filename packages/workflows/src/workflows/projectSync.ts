// @sow/workflows — task 7.13: PROJECT SYNC — PURE orchestration DRIVER.
//
// Sibling of the 7.6 meeting-closeout driver: same two-layer structure (pure
// driver + injected activity ports), same foundation ports (Clock, repos, 7.5
// health sink), same idempotency seam (resolveRun). Progresses a project-sync run
// THROUGH a workflows-local `projectSyncMachine` (no illegal edges; every
// transition guarded) over INJECTED activity ports (src/ports/projectSync.ts),
// injected Clock, 7.5 health sink.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): the driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through injected ports + Clock; per-step idempotency KEYS + derived committed
// outputs live in ACTIVITIES (node:crypto lives there); the driver only RECEIVES a
// derived result. Vitest-unit-testable with no Temporal server.
//
// The local projectSyncMachine (defined via @sow/domain `defineMachine` — @sow/domain
// does not ship a project-sync machine, so this workflow owns its state alphabet,
// matching how the 6 domain machines are each defined) is PURE + TOTAL: legal edges
// return ok(to), illegal edges return a typed err — the machine never throws.
//
// ★★ THE DETERMINISTIC-PROGRESS INVARIANT (REQ-F-011 / PRJ-3/4). The numeric
// progress is derived by a DETERMINISTIC parser of checkboxes/status
// (ParseProgressPort) — a MODEL-supplied percentage is FORBIDDEN. The synthesis
// agent (SynthesizeNarrativePort) only produces PROSE explanation/blockers/
// next-actions OVER the deterministic facts. The committed numeric progress is
// DERIVED by BuildSyncOutputsPort from the DETERMINISTIC facts — never from the
// (validated) narrative. So even a narrative field named "percent" can never become
// the committed number: the driver hands the deterministic `progress` (not the
// narrative) to the deriver as the numeric source.
//
// ★★★ GOVERNANCE (the 7.6 lesson, applied here):
//   1. DERIVE-FROM-VALIDATED: the committed KnowledgeMutationPlan is DERIVED (via
//      the injected BuildSyncOutputsPort) FROM the VALIDATED narrative + the
//      DETERMINISTIC facts — NEVER caller-supplied — and `plan.workspaceId` is
//      STAMPED from the REGISTRY-BOUND workspace (never a caller value). An inferred
//      owner/date, rejected at validate, can never reach the plan.
//   2. Semantic writes ONLY via KnowledgeWriter (commit port); external writes ONLY
//      via the Tool Gateway envelope (propose port).
//   3. Idempotency/replay: resolveRun reuses a seen run; the whole driver is safe to
//      re-drive from the start (KnowledgeWriter idempotent-replay + Tool Gateway
//      envelope reuse).
//   4. Every failure/park class → a distinct 7.5 System Health item (nothing silent).
//   5. The workspace is bound (registry resolve) before any durable write (WS-2).
//
// §16: the driver NEVER throws across a boundary. It folds each typed port rejection
// onto a distinct projectSyncMachine state + routes it through the health sink, and
// returns a discriminated-union-friendly outcome whose `state` is the machine state
// the pipeline finally rested in.
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
  ProjectSyncContext,
  ResolveRegistryPort,
  ParseProgressPort,
  SynthesizeNarrativePort,
  ValidateNarrativePort,
  BuildSyncOutputsPort,
  CommitStatusPort,
  ProjectSyncUpdateDashboardPort,
  ProjectSyncProposeActionsPort,
  ProjectSyncHealthSink,
  ProjectSyncFailure,
} from "../ports/projectSync";

// --- the local project-sync state machine ----------------------------------

/**
 * The closed project-sync state alphabet. Happy path:
 *   scheduled → registry_resolved → progress_parsed → briefed →
 *   synced_committed → dashboard_updated → done
 * plus the failure/park states (each mapped 1:1 to a distinct 7.5 health item).
 */
export const PROJECT_SYNC_STATES = [
  // happy path
  "scheduled",
  "registry_resolved",
  "progress_parsed",
  "briefed",
  "synced_committed",
  "dashboard_updated",
  "external_actions_applied",
  // registry / parse failure + park
  "provider_unmapped", // a declared progress provider has no mapping (PRJ-3/4)
  "parse_failed", // the plan/provider status could not be parsed
  "connector_stale", // an external provider's cursor is stale (LIFE-2)
  "ambiguous_status", // a task's status is ambiguous — parser refuses to guess (PRJ-4)
  // synthesis / validate / commit failure
  "provider_failed", // the synthesis provider/runtime failed
  "schema_rejected", // the validator / derivation rejected (no partial commit)
  "write_conflict", // a compare-revision clash at commit
  "outbox_retry", // an external write held / needs approval (re-drivable)
  // terminal
  "done",
] as const;

export type ProjectSyncState = (typeof PROJECT_SYNC_STATES)[number];

/**
 * Adjacency table. Terminal `done` maps to []. Every failure/park state carries a
 * pinned recovery/retry back-edge (a non-terminal state needs ≥1 outgoing edge) so
 * the machine is total; the driver only ever walks the happy edges + the pinned
 * failure-entry edges.
 */
const projectSyncTransitions: Readonly<
  Record<ProjectSyncState, readonly ProjectSyncState[]>
> = {
  // scheduled → resolve the registry, OR a registry failure.
  scheduled: ["registry_resolved", "provider_unmapped"],
  // registry_resolved → parse deterministic progress, OR a parse/stale/ambiguous failure.
  registry_resolved: ["progress_parsed", "parse_failed", "connector_stale", "ambiguous_status"],
  // progress_parsed → run the synthesis agent, OR a provider failure.
  progress_parsed: ["briefed", "provider_failed"],
  // briefed → commit the derived status plan, OR a validator/derivation rejection,
  // OR a write conflict surfaced at commit.
  briefed: ["synced_committed", "schema_rejected", "write_conflict"],
  // synced_committed → update the dashboard read-model.
  synced_committed: ["dashboard_updated"],
  // dashboard_updated → dispatch external actions (or straight to done when none).
  dashboard_updated: ["external_actions_applied", "outbox_retry", "done"],
  // external_actions_applied → done.
  external_actions_applied: ["done"],
  // --- failure/park recovery back-edges (each non-terminal, ≥1 outgoing) ---
  provider_unmapped: ["scheduled"],
  parse_failed: ["registry_resolved"],
  connector_stale: ["registry_resolved"],
  ambiguous_status: ["registry_resolved"],
  provider_failed: ["progress_parsed"],
  schema_rejected: ["briefed"],
  write_conflict: ["briefed"],
  outbox_retry: ["dashboard_updated"],
  // terminal
  done: [],
};

/** The pure, total project-sync machine (defined via the @sow/domain primitive). */
export const projectSyncMachine: StateMachine<ProjectSyncState> =
  defineMachine<ProjectSyncState>(projectSyncTransitions);

// --- input -----------------------------------------------------------------

/**
 * The project-sync trigger input. The committed outputs (the KnowledgeMutationPlan
 * + dashboard + external actions) are NOT caller-supplied — they are DERIVED inside
 * the governed pipeline by BuildSyncOutputsPort from the VALIDATED narrative + the
 * DETERMINISTIC facts + the registry-bound workspace, so an inferred value can never
 * reach the commit and the write always targets the bound workspace.
 */
export interface ProjectSyncInput {
  readonly run: ResolveRunInput;
  readonly context: ProjectSyncContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the project-sync activity ports, the 7.5 health sink,
 * the 7.4 WorkflowRun repository (resolveRun), and the injected Clock. Every
 * dependency is a narrow port so the driver stays pure and fully injected-testable
 * (no registry / connector / broker / KnowledgeWriter / Tool Gateway / Temporal).
 */
export interface ProjectSyncDeps {
  readonly registry: ResolveRegistryPort;
  readonly parse: ParseProgressPort;
  readonly synthesize: SynthesizeNarrativePort;
  readonly validate: ValidateNarrativePort;
  readonly buildOutputs: BuildSyncOutputsPort;
  readonly commit: CommitStatusPort;
  readonly dashboard: ProjectSyncUpdateDashboardPort;
  readonly propose: ProjectSyncProposeActionsPort;
  readonly health: ProjectSyncHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a project-sync drive. `state` is the machine state the pipeline
 * rested in (`done`, or a failure/park state). `context` is the final threaded
 * context. `run` is the resolveRun result; `runReused` mirrors its `reused` flag.
 * `surfaced` names the health failure routed on a failure/park branch.
 */
export interface ProjectSyncOutcome {
  readonly state: ProjectSyncState;
  readonly context: ProjectSyncContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: ProjectSyncFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The machine is pure + total (never throws); an
 * illegal edge stops the cursor at the last legal state rather than crashing,
 * keeping the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: ProjectSyncState,
  through: readonly ProjectSyncState[],
): ProjectSyncState {
  let cursor = from;
  for (const to of through) {
    const step = projectSyncMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a project-sync failure state to the §16 FailureClass for the health sink. */
function failureClassFor(state: ProjectSyncState): FailureClass {
  switch (state) {
    case "provider_unmapped":
      return "conflict_review";
    case "parse_failed":
      return "schema_rejection";
    case "connector_stale":
      return "connector_unreachable";
    case "ambiguous_status":
      return "conflict_review";
    case "provider_failed":
      return "write_through_failed";
    case "schema_rejected":
      return "schema_rejection";
    case "write_conflict":
      return "conflict_review";
    case "outbox_retry":
      return "write_through_failed";
    default:
      return "write_through_failed";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the project-sync pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step is keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. RESOLVE the project registry (PRJ-3) — a missing provider mapping folds to
 *      provider_unmapped (no durable write); this BINDS the workspace (WS-2).
 *   3. PARSE the DETERMINISTIC progress (REQ-F-011/PRJ-4) — parse/stale/ambiguous
 *      folds to a distinct failure state. This is the SOLE numeric source.
 *   4. SYNTHESIZE the prose narrative OVER the facts — a provider failure folds to
 *      provider_failed (no commit). The agent never produces the number.
 *   5. VALIDATE the narrative (no-inference + schema) — rejection → schema_rejected,
 *      NO partial commit.
 *   6. DERIVE outputs FROM the validated narrative + the DETERMINISTIC facts + the
 *      bound workspace (BuildSyncOutputsPort) — the committed number comes from the
 *      FACTS, never the model; a derivation failure → schema_rejected, NO partial commit.
 *   7. COMMIT the derived plan via KnowledgeWriter — conflict → write_conflict;
 *      success mints a revision (idempotent replay reuses it).
 *   8. UPDATE the dashboard read-model FROM the committed status — a failure surfaces
 *      but NEVER rolls the commit back.
 *   9. DISPATCH external actions via the Tool Gateway — held/approval → outbox_retry
 *      (fail-closed, re-drivable); success advances external_actions_applied.
 *  10. done.
 *
 * Every failure/park branch routes through the health sink (inv-5) and returns the
 * resting machine state. Never throws.
 */
export async function runProjectSync(
  input: ProjectSyncInput,
  deps: ProjectSyncDeps,
): Promise<ProjectSyncOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run —
  //    the whole pipeline is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: ProjectSyncState = "scheduled";
  let context: ProjectSyncContext = input.context;

  const surface = async (
    failState: ProjectSyncState,
    message: string,
  ): Promise<ProjectSyncOutcome> => {
    const failure: ProjectSyncFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed); the
    // sink's own error is the 7.5 seam's concern, not a reason to lose machine state.
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, surfaced: failure };
  };

  // 2. RESOLVE the project registry (PRJ-3). A missing provider mapping OR an
  //    unknown project folds to provider_unmapped — NO durable write. This BINDS
  //    the workspace (WS-2) the derived plan will commit to.
  const registered = await deps.registry.resolve(context);
  if (!isOk(registered)) {
    state = advance(state, ["provider_unmapped"]);
    return surface(state, `project registry resolution failed: ${registered.error.code}`);
  }
  const registry = registered.value;
  // Capture the bound workspace in a local so the derived plan's workspaceId is
  // provably the registry-bound one (not a caller-controlled value) — the WS-2/WS-4
  // anchor buildOutputs stamps onto the plan.
  const boundWorkspaceId = registry.workspaceId;
  state = advance(state, ["registry_resolved"]);
  context = { ...context, registry };

  // 3. PARSE the DETERMINISTIC progress (REQ-F-011 / PRJ-4). This is the SOLE
  //    producer of the numeric progress — NO model is involved. A parse failure,
  //    stale connector, or ambiguous status folds to a distinct failure state.
  const parsed = await deps.parse.parse(context);
  if (!isOk(parsed)) {
    const code = parsed.error.code;
    const failState: ProjectSyncState =
      code === "connector_stale"
        ? "connector_stale"
        : code === "ambiguous_status"
          ? "ambiguous_status"
          : "parse_failed";
    state = advance(state, [failState]);
    return surface(state, `deterministic progress parse failed: ${code}`);
  }
  const progress = parsed.value;
  state = advance(state, ["progress_parsed"]);
  context = { ...context, progress };

  // 4. SYNTHESIZE the prose narrative OVER the deterministic facts. The agent runs
  //    read-only through the broker and produces ONLY prose (explanation/blockers/
  //    next-actions) — it NEVER produces the numeric progress (REQ-F-011). A
  //    provider/egress/budget/schema failure folds to provider_failed (no commit).
  const synthesized = await deps.synthesize.synthesize(context, progress);
  if (!isOk(synthesized)) {
    state = advance(state, ["provider_failed"]);
    return surface(state, `status synthesis failed: ${synthesized.error.code}`);
  }
  const narrative = synthesized.value;
  state = advance(state, ["briefed"]);
  context = { ...context, narrative };

  // 5. VALIDATE the narrative (inv-3: no-inference + schema). An inferred field
  //    (no-inference) or a schema failure HARD-STOPS with NO KnowledgeWriter commit.
  const validated = deps.validate.validate(narrative);
  if (!isOk(validated)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `narrative rejected: ${validated.error.code}`);
  }

  // 6. DERIVE the committed outputs FROM the validated narrative + the DETERMINISTIC
  //    facts + the registry-bound workspace (the governance seam). The committed
  //    numeric progress comes ONLY from `progress` (the deterministic facts) — a
  //    model-supplied percentage can NEVER become the committed number (REQ-F-011).
  //    The prose comes from the validated narrative; `plan.workspaceId` is stamped
  //    from boundWorkspaceId. A derivation failure folds to schema_rejected with NO
  //    partial commit (buildOutputs runs BEFORE any durable write).
  const built = await deps.buildOutputs.build(validated.value, progress, boundWorkspaceId);
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `status derivation failed: ${built.error.code}`);
  }
  const plan = built.value.plan;
  const actions = built.value.actions;

  // 7. COMMIT the derived plan through the KnowledgeWriter (inv-4: the SOLE Markdown
  //    writer) to the project's status sections. IDEMPOTENT by the plan's key (inv-5):
  //    a replay reuses the prior revision. A compare-revision clash → write_conflict.
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) {
    state = advance(state, ["write_conflict"]);
    return surface(state, `status commit failed: ${committed.error.code}`);
  }
  state = advance(state, ["synced_committed"]);
  context = { ...context, revisionId: committed.value.revisionId };

  // 8. UPDATE the dashboard read-model FROM the committed status. A failure surfaces
  //    a health item but does NOT roll the durable Markdown commit back (like 7.6
  //    reindex) — the status stands; we continue.
  const dashboardUpdated = await deps.dashboard.update(built.value.dashboard);
  if (!isOk(dashboardUpdated)) {
    const dashboardFailure: ProjectSyncFailure = {
      failureClass: "sync_lagging",
      subjectRef: input.run.workflowId,
      message: `dashboard update failed (status stands): ${dashboardUpdated.error.code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(dashboardFailure);
    // Fall through — the commit is durable, so the sync continues.
  }
  state = advance(state, ["dashboard_updated"]);

  // No external actions ⇒ done straight from dashboard_updated.
  if (actions.length === 0) {
    state = advance(state, ["done"]);
    return { state, context, run: runResult, runReused };
  }

  // 9. External-action stage (inv-4/inv-5): every external write goes through the
  //    Tool Gateway propose port. A held / approval-required action FAILS CLOSED to
  //    outbox_retry (re-drivable via the outbox) — no blind write.
  const appliedEnvelopes: ExternalWriteEnvelope[] = [];
  for (const item of actions) {
    const proposed = await deps.propose.propose(item.action, item.envelope);
    if (!isOk(proposed)) {
      const code = proposed.error.code;
      state = advance(state, ["outbox_retry"]);
      return surface(state, `external action held (${code}) — re-drivable via outbox`);
    }
    appliedEnvelopes.push(proposed.value.envelope);
  }
  state = advance(state, ["external_actions_applied"]);

  // 10. done (happy terminal).
  state = advance(state, ["done"]);
  return { state, context, run: runResult, runReused };
}

// Re-export the envelope type consumers may reference on the outcome context.
export type { ExternalWriteEnvelope };
