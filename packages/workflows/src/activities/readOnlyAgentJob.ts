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
import type { BrokerJobRequest, BrokerOutcome, BrokerStage } from "@sow/providers";
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
 * The FIXED, generic rejection message for a `schema_rejected` Broker outcome — replaces the
 * Broker's raw `outcome.error.message` at the ERR arm below ONLY for this one code (SAFETY RULE
 * 7, incidental text, never the payload: mirrors runAgentJob.ts's identical remedy). The real
 * Broker's schema gate (`schema-gate.ts`) folds a no-inference rejection into its message as
 * `no-inference rejection … [<fields>]`, quoting MODEL-OUTPUT FIELD NAMES — this is the ONE
 * rejection stage whose message can carry foreign (model-authored) text, so it is the ONE stage
 * redacted.
 *
 * Every OTHER Broker rejection stage (admission, route resolution, egress veto, health, budget,
 * provider run) emits SoW-authored closed diagnostic text, reached here by all four output-
 * workflow families — an operator needs to tell one failure from another, so those messages
 * cross UNCHANGED below (restored 2026-08-27: an earlier pass over-applied this schema-gate-
 * specific justification to all five failure codes, collapsing every distinct Broker failure
 * onto one fixed sentence per code — CLAUDE.md "THE BAR IS INVERTED: restore unless removal is
 * clearly justified").
 *
 * REACHABILITY (fixed here): this remedy was DEAD CODE until the rejection mapping was moved off
 * `outcome.error.branch` and onto `outcome.error.stage` — no `JobBranch` member contains the
 * substring "schema", so `schema_rejected` could never be derived and this sentence never once
 * replaced anything. The poisoned no-inference message crossed VERBATIM. See
 * {@link BROKER_STAGE_FAILURE_CODE}.
 *
 * SCOPE, stated exactly: the swap is keyed on the derived code, i.e. on the `schema_gate` STAGE —
 * so it also replaces that stage's OTHER denial, `tool_policy_violation`, whose message
 * (`output-normalizer.ts`'s fixed "output implies a mutating external action …" sentence) is
 * SoW-authored and carries no model text. Redacting it is a small, deliberate over-reach kept for
 * the stage-level guarantee: EVERY schema-gate message is replaced, including one from a custom
 * `SchemaGate` injected at a composition root that stamps some other `reason`.
 */
const SCHEMA_REJECTED_MESSAGE =
  "read-only agent job output failed the candidate-data schema gate";

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
        // comment): only a schema-gate rejection's message can carry a model-authored field
        // name (the no-inference branch), so only that one is replaced with a fixed sentence.
        // Every other code's message is SoW-authored diagnostic text and crosses UNCHANGED so
        // an operator can tell one failure from another. The closed `code` is what a workflow
        // driver switches on; it always crosses byte-identical regardless.
        const message = code === "schema_rejected" ? SCHEMA_REJECTED_MESSAGE : outcome.error.message;
        return err({ code, message });
      }
      return ok(deps.mapCandidate(outcome));
    },
  };
}
