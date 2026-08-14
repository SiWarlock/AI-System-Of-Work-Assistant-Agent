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
  KnowledgeMutationPlan,
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
  SourceBuildOutputsPort,
  CommitKnowledgePort,
  ProposeActionsPort,
  IndexGbrainPort,
  SourceHealthSink,
  SourceIngestionContext,
  SourceWorkflowFailure,
  SourceAgentFailureCode,
  KnowledgeCommitFailureCode,
  SourceLivingVaultPort,
  LivingVaultFailure,
  ProposeKnowledgeApprovalPort,
  ProposeKnowledgeApprovalResult,
  ProposeKnowledgeApprovalError,
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
  readonly buildOutputs: SourceBuildOutputsPort;
  readonly commit: CommitKnowledgePort;
  readonly propose: ProposeActionsPort;
  readonly index: IndexGbrainPort;
  readonly health: SourceHealthSink;
  readonly runs: WorkflowRunRefRepository;
  readonly clock: Clock;
  /**
   * 13.8d — the OPTIONAL living-vault rewrite seam (§6 KN-10: the vault rewrites itself around an
   * ingested source). UNBOUND skips the leg entirely. NOTE that the production Temporal wrapper ALWAYS
   * binds it (the sandbox cannot read boot config, so the arming gate lives in the activity, which
   * returns an empty plan set while unarmed): on that path the dormant cost is one inert activity call,
   * and every OBSERVABLE pipeline outcome — plans committed, health items, resting state — is identical
   * to pre-13.8d. "Unbound" remains the shape used by direct/unit drivers.
   * The strict `=== true` arming check lives at the COMPOSITION ROOT (worker boot), not here —
   * "logic-in-package, wire-at-boot": this driver only ever sees "bound or not".
   */
  readonly livingVault?: SourceLivingVaultPort;
  /**
   * 13.8i — OPTIONAL routing of a withheld PROPOSE-tier living-vault plan into a PENDING §9.8
   * Approval, completing 13.8d's tier split. Subordinate to `livingVault` (only ever consulted when
   * that leg is bound AND emits a plan with `requiresApproval !== false`), so unbound direct/unit
   * drivers need not fake it — mirrors `livingVault`'s own optionality. UNBOUND ⇒ a withheld plan's
   * mint attempt degrades to a typed failure (surfaced, never a silent drop, never a downgrade to
   * auto-commit) — see the withhold branch below.
   */
  readonly proposeKnowledgeApproval?: ProposeKnowledgeApprovalPort;
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
  /**
   * 13.8i (b) — the ordered ids of the living-vault AUTO-tier plans this run actually COMMITTED (the
   * one-action batch-undo unit) — NOT the producer's raw `IngestRewriteReceipt.planIds`, which would
   * also include a withheld PROPOSE plan's id even though nothing was written for it. Empty when the
   * living-vault leg is unbound or emitted nothing committable. No batch-undo executor consumes this
   * yet — tracked as a follow-up task (named at Step 9), not built here (L106).
   */
  readonly livingVaultPlanIds: readonly string[];
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
 * (inv-5 — distinct class per CAUSE, not just per resting state). Now that the OBS-2 taxonomy
 * has dedicated SECURITY / POLICY / EGRESS members (C-enum), each terminal safety cause is
 * classed HONESTLY (the C-fix least-wrong interims + their `arch_gap` markers are retired):
 *   • injection_detected (a prompt-injection / untrusted-content attack) → `security_violation`
 *   • admission_rejected (ING-7 mutating-tool refused at admission)      → `policy_denial`
 *   • egress_vetoed      (an egress-policy veto, safety rule 5)          → `egress_denied`
 *   • unsupported_type   (no processing path — a genuine schema/type reject) → `schema_rejection`
 *   • provider/budget failures are retryable                            → `write_through_failed`
 * The specific cause code additionally rides the surfaced MESSAGE (defense in depth).
 */
