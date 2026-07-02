// @sow/workflows — task 7.11: WEEKLY / MONTHLY REVIEW — PURE orchestration DRIVER.
//
// A sibling of the 7.10 daily-brief driver: a deterministic control driver that
// progresses a period-review run THROUGH a local `periodReviewMachine` (no illegal
// edges; every transition guarded) over the INJECTED activity ports (declared in
// this file), the injected Clock, the 7.5 health sink, and the 7.4 idempotency
// seam (resolveRun). It reuses the 7.2 durable-schedule catch-up
// (collapsedNextRunFromClock) so a missed period schedule COLLAPSES to ONE run
// (LIFE-2/LIFE-5) rather than a thundering herd of once-per-missed-occurrence runs.
//
// ★ DISTINCT FROM THE DAILY BRIEF (BRF-1): the period review is PERIOD-WINDOWED.
// Its inputs are the period's meetings/decisions/commitments, the project-progress
// deltas, and recurring-blocker detection OVER THE WINDOW — not "today". The window
// [windowStart, windowEnd] is computed by the CLOCK-JUMP-SAFE `computeReviewWindow`
// activity (src/activities/periodWindow.ts, reusing the 7.2 `computeElapsed`
// helper), NEVER a naive wall subtraction — so a forward NTP/DST jump cannot
// balloon the window and a backward jump cannot invert it (LIFE-5).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through the injected ports + Clock, so it is Vitest-unit-testable with no Temporal
// server and safe to wrap in a thin @temporalio workflow later (that wrapper + its
// SOW_TEMPORAL integration test are the worker-wiring wave's job — NOT this file).
// Per-step idempotency KEYS + the derived committed outputs live in the ACTIVITIES;
// the driver only RECEIVES the derived result.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct periodReviewMachine failure STATE and routes
// it through the health sink (inv-5: nothing fails silently). The returned outcome
// is a discriminated-union-friendly record whose `state` is the machine state the
// pipeline finally rested in.
//
// 7.11 safety invariants this driver makes true:
//   inv-1  LIFE-2 collapse: a wake after many missed period occurrences drives ONE
//          review; a wake with nothing due parks in no_run_due with NO durable write.
//   inv-2  the review job runs through the broker port under a read-only tool policy;
//          a provider/egress/budget/admission rejection folds to provider_failed —
//          the job never runs / never commits.
//   inv-3  LEAKAGE-SAFE global review (REQ-F-005/008): the global/coordination review
//          reads cross-workspace context ONLY through SANITIZED GclProjections that
//          crossed the GCL Visibility Gate. A projection failing the gate parks in
//          projection_stale — NO raw cross-workspace content ever reaches the review.
//   inv-4  DERIVE-FROM-VALIDATED: the committed plans are derived FROM the validated
//          review (never caller-supplied) and `plan.workspaceId` is stamped from the
//          BOUND workspace — the global review to the Global/Coordination repo, each
//          workspace review to its own repo (WS-2/WS-4). Semantic writes ONLY via
//          KnowledgeWriter; the telegram summary ONLY via the Tool Gateway envelope.
//   inv-5  idempotent replay: resolveRun reuses a seen run; a re-drive from the start
//          produces NO duplicate commit and NO duplicate external write; EVERY
//          failure class surfaces a distinct 7.5 health item.
import { isOk, ok } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  ExternalWriteEnvelope,
  KnowledgeMutationPlan,
  ProposedAction,
  GclProjection,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine, ExtractionField, NoInferenceRejection } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository, ScheduleStore } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { collapsedNextRunFromClock } from "../runtime/catchUpWindow";
import { advanceBookkeeping } from "../runtime/clock";
import { computeReviewWindow } from "../activities/periodWindow";
import type { ReviewWindow, ReviewPeriod } from "../activities/periodWindow";

// ===========================================================================
// (A) The local periodReviewMachine (state alphabet + adjacency)
// ===========================================================================
//
// Defined via the @sow/domain `defineMachine` primitive (the domain package ships
// no period-review machine; the workflow owns its own state alphabet, exactly as
// the 7.10 daily brief does). PURE + TOTAL: legal edges return ok(to), illegal
// edges return a typed err — the machine never throws.

