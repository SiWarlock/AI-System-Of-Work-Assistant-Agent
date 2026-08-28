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
// The CANONICAL Broker-rejection → failure-code mapping lives in `readOnlyAgentJob.ts` (the
// generic read-only core) and is shared by all three legs — this one, the read-only families, and
// apps/worker's `composition/source-extraction.ts`. It reads the rejection's closed `stage`, NOT
// its `branch`; see BROKER_STAGE_FAILURE_CODE's doc comment for why that distinction is the whole
// bug. Do NOT re-introduce a local copy.
import {
  brokerRejectionFailureCode,
  brokerRejectionNeedsFixedMessage,
} from "./readOnlyAgentJob";
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

/** Default Broker-rejection → meeting-agent-failure mapping: the SHARED, stage-keyed
 * `brokerRejectionFailureCode` (imported above). Its `BrokerStageFailureCode` return is a strict
 * subset of {@link MeetingAgentFailureCode}, which this alias's type pins — if the union ever
 * drops a member, this line REDs rather than the mapping silently mis-coding. */
const defaultMapRejection: (outcome: BrokerOutcome) => MeetingAgentFailureCode =
  brokerRejectionFailureCode;

/**
 * The FIXED rejection message that replaces the Broker's raw `outcome.error.message` at the ERR arm
 * below for the ONE denial `brokerRejectionNeedsFixedMessage` selects — `schema-gate.ts`'s
 * no-inference branch, which folds `[<model-chosen field names>]`, drawn from the untrusted
 * transcript, into its own text (SAFETY RULE 7, incidental text, never the payload).
 *
 * IT NAMES THE BRANCH ON PURPOSE. A bare "failed the schema gate" would tell an operator only what
 * the closed `code` already tells them, so this sentence carries the REQ-F-017 fact — entirely
 * SoW-authored — and withholds only the field list.
 *
 * Every OTHER Broker rejection — every other stage (admission, route resolution, egress veto,
 * health, budget, provider run, emit) AND the schema gate's own five other denials (ajv structural,
 * missing model parser, Zod `.refine`, un-normalizable output, §3 universal rule) AND its
 * `tool_policy_violation` and `lifecycle_fault` reasons — emits SoW-authored closed diagnostic
 * text. An operator needs to tell "no eligible provider for route claude/opus" from a provider
 * timeout from a locked Keychain, and an ajv structural rejection from a no-inference one, so those
 * cross UNCHANGED below. Two restores landed here, in this order:
 *   • 2026-08-27 (a): an earlier pass applied this schema-gate justification to all five FAILURE
 *     CODES, collapsing every Broker failure onto one fixed sentence per code.
 *   • 2026-08-27 (b), this change: the follow-up still collapsed FOUR of the schema gate's six
 *     `schema_rejected` branches, plus the gate's `lifecycle_fault`. Now exactly one is replaced.
 * (CLAUDE.md "THE BAR IS INVERTED: restore unless removal is clearly justified".)
 *
 * REACHABILITY: this remedy was DEAD CODE until the rejection mapping moved off
 * `outcome.error.branch` onto `outcome.error.stage` — no `JobBranch` member contains the substring
 * "schema", so `schema_rejected` could never be derived and this sentence never once replaced
 * anything. The poisoned no-inference message crossed VERBATIM out of `meetingRunAgentJob`. See
 * `readOnlyAgentJob.ts`'s BROKER_STAGE_FAILURE_CODE.
 *
 * SCOPE: `brokerRejectionNeedsFixedMessage` in `readOnlyAgentJob.ts` IS the rule — imported above,
 * shared by this leg, the read-only leg AND `apps/worker`'s `source-extraction.ts`, so all three
 * cannot drift. It takes the whole closed-field `BrokerRejection` and reads `stage` +`reason` +the
 * no-inference message anchor; see its own doc comment for the six-branch enumeration and for the
 * residual it deliberately accepts rather than buying back with a message-collapsing backstop.
 */
const SCHEMA_REJECTED_MESSAGE =
  "meeting.close broker output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)";

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
        const code = mapRejection(outcome);
        // SAFETY RULE 7 (incidental, NOT the payload — see SCHEMA_REJECTED_MESSAGE's doc
        // comment): exactly ONE Broker denial's message can carry model-authored text — the schema
        // gate's no-inference branch — so exactly one is replaced with a fixed sentence. Every
        // other message, INCLUDING the schema gate's own five other denials and its
        // `tool_policy_violation` / `lifecycle_fault` reasons, crosses UNCHANGED so an operator can
        // tell one failure from another. The rule is the shared predicate
        // `brokerRejectionNeedsFixedMessage`, imported from the read-only leg (and also called by
        // apps/worker's source-extraction leg) so all three cannot drift. NOTE it reads
        // `outcome.error`, NOT the derived `code` — a custom `mapRejection` relabels the failure for
        // the caller's own taxonomy, and relabelling cannot change whether the broker's message
        // contains model text. The closed `code` is what a workflow driver switches on; it always
        // crosses byte-identical regardless.
        const message = brokerRejectionNeedsFixedMessage(outcome.error)
          ? SCHEMA_REJECTED_MESSAGE
          : outcome.error.message;
        return err({ code, message });
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
