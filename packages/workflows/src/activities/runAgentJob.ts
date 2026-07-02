// @sow/workflows — slice 7.6 ACTIVITY: build + admit + dispatch the `meeting.close`
// AgentJob (inv-2 — ING-7 admission + the Broker).
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY use adapters
// (@sow/policy admission, @sow/providers Broker) + node:crypto for the idempotency
// key. It takes ALL its effects INJECTED (the Broker, the key builder, the
// egress/matrix/workspace builders, the candidate→extraction mapper) so it is
// Vitest-unit-testable with fakes and never touches a real network in the module.
// It implements {@link RunMeetingAgentJobPort}.
//
// SAFETY (inv-2): the meeting.close job runs under a READ-ONLY ToolPolicy on the
// UNTRUSTED transcript (trustLevel 'untrusted' / carriesRawContent true), carrying
// an outputSchemaId + budget caps + a deterministic idempotencyKey. Before ANY
// dispatch it is put through the ING-7 admission predicate (@sow/policy `admitJob`):
// a job declaring a MUTATING tool policy on untrusted content is REJECTED at
// admission → `admission_rejected`, and the Broker is NEVER called (never run).
//   arch_gap / flag: the brief names `admitCandidateJob`. That is the `unknown`
//   candidate-DATA gate (ajv structural + Zod refine + ING-7) for PROVIDER-emitted
//   jobs. Here the AgentJob is CONTROL-PLANE-built from typed inputs (already a
//   well-typed `AgentJob`), so the applicable gate is the ING-7 predicate `admitJob`
//   itself — the same denial the composed gate ends in. The Broker ALSO re-runs
//   admission internally (defence in depth). `admit` is injectable to swap in the
//   full candidate gate at the worker-wiring seam if a job is ever built from
//   candidate data.
//
// §16: returns a typed Result — never throws across the activity boundary. A Broker
// rejection is mapped onto the closed {@link MeetingAgentFailureCode} set.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  AgentJob,
  AgentJobId,
  WorkflowId,
  WorkspaceId,
  Capability,
  ToolPolicy,
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
} from "@sow/providers";
import type {
  RunMeetingAgentJobPort,
  MeetingAgentFailure,
  MeetingAgentFailureCode,
  MeetingCloseoutContext,
  AgentExtraction,
} from "../ports/meetingCloseout";

/** The narrow Broker surface this activity dispatches through (injected). */
export interface MeetingBroker {
  runJob(req: BrokerJobRequest, signal?: AbortSignal): Promise<BrokerOutcome>;
}

/**
 * The typed inputs from which the meeting.close AgentJob is assembled. `toolPolicy`
 * / `providerRoute` / `contextRefs` default to safe read-only values but are
 * overridable (a MUTATING toolPolicy is what the ING-7 test exercises — it MUST be
 * refused at admission).
 */
export interface MeetingJobInputs {
  readonly workflowRunId: WorkflowId;
  readonly workspaceId: WorkspaceId;
  readonly capability: Capability | string;
  readonly outputSchemaId: string;
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd?: number;
  readonly idempotencyKey: string;
  readonly jobId?: string;
  readonly contextRefs?: readonly ContextRef[];
  readonly toolPolicy?: ToolPolicy;
  readonly providerRoute?: ProviderRoute;
}

/**
 * Injected deps for the run-agent-job activity. The Broker + the assemblers for the
 * per-workspace EgressPolicy / ProviderMatrix / workspace posture the Broker request
 * carries, the candidate→extraction mapper (the concrete meeting.close output-schema
 * shape is a §9 arch_gap — the mapper owns it), and (optionally) the rejection mapper
 * + admission predicate override.
 */