function agentFailureClass(code: SourceAgentFailureCode): FailureClass {
  switch (code) {
    case "provider_failed":
    case "budget_exceeded":
      // retryable (failed_retryable). NOTE: budget_exceeded could map to the dedicated
      // `budget_breach` member, but that is a non-terminal mapping out of this slice's scope.
      return "write_through_failed";
    case "injection_detected":
      return "security_violation";
    case "admission_rejected":
      return "policy_denial";
    case "egress_vetoed":
      return "egress_denied";
    case "unsupported_type":
    case "schema_rejected":
    default:
      return "schema_rejection";
  }
}

/**
 * Map a KnowledgeWriter commit failure CODE to the §16 FailureClass its surfaced health item
 * carries. A KnowledgeWriter refusing/failing a write is never `worker_down` (the worker is up).
 * With the C-enum taxonomy, the isolation + secret causes are classed HONESTLY (interims +
 * `arch_gap` markers retired):
 *   • secret_found              (a secret-scan refusal — a secret breach)       → `security_violation`
 *   • ownership_violation       (KN-7/KN-8 — a SECTION-ownership refusal: human-
 *                                 owned bytes changed/deleted/absorbed, or an
 *                                 untargeted assistant region's bytes moved, or
 *                                 markers malformed. ⛔ NOT workspace isolation —
 *                                 see @sow/knowledge ownership.ts's four
 *                                 conditions, 24.49)                            → `isolation_breach`
 *   • workspace_path_violation  (24.12/24.23 — a foreign-workspace note landing
 *                                 unprefixed, §5 WS-8. This one IS workspace
 *                                 isolation, and it earns `isolation_breach` on
 *                                 its OWN merits — ⛔ NOT by analogy to
 *                                 ownership_violation, which 24.23 wrongly cited
 *                                 as the same class. CRITICAL severity via
 *                                 defaultSeverityForFailureClass)               → `isolation_breach`
 *   • commit_failed / write_conflict (a generic/compare-revision write failure) → `write_through_failed`
 *   • schema_rejected                                                          → `schema_rejection`
 */
// Exported (13.8f-C) so meetingCloseout.ts's own sibling-plan commit loop shares the SAME
// KnowledgeCommitFailureCode → FailureClass taxonomy rather than a second, independently-drifting copy
// (contracts L119 — two copies of a mapping that must agree, with nothing tying them together).
export function commitFailureClass(code: KnowledgeCommitFailureCode): FailureClass {
  switch (code) {
    case "schema_rejected":
      return "schema_rejection";
    case "secret_found":
      return "security_violation";
    case "ownership_violation":
      return "isolation_breach";
    case "workspace_path_violation":
      return "isolation_breach";
    case "write_conflict":
      return "write_through_failed";
    case "commit_failed":
      return "write_through_failed";
    // 24.72 Leg B — POST-COMMIT record faults ⇒ `db_unavailable`, recorded as LEAST-WRONG, NOT as
    // correct (`contracts L18`: class by CAUSE, and name the limit rather than imply coverage).
    // ⛔ THIS REVERSES A DOCUMENTED DECISION made earlier in this slice. The first version returned
    // `write_through_failed` on the reason "the write-through ATTEMPT errored" — which CONTRADICTS
    // this task's own premise: the attempt SUCCEEDED and the Markdown is durable. A class asserting
    // the write failed is the same report inversion 24.72 exists to fix, one layer out.
    // The audit repo and the revision store ARE the §4 operational store, so `db_unavailable` is
    // cause-accurate when that store is genuinely unreachable.
    // ⚠ arch_gap — WHAT IT OVER-CLAIMS: a constraint violation or lock contention is NOT
    // unavailability, and both land here too. `db_unavailable` is the closest existing member of the
    // FROZEN §16 enum, not a description of every cause it now carries; the discriminating detail
    // survives in the `KnowledgeCommitFailureCode` and in the failure MESSAGE, never in the class.
    // ⚠ Relation to `### 24.80`: this PARTIALLY addresses it — these faults no longer share a class
    // (and therefore no longer share a `healthItemDedupeKey`, `${failureClass}|${subjectRef}`, 24.58)
    // with genuine `write_conflict` / `commit_failed` write-through failures, so an acknowledged
    // benign item can no longer absorb one of these. ⛔ It does NOT close 24.80: `audit_record_failed`
    // and `revision_record_failed` still share a class with EACH OTHER.
    case "audit_record_failed":
      return "db_unavailable";
    case "revision_record_failed":
      return "db_unavailable";
    default: {
      // A new KnowledgeCommitFailureCode member reaches here as a non-`never`
      // type → tsc error, forcing a deliberate class above. Never a `default:`
      // that silently absorbs a real reason (task 24.23 / L134).
      const _exhaustive: never = code;
      void _exhaustive;
      return "write_through_failed";
    }
  }
}

