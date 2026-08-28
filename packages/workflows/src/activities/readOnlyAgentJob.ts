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
import type { BrokerJobRequest, BrokerOutcome } from "@sow/providers";
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

/** Default Broker-rejection → failure-code mapping (mirrors runAgentJob.ts). */
function defaultMapRejection(outcome: BrokerOutcome): ReadOnlyAgentFailureCode {
  if (outcome.ok) return "provider_failed";
  const branch = String(outcome.error.branch);
  if (branch.includes("schema")) return "schema_rejected";
  if (branch.includes("egress")) return "egress_vetoed";
  if (branch.includes("budget")) return "budget_exceeded";
  return "provider_failed";
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
  const mapRejection = deps.mapRejection ?? defaultMapRejection;
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