/** The closed period-review state alphabet. */
export const PERIOD_REVIEW_STATES = [
  // happy path
  "scheduled",
  "window_computed",
  "connectors_refreshed",
  "projections_updated",
  "reviewed",
  "workspace_reviews_committed",
  "global_review_committed",
  "dashboard_updated",
  "notified",
  // recovery / park
  "no_run_due",
  "connector_stale",
  "projection_stale",
  "provider_failed",
  "schema_rejected",
  "write_conflict",
  "notify_failed",
  "outbox_retry",
  // terminal
  "done",
] as const;

export type PeriodReviewState = (typeof PERIOD_REVIEW_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Failure/park states each carry a
// pinned recovery/retry back-edge (a non-terminal state needs ≥1 outgoing edge) so
// the machine is total; the driver only walks the happy edges + the pinned
// failure-entry edges.
const periodReviewTransitions: Readonly<
  Record<PeriodReviewState, readonly PeriodReviewState[]>
> = {
  // scheduled → compute the window, OR park (nothing due, LIFE-2 collapse to zero).
  scheduled: ["window_computed", "no_run_due"],
  // window_computed → refresh connectors.
  window_computed: ["connectors_refreshed", "connector_stale"],
  // connectors_refreshed → update projections, OR a stale connector.
  connectors_refreshed: ["projections_updated", "connector_stale"],
  // projections_updated → run the review agent, OR a stale/gate-rejected projection.
  projections_updated: ["reviewed", "projection_stale"],
  // reviewed → commit workspace reviews, OR a provider failure, OR a validator /
  // derivation rejection (schema_rejected).
  reviewed: [
    "workspace_reviews_committed",
    "provider_failed",
    "schema_rejected",
    "write_conflict",
  ],
  // workspace_reviews_committed → commit the global review, OR a conflict, OR a
  // derivation rejection surfaced while building global outputs.
  workspace_reviews_committed: ["global_review_committed", "write_conflict", "schema_rejected"],
  // global_review_committed → update the dashboard read-model.
  global_review_committed: ["dashboard_updated", "write_conflict"],
  // dashboard_updated → send the telegram summary (a dashboard failure does NOT
  // block — it surfaces + falls through, so the driver still advances here).
  dashboard_updated: ["notified", "outbox_retry", "notify_failed"],
  // notified → done.
  notified: ["done"],
  // failure/park back-edges (each non-terminal state has ≥1 outgoing edge).
  no_run_due: ["scheduled"],
  connector_stale: ["connectors_refreshed"],
  projection_stale: ["projections_updated"],
  provider_failed: ["reviewed"],
  schema_rejected: ["reviewed"],
  write_conflict: ["reviewed"],
  notify_failed: ["dashboard_updated"],
  outbox_retry: ["dashboard_updated"],
  // terminal
  done: [],
};

/** The local period-review machine (defined via the @sow/domain primitive). */
export const periodReviewMachine: StateMachine<PeriodReviewState> =
  defineMachine<PeriodReviewState>(periodReviewTransitions);

// ===========================================================================
// (B) The period-review activity PORTS (the seam the driver reasons in)
// ===========================================================================
//
// Declared HERE (the driver owns them, mirroring the 7.10 daily-brief seam) so the
// two-file src surface stays: this driver + the periodWindow activity. Each port is
// PURE + workflow-safe (types only; no @temporalio / node:crypto). The error sets
// are DECOUPLED from concrete adapter shapes — they are the period-review
// vocabulary mapped 1:1 to the machine failure states. §16: every port returns a
// typed Result, never throws.

/**
 * A single workspace this period-review run is authorized to review over. The run is
 * BOUND to a set of these (WS-2): the driver never reviews a workspace it was not
 * scoped to, and per-workspace reviews commit ONLY to their own workspace repo.
 */
export interface ReviewWorkspaceScope {
  readonly workspaceId: WorkspaceId;
  /** The workspace's GBrain brain id (the in-scope brain the agent may query). */
  readonly brainId?: string;
}

/**
 * The candidate review draft — the review AgentJob output. CANDIDATE DATA until it
 * clears the no-inference + schema gate: `fields` is the abstract evidence-backed
 * extraction-field set the domain no-inference validator (REQ-F-017) operates on,
 * keyed by field name. Period-review fields carry the window signals distinct from
 * the daily brief (e.g. `recurringBlocker`, `progressDelta`).
 */
export interface ReviewDraft {
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/**
 * The VALIDATED review — the candidate that PASSED both the no-inference rule and
 * the schema gate. A distinct `readonly validated: true` brand so the driver cannot
 * commit an un-validated candidate: only a {@link ValidateReviewPort} produces one.
 */
export interface ValidatedReview {
  readonly validated: true;
  readonly fields: Record<string, ExtractionField<unknown>>;
  readonly schemaId?: string;
}

/**
 * The pipeline context carried between period-review activities. A PLAIN, immutable
 * data record (no methods, no clock, no I/O). Each stage threads a NEW context with
 * the next field populated. `scopes` are bound at admission (WS-2): NO durable write
 * may target a workspace absent from this set.
 */
export interface PeriodReviewContext {
  /** The workspaces this run is authorized to review over (WS-2 bound at admission). */
  readonly scopes: readonly ReviewWorkspaceScope[];
  /** The computed clock-jump-safe review window (present once computed). */
  readonly window?: ReviewWindow;
  /** The connector ids refreshed for this run (present once refresh ran). */
  readonly refreshedConnectors?: readonly string[];
  /**
   * The SANITIZED GCL projections that crossed the Visibility Gate — the ONLY
   * cross-workspace context the global review may read (REQ-F-005/008). Present once
   * projections were updated. NEVER carries raw workspace bodies (leakage-safe).
   */
  readonly projections?: readonly GclProjection[];
  /** The committed workspace-review revision ids, keyed by workspaceId. */
  readonly workspaceRevisions?: Readonly<Record<string, string>>;
  /** The committed global-review revision id (present once committed). */
  readonly globalRevisionId?: string;
  /** The telegram-summary envelope proposed/applied (present once notify ran). */
  readonly notifyEnvelope?: ExternalWriteEnvelope;
}

// --- (B1) ReviewRefreshConnectorsPort --------------------------------------------

export type ReviewRefreshConnectorsErrorCode = "connector_unreachable" | "connector_stale";
export interface ReviewRefreshConnectorsError {
  readonly code: ReviewRefreshConnectorsErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}
export interface ReviewRefreshConnectorsResult {
  readonly refreshedConnectors: readonly string[];
}
export interface ReviewRefreshConnectorsPort {
  refresh(
    ctx: PeriodReviewContext,
  ): Promise<Result<ReviewRefreshConnectorsResult, ReviewRefreshConnectorsError>>;
}

// --- (B2) ReviewUpdateProjectionsPort — SANITIZED GCL projections ----------------

export type ReviewUpdateProjectionsErrorCode = "projection_stale" | "gate_rejected";
export interface ReviewUpdateProjectionsError {
  readonly code: ReviewUpdateProjectionsErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}
export interface ReviewUpdateProjectionsPort {
  update(
    ctx: PeriodReviewContext,
  ): Promise<Result<readonly GclProjection[], ReviewUpdateProjectionsError>>;
}

// --- (B3) RunReviewAgentPort — Flow 2: global scope + in-scope brains ------

export type ReviewAgentFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";
export interface ReviewAgentFailure {
  readonly code: ReviewAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}
/**
 * The review agent's full output: ONE global/coordination review draft + a
 * per-workspace review draft keyed by workspaceId. Both are CANDIDATE data until
 * validated. The global draft was produced over the GCL GLOBAL scope + ONLY-in-scope
 * brains (Flow 2) reading cross-workspace context ONLY through the sanitized
 * projections handed to it — so no raw cross-workspace content can appear in
 * `global` (leakage-safe by construction).
 */
export interface ReviewAgentOutput {
  readonly global: ReviewDraft;
  readonly workspaceDrafts: Readonly<Record<string, ReviewDraft>>;
}
export interface RunReviewAgentPort {
  run(ctx: PeriodReviewContext): Promise<Result<ReviewAgentOutput, ReviewAgentFailure>>;
}

// --- (B4) ValidateReviewPort — no-inference + schema, no partial -----------

export type ReviewValidationRejectionCode =
  | "no_inference_violation"
  | "schema_rejected"
  | "unsupported_claim";
export interface ReviewValidationRejection {
  readonly code: ReviewValidationRejectionCode;
  readonly message: string;
  readonly rejections: readonly NoInferenceRejection[];
}
export interface ValidateReviewPort {
  validate(draft: ReviewDraft): Result<ValidatedReview, ReviewValidationRejection>;
}

// --- (B5) BuildGlobalReviewPort — derive committed outputs FROM validated --

/**
 * One external-action proposal to run through the Tool Gateway notify port. Keys are
 * computed in the build ACTIVITY (node:crypto lives there), never in the driver.
 */
export interface PeriodReviewExternalAction {
  readonly action: ProposedAction;
  readonly envelope: ExternalWriteEnvelope;
}

/**
 * The derived semantic outputs of the global review: the KnowledgeMutationPlan the
 * KnowledgeWriter commits to the GLOBAL/Coordination repo + a DASHBOARD read-model
 * record + a Telegram-summary external action. ALL derived from the
 * {@link ValidatedReview} + the sanitized projections + the review WINDOW — never
 * caller-supplied — so a no-inference bypass is impossible and the write always
 * targets the GLOBAL workspace (`plan.workspaceId` stamped from the passed
 * globalWorkspaceId). LEAKAGE-SAFE: built ONLY from validated fields + sanitized
 * projections — never raw cross-workspace bodies.
 */
export interface GlobalReviewOutputs {
  readonly plan: KnowledgeMutationPlan;
  readonly dashboard: Record<string, unknown>;
  readonly notify?: PeriodReviewExternalAction;
}

export type BuildReviewFailureCode = "unmappable_review" | "build_failed";
export interface BuildReviewFailure {
  readonly code: BuildReviewFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface BuildGlobalReviewPort {
  build(
    validated: ValidatedReview,
    projections: readonly GclProjection[],
    window: ReviewWindow,
    globalWorkspaceId: WorkspaceId,
  ): Promise<Result<GlobalReviewOutputs, BuildReviewFailure>>;
}

// --- (B6) BuildWorkspaceReviewPort — per-workspace committed plan ----------

export interface BuildWorkspaceReviewPort {
  build(
    validated: ValidatedReview,
    window: ReviewWindow,
    workspaceId: WorkspaceId,
  ): Promise<Result<KnowledgeMutationPlan, BuildReviewFailure>>;
}

// --- (B7) CommitReviewPort — KnowledgeWriter, idempotent replay ------------

export interface ReviewCommitSuccess {
  readonly revisionId: string;
  readonly replayed: boolean;
}
export type ReviewCommitFailureCode =
  | "schema_rejected"
  | "write_conflict"
  | "ownership_violation"
  | "secret_found"
  | "commit_failed";
export interface ReviewCommitFailure {
  readonly code: ReviewCommitFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}
export interface CommitReviewPort {
  commit(plan: KnowledgeMutationPlan): Promise<Result<ReviewCommitSuccess, ReviewCommitFailure>>;
}

// --- (B8) ReviewUpdateDashboardPort — rebuildable read-model, summary-only -------

export type ReviewUpdateDashboardErrorCode = "dashboard_failed";
export interface ReviewUpdateDashboardError {
  readonly code: ReviewUpdateDashboardErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}
export interface ReviewUpdateDashboardPort {
  update(payload: Record<string, unknown>): Promise<Result<void, ReviewUpdateDashboardError>>;
}

// --- (B9) ReviewNotifyPort — Tool Gateway telegram summary, envelope reuse -------

export interface ReviewNotifyResult {
  readonly status: "created" | "reused";
  readonly envelope: ExternalWriteEnvelope;
}
export type ReviewNotifyErrorCode = "held" | "approval_pending" | "conflict" | "rejected";
export interface ReviewNotifyError {
  readonly code: ReviewNotifyErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}
export interface ReviewNotifyPort {
  notify(
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ): Promise<Result<ReviewNotifyResult, ReviewNotifyError>>;
}

// --- (B10) PeriodReviewHealthSink — inv-5: the failure sink (7.5 shape) ----

export interface PeriodReviewFailure {
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly severity?: string;
  readonly message: string;
  readonly auditRef: AuditId;
}
export interface PeriodReviewSurfaceOutcome {
  readonly routedToHealth: boolean;
  readonly routedToOutbox: boolean;
}
export interface PeriodReviewHealthSinkError {
  readonly code: "surface_failed" | "outbox_failed";
  readonly message: string;
  readonly cause?: unknown;
}
export interface PeriodReviewHealthSink {
  surface(
    failure: PeriodReviewFailure,
  ): Promise<Result<PeriodReviewSurfaceOutcome, PeriodReviewHealthSinkError>>;
}

// ===========================================================================
// (C) The driver
// ===========================================================================

/**
 * The complete input to {@link runPeriodReview}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam. `period` + `intervalMs` +
 * `catchUpWindowMs` drive both the LIFE-2 collapse and the clock-jump-safe review
 * WINDOW. `globalWorkspaceId` is the Global/Coordination target. The committed
 * outputs are NOT caller-supplied — they are DERIVED inside the governed pipeline
 * from the VALIDATED review + the bound workspaces (inv-4).
 */
export interface PeriodReviewInput {
  readonly run: ResolveRunInput;
  readonly scheduleId: string;
  readonly period: ReviewPeriod;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly context: PeriodReviewContext;
}

/**
 * The injected dependency set: the period-review activity ports, the 7.5 health
 * sink, the 7.4 WorkflowRun repository (resolveRun), the 7.2 durable-schedule store,
 * and the injected Clock. Every dependency is a narrow port so the driver stays pure
 * and fully injected-testable.
 */
export interface PeriodReviewDeps {
  readonly refreshConnectors: ReviewRefreshConnectorsPort;
  readonly updateProjections: ReviewUpdateProjectionsPort;
  readonly agent: RunReviewAgentPort;
  readonly validate: ValidateReviewPort;
  readonly buildGlobal: BuildGlobalReviewPort;
  readonly buildWorkspace: BuildWorkspaceReviewPort;
  readonly commit: CommitReviewPort;
  readonly dashboard: ReviewUpdateDashboardPort;
  readonly notify: ReviewNotifyPort;
  readonly health: PeriodReviewHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly schedule: ScheduleStore;
  readonly clock: Clock;
}

/**
 * The result of a period-review drive. `state` is the machine state the pipeline
 * rested in (`done`, a failure/park state, or `no_run_due`). `context` is the final
 * threaded context (carries the computed `window`). `run`/`runReused` mirror
 * resolveRun. `collapsed` is true when MORE THAN ONE due occurrence collapsed into
 * one run (LIFE-2). `surfaced` names the health failure routed on a failure/park
 * branch. Never throws.
 */
export interface PeriodReviewOutcome {
  readonly state: PeriodReviewState;
  readonly context: PeriodReviewContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly collapsed: boolean;
  readonly surfaced?: PeriodReviewFailure;
}

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws);
 * an illegal edge stops the cursor at the last legal state rather than crashing,
 * keeping the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: PeriodReviewState,
  through: readonly PeriodReviewState[],
): PeriodReviewState {
  let cursor = from;
  for (const to of through) {
    const step = periodReviewMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

/** Map a period-review failure state to a §16 FailureClass for the health sink. */
function failureClassFor(state: PeriodReviewState): FailureClass {
  switch (state) {
    case "connector_stale":
      return "connector_unreachable";
    case "projection_stale":
      return "sync_lagging";
    case "provider_failed":
      return "write_through_failed";
    case "schema_rejected":
      return "schema_rejection";
    case "write_conflict":
      return "conflict_review";
    case "notify_failed":
      return "conflict_review";
    case "outbox_retry":
      return "write_through_failed";
    case "no_run_due":
      return "missed_or_late_schedule";
    default:
      return "write_through_failed";
  }
}

/**
 * Run the period-review pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. LIFE-2 catch-up: collapse (possibly many) missed period occurrences to a
 *      single run (NO run due ⇒ park in no_run_due; `collapsed` when >1).
 *   3. compute the CLOCK-JUMP-SAFE review WINDOW (the 7.11 seam) from the durable
 *      bookkeeping + the clock — never a naive wall subtraction (LIFE-5).
 *   4. refresh connectors — a stale/unreachable connector folds to connector_stale.
 *   5. update SANITIZED GCL projections through the Visibility Gate (inv-3,
 *      leakage-safe) — a gate rejection parks in projection_stale.
 *   6. run the review AgentJob over the GCL global scope + in-scope brains (Flow 2,
 *      inv-2) — a rejection folds to provider_failed (no commit).
 *   7. DERIVE-AND-VALIDATE EVERYTHING BEFORE ANY COMMIT (no-partial-commit, inv-4):
 *      validate the global + each per-workspace draft, derive their plans + the
 *      global dashboard + telegram. Any rejection HARD-STOPS at schema_rejected
 *      with ZERO commits.
 *   8. commit each per-workspace review to its OWN repo, then the global review to
 *      Global/Coordination (inv-4). Idempotent by planId (inv-5).
 *   9. update the dashboard read-model (a failure surfaces but does NOT block).
 *  10. send the telegram summary through the Tool Gateway (inv-4/inv-5).
 *  11. advance the durable schedule bookkeeping + done.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runPeriodReview(
  input: PeriodReviewInput,
  deps: PeriodReviewDeps,
): Promise<PeriodReviewOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run.
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: PeriodReviewState = "scheduled";
  let context: PeriodReviewContext = input.context;
  let collapsed = false;

  const surface = async (
    failState: PeriodReviewState,
    message: string,
  ): Promise<PeriodReviewOutcome> => {
    const failure: PeriodReviewFailure = {
      failureClass: failureClassFor(failState),
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route through the health sink — nothing fails silently (inv-5). Even if the
    // sink itself errors we still return the failure state (fail-closed).
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, collapsed, surfaced: failure };
  };

  // 2. LIFE-2 catch-up: collapse missed period occurrences to a SINGLE run (7.2).
  const bookkeeping = await deps.schedule.getBookkeeping(input.scheduleId);
  if (bookkeeping !== undefined) {
    const catchUp = collapsedNextRunFromClock(bookkeeping, deps.clock, {
      intervalMs: input.intervalMs,
      catchUpWindowMs: input.catchUpWindowMs,
    });
    if (catchUp.nextRun === null) {
      // Nothing catchable due — park in no_run_due with NO durable write (inv-1).
      state = advance(state, ["no_run_due"]);
      return surface(state, "no period-review run due — schedule not yet elapsed");
    }
    collapsed = catchUp.collapsed;
  }

  // 3. Compute the CLOCK-JUMP-SAFE review window (the 7.11 seam). Reuses the 7.2
  //    computeElapsed via computeReviewWindow — NEVER a naive wall subtraction
  //    (LIFE-5): a forward jump cannot balloon the window, a backward jump cannot
  //    invert it. A first-ever run (no bookkeeping) uses a wall-only fallback.
  const windowBookkeeping = bookkeeping ?? advanceBookkeeping(input.scheduleId, deps.clock);
  const window = computeReviewWindow(windowBookkeeping, deps.clock, {
    period: input.period,
    intervalMs: input.intervalMs,
  });
  state = advance(state, ["window_computed"]);
  context = { ...context, window };

  // 4. Refresh connectors. A stale/unreachable connector folds to connector_stale.
  const refreshed = await deps.refreshConnectors.refresh(context);
  if (!isOk(refreshed)) {
    state = advance(state, ["connectors_refreshed", "connector_stale"]);
    return surface(state, `connector refresh failed: ${refreshed.error.code}`);
  }
  state = advance(state, ["connectors_refreshed"]);
  context = { ...context, refreshedConnectors: refreshed.value.refreshedConnectors };

  // 5. Update SANITIZED GCL projections through the Visibility Gate (inv-3). A gate
  //    rejection (raw content present) or stale projection folds to
  //    projection_stale — NO raw cross-workspace content ever reaches the review.
  const projected = await deps.updateProjections.update(context);
  if (!isOk(projected)) {
    state = advance(state, ["projections_updated", "projection_stale"]);
    return surface(state, `projection update failed: ${projected.error.code}`);
  }
  state = advance(state, ["projections_updated"]);
  context = { ...context, projections: projected.value };

  // 6. Run the review AgentJob over the GCL global scope + in-scope brains (Flow 2,
  //    inv-2). The agent reads cross-workspace context ONLY through the sanitized
  //    projections on the context — never raw bodies.
  const reviewed = await deps.agent.run(context);
  if (!isOk(reviewed)) {
    state = advance(state, ["reviewed", "provider_failed"]);
    return surface(state, `review job rejected: ${reviewed.error.code}`);
  }
  state = advance(state, ["reviewed"]);
  const agentOutput = reviewed.value;

  // 7. DERIVE-AND-VALIDATE EVERYTHING BEFORE ANY COMMIT (no-partial-commit, inv-4).
  //    Validate the global + each per-workspace draft and derive their plans FIRST;
  //    a rejection ANYWHERE hard-stops at schema_rejected with ZERO commits.

  // 7a. Global draft: validate (inv-4 no-inference / schema).
  const validatedGlobal = deps.validate.validate(agentOutput.global);
  if (!isOk(validatedGlobal)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `global review rejected: ${validatedGlobal.error.code}`);
  }

  // 7b. Per-workspace reviews: validate draft + DERIVE plan stamped to the BOUND
  //     workspace (inv-4 / WS-2/WS-4) — NO commit yet.
  const workspacePlans: KnowledgeMutationPlan[] = [];
  for (const scope of context.scopes) {
    const draft = agentOutput.workspaceDrafts[String(scope.workspaceId)];
    if (draft === undefined) continue; // no per-workspace draft for this scope
    const validatedWs = deps.validate.validate(draft);
    if (!isOk(validatedWs)) {
      state = advance(state, ["schema_rejected"]);
      return surface(state, `workspace review rejected: ${validatedWs.error.code}`);
    }
    const wsPlan = await deps.buildWorkspace.build(validatedWs.value, window, scope.workspaceId);
    if (!isOk(wsPlan)) {
      state = advance(state, ["schema_rejected"]);
      return surface(state, `workspace review derivation failed: ${wsPlan.error.code}`);
    }
    workspacePlans.push(wsPlan.value);
  }

  // 7c. Global review: DERIVE plan + dashboard + telegram FROM the validated global
  //     draft + SANITIZED projections + the WINDOW + globalWorkspaceId (inv-3
  //     leakage-safe, inv-4). A derivation failure folds to schema_rejected BEFORE
  //     any commit — no partial commit.
  const built = await deps.buildGlobal.build(
    validatedGlobal.value,
    context.projections ?? [],
    window,
    input.globalWorkspaceId,
  );
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `global review derivation failed: ${built.error.code}`);
  }

  // 8. Commit each per-workspace review to its OWN repo (inv-4). Idempotent by
  //    planId (inv-5): a replay reuses the prior revision.
  const workspaceRevisions: Record<string, string> = {};
  for (const plan of workspacePlans) {
    const committedWs = await deps.commit.commit(plan);
    if (!isOk(committedWs)) {
      state = advance(state, ["write_conflict"]);
      return surface(state, `workspace review commit failed: ${committedWs.error.code}`);
    }
    workspaceRevisions[String(plan.workspaceId)] = committedWs.value.revisionId;
  }
  state = advance(state, ["workspace_reviews_committed"]);
  context = { ...context, workspaceRevisions };

  // 8b. Commit the global review to Global/Coordination (inv-4).
  const globalCommitted = await deps.commit.commit(built.value.plan);
  if (!isOk(globalCommitted)) {
    state = advance(state, ["global_review_committed", "write_conflict"]);
    return surface(state, `global review commit failed: ${globalCommitted.error.code}`);
  }
  state = advance(state, ["global_review_committed"]);
  context = { ...context, globalRevisionId: globalCommitted.value.revisionId };

  // 9. Update the dashboard read-model. A failure surfaces a health item but does
  //    NOT roll the durable Markdown commit back (like the 7.6 reindex) — the
  //    review stands; we continue.
  const dashboardUpdated = await deps.dashboard.update(built.value.dashboard);
  if (!isOk(dashboardUpdated)) {
    const dashboardFailure: PeriodReviewFailure = {
      failureClass: "write_through_failed",
      subjectRef: input.run.workflowId,
      message: `dashboard update failed (review stands): ${dashboardUpdated.error.code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(dashboardFailure);
    // Fall through — the commit is durable.
  }
  state = advance(state, ["dashboard_updated"]);

  // 10. Send the telegram summary through the Tool Gateway (inv-4/inv-5). No summary
  //     ⇒ done straight from dashboard_updated. A hold/conflict/rejected →
  //     outbox_retry (non-terminal); an approval-required send → notify_failed
  //     (fail-closed, no send).
  const notifyAction = built.value.notify;
  if (notifyAction === undefined) {
    state = advance(state, ["notified", "done"]);
    return { state, context, run: runResult, runReused, collapsed };
  }
  const sent = await deps.notify.notify(notifyAction.action, notifyAction.envelope);
  if (!isOk(sent)) {
    const code = sent.error.code;
    if (code === "approval_pending") {
      state = advance(state, ["notify_failed"]);
      return surface(state, "telegram summary requires approval");
    }
    state = advance(state, ["outbox_retry"]);
    return surface(state, `telegram summary held: ${code}`);
  }
  context = { ...context, notifyEnvelope: sent.value.envelope };

  // 11. Advance the durable schedule bookkeeping + done.
  await deps.schedule.put(advanceBookkeeping(input.scheduleId, deps.clock));
  state = advance(state, ["notified", "done"]);
  return { state, context, run: runResult, runReused, collapsed };
}

// Re-export the window type consumers may reference on the outcome context.
export type { ReviewWindow, ReviewPeriod };
