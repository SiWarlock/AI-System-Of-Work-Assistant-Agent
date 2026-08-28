// @sow/workflows — task 25.2/25.3/25.4 (PKG-W3) ACTIVITY: a GENERIC read-only
// AgentJob runner, reused across the four output-workflow families' model-
// synthesis legs (RunBriefingAgentPort, ReviewAgentPort, SynthesizeNarrativePort,
// ProposeWindowsAgentPort). Sibling of the 7.6 `runAgentJob.ts` (which is
// MEETING-CLOSEOUT-specific — untrusted transcript, its own port types); this one
// is generic over the pipeline Ctx + candidate Output because all four families
// build a READ-ONLY job over ALREADY-SANITIZED context (deterministic facts /
// GCL-gated projections / busy-free windows) — never raw untrusted content — so
// one shared core is correct rather than four near-duplicates.
//
// This is an ACTIVITY, NOT workflow code — it MAY use @sow/policy admission +
// the @sow/providers Broker. It takes ALL effects INJECTED (the Broker, the
// per-family job-assembly inputs, the egress/matrix/workspace builders, the
// candidate mapper) so it is Vitest-unit-testable with fakes and never touches a
// real network in the module.
//
// SAFETY (inv-2, defense in depth): even though every caller already builds a
// read-only ToolPolicy over sanitized data, the activity STILL runs the job
// through the ING-7 admission predicate (@sow/policy `admitJob`) before
// dispatch — a job that somehow declared a mutating tool is refused at
// admission, never reaching the Broker. The Broker re-runs admission internally
// too (defense in depth, matching runAgentJob.ts's own posture).
//
// §16: returns a typed Result — never throws. A Broker rejection folds onto the
// closed {@link ReadOnlyAgentFailureCode} set.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  AgentJob,
  AgentJobId,
  WorkflowId,
  WorkspaceId,
  Capability,
  ProviderRoute,
  ContextRef,
  EgressPolicy,
  ProviderMatrix,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import { admitJob, isDeny } from "@sow/policy";
import type { PolicyDecision, LocalProviderConfig } from "@sow/policy";
import type {
  BrokerJobRequest,
  BrokerOutcome,
  BrokerStage,
  BrokerRejection,
} from "@sow/providers";
import type { ToolPolicy } from "@sow/contracts";

/** The narrow Broker surface this activity dispatches through (injected). */
export interface ReadOnlyAgentBroker {
  runJob(req: BrokerJobRequest, signal?: AbortSignal): Promise<BrokerOutcome>;
}

/**
 * The typed inputs from which the read-only AgentJob is assembled. Every job
 * built here is `mode: "read_only"` / `allowsMutating: false` and carries
 * `trustLevel: "trusted"` / `carriesRawContent: false` — the context it reads is
 * ALREADY sanitized (a GCL-gated projection, a deterministic progress fact set,
 * a sanitized busy/free window set), never a raw untrusted body (that is the
 * meeting-closeout leg's job, not this one's).
 */
export interface ReadOnlyAgentJobInputs {
  readonly workflowRunId: WorkflowId;
  readonly workspaceId: WorkspaceId;
  readonly capability: Capability | string;
  readonly outputSchemaId: string;
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd?: number;
  readonly idempotencyKey: string;
  readonly jobId?: string;
  readonly contextRefs?: readonly ContextRef[];
  readonly providerRoute?: ProviderRoute;
}

/**
 * Closed, enumerable failure set (§16 — never thrown) — IDENTICAL across all
 * four families' widened port failure-code unions (see the 25.2/25.3/25.4
 * "WIDENED" notes on ports/dailyBrief.ts, workflows/periodReview.ts,
 * ports/projectSync.ts) so this ONE core satisfies every one of them directly.
 */
export type ReadOnlyAgentFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded"
  | "admission_rejected";

