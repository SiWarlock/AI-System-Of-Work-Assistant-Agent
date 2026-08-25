// @sow/workflows — task 13.14: /research — the SIMPLE governed research flow, the
// PURE orchestration DRIVER.
//
// A sibling of the 7.6-template drivers (copilotQa.ts, connectorSyncHealth.ts):
// the deterministic control driver that progresses ONE research query THROUGH a
// local researchMachine (no illegal edges; every transition guarded) over the
// INJECTED activity ports (src/ports/research.ts), the injected Clock, the
// shared 13.14 health sink, and the 7.4 idempotency seam (resolveRun).
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): this driver imports NEITHER
// @temporalio NOR node:crypto and calls NO Date.now()/Math.random(). All time +
// I/O arrive through the injected ports + Clock, so it is Vitest-unit-testable
// with no Temporal server. node:crypto (the plan's idempotency key) lives in the
// `buildResearchNotePlan.ts` ACTIVITY; this driver only RECEIVES the derived
// plan.
//
// ⛔ §ARM-RESEARCH: the RES-1 provider (13.13) is owner-gated behind a paid key.
// This driver NEVER binds a real provider — `deps.query` is an INJECTED SEAM
// (unbound/dormant in production until arming; a faked port in tests). Building
// this flow machinery discharges NOTHING about the arming crossing itself.
//
// 13.14 safety invariants this driver makes true (§7 RES-2, REQ-F-017/022):
//   inv-1  CANDIDATE-DATA GATE (safety rule 2): the driver NEVER writes Markdown
//          itself. It only receives an ALREADY-VALIDATED `ResearchDossier`
//          (`RunResearchQueryPort` schema-gates internally, mirroring
//          copilotQa's `SynthesizeAnswerPort`) and hands it to
//          `BuildResearchNotePlanPort`, which derives the KnowledgeMutationPlan
//          — never a caller-supplied plan.
//   inv-2  ONE WRITER (safety rule 1): the plan lands through the EXISTING
//          `CommitKnowledgePort` (KnowledgeWriter) — never a second writer.
//   inv-3  EGRESS VETO fail-closed (safety rule 5): a `egress_vetoed` query
//          failure parks in `query_failed` with NO plan built and NO commit
//          attempted — never a cloud fallback.
//   inv-4  no-inference (REQ-F-017): the plan is DERIVED from the dossier by the
//          activity, never assembled by this driver — no owner/date is ever
//          invented here.
//   inv-5  idempotent replay + nothing silent: resolveRun reuses a seen run; a
//          re-drive re-derives the SAME plan (the activity's key is stable);
//          EVERY failure class routes through the health sink.
import { isOk } from "@sow/contracts";
import type { Result, WorkflowRunRef, FailureClass, AuditId } from "@sow/contracts";
import { defineMachine } from "@sow/domain";
import type { StateMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import { commitFailureClass } from "./sourceIngestion";
import type {
  ResearchQuery,
  RunResearchQueryPort,
  BuildResearchNotePlanPort,
  CommitKnowledgePort,
  ResearchHealthSink,
  ResearchFailure,
} from "../ports/research";

// --- the local /research state machine --------------------------------------

/** The full /research state alphabet. */
export const RESEARCH_STATES = [
  // happy path
  "received",
  "queried",
  "planned",
  // failure / park
  "query_failed",
  "plan_failed",
  "commit_rejected",
  // terminal
  "done",
] as const;

export type ResearchState = (typeof RESEARCH_STATES)[number];

// Adjacency table. Terminal `done` maps to []. Each failure/park state carries a
// pinned recovery back-edge (a non-terminal state needs ≥1 outgoing edge) so the
// machine is total; the driver only walks the happy edges + the pinned
// failure-entry edges.
const researchTransitions: Readonly<Record<ResearchState, readonly ResearchState[]>> = {
  // received → a validated dossier, OR a query failure (provider/budget/egress/schema).
  received: ["queried", "query_failed"],
  // queried → a derived plan, OR a plan-derivation failure (path_escape).
  queried: ["planned", "plan_failed"],
  // planned → done (committed), OR a KnowledgeWriter rejection.
  planned: ["done", "commit_rejected"],
  // park / recovery back-edges (non-terminal → ≥1 outgoing edge).
  query_failed: ["received"],
  plan_failed: ["queried"],
  commit_rejected: ["planned"],
  // terminal
  done: [],
};

export const researchMachine: StateMachine<ResearchState> = defineMachine<ResearchState>(researchTransitions);

// --- driver input ------------------------------------------------------------

/** The complete input to {@link runResearch}. */
export interface ResearchInput {
  readonly run: ResolveRunInput;
  readonly query: ResearchQuery;
}

// --- injected dependencies ----------------------------------------------------

/**
 * The injected dependency set. Every dependency is a narrow port so the driver
 * stays pure and fully injected-testable (no GBrain / broker / KnowledgeWriter /
 * Temporal). `commit` is the EXISTING `CommitKnowledgePort` (imported from
 * ports/research.ts, itself re-exported from meetingCloseout.ts — never a
 * second writer, safety rule 1).
 */
export interface ResearchDeps {
  readonly query: RunResearchQueryPort;
  readonly buildPlan: BuildResearchNotePlanPort;
  readonly commit: CommitKnowledgePort;
  readonly health: ResearchHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome ------------------------------------------------------------

/** The result of a /research drive. Never throws. */
export interface ResearchOutcome {
  readonly state: ResearchState;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly revisionId?: string;
  readonly surfaced?: ResearchFailure;
}

// --- machine-transition helper -------------------------------------------------

/**
 * Advance the local machine cursor through an ORDERED list of successor states,
 * asserting each edge is legal. The domain machine is pure + total (never
 * throws); an illegal edge stops the cursor at the last legal state rather than
 * crashing, keeping the driver total (§16). Returns the last legal state reached.
 */
function advance(from: ResearchState, through: readonly ResearchState[]): ResearchState {
  let cursor = from;
  for (const to of through) {
    const step = researchMachine.transition(cursor, to);
    if (!isOk(step)) return cursor;
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) -----

/** Map a RES-1 query failure code to a §16 FailureClass, mirroring copilotQa's SynthesizeFailure mapping. */
function queryFailureClass(code: "provider_failed" | "budget_exceeded" | "egress_vetoed" | "schema_rejected"): FailureClass {
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
 * Run the /research pipeline as a pure, replay-safe driver.
 *
 * Order:
 *   1. resolveRun (7.4 seam) — a seen idempotencyKey reuses the existing run.
 *   2. RUN the RES-1 query (candidate-gated INSIDE the port — inv-1). A
 *      provider/budget/schema failure OR an egress veto folds to
 *      `query_failed` — fail-closed, never a cloud fallback (inv-3).
 *   3. DERIVE the single-note KnowledgeMutationPlan from the validated dossier
 *      (inv-4 — never assembled here). A `path_escape` derivation failure folds
 *      to `plan_failed`.
 *   4. COMMIT the plan through the EXISTING KnowledgeWriter port (inv-2). A
 *      rejection folds to `commit_rejected`, its FailureClass derived by the
 *      SHARED `commitFailureClass` mapper (contracts L119/L134 — one taxonomy,
 *      not a second copy).
 *
 * Every failure/park branch routes through the health sink (inv-5). Never throws.
 */
export async function runResearch(input: ResearchInput, deps: ResearchDeps): Promise<ResearchOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the run.
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  let state: ResearchState = "received";

  const surface = async (
    failState: ResearchState,
    failureClass: FailureClass,
    message: string,
  ): Promise<ResearchOutcome> => {
    const failure: ResearchFailure = {
      failureClass,
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(failure);
    return { state: failState, run: runResult, runReused, surfaced: failure };
  };

  // 2. RUN the RES-1 query — candidate-gated inside the port (inv-1). An
  //    egress veto is fail-closed here too (inv-3): NO plan is built, NO
  //    commit is attempted.
  const queried = await deps.query.run(input.query);
  if (!isOk(queried)) {
    state = advance(state, ["query_failed"]);
    return surface(state, queryFailureClass(queried.error.code), `research query failed: ${queried.error.code}`);
  }
  const dossier = queried.value;
  state = advance(state, ["queried"]);

  // 3. DERIVE the single-note plan from the VALIDATED dossier (inv-4 — never
  //    assembled by this driver).
  const built = await deps.buildPlan.build(dossier, input.query.workspaceId);
  if (!isOk(built)) {
    state = advance(state, ["plan_failed"]);
    return surface(state, "schema_rejection", `research note plan derivation failed: ${built.error.code}`);
  }
  const plan = built.value;
  state = advance(state, ["planned"]);

  // 4. COMMIT through the EXISTING KnowledgeWriter port (inv-2, safety rule 1
  //    — no second writer). A rejection's FailureClass comes from the SHARED
  //    mapper (L119/L134).
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) {
    state = advance(state, ["commit_rejected"]);
    return surface(
      state,
      commitFailureClass(committed.error.code),
      `research note commit failed: ${committed.error.code}`,
    );
  }
  state = advance(state, ["done"]);

  return { state, run: runResult, runReused, revisionId: committed.value.revisionId };
}
