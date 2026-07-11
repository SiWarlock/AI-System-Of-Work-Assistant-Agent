// @sow/workflows — task 7.7: SOURCE INGESTION — PURE orchestration DRIVER.
//
// A sibling of the 7.6 meeting-closeout driver: same two-layer structure (pure
// driver + injected activity ports), same foundation ports (Clock, the repos, the
// 7.5 health sink), same idempotency seam (resolveRun). It progresses a
// source-ingestion run THROUGH the @sow/domain `sourceMachine` (no illegal edges;
// every transition guarded) over INJECTED activity ports
// (src/ports/sourceIngestion.ts), an injected Clock, and the 7.5 health sink.
//
// ★ TWO-LAYER + SANDBOX (root CLAUDE.md): the driver imports NEITHER @temporalio NOR
// node:crypto and calls NO Date.now()/Math.random(). All time + I/O arrive through
// injected ports + Clock; per-step idempotency KEYS are computed in the ACTIVITIES
// (node:crypto lives there). It is Vitest-unit-testable with no Temporal server.
//
// The @sow/domain sourceMachine (DOMAIN_MODEL §Source):
//   captured → classified → (queued_for_review | processing) → proposed
//            → applied | rejected | failed_retryable | failed_terminal
// FORBIDDEN (structurally unrepresentable): captured→applied (skips classification +
// policy) and processing→external_write (the source agent cannot drive an external
// write — there is no external_write state at all). The driver walks ONLY the legal
// edges, so it can never author a forbidden transition.
//
// ★★ GOVERNANCE (the 7.6 lesson, applied identically here):
//  1. DERIVE-FROM-VALIDATED: the committed KnowledgeMutationPlan is DERIVED (via the
//     injected BuildOutputsPort) FROM the VALIDATED extraction (agent output that
//     passed the candidate-data gate + validateNoInference) — NEVER caller-supplied —
//     and its workspaceId is STAMPED from the routing-BOUND workspace, never a caller
//     value. An inferred owner/date is rejected at validate, so it can never reach a
//     commit.
//  2. Semantic writes ONLY via KnowledgeWriter (the commit port); external writes ONLY
//     via the Tool Gateway envelope (the propose port). No direct write adapter.
//  3. Idempotency/replay: resolveRun reuses a seen run; the whole driver is safe to
//     re-drive from the start (KnowledgeWriter idempotent-replay + Tool Gateway
//     envelope reuse).
//  4. Every failure/park class → a distinct 7.5 System Health item (nothing silent).
//     Workspace bound (routing high-confidence) before any durable write (WS-2).
//
// §16: the driver NEVER throws across a boundary. It folds each typed port rejection
// onto a distinct sourceMachine state + routes it through the health sink, and
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
import type { SourceState } from "@sow/domain";
import { sourceMachine } from "@sow/domain";
import type { Clock, WorkflowRunRefRepository } from "../ports/operational";
import { resolveRun } from "../runtime/idempotency";
import type { ResolveRunInput } from "../runtime/idempotency";
import type { WorkflowRunError } from "../runtime/workflowRun";
import type {
  RegisterSourcePort,
  RouteSourcePort,
  RunSourceAgentJobPort,
  ValidateExtractionPort,
  BuildOutputsPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  IndexGbrainPort,
  SourceHealthSink,
  SourceIngestionContext,
  SourceWorkflowFailure,
  SourceAgentFailureCode,
  KnowledgeCommitFailureCode,
} from "../ports/sourceIngestion";

// --- input -----------------------------------------------------------------

/**
 * The source-ingestion trigger input. The semantic outputs (plan + actions) are NOT
 * caller-supplied — they are DERIVED inside the pipeline by the BuildOutputsPort — so
 * the input is just the run submission + the pre-registration context (the raw source
 * to register). A caller cannot inject a plan or redirect the write target.
 */
export interface SourceIngestionInput {
  readonly run: ResolveRunInput;
  readonly context: SourceIngestionContext;
}

// --- injected dependencies -------------------------------------------------

/**
 * The injected dependency set: the source-ingestion activity ports, the 7.5 health
 * sink, the 7.4 WorkflowRun repository (for resolveRun's idempotency seam), and the
 * injected Clock. Every dependency is a narrow port so the driver stays pure and
 * fully injected-testable (no registerSource / broker / KnowledgeWriter / Tool
 * Gateway / Temporal).
 */