export interface RunAgentJobActivityDeps {
  readonly broker: MeetingBroker;
  readonly inputs: MeetingJobInputs;
  readonly buildEgress: (ctx: MeetingCloseoutContext) => EgressPolicy;
  readonly buildMatrix: (ctx: MeetingCloseoutContext) => ProviderMatrix;
  readonly buildWorkspace: (
    ctx: MeetingCloseoutContext,
  ) => { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
  readonly mapCandidate: (outcome: BrokerOutcome) => AgentExtraction;
  readonly localConfig?: LocalProviderConfig;
  /** Maps a Broker rejection onto the closed meeting-agent failure set. */
  readonly mapRejection?: (outcome: BrokerOutcome) => MeetingAgentFailureCode;
  /** ING-7 admission predicate override (default: @sow/policy `admitJob`). */
  readonly admit?: (job: AgentJob) => PolicyDecision<AgentJob>;
}

/** The safe DEFAULT: a READ-ONLY, non-mutating ToolPolicy for the untrusted transcript. */
const READ_ONLY_TOOL_POLICY: ToolPolicy = {
  mode: "read_only",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: false,
};

/** Default Broker-rejection → meeting-agent-failure mapping. */
function defaultMapRejection(outcome: BrokerOutcome): MeetingAgentFailureCode {
  if (outcome.ok) return "provider_failed";
  // The Broker's schema/tool-policy gate rejection folds onto schema_rejected;
  // everything else (route/health/run) is a provider failure. Egress-veto /
  // budget branches carry their own codes.
  const branch = String(outcome.error.branch);
  if (branch.includes("schema")) return "schema_rejected";
  if (branch.includes("egress")) return "egress_vetoed";
  if (branch.includes("budget")) return "budget_exceeded";
  return "provider_failed";
}

/**
 * Build a {@link RunMeetingAgentJobPort} that assembles the read-only untrusted
 * meeting.close job, ADMITS it (ING-7), then dispatches through the Broker (inv-2).
 * A mutating-tool declaration is refused BEFORE the Broker runs. Never throws.
 */
export function createRunAgentJobActivity(
  deps: RunAgentJobActivityDeps,
): RunMeetingAgentJobPort {
  const admit = deps.admit ?? admitJob;
  const mapRejection = deps.mapRejection ?? defaultMapRejection;
  return {
    async run(
      ctx: MeetingCloseoutContext,
    ): Promise<Result<AgentExtraction, MeetingAgentFailure>> {
      const i = deps.inputs;
      const job: AgentJob = {
        id: (i.jobId ?? i.idempotencyKey) as AgentJobId,
        workflowRunId: i.workflowRunId,
        workspaceId: i.workspaceId,
        capability: i.capability as Capability,
        contextRefs: [...(i.contextRefs ?? [])],
        outputSchemaId: i.outputSchemaId,
        toolPolicy: i.toolPolicy ?? READ_ONLY_TOOL_POLICY,
        providerRoute: i.providerRoute ?? DEFAULT_ROUTE,
        // inv-2: the transcript is untrusted raw content — always.
        trustLevel: "untrusted",
        carriesRawContent: true,
        maxRuntimeSeconds: i.maxRuntimeSeconds,
        ...(i.maxCostUsd !== undefined ? { maxCostUsd: i.maxCostUsd } : {}),
        idempotencyKey: i.idempotencyKey,
      };

      // ── ING-7 admission (inv-2): a mutating tool on untrusted content is refused
      //    BEFORE any dispatch. Broker never runs.
      const decision = admit(job);
      if (isDeny(decision)) {
        return err({
          code: "admission_rejected",
          message: decision.message,
        });
      }

      // ── dispatch through the Broker.
      const req: BrokerJobRequest = {
        job,
        matrix: deps.buildMatrix(ctx),
        egress: deps.buildEgress(ctx),
        workspace: deps.buildWorkspace(ctx),
        ...(deps.localConfig !== undefined ? { localConfig: deps.localConfig } : {}),
      };
      const outcome = await deps.broker.runJob(req);
      if (!outcome.ok) {
        return err({
          code: mapRejection(outcome),
          message: outcome.error.message,
        });
      }
      // Accepted: map the Broker CANDIDATE → an AgentExtraction (the mapper owns the
      // §9 output-schema shape arch_gap).
      return ok(deps.mapCandidate(outcome));
    },
  };
}

// A minimal local-zero-egress DEFAULT route (a real route is resolved by the Broker
// from the ProviderMatrix; this is only the pre-dispatch placeholder the ING-7
// predicate is evaluated over — admission is route-independent).
const DEFAULT_ROUTE: ProviderRoute = {
  provider: "ollama",
  model: "local-default",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local_zero_egress",
} as unknown as ProviderRoute;
