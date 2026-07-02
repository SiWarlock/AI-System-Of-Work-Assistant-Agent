// @sow/workflows — task 7.10: DAILY BRIEF — the PURE orchestration DRIVER.
//
// This is a sibling of the 7.6 meeting-closeout driver: the deterministic control
// driver that progresses a daily-brief run THROUGH a local dailyBriefMachine (no
// illegal edges; every transition guarded) over the INJECTED activity ports
// (src/ports/dailyBrief.ts), the injected Clock, the 7.5 health sink, and the 7.4
// idempotency seam (resolveRun). It reuses the 7.2 durable-schedule catch-up
// (collapsedNextRunFromClock) so a missed daily schedule COLLAPSES to ONE run
// (LIFE-2/LIFE-5) rather than a thundering herd of once-per-missed-occurrence runs.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER @temporalio
// NOR node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive
// through the injected ports + Clock, so it is Vitest-unit-testable with no Temporal
// server and safe to wrap in a thin @temporalio workflow later (that wrapper + its
// SOW_TEMPORAL integration test are the worker-wiring wave's job — NOT this file).
// Per-step idempotency KEYS + the derived committed outputs live in ACTIVITIES
// (node:crypto lives there); the driver only RECEIVES the derived result.
//
// The local dailyBriefMachine (defined here via the @sow/domain `defineMachine`
// primitive — @sow/domain does not ship a daily-brief machine, so this workflow
// owns its state alphabet, matching how the 6 domain machines are each defined) is
// PURE + TOTAL: legal edges return ok(to), illegal edges return a typed err — the
// machine never throws.
//
// §16 error convention: the driver NEVER throws across a boundary. It folds every
// typed port rejection onto a distinct dailyBriefMachine failure STATE and routes it
// through the health sink (inv-5: nothing fails silently). Never throws.
//
// 7.10 safety invariants this driver makes true:
//   inv-1  LIFE-2 collapse: a missed daily schedule collapses to ONE run; a wake
//          with nothing due parks in no_run_due with NO durable write.
//   inv-2  the briefing job runs through the broker port under a read-only tool
//          policy; a provider/egress/budget/admission rejection folds to
//          provider_failed — the job never runs / never commits.
//   inv-3  LEAKAGE-SAFE global brief (REQ-F-005/008): the global/coordination brief
//          reads cross-workspace context ONLY through SANITIZED GclProjections that
//          crossed the GCL Visibility Gate (authorizeCrossWorkspaceRawRead). A
//          projection failing the gate parks in projection_stale — NO raw
//          cross-workspace content ever reaches the global brief.
//   inv-4  DERIVE-FROM-VALIDATED: every committed plan is derived FROM the validated
//          brief (never caller-supplied) with `plan.workspaceId` stamped from the
//          BOUND workspace — the global brief to the Global/Coordination repo, each
//          workspace brief to its own repo (WS-2/WS-4). Semantic writes ONLY via
//          KnowledgeWriter; the telegram summary ONLY via the Tool Gateway envelope.
//   inv-5  idempotent replay: resolveRun reuses a seen run; a re-drive from the
//          start produces NO duplicate commit and NO duplicate external write; EVERY
//          failure class surfaces a distinct 7.5 health item.
import { isOk, ok } from "@sow/contracts";
import type {
  Result,
  WorkspaceId,
  WorkflowRunRef,
  ExternalWriteEnvelope,
  KnowledgeMutationPlan,
  FailureClass,
  AuditId,
} from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository, ScheduleStore } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { collapsedNextRunFromClock } from "../runtime/catchUpWindow";
import { advanceBookkeeping } from "../runtime/clock";
import type {
  DailyBriefContext,
  RefreshConnectorsPort,
  UpdateProjectionsPort,
  RunBriefingAgentPort,
  ValidateBriefPort,
  BuildGlobalBriefPort,
  BuildWorkspaceBriefPort,
  CommitBriefPort,
  UpdateDashboardPort,
  NotifyPort,
  DailyBriefHealthSink,
  DailyBriefFailure,
} from "../ports/dailyBrief";