export interface SourceIngestionDeps {
  readonly register: RegisterSourcePort;
  readonly route: RouteSourcePort;
  readonly agent: RunSourceAgentJobPort;
  readonly validate: ValidateExtractionPort;
  readonly buildOutputs: BuildOutputsPort;
  readonly commit: CommitKnowledgePort;
  readonly propose: ProposeActionsPort;
  readonly index: IndexGbrainPort;
  readonly health: SourceHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
}

// --- driver outcome --------------------------------------------------------

/**
 * The result of a source-ingestion drive. `state` is the machine state the pipeline
 * rested in (the happy terminal `applied`, or a park/failure state). `context` is the
 * final threaded context (workspace stays undefined on a queued_for_review park —
 * inv-1). `run` is the resolveRun result; `runReused` mirrors resolveRun's `reused`
 * flag. `surfaced` names the health failure routed on a failure/park branch.
 */
export interface SourceIngestionOutcome {
  readonly state: SourceState;
  readonly context: SourceIngestionContext;
  readonly run: Result<WorkflowRunRef, WorkflowRunError>;
  readonly runReused: boolean;
  readonly surfaced?: SourceWorkflowFailure;
}

// --- machine-transition helper ---------------------------------------------

/**
 * Walk an ORDERED list of successor states, asserting each edge is legal. The domain
 * machine is pure + total (never throws); an illegal edge returns a typed error.
 * Since the driver only ever walks edges the DOMAIN_MODEL pins, a rejection here is a
 * programming error, not a runtime condition — we surface the failure STATE itself
 * rather than crash, keeping the driver total. Returns the last legal state reached
 * (so a mis-pinned edge cannot silently "teleport" the cursor past a forbidden edge —
 * captured→applied would stop at captured, never reach applied).
 */
function advance(
  from: SourceState,
  through: readonly SourceState[],
): SourceState {
  let cursor = from;
  for (const to of through) {
    const step = sourceMachine.transition(cursor, to);
    if (!isOk(step)) {
      return cursor;
    }
    cursor = step.value;
  }
  return cursor;
}

// --- failure-class mapping (inv-5: distinct health item per failure class) --

/**
 * Map a source-ingestion resting STATE to a §16 FailureClass — the DEFAULT used for the
 * non-terminal park/failure states. `failed_terminal` is deliberately NOT classed here
 * from the state alone: it conflates several distinct causes (a register-malformed schema
 * reject, an ING-7/injection/egress agent terminal, an ownership/secret/commit write
 * failure), so every terminal call site passes an explicit CAUSE-derived class (see
 * {@link agentFailureClass} / {@link commitFailureClass} + the register-malformed site).
 * `worker_down` is RESERVED for a genuine supervision/infra failure, which this driver
 * never produces as a terminal cause — so the `failed_terminal` fallback below (never hit
 * today; a guard for a future un-classed terminal site) is the generic write_through_failed,
 * NOT worker_down. inv-5: a distinct health class per CAUSE, not per resting state.
 */
function failureClassFor(state: SourceState): FailureClass {
  switch (state) {
    case "queued_for_review":
      return "conflict_review";
    case "rejected":
      return "schema_rejection";
    case "failed_retryable":
      return "write_through_failed";
    case "failed_terminal":
    default:
      return "write_through_failed";
  }
}

/**
 * Map a source-agent failure CODE to the §16 FailureClass its surfaced health item carries
 * (inv-5 — distinct class per CAUSE, not just per resting state). A source-processing job
 * that failed at the candidate/policy gate produced NO valid candidate → `schema_rejection`;
 * provider/budget failures are retryable → `write_through_failed`. The specific cause code
 * additionally rides the surfaced MESSAGE, so it is never lost where the class is a coarser
 * bucket.
 *
 * arch_gap: the frozen `FailureClass` enum (shared-enums.ts) has NO dedicated SECURITY /
 * EGRESS member, so `injection_detected` (a prompt-injection / untrusted-content attack) and
 * `egress_vetoed` (an egress-policy denial) use the least-wrong `schema_rejection` — which
 * UNDERSTATES a security/egress cause to a class-filtering operator. Pending a frozen-contract
 * FailureClass expansion (a `security_violation`/`policy_denial`-style member — the
 * policy_denial/egress_status named-constant precedent); the cause rides the message meanwhile.
 */