export interface ReadOnlyAgentFailure {
  readonly code: ReadOnlyAgentFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** Injected deps for the generic read-only agent-job activity. */
export interface ReadOnlyAgentJobDeps<Ctx, Output> {
  readonly broker: ReadOnlyAgentBroker;
  readonly inputs: ReadOnlyAgentJobInputs;
  readonly buildEgress: (ctx: Ctx) => EgressPolicy;
  readonly buildMatrix: (ctx: Ctx) => ProviderMatrix;
  readonly buildWorkspace: (
    ctx: Ctx,
  ) => { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
  /** Maps the Broker's ACCEPTED candidate → the family's output shape. */
  readonly mapCandidate: (outcome: BrokerOutcome) => Output;
  readonly localConfig?: LocalProviderConfig;
  /** Maps a Broker rejection onto the closed failure set (default below). */
  readonly mapRejection?: (outcome: BrokerOutcome) => ReadOnlyAgentFailureCode;
  /** ING-7 admission predicate override (default: @sow/policy `admitJob`). */
  readonly admit?: (job: AgentJob) => PolicyDecision<AgentJob>;
}

/** The safe DEFAULT read-only, non-mutating ToolPolicy every family's job carries. */
const READ_ONLY_TOOL_POLICY: ToolPolicy = {
  mode: "read_only",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: false,
};

/** A minimal local-zero-egress DEFAULT route — admission is route-independent;
 * the Broker resolves the REAL route from the ProviderMatrix. */
const DEFAULT_ROUTE = {
  provider: "ollama",
  model: "local-default",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local_zero_egress",
} as unknown as ProviderRoute;

// ── THE CANONICAL Broker-rejection → failure-code mapping ───────────────────
// This module is the ONE home of the table. `runAgentJob.ts` (the meeting leg) and
// `apps/worker/src/composition/source-extraction.ts` (the source leg) both import
// `brokerRejectionFailureCode` from here rather than keeping their own copy — the
// three hand-written copies that preceded it drifted into the same wrong-field bug
// and only one of them was ever noticed.

/**
 * The failure codes a Broker rejection can derive to. A strict SUBSET of every
 * consuming leg's own closed union ({@link ReadOnlyAgentFailureCode},
 * `MeetingAgentFailureCode`, `SourceAgentFailureCode`) — the `mapRejection` seam at
 * each leg is what pins the subset relation, and REDs if a union ever drops a member.
 * `admission_rejected` is deliberately NOT here: every leg denies ING-7 admission
 * itself BEFORE dispatch and returns that code from its own pre-Broker arm.
 */
export type BrokerStageFailureCode =
  | "provider_failed"
  | "schema_rejected"
  | "egress_vetoed"
  | "budget_exceeded";

/**
 * {@link BrokerStage} → the failure code that stage's rejection derives to.
 *
 * READ THE `stage`, NEVER THE `branch`. A {@link BrokerRejection} carries BOTH, and
 * they answer different questions: `stage` is WHERE in the pipeline the job died
 * (`packages/providers/src/broker/broker.ts`'s `BrokerStage`); `branch` is WHICH
 * terminal lifecycle state the domain machine landed in (`agent-job-machine.ts`'s
 * `JobBranch` — `accepted | rejected | cancelled_budget | failed_retryable |
 * failed_terminal`). "schema" and "egress" are stage concepts; NO `JobBranch` member
 * contains either substring, so the substring-over-`branch` mapping this replaced
 * could never produce `schema_rejected` or `egress_vetoed` at all, and produced
 * `budget_exceeded` only where the branch happened to be spelled `cancelled_budget`.
 *
 * The table is TOTAL over the closed `BrokerStage` union by its
 * `Record<BrokerStage, …>` type: a tenth stage added upstream makes this literal miss
 * a key and FAILS THE TYPECHECK. There is deliberately no default clause — a default
 * would swallow a new stage into a silent wrong answer, which is the class of bug
 * this replaces.
 *
 * `cancelled_budget` (a BRANCH) is NOT consulted, on purpose. Two stages reach it in
 * the real broker: `budget_post` (a genuine cap breach — `budget-enforcer.ts`'s
 * `post`, reason `budget_exceeded`) and `run` (a cooperatively-cancelled provider
 * result — `broker.ts`'s run arm, reason `provider_cancelled`). Only the first is a
 * budget event; the second is a provider event that merely lands in the one cancel
 * terminal the frozen domain machine offers. Deriving "budget cap breached" from the
 * NAME of that state would be the same read-a-decision-out-of-a-string mistake, so
 * `run` maps to `provider_failed` and the broker's own message ("provider run
 * cancelled; output discarded before any hand-off") crosses to say which it was.
 */
export const BROKER_STAGE_FAILURE_CODE: Readonly<Record<BrokerStage, BrokerStageFailureCode>> = {
  admission: "provider_failed",
  route_resolution: "provider_failed",
  egress_veto: "egress_vetoed",
  health: "provider_failed",
  budget_pre: "budget_exceeded",
  run: "provider_failed",
  budget_post: "budget_exceeded",
  schema_gate: "schema_rejected",
  emit: "provider_failed",
};

/**
 * The DEFAULT Broker-rejection → failure-code mapping for every leg. Total, pure, and
 * driven off the closed {@link BrokerStage}. An `ok` outcome is not a rejection at all
 * — callers only reach this on the ERR arm — so it folds to `provider_failed` rather
 * than widening the return type.
 */
export function brokerRejectionFailureCode(outcome: BrokerOutcome): BrokerStageFailureCode {
  if (outcome.ok) return "provider_failed";
  // The `| undefined` is a RUNTIME BOUNDARY GUARD, not a type-level default, and the distinction
  // is the whole point: `stage` is typed `BrokerStage`, so a legal NEW stage can never reach the
  // fallback — the table above would have failed the typecheck first (a default clause on the
  // table is what would swallow it, reproducing the bug this replaces). What reaches the fallback
  // is data that VIOLATES the contract: a hand-rolled or foreign `BrokerOutcome` with `stage`
  // absent or unrecognized. For that, the coarse catch-all is the honest answer — it forwards the
  // Broker's message rather than asserting a gate decision nothing supports. NOTE the limit: such
  // a rejection's message is NOT redacted, exactly as before this fix; the real broker always
  // stamps a `stage`, and rule-7 redaction here rests on that.
  const code: BrokerStageFailureCode | undefined = BROKER_STAGE_FAILURE_CODE[outcome.error.stage];
  return code ?? "provider_failed";
}

/**
 * `schema-gate.ts`'s no-inference branch opens its message with THIS fixed, SoW-AUTHORED literal
 * and interpolates the model-authored field names only into the trailing `[…]`:
 *
 *   `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${fields}]`
 *
 * So the prefix is at index 0 by construction and no model text can reach position 0 of it — which
 * is what makes an ANCHORED `startsWith` here safe rather than a substring heuristic.
 *
 * ⚠ THIS CONSTANT DUPLICATES A LITERAL IN A PACKAGE THIS ONE CANNOT TYPE-BIND TO. It is anchored by
 * a TEST instead, not by the compiler: `read-only-agent-job-broker-rejection-redaction.test.ts`
 * drives the REAL `createSchemaGate` with a REJECTING `NoInferenceView` and asserts the predicate
 * below fires on the message it actually produced. Reword `schema-gate.ts`'s template and that test
 * REDs. Do not "simplify" it to a fixture string.
 */
export const NO_INFERENCE_REJECTION_PREFIX = "no-inference rejection (REQ-F-017)";

/**
 * THE CANONICAL rule for whether a Broker rejection's message must be replaced by the leg's own
 * fixed sentence (SAFETY RULE 7, incidental text, never the payload). ALL THREE legs call THIS
 * function — `runAgentJob.ts` and `apps/worker/src/composition/source-extraction.ts` import it, and
 * none keeps a rule of its own. That is new: source-extraction previously kept a NARROWER
 * `reason === "schema_rejected"` key, whose doc comment claimed the two rules "differ ONLY on a
 * reason the real Broker never stamps at this stage". That claim was FALSE — `broker.ts:383` calls
 * `lifecycleFault("schema_gate", …)`, stamping `stage: "schema_gate"` with `reason:
 * "lifecycle_fault"`, so a real broker lifecycle fault at the gate was redacted by the two workflow
 * legs and forwarded by the worker leg. One rule, one answer, no cell left to diverge on.
 *
 * THREE CONDITIONS, all read off the rejection's OWN closed fields — the parameter is the whole
 * {@link BrokerRejection}, never a derived, stringly-typed `code`:
 *
 *  - `stage === "schema_gate"` — the closed {@link BrokerStage} the broker stamped. Read from the
 *    rejection itself, NOT from `mapRejection`'s derived code: a caller-supplied `mapRejection` is
 *    a caller RELABELLING the failure for its own taxonomy, and relabelling cannot change whether
 *    the broker's message contains model text.
 *
 *  - `reason === "schema_rejected"` — `schema-gate.ts`'s `schemaDeny`. Excludes the same stage's
 *    `tool_policy_violation` (a fixed SoW-authored `output-normalizer.ts` literal) AND its
 *    `lifecycle_fault` (`broker lifecycle fault at schema_gate`) — both real, both SoW-authored,
 *    both previously collapsed.
 *
 *  - the message is the NO-INFERENCE one ({@link NO_INFERENCE_REJECTION_PREFIX}). This is the
 *    condition the previous rule lacked, and it is why four distinct denials used to render
 *    identically. `schemaDeny` has SIX call sites in `schema-gate.ts` and only ONE of them
 *    interpolates model-authored text:
 *
 *      1. `ajv structural gate rejected output against '<schemaId>' (<ajv code>)`     — SoW-authored
 *      2. `no model parser registered for '<schemaId>'; refusing ajv-alone …`         — SoW-authored
 *      3. `model schema parse rejected output against '<schemaId>' (Zod .refine…)`    — SoW-authored
 *      4. `no-inference rejection (REQ-F-017): … not coerced [<model field names>]`   — ⚠ MODEL TEXT
 *      5. `output not normalizable to a candidate: <normalizer message>`              — SoW-authored
 *      6. `§3 universal rule rejection (<code>:<domain field names>)`                 — SoW-authored
 *
 *    (5)'s interpolation is `output-normalizer.ts`'s `no candidate mapping for outputSchemaId
 *    '<id>'` — the job's OWN control-plane-built schema id. (6)'s is `universal-rules.ts`'s fixed
 *    field literals (`workspaceId` / `sourceRefs` / `canonicalObjectKey` / `idempotencyKey`). Only
 *    (4) folds `ni.error.map((r) => r.field)` — names the MODEL chose — into the text.
 *
 * ⚠ REACHABILITY, STATED HONESTLY — do not read this function as closing a LIVE leak. The only
 * composition root that builds a schema gate (`apps/worker/src/composition/backends.ts:866`) wires
 * `createSchemaGate({ modelSchemas: CANDIDATE_MODEL_SCHEMAS })` with NO `noInference` view, and its
 * own comment says that view "binds with the real extraction leg (18.3/18.4)". So branch (4) — the
 * ONE that can carry model text — is UNREACHABLE in production today. This rule pins what must hold
 * WHEN the view is bound. It routes on KIND (safety rule 7), not on when it becomes reachable.
 *
 * ⚠ THE RESIDUAL, STATED HONESTLY — do not read this function as a stronger guarantee than it is.
 * A custom `SchemaGate` injected at a composition root could stamp `schema_rejected` with model
 * text under some other message shape, and this rule would forward it. That residual is ACCEPTED
 * here deliberately: the previous stage-level backstop bought it by collapsing five SoW-authored
 * diagnostics into one sentence, which is the operator-blinding trade root CLAUDE.md forbids ("THE
 * BAR IS INVERTED: restore unless removal is clearly justified"). The STRUCTURAL fix is a distinct
 * `BrokerFailureReason` for the no-inference branch (e.g. `no_inference_rejected`) so this rule can
 * key on a closed field alone — that lives in `packages/providers`, not here.
 */
export function brokerRejectionNeedsFixedMessage(rejection: BrokerRejection): boolean {
  if (rejection.stage !== "schema_gate") return false;
  if (rejection.reason !== "schema_rejected") return false;
  // RUNTIME BOUNDARY GUARD, not a type-level default (the same posture as
  // `brokerRejectionFailureCode`'s `| undefined`): `message` is typed `string`, so what reaches the
  // non-string arm is data that VIOLATES the contract — a hand-rolled or foreign `BrokerOutcome`.
  // Such a value has no message to leak and none to forward; `false` is the honest answer.
  const message: unknown = rejection.message;
  return typeof message === "string" && message.startsWith(NO_INFERENCE_REJECTION_PREFIX);
}

/**
 * The FIXED rejection message that replaces the Broker's raw `outcome.error.message` at the ERR arm
 * below for the ONE denial {@link brokerRejectionNeedsFixedMessage} selects — `schema-gate.ts`'s
 * no-inference branch, whose text folds `[<model-chosen field names>]` into itself (SAFETY RULE 7,
 * incidental text, never the payload: mirrors runAgentJob.ts's identical remedy).
 *
 * IT NAMES THE BRANCH ON PURPOSE. A bare "failed the schema gate" would tell an operator only what
 * the closed `code` already tells them, so this sentence carries the REQ-F-017 fact — entirely
 * SoW-authored — and withholds only the field list. Restoring, not removing, is the bar.
 *
 * Every OTHER Broker rejection — every other stage (admission, route resolution, egress veto,
 * health, budget, provider run, emit) AND the schema gate's own five other denials (ajv structural,
 * missing model parser, Zod `.refine`, un-normalizable output, §3 universal rule) AND its
 * `tool_policy_violation` and `lifecycle_fault` reasons — emits SoW-authored closed diagnostic text
 * and crosses UNCHANGED below. Two restores landed here, in this order:
 *   • 2026-08-27 (a): an earlier pass applied this schema-gate justification to all five FAILURE
 *     CODES, collapsing every Broker failure onto one fixed sentence per code.
 *   • 2026-08-27 (b), this change: the follow-up still collapsed FOUR of the schema gate's six
 *     `schema_rejected` branches — an ajv structural rejection and a no-inference rejection
 *     rendered byte-identically — plus the gate's `lifecycle_fault`. Now exactly one is replaced.
 * (CLAUDE.md "THE BAR IS INVERTED: restore unless removal is clearly justified".)
 *
 * REACHABILITY: this remedy was DEAD CODE until the rejection mapping moved off
 * `outcome.error.branch` onto `outcome.error.stage` — no `JobBranch` member contains the substring
 * "schema", so `schema_rejected` could never be derived and this sentence never once replaced
 * anything. The poisoned no-inference message crossed VERBATIM. See
 * {@link BROKER_STAGE_FAILURE_CODE}. It is now driven end-to-end against the REAL `createBroker` +
 * `createSchemaGate` in this activity's sibling test, so the claim rests on a run, not a reading.
 */
const SCHEMA_REJECTED_MESSAGE =
  "read-only agent job output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)";

/**
 * Build a generic `{run(ctx): Promise<Result<Output, ReadOnlyAgentFailure>>}`
 * activity: assembles the read-only job, ADMITS it (ING-7, defense in depth),
 * dispatches through the Broker, and maps the accepted candidate through
 * `mapCandidate`. Structurally satisfies RunBriefingAgentPort / RunReviewAgentPort
 * / ProposeWindowsAgentPort directly (all declare `run(ctx)`); SynthesizeNarrativePort's
 * two-arg `synthesize(ctx, progress)` is bridged by a thin wrapper at the call site
 * (the factory composes `Ctx = {readonly ctx; readonly progress}`). Never throws.
 */
export function createReadOnlyAgentJobActivity<Ctx, Output>(
  deps: ReadOnlyAgentJobDeps<Ctx, Output>,
): { run(ctx: Ctx): Promise<Result<Output, ReadOnlyAgentFailure>> } {
  const admit = deps.admit ?? admitJob;
  const mapRejection = deps.mapRejection ?? brokerRejectionFailureCode;
  return {
    async run(ctx: Ctx): Promise<Result<Output, ReadOnlyAgentFailure>> {
      const i = deps.inputs;
      const job: AgentJob = {
        id: (i.jobId ?? i.idempotencyKey) as AgentJobId,
        workflowRunId: i.workflowRunId,
        workspaceId: i.workspaceId,
        capability: i.capability as Capability,
        contextRefs: [...(i.contextRefs ?? [])],
        outputSchemaId: i.outputSchemaId,
        toolPolicy: READ_ONLY_TOOL_POLICY,
        providerRoute: i.providerRoute ?? DEFAULT_ROUTE,
        // These jobs read ALREADY-SANITIZED context (never a raw untrusted body).
        trustLevel: "trusted",
        carriesRawContent: false,
        maxRuntimeSeconds: i.maxRuntimeSeconds,
        ...(i.maxCostUsd !== undefined ? { maxCostUsd: i.maxCostUsd } : {}),
        idempotencyKey: i.idempotencyKey,
      };

      // ING-7 admission (defense in depth) — never reached by a mutating tool.
      const decision = admit(job);
      if (isDeny(decision)) {
        return err({ code: "admission_rejected", message: decision.message });
      }

      const req: BrokerJobRequest = {
        job,
        matrix: deps.buildMatrix(ctx),
        egress: deps.buildEgress(ctx),
        workspace: deps.buildWorkspace(ctx),
        ...(deps.localConfig !== undefined ? { localConfig: deps.localConfig } : {}),
      };
      const outcome = await deps.broker.runJob(req);
      if (!outcome.ok) {
        const code = mapRejection(outcome);
        // SAFETY RULE 7 (incidental, NOT the payload — see SCHEMA_REJECTED_MESSAGE's doc
        // comment): exactly ONE Broker denial's message can carry model-authored text — the schema
        // gate's no-inference branch — so exactly one is replaced with a fixed sentence. Every
        // other message, INCLUDING the schema gate's own five other denials and its
        // `tool_policy_violation` / `lifecycle_fault` reasons, crosses UNCHANGED so an operator can
        // tell one failure from another. The rule is the shared predicate
        // `brokerRejectionNeedsFixedMessage`, taking the whole closed-field `BrokerRejection`; the
        // sibling `runAgentJob.ts` and worker `source-extraction.ts` legs call the SAME function,
        // so all three cannot drift. NOTE it reads `outcome.error`, NOT the derived `code` — a
        // custom `mapRejection` relabels the failure for the caller's own taxonomy, and relabelling
        // cannot change whether the broker's message contains model text. The closed `code` is what
        // a workflow driver switches on; it always crosses byte-identical regardless.
        const message = brokerRejectionNeedsFixedMessage(outcome.error)
          ? SCHEMA_REJECTED_MESSAGE
          : outcome.error.message;
        return err({ code, message });
      }
      return ok(deps.mapCandidate(outcome));
    },
  };
}