/**
 * 13.8i-B — map a propose-knowledge-approval outcome to the `reason` string + §16 FailureClass its
 * surfaced health item carries. `write_through_blocked` = a PRECONDITION HOLDS the write-through
 * (`not_armed` — no port bound at all, never attempted); `write_through_failed` = the write ATTEMPT
 * errored (`mint_failed`, or this driver's own test-only unbound/throw path, which folds to `undefined`).
 */
// Exported (13.8i-B) so meetingCloseout.ts's own sibling-plan propose loop shares the SAME mapping
// rather than a second, independently-drifting copy — the same precedent `commitFailureClass` set above
// (contracts L119).
export function proposeApprovalSurfaceInfo(
  proposed: Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError> | undefined,
): { readonly reason: string; readonly failureClass: FailureClass } {
  // TOTAL: the `isOk(proposed)` arm is unreachable BY CALLING CONVENTION (every call site only reaches
  // this helper from its own `else` of an `isOk` check) but the function stays total/never-throws (§16)
  // rather than assuming its caller's context — an ok result folds to the same safe default as unbound.
  if (proposed !== undefined && !isOk(proposed)) {
    return {
      reason: proposed.error.code,
      failureClass: proposed.error.code === "not_armed" ? "write_through_blocked" : "write_through_failed",
    };
  }
  return { reason: "propose_port_unbound_or_threw", failureClass: "write_through_failed" };
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
 * secret / workspace-path / commit failure is TERMINAL (a section-ownership,
 * workspace-isolation or secret breach never retries blindly — safety rules 4/7).
 * ⚠ The three are DISTINCT invariants and only the middle one is about workspaces:
 * ownership_violation is KN-7/KN-8 SECTION ownership, workspace_path_violation is
 * §5 WS-8, secret_found is rule 7 (24.49).
 */
function commitFailureState(code: KnowledgeCommitFailureCode): SourceState {
  switch (code) {
    case "write_conflict":
      return "failed_retryable";
    case "schema_rejected":
      return "rejected";
    case "ownership_violation":
      return "failed_terminal";
    case "secret_found":
      return "failed_terminal";
    case "workspace_path_violation":
      return "failed_terminal";
    case "commit_failed":
      return "failed_terminal";
    // ⛔ 24.72 Leg B — POST-COMMIT record faults are TERMINAL, and the reason is SEMANTIC rather
    // than a measurement, so it holds even if the reachability facts below change.
    // THE MARKDOWN WRITE SUCCEEDED; only its bookkeeping did not. The operator needs RECONCILE, not
    // RE-RUN, and `failed_retryable` would name the wrong remedy.
    // ⛔⛔ AND RETRY IS NOT MERELY USELESS HERE — IT IS THE DEFECT. An earlier draft of this note
    // claimed "the writer's idempotent replay returns `replayed:true` and writes nothing". THAT IS
    // FALSE FOR EXACTLY THESE TWO CODES, and the inversion is load-bearing:
    //   `applyPlan`'s replay guard keys on `deps.revisions.getByIdempotencyKey`, and the revision
    //   record is written LAST. `audit_record_failed` returns BEFORE `revisions.record` runs;
    //   `revision_record_failed` IS that call failing. ⇒ under BOTH codes NO revision record exists,
    //   so a second `applyPlan` with the same `kw:commit:${planId}` MISSES the replay guard and
    //   re-enters the full pipeline. At the RESOLVER-bound call site (semanticApprovalDispatch
    //   resolves the LIVE head) the compare-revision then PASSES, the diff is empty, and a SECOND
    //   AuditRecord is appended — 24.76's proven misdescribing-audit-row defect.
    // ⇒ the replay guard does NOT close this; terminal is what closes it. LOAD-BEARING, not cautious.
    // ⚠ SECOND, WEAKER REASON, recorded because it is the one that can go stale: nothing today
    // consumes a `failed_retryable` SourceState — it is a workflow-LOCAL variable NOT WRITTEN TO THE
    // OPERATIONAL STORE, and no caller reads `.state` today. ⚠ Stated precisely: it is NOT
    // "never persisted" — it is returned as `SourceIngestionOutcome.state`, so it lands in Temporal's
    // durable event history and is reachable via the run handle's result. What is measured is the
    // absence of a CONSUMER, not the absence of a record.
    // The domain machine's `failed_retryable → processing` back-edge also has no performer. A
    // terminal mapping is correct whether or not a re-driver is added later; a retryable mapping
    // would be safe only while that census stays true (24.85's measurement discipline, applied to a
    // taxonomy choice).
    // ⭐ This is also what preserves 24.76's Claim 2: a re-drivable post-commit fault plus the
    // deterministic `kw:commit:${planId}` idempotency key is exactly the misdescribing-audit-row
    // path that task proved and graded NOT LIVE.
    // ⛔⛔ DO NOT RELAX THIS IF `#79` RESOLVES AS "NO RE-DRIVE". Terminal was chosen to be correct
    // INDEPENDENT of that open question, and it is correct under BOTH branches:
    //   • `resume.ts` ledger-keyed (as measured) ⇒ it re-drives regardless of this state, so the
    //     mapping neither creates nor closes that path, and terminal stands on the reasons above.
    //   • `resume.ts` state-keyed anywhere ⇒ `failed_retryable` would hand it a LIVE re-drive into
    //     24.76's precondition, and terminal is MORE clearly right, not less.
    // ⚠ CORRECTED — an earlier draft of this block named a bare `resume.ts` as the coupling. That is
    // the WRONG SUBSYSTEM, and the bare filename was also AMBIGUOUS: `packages/workflows/src/runtime/
    // resume.ts` and `apps/worker/src/api/stream/resume.ts` both exist; the claim concerns the first.
    // Measured: `packages/workflows/src/runtime/resume.ts` cannot reach `applyPlan` (the loop skips
    // every non-`external_write` step, `recoverRun` has zero production callers, and nothing in
    // production constructs a `ResumeInput`). ⇒ THE COUPLING IS THE WRITER'S KEY ORDERING, described
    // above, and it therefore applies to ANY re-drive mechanism — Temporal retry, an operator re-run,
    // an approval re-dispatch — not to one subsystem. Naming `resume.ts` would send the next reader
    // to audit the one place it demonstrably is not.
    // ⇒ no resolution of the re-drive question licenses relaxing this to retryable (`contracts L146`:
    // ask what the conservative choice was incidentally preventing before correcting it away).
    case "audit_record_failed":
      return "failed_terminal";
    case "revision_record_failed":
      return "failed_terminal";
    default: {
      // A new KnowledgeCommitFailureCode member reaches here as a non-`never`
      // type → tsc error, forcing a deliberate state above. Never a `default:`
      // that silently absorbs a real reason (task 24.23 / L134).
      const _exhaustive: never = code;
      void _exhaustive;
      return "failed_terminal";
    }
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
  // 13.8i (b) — the ordered ids of living-vault plans this run actually COMMITS (populated in step
  // 7b, below). A plain mutable array so `surface`'s closure (defined before that step runs) always
  // reads whatever has been accumulated by the time any return fires — empty on every branch that
  // exits before step 7b, which is exactly correct (nothing committed yet).
  const livingVaultPlanIds: string[] = [];

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
    return { state: failState, context, run: runResult, runReused, surfaced: failure, livingVaultPlanIds };
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
  // Thread the PER-FILE source identity into the build so it derives a distinct content-addressed
  // note path + planId per dropped file (a fixed path collapses every file to one note). Narrow to
  // {sourceId, contentHash} — the derivation must never see origin/routingHints (injection surface).
  // 15.3: thread the GATE-VALIDATED note body (SourceEnvelope.body, already cleared the §8 gate) as
  // a SEPARATE param from the path-keying identity — the note BODY may use it, the note PATH never
  // does (deriveSourceNotePath keys only on {sourceId, contentHash}, so a hostile body can't traverse).
  const built = await deps.buildOutputs.build(
    validated.value,
    boundWorkspaceId,
    {
      sourceId: context.source.sourceId,
      contentHash: context.source.contentHash,
    },
    context.source.body,
  );
  if (!isOk(built)) {
    state = advance(state, ["proposed", "rejected"]);
    return surface(state, `output derivation failed: ${built.error.code}`);
  }
  const plan = built.value.plan;
  const actions = built.value.actions;

  // 6b. LIVING VAULT (13.8d / §6 KN-10) — derive the mutations that keep the REST of the vault true
  //     around this new source (entity updates + index/op-log parity), so ingestion is not merely
  //     "append one note". DORMANT BY DEFAULT: `livingVault` is optional and the shipped composition
  //     leaves it unbound (the strict `=== true` arming flag lives at the composition root), so the
  //     whole leg is skipped and the pipeline stays byte-equivalent to pre-13.8d.
  //
  //     BEST-EFFORT BY DESIGN: the derived source note is what this pipeline guarantees, so a rewrite
  //     that fails — or even THROWS, which a §16 port must not do but we refuse to trust — degrades to
  //     the single-note path rather than losing the ingest. The degrade is surfaced (inv-5: never
  //     silent) and, because it happens BEFORE any commit, it can never leave a partial write.
  const livingVaultPlans: KnowledgeMutationPlan[] = [];
  if (deps.livingVault !== undefined) {
    let rewritten: Result<readonly KnowledgeMutationPlan[], LivingVaultFailure> | undefined;
    try {
      rewritten = await deps.livingVault.rewrite(validated.value, boundWorkspaceId, {
        sourceId: context.source.sourceId,
        contentHash: context.source.contentHash,
      });
    } catch {
      // A thrown error carries an untrusted message (and possibly a path) — we deliberately keep it
      // out of the health item (safety rule 7) and record only the fact of the degrade.
      rewritten = undefined;
    }
    if (rewritten === undefined || !isOk(rewritten)) {
      const reason = rewritten === undefined ? "rewrite_threw" : rewritten.error.code;
      // `sync_lagging` mirrors the step-8 index/sync degrade: the committed truth stands while a
      // DERIVED view of it is now behind — here the vault's entity/index parity, there GBrain's.
      await deps.health.surface({
        failureClass: "sync_lagging",
        subjectRef: input.run.workflowId,
        message: `living-vault rewrite degraded (source note stands): ${reason}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
    } else {
      livingVaultPlans.push(...rewritten.value);
    }
  }

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

  // 7b. Commit the living-vault plans through the SAME KnowledgeWriter port (13.8d). Safety rule 1:
  //     the binding introduces NO second writer — it hands additional VALIDATED plans to the existing
  //     commit path, which re-runs the write gate on each. Ordered AFTER the source note so that note's
  //     revision is durable first; each plan is individually idempotent, so a re-drive replays.
  //     Empty on the shipped default (the leg above never ran), so this loop is a no-op.
  //
  //     ⛔ AUTO TIER ONLY. The living-vault planner emits up to TWO plans: an AUTO one (additive,
  //     derived, reversible) and a PROPOSE one carrying the human-relevant edits (§6 KN-10 tiered
  //     autonomy). A plan marked `requiresApproval` belongs to the §9.8 Approvals surface — committing
  //     it here would auto-apply exactly the class of edit the approval gate exists to hold. It is
  //     WITHHELD instead — NEVER falls through to commit regardless of what happens next.
  //     The test is strict `!== false`: an absent/unknown flag withholds (fail-closed — only an
  //     explicit auto-tier plan is auto-committed).
  //
  //     13.8i — completing the tier split: a withheld plan is no longer just COUNTED, it is ROUTED into
  //     a PENDING §9.8 Approval via the injected `proposeKnowledgeApproval` port (reusing the EXISTING
  //     copilotProposeKnowledgeSink minting at the worker composition root — never a second sink). The
  //     mint attempt keys on the IDENTICAL `!== false` predicate the withhold branch uses — a second,
  //     divergent condition here would be the bug. UNBOUND port, a rejected mint, OR a throw are ALL the
  //     SAME safe OUTCOME (the plan stays withheld and the fault is surfaced — never a downgrade to
  //     auto-commit), but 13.8i-B DISTINGUISHES them at the SURFACED failureClass: `not_armed` (no port
  //     bound at all — a PRECONDITION that was never satisfied) reads as `write_through_blocked`, every
  //     other case (a genuine `mint_failed` rejection, or this driver's own test-only unbound/throw path)
  //     reads as `write_through_failed` (an ATTEMPT that errored) — so an operator can tell "never armed"
  //     from "the sink genuinely rejected it." `not_armed` is a LIVE guard at the arming transition (see
  //     `createProposeKnowledgeApprovalActivity`, apps/worker/src/composition/living-vault.ts), not dead
  //     code: 13.8i-B binds `proposeKnowledgeApproval` unconditionally, so it fires only if a future
  //     `ProofSpineParams` construction site omits it while a PROPOSE-tier plan reaches this branch —
  //     exactly the misconfiguration an operator arming living-vault needs distinguished.
  //     Idempotency inherits the SAME assumption 13.8d's own AUTO-tier commit already makes (a re-drive
  //     replays because "each plan is individually idempotent") — the sink dedupes by the plan's own
  //     `planId`, unverified-but-unchanged from what this pipeline already relies on elsewhere.
  let queuedForApproval = 0;
  for (const livingVaultPlan of livingVaultPlans) {
    if (livingVaultPlan.requiresApproval !== false) {
      let proposed: Result<ProposeKnowledgeApprovalResult, ProposeKnowledgeApprovalError> | undefined;
      try {
        proposed =
          deps.proposeKnowledgeApproval === undefined
            ? undefined
            : await deps.proposeKnowledgeApproval.propose(livingVaultPlan, boundWorkspaceId);
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
          // plans collapse onto ONE item (last message wins, N-1 lost) — including N failures
          // of the SAME code. Run-anchored composite, NOT a bare planId: `newPlanId` has no
          // production binding yet, so a bare id would inherit whatever it is bound to at
          // arming. (`connectorSyncHealth` sets the per-item precedent; its bare connectorId
          // is right THERE because a connector is durable across runs — a plan is not.)
          //
          // ⛔ WHAT THIS COMPOSITE NEEDS FROM `newPlanId`, because the fix is only as good as
          // its binding and NOTHING enforces this today (`PlanIdSchema` requires only
          // non-empty-after-trim): the production binding MUST be (a) INJECTIVE WITHIN A RUN —
          // two plans of one run never share an id, or this silently degrades to the exact
          // collapse it exists to prevent, invisibly to these tests; (b) BOUNDED LENGTH — the
          // dedupe key is the health-item PRIMARY KEY on both dialects, so an oversized id
          // fails the `put` and the item is lost on the path whose purpose is visibility;
          // (c) DERIVED FROM NOTHING CONTENT-BEARING — this id reaches the renderer via
          // `UiSafeHealthItem.id`, a global surface that deliberately DROPS `message` as
          // content-bearing, so a title/slug-derived planId would leak a content fragment into
          // the one field on that shape assumed opaque. A constant binding already exists in
          // test scaffolding, so (a) is not hypothetical.
          subjectRef: `${input.run.workflowId}:${String(livingVaultPlan.planId)}`,
          message: `living-vault PROPOSE plan could not be queued for approval (withheld, never committed): ${reason}`,
          auditRef: input.run.workflowId as unknown as AuditId,
        });
      }
      continue; // NEVER falls through to commit, regardless of the mint outcome above
    }
    const extra = await deps.commit.commit(livingVaultPlan);
    if (!isOk(extra)) {
      // BEST-EFFORT, matching step 8: the source note's revision is already durable and the living
      // vault is an enrichment of it, so a parity-plan failure is surfaced (inv-5) and the pipeline
      // continues rather than failing a run whose primary output succeeded.
      await deps.health.surface({
        failureClass: commitFailureClass(extra.error.code),
        // 24.58 — PER-PLAN identity; see the propose branch above for the full reasoning.
        // Sharpest case here: `ownership_violation` and `workspace_path_violation` BOTH map
        // to `isolation_breach`, so two distinct breaches in one run previously produced the
        // identical key and the second silently upserted the first.
        subjectRef: `${input.run.workflowId}:${String(livingVaultPlan.planId)}`,
        message: `living-vault commit failed (source note stands): ${extra.error.code}`,
        auditRef: input.run.workflowId as unknown as AuditId,
      });
    } else {
      // 13.8i (b) — the batch-undo unit reflects what was ACTUALLY COMMITTED, not what the producer
      // merely emitted (a withheld PROPOSE plan has no revision to undo — see SourceIngestionOutcome's
      // own doc comment for why this is NOT `receipt.planIds` forwarded verbatim).
      livingVaultPlanIds.push(String(livingVaultPlan.planId));
    }
  }
  if (queuedForApproval > 0) {
    await deps.health.surface({
      failureClass: "conflict_review",
      subjectRef: input.run.workflowId,
      message: `living-vault queued ${queuedForApproval} plan(s) for §9.8 approval`,
      auditRef: input.run.workflowId as unknown as AuditId,
    });
  }

  // 8. Index GBrain / sync NotebookLM AFTER the commit — idempotent, and it NEVER
  //    rolls the commit back. An index/sync failure surfaces but the commit stands.
  const indexed = await deps.index.index(committed.value.revisionId);
  if (!isOk(indexed)) {
    const indexFailure: SourceWorkflowFailure = {
      // 24.58 CATEGORY 2 — ACCEPTED COLLAPSE, recorded rather than fixed (L82: not an
      // oversight). This shares `sync_lagging` + the run's subjectRef with the living-vault
      // rewrite degrade above, so if BOTH fire in one run they coalesce onto one item and
      // only this message survives. Deliberate: both are RUN-level "the primary output stands,
      // a derived view is behind" degrades, so a run-scoped identity is the honest one — unlike
      // the per-PLAN loop failures, which got per-plan identities. ⚠ Reachable only once the
      // living-vault leg is ARMED (unarmed ⇒ ok([]) ⇒ that branch never fires), so this is a
      // living-vault ARMING PRECONDITION: revisit at arming, not after the first armed run.
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
    return { state, context, run: runResult, runReused, livingVaultPlanIds };
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
  return { state, context, run: runResult, runReused, livingVaultPlanIds };
}