function agentFailureClass(code: SourceAgentFailureCode): FailureClass {
  switch (code) {
    case "provider_failed":
    case "budget_exceeded":
      // retryable (failed_retryable) — unchanged. arch_gap: budget_exceeded could map to the
      // dedicated `budget_breach` member, but that is a non-terminal mapping out of this fix's scope.
      return "write_through_failed";
    case "admission_rejected":
    case "unsupported_type":
    case "injection_detected": // arch_gap: no SECURITY FailureClass member — understated as schema_rejection
    case "egress_vetoed": // arch_gap: no EGRESS/policy FailureClass member — understated as schema_rejection
    case "schema_rejected":
    default:
      return "schema_rejection";
  }
}

/**
 * Map a KnowledgeWriter commit failure CODE to the §16 FailureClass its surfaced health item
 * carries. A KnowledgeWriter refusing or failing a write is a WRITE-THROUGH failure, never
 * `worker_down` (the worker is up; the write was refused/failed): compare-revision conflict,
 * ownership refusal, secret-scan refusal, and a generic commit failure all → `write_through_failed`.
 * A schema reject → `schema_rejection`.
 *
 * arch_gap: `ownership_violation` (a WS-isolation refusal) and `secret_found` (a secret-breach
 * refusal) have no dedicated ISOLATION / SECURITY FailureClass member — least-wrong
 * `write_through_failed` UNDERSTATES them; pending a frozen-contract FailureClass expansion. The
 * cause rides the surfaced message meanwhile (safety rules 4/7).
 */
function commitFailureClass(code: KnowledgeCommitFailureCode): FailureClass {
  switch (code) {
    case "schema_rejected":
      return "schema_rejection";
    case "write_conflict":
    case "ownership_violation": // arch_gap: no ISOLATION FailureClass member — understated as write_through_failed
    case "secret_found": // arch_gap: no SECURITY FailureClass member — understated as write_through_failed
    case "commit_failed":
    default:
      return "write_through_failed";
  }
}

/**
 * Map a source-agent failure code to the sourceMachine resting state it folds to.
 * Terminal safety classes (ING-7 admission, injection, unsupported type, egress veto)
 * are TERMINAL failures (never retried blindly); provider/budget are retryable; a
 * broker candidate-gate rejection is `rejected` (a schema failure, not a retry).
 */
function agentFailureState(code: SourceAgentFailureCode): SourceState {
  switch (code) {
    case "admission_rejected":
    case "injection_detected":
    case "unsupported_type":
    case "egress_vetoed":
      return "failed_terminal";
    case "schema_rejected":
      return "rejected";
    case "provider_failed":
    case "budget_exceeded":
    default:
      return "failed_retryable";
  }
}

/**
 * Map a KnowledgeWriter commit failure to the resting state. A compare-revision
 * `write_conflict` is retryable; a schema rejection is `rejected`; an ownership /
 * secret / commit failure is TERMINAL (a WS-isolation or secret breach never retries
 * blindly — safety rules 4/7).
 */
function commitFailureState(code: KnowledgeCommitFailureCode): SourceState {
  switch (code) {
    case "write_conflict":
      return "failed_retryable";
    case "schema_rejected":
      return "rejected";
    case "ownership_violation":
    case "secret_found":
    case "commit_failed":
    default:
      return "failed_terminal";
  }
}

// --- driver ----------------------------------------------------------------

/**
 * Run the source-ingestion pipeline as a pure, replay-safe driver.
 *
 * Order (each durable step keyed for inv-5):
 *  1. resolve the run idempotently (7.4) — a seen key reuses the run.
 *  2. REGISTER the SourceEnvelope BEFORE extraction (Flow 4 / REQ-F-010). A
 *     `dedupe_hit` is a NO-OP (rejected, no reprocessing); a malformed source is
 *     failed_terminal. The initial machine state after a fresh register is `captured`.
 *  3. ROUTE/classify (inv-1 / WS-2). HIGH-confidence binds the workspace and advances
 *     to `processing`; LOW-confidence parks in `queued_for_review` (Ingestion Inbox)
 *     with NO workspace guess + NO durable write; the router NEVER auto-routes.
 *  4. run the source-processing AgentJob under a READ-ONLY ToolPolicy (ING-7) — a
 *     mutating tool is rejected at admission; injection/unsupported → failed_terminal;
 *     provider/budget → failed_retryable; schema → rejected.
 *  5. validate the candidate (inv-3) — an inferred/schema rejection → rejected, NO
 *     partial commit.
 *  6. DERIVE outputs (plan + external actions) from the validated extraction + bound
 *     workspace (BuildOutputsPort) — derivation failure → rejected, NO partial commit.
 *  7. commit the DERIVED plan via KnowledgeWriter — conflict → failed_retryable;
 *     ownership/secret → failed_terminal; success mints a revision (idempotent replay).
 *  8. index GBrain / sync NotebookLM AFTER the commit — failure surfaces but NEVER
 *     rolls the commit back.
 *  9. dispatch external actions via the Tool Gateway — approval/held → failed_retryable
 *     (fail-closed, re-drivable via the outbox); success advances to `applied`.
 *
 * Every failure/park branch routes through the health sink (inv-5) and returns the
 * resting machine state. Never throws.
 */