// --- the local daily-brief state machine -----------------------------------

/** The full daily-brief state alphabet. */
export const DAILY_BRIEF_STATES = [
  // happy path
  "scheduled",
  "connectors_refreshed",
  "projections_updated",
  "briefed",
  "workspace_briefs_committed",
  "global_brief_committed",
  "dashboard_updated",
  "notified",
  // failure / recovery / park
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

export type DailyBriefState = (typeof DAILY_BRIEF_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Failure/park states each carry a
// pinned recovery/retry back-edge (a non-terminal state needs ≥1 outgoing edge) so
// the machine is total; the driver only walks the happy edges + the pinned
// failure-entry edges.
const dailyBriefTransitions: Readonly<Record<DailyBriefState, readonly DailyBriefState[]>> = {
  // scheduled → refresh connectors, OR park (nothing due, LIFE-2 collapse to zero).
  scheduled: ["connectors_refreshed", "no_run_due"],
  // connectors_refreshed → update projections, OR a stale connector.
  connectors_refreshed: ["projections_updated", "connector_stale"],
  // projections_updated → run the briefing agent, OR a stale/gate-rejected projection.
  projections_updated: ["briefed", "projection_stale"],
  // briefed → commit the workspace briefs, OR a provider failure, OR a validator /
  // derivation rejection (schema_rejected).
  briefed: ["workspace_briefs_committed", "provider_failed", "schema_rejected", "write_conflict"],
  // workspace_briefs_committed → commit the global brief, OR a write conflict, OR a
  // derivation rejection surfaced while building the global outputs.
  workspace_briefs_committed: ["global_brief_committed", "write_conflict", "schema_rejected"],
  // global_brief_committed → update the dashboard read-model.
  global_brief_committed: ["dashboard_updated", "write_conflict"],
  // dashboard_updated → send the telegram summary (dashboard failure does NOT block).
  dashboard_updated: ["notified", "notify_failed", "outbox_retry"],
  // notified → done.
  notified: ["done"],
  // park / recovery back-edges (non-terminal → ≥1 outgoing edge).
  no_run_due: ["scheduled"],
  connector_stale: ["connectors_refreshed"],
  projection_stale: ["projections_updated"],
  provider_failed: ["briefed"],
  schema_rejected: ["briefed"],
  write_conflict: ["workspace_briefs_committed"],
  notify_failed: ["notified"],
  outbox_retry: ["notified"],
  // terminal
  done: [],
};

export const dailyBriefMachine: StateMachine<DailyBriefState> =
  defineMachine<DailyBriefState>(dailyBriefTransitions);

// --- driver input ----------------------------------------------------------

/**
 * The complete input to {@link runDailyBrief}. `run` is the trigger submission
 * resolved idempotently through the 7.4 seam. `scheduleId`/`intervalMs`/
 * `catchUpWindowMs` drive the 7.2 collapsed catch-up (LIFE-2). `globalWorkspaceId`
 * is the Global/Coordination workspace the global brief commits to. `context` is
 * the bound workspace set (WS-2).
 *
 * The committed outputs (the per-workspace + global KnowledgeMutationPlans + the
 * telegram action) are NOT caller-supplied — they are DERIVED inside the governed
 * pipeline by the build ports from the VALIDATED brief + the bound workspaces, so
 * an inferred value can never reach a commit and each write targets the bound
 * workspace (inv-4).
 */
export interface DailyBriefInput {
  readonly run: ResolveRunInput;
  readonly scheduleId: string;
  readonly intervalMs: number;
  readonly catchUpWindowMs: number;
  readonly globalWorkspaceId: WorkspaceId;
  readonly context: DailyBriefContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the daily-brief activity ports, the 7.5 health sink,
 * the 7.4 WorkflowRun repository (resolveRun), the 7.2 durable-schedule store, and
 * the injected Clock. Every dependency is a narrow port so the driver stays pure and
 * fully injected-testable (no connectors / broker / KnowledgeWriter / Tool Gateway /
 * GCL gate / Temporal).
 */
export interface DailyBriefDeps {
  readonly refreshConnectors: RefreshConnectorsPort;
  readonly updateProjections: UpdateProjectionsPort;
  readonly agent: RunBriefingAgentPort;
  readonly validate: ValidateBriefPort;
  readonly buildGlobal: BuildGlobalBriefPort;
  readonly buildWorkspace: BuildWorkspaceBriefPort;
  readonly commit: CommitBriefPort;
  readonly dashboard: UpdateDashboardPort;
  readonly notify: NotifyPort;
  readonly health: DailyBriefHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly schedule: ScheduleStore;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a daily-brief drive. `state` is the machine state the pipeline
 * rested in (`done`, a failure/park state, or `no_run_due`). `context` is the final
 * threaded context. `run` is the resolveRun result; `runReused` mirrors its `reused`
 * flag. `collapsed` is true when MORE THAN ONE missed occurrence folded into the
 * single run (LIFE-2). `surfaced` names the health failure routed on a failure/park
 * branch (undefined on the happy path). Never throws.
 */
export interface DailyBriefOutcome {
  readonly state: DailyBriefState;
  readonly context: DailyBriefContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly collapsed: boolean;
  readonly surfaced?: DailyBriefFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never throws);
 * an illegal edge stops the cursor at the last legal state rather than crashing,
 * keeping the driver total (§16). Returns the last legal state reached.
 */
function advance(
  from: DailyBriefState,
  through: readonly DailyBriefState[],
): DailyBriefState {
  let cursor = from;
  for (const to of through) {
    const step = dailyBriefMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/** Map a daily-brief failure state to a §16 FailureClass for the health sink. */
function failureClassFor(state: DailyBriefState): FailureClass {
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

// --- driver ----------------------------------------------------------------

/**
 * Run the daily-brief pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for idempotent replay — inv-5):
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. LIFE-2 catch-up: collapse the (possibly many) missed daily occurrences to a
 *      single run via collapsedNextRunFromClock. Nothing due ⇒ park in no_run_due
 *      (NO durable write). One-or-many due ⇒ one run (`collapsed` iff >1).
 *   3. refresh connectors — a stale/unreachable connector folds to connector_stale.
 *   4. update the SANITIZED GCL projections through the Visibility Gate — a gate
 *      rejection / stale projection folds to projection_stale (inv-3, leakage-safe).
 *   5. run the briefing AgentJob over the GCL global scope + in-scope brains (Flow 2)
 *      — a rejection folds to provider_failed (no commit).
 *   6. validate the global draft (no-inference + schema) — a rejection → schema_rejected.
 *   7. derive + commit each per-workspace brief to its OWN repo (inv-4).
 *   8. derive + commit the global brief to the Global/Coordination repo (inv-4).
 *   9. update the dashboard read-model (a failure surfaces but does NOT block).
 *  10. send the telegram summary through the Tool Gateway (inv-4/inv-5).
 *  11. advance the durable schedule bookkeeping + done.
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runDailyBrief(
  input: DailyBriefInput,
  deps: DailyBriefDeps,
): Promise<DailyBriefOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run.
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: DailyBriefState = "scheduled";
  let context: DailyBriefContext = input.context;

  const surface = async (
    failState: DailyBriefState,
    message: string,
    collapsed: boolean,
  ): Promise<DailyBriefOutcome> => {
    const failure: DailyBriefFailure = {
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

  // 2. LIFE-2 catch-up: collapse missed daily occurrences to a SINGLE run. On the
  //    very first run (no bookkeeping) we treat the run as due (seed happens at the
  //    end). If bookkeeping exists, ask the 7.2 catch-up whether anything is due.
  let collapsed = false;
  const bookkeeping = await deps.schedule.getBookkeeping(input.scheduleId);
  if (bookkeeping !== undefined) {
    const catchUp = collapsedNextRunFromClock(bookkeeping, deps.clock, {
      intervalMs: input.intervalMs,
      catchUpWindowMs: input.catchUpWindowMs,
    });
    if (catchUp.nextRun === null) {
      // Nothing catchable is due — park in no_run_due with NO durable write (inv-1).
      state = advance(state, ["no_run_due"]);
      return surface(state, "no daily-brief run due — schedule not yet elapsed", false);
    }
    collapsed = catchUp.collapsed;
  }

  // 3. Refresh connectors. A stale/unreachable connector folds to connector_stale.
  const refreshed = await deps.refreshConnectors.refresh(context);
  if (!isOk(refreshed)) {
    state = advance(state, ["connectors_refreshed", "connector_stale"]);
    return surface(state, `connector refresh failed: ${refreshed.error.code}`, collapsed);
  }
  state = advance(state, ["connectors_refreshed"]);
  context = { ...context, refreshedConnectors: refreshed.value.refreshedConnectors };

  // 4. Update the SANITIZED GCL projections through the Visibility Gate (inv-3). A
  //    gate rejection (raw content present) or a stale projection folds to
  //    projection_stale — NO raw cross-workspace content ever reaches the brief.
  const projected = await deps.updateProjections.update(context);
  if (!isOk(projected)) {
    state = advance(state, ["projections_updated", "projection_stale"]);
    return surface(state, `projection update failed: ${projected.error.code}`, collapsed);
  }
  state = advance(state, ["projections_updated"]);
  context = { ...context, projections: projected.value };

  // 5. Run the briefing AgentJob over the GCL global scope + in-scope brains (Flow 2,
  //    inv-2). The agent reads cross-workspace context ONLY through the sanitized
  //    projections on the context — never raw bodies. A rejection folds to
  //    provider_failed (no commit).
  const briefed = await deps.agent.run(context);
  if (!isOk(briefed)) {
    state = advance(state, ["briefed", "provider_failed"]);
    return surface(state, `briefing job rejected: ${briefed.error.code}`, collapsed);
  }
  state = advance(state, ["briefed"]);
  const agentOutput = briefed.value;

  // 6. DERIVE-AND-VALIDATE EVERYTHING BEFORE ANY COMMIT (no-partial-commit, inv-4).
  //    All validation + plan derivation (per-workspace AND global) runs FIRST; only
  //    once every plan is derived does the driver start committing. So a validator
  //    rejection or a derivation failure ANYWHERE folds to schema_rejected with
  //    ZERO durable writes — no partially-committed brief set.
  //
  // 6a. Validate the global draft (inv-4 governance seam). A no-inference / schema
  //     rejection HARD-STOPS at schema_rejected.
  const validatedGlobal = deps.validate.validate(agentOutput.global);
  if (!isOk(validatedGlobal)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `global brief rejected: ${validatedGlobal.error.code}`, collapsed);
  }

  // 6b. Per-workspace briefs: validate each draft + DERIVE its plan stamped to the
  //     BOUND workspace (inv-4 / WS-2/WS-4) — NO commit yet.
  const workspacePlans: KnowledgeMutationPlan[] = [];
  for (const scope of context.scopes) {
    const draft = agentOutput.workspaceDrafts[String(scope.workspaceId)];
    if (draft === undefined) continue; // no per-workspace draft for this scope
    const validatedWs = deps.validate.validate(draft);
    if (!isOk(validatedWs)) {
      state = advance(state, ["schema_rejected"]);
      return surface(state, `workspace brief rejected: ${validatedWs.error.code}`, collapsed);
    }
    const wsPlan = await deps.buildWorkspace.build(validatedWs.value, scope.workspaceId);
    if (!isOk(wsPlan)) {
      state = advance(state, ["schema_rejected"]);
      return surface(state, `workspace brief derivation failed: ${wsPlan.error.code}`, collapsed);
    }
    workspacePlans.push(wsPlan.value);
  }

  // 6c. Global brief: DERIVE the plan + dashboard + telegram FROM the validated
  //     global draft + the SANITIZED projections + the passed globalWorkspaceId
  //     (inv-3 leakage-safe, inv-4). A derivation failure folds to schema_rejected
  //     BEFORE any commit — no partial commit.
  const built = await deps.buildGlobal.build(
    validatedGlobal.value,
    context.projections ?? [],
    input.globalWorkspaceId,
  );
  if (!isOk(built)) {
    state = advance(state, ["schema_rejected"]);
    return surface(state, `global brief derivation failed: ${built.error.code}`, collapsed);
  }

  // 7. Commit each per-workspace brief to its OWN repo (inv-4). Commits are
  //    idempotent (inv-5: a replay reuses them). A conflict → write_conflict.
  const workspaceRevisions: Record<string, string> = {};
  for (const plan of workspacePlans) {
    const committedWs = await commitPlan(deps, plan);
    if (!isOk(committedWs)) {
      state = advance(state, ["write_conflict"]);
      return surface(state, `workspace brief commit failed: ${committedWs.error}`, collapsed);
    }
    workspaceRevisions[String(plan.workspaceId)] = committedWs.value;
  }
  state = advance(state, ["workspace_briefs_committed"]);
  context = { ...context, workspaceRevisions };

  // 8. Commit the global brief to the Global/Coordination repo (inv-4).
  const globalCommitted = await commitPlan(deps, built.value.plan);
  if (!isOk(globalCommitted)) {
    state = advance(state, ["global_brief_committed", "write_conflict"]);
    return surface(state, `global brief commit failed: ${globalCommitted.error}`, collapsed);
  }
  state = advance(state, ["global_brief_committed"]);
  context = { ...context, globalRevisionId: globalCommitted.value };

  // 9. Update the dashboard read-model. A failure surfaces a health item but does
  //    NOT roll the durable Markdown commit back (like the 7.6 reindex) — the brief
  //    stands; we continue.
  const dashboardUpdated = await deps.dashboard.update(built.value.dashboard);
  if (!isOk(dashboardUpdated)) {
    const dashboardFailure: DailyBriefFailure = {
      failureClass: "write_through_failed",
      subjectRef: input.run.workflowId,
      message: `dashboard update failed (brief stands): ${dashboardUpdated.error.code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(dashboardFailure);
    // fall through — the commit is durable.
  }
  state = advance(state, ["dashboard_updated"]);

  // 10. Send the telegram summary through the Tool Gateway (inv-4/inv-5). No summary
  //     ⇒ done straight from dashboard_updated. A hold/conflict/rejected → outbox_retry
  //     (non-terminal); an approval-required send → notify_failed (fail-closed, no send).
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
      return surface(state, "telegram summary requires approval", collapsed);
    }
    state = advance(state, ["outbox_retry"]);
    return surface(state, `telegram summary held: ${code}`, collapsed);
  }
  state = advance(state, ["notified"]);
  context = { ...context, notifyEnvelope: sent.value.envelope };

  // 11. Advance the durable schedule bookkeeping to this run + terminal done. The
  //     advance is idempotent at a fixed clock reading (7.2), so a replay is a no-op.
  await deps.schedule.put(advanceBookkeeping(input.scheduleId, deps.clock));
  state = advance(state, ["done"]);
  return { state, context, run: runResult, runReused, collapsed };
}

// --- commit helper ---------------------------------------------------------

/**
 * Commit a derived plan through the KnowledgeWriter port, folding the typed failure
 * to a compact `Result<string, code>` (the revisionId on success). The driver maps
 * the failure code onto its own machine state. Never throws.
 */
async function commitPlan(
  deps: DailyBriefDeps,
  plan: KnowledgeMutationPlan,
): Promise<Result<string, string>> {
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) return { ok: false, error: committed.error.code };
  return ok(committed.value.revisionId);
}

// Re-export the envelope type consumers may reference on the outcome context.
export type { ExternalWriteEnvelope };