export async function runSourceIngestion(
  input: SourceIngestionInput,
  deps: SourceIngestionDeps,
): Promise<SourceIngestionOutcome> {
  // 1. Resolve the run idempotently (7.4). A seen idempotencyKey reuses the existing
  //    run — the whole pipeline is safe to re-drive from the start (inv-5 / LIFE-3).
  const resolved = await resolveRun(input.run, deps.runs, deps.clock);
  const runResult: Result<WorkflowRunRef, WorkflowRunError> = isOk(resolved)
    ? { ok: true, value: resolved.value.run }
    : resolved;
  const runReused = isOk(resolved) ? resolved.value.reused : false;

  // The machine cursor starts at the initial state.
  let state: SourceState = "captured";
  let context: SourceIngestionContext = input.context;

  const surface = async (
    failState: SourceState,
    message: string,
    // The §16 class. Non-terminal callers omit it (the state-based default is correct);
    // every terminal (failed_terminal) caller passes an explicit CAUSE-derived class
    // (inv-5) because failed_terminal conflates distinct causes — see failureClassFor.
    failureClass: FailureClass = failureClassFor(failState),
  ): Promise<SourceIngestionOutcome> => {
    const failure: SourceWorkflowFailure = {
      failureClass,
      subjectRef: input.run.workflowId,
      message,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    // Route the failure through the 7.5 health sink (inv-5). We fail-closed on the
    // machine state regardless of the sink's own result — a failure to record a
    // failure is the sink's concern, not a reason to lose the machine state.
    await deps.health.surface(failure);
    return { state: failState, context, run: runResult, runReused, surfaced: failure };
  };

  // 2. REGISTER the SourceEnvelope BEFORE any extraction (Flow 4 / REQ-F-010).
  const registered = await deps.register.register(context);
  if (!isOk(registered)) {
    // A malformed source never becomes a durable source — terminal.
    // A register-MALFORMED reject is a DATA-validation failure (schema_rejection), NOT the
    // worker being down. There is no captured→rejected machine edge, so it rests at
    // failed_terminal — with the CAUSE-correct class (inv-5; drains the C1 Finding).
    return surface(
      "failed_terminal",
      `source registration failed: ${registered.error.code}`,
      "schema_rejection",
    );
  }
  if (registered.value.outcome === "dedupe_hit") {
    // Flow-4 dedupe-hit: the contentHash is already known — a NO-OP. No routing, no
    // extraction, no durable write. Surfaced so the no-op is not silent (inv-5).
    return surface("rejected", `source dedupe-hit (no-op): ${registered.value.contentHash}`);
  }
  // Fresh source registered → the source is `captured` (starting cursor).
  context = { ...context, source: registered.value.envelope };

  // 3. ROUTE/classify (inv-1 / WS-2). A router error OR low-confidence outcome parks
  //    in queued_for_review with NO workspace guess and NO durable write.
  const routed = await deps.route.route(context);
  if (!isOk(routed)) {
    state = advance(state, ["classified", "queued_for_review"]);
    return surface(state, `source routing failed: ${routed.error.code}`);
  }
  const routing = routed.value;
  state = advance(state, ["classified"]);
  context = { ...context, routing };
  if (routing.confidence === "low") {
    // Parked in the Ingestion Inbox — workspace stays UNBOUND (inv-1). The router
    // NEVER auto-routes a low-confidence source.
    state = advance(state, ["queued_for_review"]);
    return surface(state, "source routing low-confidence — parked in the Ingestion Inbox");
  }
  // HIGH confidence: bind the workspace BEFORE any durable write (inv-1 / WS-2). We
  // capture the bound workspace in a local so the derived plan's workspace is provably
  // the routing-bound one (not a caller value) — the WS-2/WS-4 anchor buildOutputs
  // stamps onto the plan.
  const boundWorkspaceId = routing.workspaceId;
  context = { ...context, workspaceId: boundWorkspaceId };

  // classified → processing (the source-processing job runs on the bound-workspace
  // context). This is the ONLY path to processing — a forbidden captured→applied edge
  // is structurally impossible.
  state = advance(state, ["processing"]);

  // 4. Run the source-processing AgentJob under a READ-ONLY ToolPolicy (ING-7). A
  //    mutating tool is refused at admission; injection/unsupported → terminal;
  //    provider/budget → retryable; schema → rejected. The job may emit ONLY a
  //    plan/proposal — it can NEVER drive an external write (no such machine edge).
  const extracted = await deps.agent.run(context);
  if (!isOk(extracted)) {
    // processing → proposed is the only legal edge out of processing; the failure
    // disposition then resolves off proposed (proposed → rejected | failed_*).
    const failState = agentFailureState(extracted.error.code);
    state = advance(state, ["proposed", failState]);
    return surface(
      state,
      `source-processing job failed: ${extracted.error.code}`,
      agentFailureClass(extracted.error.code),
    );
  }
  context = { ...context, extraction: extracted.value };

  // 5. Validate the candidate (inv-3). An inferred field (no-inference) or a schema
  //    failure HARD-STOPS with NO KnowledgeWriter commit and NO external write.
  const validated = deps.validate.validate(extracted.value);
  if (!isOk(validated)) {
    state = advance(state, ["proposed", "rejected"]);
    return surface(state, `extraction rejected: ${validated.error.code}`);
  }
  context = { ...context, validated: validated.value };

  // 6. DERIVE the committed outputs FROM the validated extraction + the routing-bound
  //    workspace (the governance seam — closes the no-inference / workspace-isolation
  //    bypass). The plan is NEVER caller-supplied; `plan.workspaceId` is stamped from
  //    boundWorkspaceId. A derivation failure folds to `rejected` with NO partial
  //    commit (buildOutputs runs BEFORE any durable write).
  const built = await deps.buildOutputs.build(validated.value, boundWorkspaceId);
  if (!isOk(built)) {
    state = advance(state, ["proposed", "rejected"]);
    return surface(state, `output derivation failed: ${built.error.code}`);
  }
  const plan = built.value.plan;
  const actions = built.value.actions;

  // The candidate is now a proposal (validated + derived).
  state = advance(state, ["proposed"]);

  // 7. Commit the DERIVED semantic output via KnowledgeWriter (the SOLE Markdown
  //    writer). IDEMPOTENT by the plan's key (inv-5): a replay reuses the prior
  //    revision. A conflict → failed_retryable; ownership/secret → failed_terminal.
  const committed = await deps.commit.commit(plan);
  if (!isOk(committed)) {
    const failState = commitFailureState(committed.error.code);
    state = advance(state, [failState]);
    return surface(
      state,
      `knowledge commit failed: ${committed.error.code}`,
      commitFailureClass(committed.error.code),
    );
  }
  context = { ...context, revisionId: committed.value.revisionId };

  // 8. Index GBrain / sync NotebookLM AFTER the commit — idempotent, and it NEVER
  //    rolls the commit back. An index/sync failure surfaces but the commit stands.
  const indexed = await deps.index.index(committed.value.revisionId);
  if (!isOk(indexed)) {
    const indexFailure: SourceWorkflowFailure = {
      failureClass: "sync_lagging",
      subjectRef: input.run.workflowId,
      message: `GBrain index/sync failed (commit stands): ${indexed.error.code}`,
      auditRef: input.run.workflowId as unknown as AuditId,
    };
    await deps.health.surface(indexFailure);
    // Fall through — the commit is durable, so ingestion continues.
  }

  // No external actions ⇒ the proposal is applied straight from the commit.
  if (actions.length === 0) {
    state = advance(state, ["applied"]);
    return { state, context, run: runResult, runReused };
  }

  // 9. External-action stage: every external write goes through the Tool Gateway
  //    propose port. An approval-required or held action FAILS CLOSED to
  //    failed_retryable (re-drivable via the outbox) — no blind write.
  const appliedEnvelopes: ExternalWriteEnvelope[] = [];
  for (const item of actions) {
    const proposed = await deps.propose.propose(item.action, item.envelope);
    if (!isOk(proposed)) {
      const code = proposed.error.code;
      state = advance(state, ["failed_retryable"]);
      return surface(state, `external action held (${code}) — re-drivable via outbox`);
    }
    appliedEnvelopes.push(proposed.value.envelope);
  }
  context = { ...context, envelopes: [...context.envelopes, ...appliedEnvelopes] };

  // Applied (happy terminal).
  state = advance(state, ["applied"]);
  return { state, context, run: runResult, runReused };
}
