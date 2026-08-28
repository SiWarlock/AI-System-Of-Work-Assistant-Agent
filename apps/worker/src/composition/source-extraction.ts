// 18.4 — the source-ingestion extraction leg ROUTED THROUGH THE BROKER (+ ING-7), the SOURCE
// analog of 18.3's meeting leg (`runAgentJob.ts` / `createRunAgentJobActivity`).
//
// Today `sourceAgent.run` returns a FIXED extraction and BYPASSES the broker entirely — so the
// untrusted/imported source never hits ING-7 admission (safety rule 6) nor the broker's internal
// candidate-data gate. `createSourceAgentBrokerRouting` closes that gap: it assembles a READ-ONLY,
// UNTRUSTED, raw-content-carrying source `AgentJob`, ADMITS it (ING-7), then dispatches through the
// injected Broker (mirroring the meeting leg), so:
//   • ING-7 (rule 6): a source job declaring a MUTATING tool policy is REJECTED at admission →
//     `admission_rejected`, and the Broker is NEVER called (never run). Source-agnostic + fail-closed
//     (the @sow/policy `admitJob` predicate; the Broker also re-runs admission internally — defence
//     in depth).
//   • gate-on-outcome: `mapCandidate` is reached ONLY on an ACCEPTED `BrokerOutcome`; a rejection
//     PROPAGATES as a typed `SourceAgentFailure` (no blind echo of a fixed extraction).
//   • the candidate-data gate proper (rule 2 / REQ-S-006 + REQ-F-017) is the DOWNSTREAM
//     `ValidateExtractionPort` (the reused `createMeetingExtractionSchemaGate` structural gate +
//     `validateNoInference`) the source workflow already runs over this extraction — this leg only
//     produces the CANDIDATE.
//
// WS-8 (rule 4) — DYNAMIC workspace binding: unlike the meeting leg (whose `MeetingJobInputs`
// carries a STATIC `workspaceId`), the source job's workspace is bound DYNAMICALLY from the
// ROUTING-BOUND `ctx.workspaceId` at run() time — NEVER from a source CONTENT field
// (`ctx.source.workspaceId` is attacker-influenceable imported content and is IGNORED). So
// `SourceJobInputs` deliberately has NO `workspaceId`.
//
// SAFE-BUILD: the run leg is 18.1's dormant stub — no real model/prompt executes here; this is a
// deterministic router. The FAITHFUL evidence-bearing reconstruction of the extraction FROM the
// accepted candidate is deferred to the first-class `agent_extraction` BrokerCandidate (task #18) —
// the KMP stand-in candidate discards `ExtractionField.evidenceRef`, so it is unreconstructable
// worker-only; the `mapCandidate` the composition root injects folds the deterministic extraction on
// accept (the meeting leg's exact pattern).
//
// §16: returns a typed Result — never throws across the boundary. A Broker rejection maps onto the
// closed {@link SourceAgentFailureCode} set.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  AgentJob,
  AgentJobId,
  WorkflowId,
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
import type { BrokerJobRequest, BrokerOutcome } from "@sow/providers";
import type {
  RunSourceAgentJobPort,
  SourceAgentFailure,
  SourceAgentFailureCode,
  SourceIngestionContext,
  AgentExtraction,
} from "@sow/workflows";
import { LOCAL_EXTRACTION_ROUTE } from "./extraction-route-gate";

/** The narrow Broker surface this leg dispatches through (injected). */
export interface SourceBroker {
  runJob(req: BrokerJobRequest, signal?: AbortSignal): Promise<BrokerOutcome>;
}

/**
 * The typed inputs from which the source-processing AgentJob is assembled. `toolPolicy` defaults to
 * a safe READ-ONLY value but is overridable (a MUTATING toolPolicy is what the ING-7 test exercises
 * — it MUST be refused at admission).
 *
 * WS-8: there is NO `workspaceId` here — the source job's workspace is bound DYNAMICALLY from the
 * routing-bound `ctx.workspaceId` at run() time (never a static input, never a source content field).
 */
export interface SourceJobInputs {
  readonly workflowRunId: WorkflowId;
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
 * 24.22 — the classification `ctx.source.routingHints["trustLevel"]` resolves to, as read by
 * {@link SourceRunAgentJobDeps.onTrustClassification}. `"trusted"` / `"untrusted"` mirror the two
 * values a connector adapter actually stamps (`capture-source.ts`'s verified-origin capture,
 * `gmail-source.ts`'s unconditional untrusted); `"unspecified"` covers every other connector
 * (file/podcast/web/youtube), which stamps no `trustLevel` key at all today.
 */
export type SourceTrustClassification = "trusted" | "untrusted" | "unspecified";

/**
 * Injected deps for the source broker-routing leg. The Broker + the per-workspace assemblers for the
 * EgressPolicy / ProviderMatrix / workspace posture the Broker request carries, the
 * candidate→extraction mapper (the concrete source-processing output-schema shape is a §9 arch_gap —
 * the mapper owns it, gating on the accepted outcome), and (optionally) the rejection mapper +
 * ING-7 admission predicate override.
 */
export interface SourceRunAgentJobDeps {
  readonly broker: SourceBroker;
  readonly inputs: SourceJobInputs;
  readonly buildEgress: (ctx: SourceIngestionContext) => EgressPolicy;
  readonly buildMatrix: (ctx: SourceIngestionContext) => ProviderMatrix;
  readonly buildWorkspace: (
    ctx: SourceIngestionContext,
  ) => { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
  readonly mapCandidate: (outcome: BrokerOutcome) => AgentExtraction;
  readonly localConfig?: LocalProviderConfig;
  /** Maps a Broker rejection onto the closed source-agent failure set. */
  readonly mapRejection?: (outcome: BrokerOutcome) => SourceAgentFailureCode;
  /** ING-7 admission predicate override (default: @sow/policy `admitJob`). */
  readonly admit?: (job: AgentJob) => PolicyDecision<AgentJob>;
  /**
   * 24.22 — a REAL reader for `ctx.source.routingHints["trustLevel"]` (the channel a connector
   * adapter stamps — `capture-source.ts:115,132`, `gmail-source.ts`'s unconditional untrusted),
   * invoked ONCE per `run()` with the resolved {@link SourceTrustClassification}, BEFORE the job is
   * built. Closes the "produced-and-dropped signal" gap this leg's own header names: previously
   * NOTHING on the extraction path ever read this field, so a future trust-propagation slice would
   * have found a channel that had never once been consulted, with no test pinning what reading it
   * should mean. READ-ONLY / OBSERVABILITY ONLY — it does NOT influence `job.trustLevel` below,
   * which stays the fail-safe `"untrusted"` constant regardless of what this reports (ING-7/inv-2:
   * imported source content is always untrusted for THIS leg, independent of any upstream
   * classification). Best-effort (§16/L25): a throwing observer is swallowed, never breaks `run()`.
   * OPTIONAL — every existing caller/fake stays valid without supplying it.
   */
  readonly onTrustClassification?: (classification: SourceTrustClassification) => void;
}

/** The safe DEFAULT: a READ-ONLY, non-mutating ToolPolicy for the untrusted imported source (ING-7). */
const READ_ONLY_TOOL_POLICY: ToolPolicy = {
  mode: "read_only",
  allowedTools: [],
  deniedTools: [],
  allowsMutating: false,
};

/** Default Broker-rejection → source-agent-failure mapping (mirrors the meeting leg's mapper). */
function defaultMapSourceRejection(outcome: BrokerOutcome): SourceAgentFailureCode {
  if (outcome.ok) return "provider_failed";
  // The Broker's schema/tool-policy gate rejection folds onto schema_rejected; the egress-veto /
  // budget branches carry their own codes; everything else (route/health/run) is a provider failure.
  const branch = String(outcome.error.branch);
  if (branch.includes("schema")) return "schema_rejected";
  if (branch.includes("egress")) return "egress_vetoed";
  if (branch.includes("budget")) return "budget_exceeded";
  return "provider_failed";
}

/**
 * The ERR-arm message for a Broker rejection. RESTORES forwarding the Broker's own
 * `outcome.error.message` VERBATIM — EXCEPT when the underlying `outcome.error.reason`
 * is `"schema_rejected"`, the one value the real Broker's schema gate
 * (`schema-gate.ts`'s `schemaDeny` / no-inference rejection) ALWAYS stamps on this
 * rejection, whose message folds `no-inference rejection (REQ-F-017): … [<fields>]`
 * quoting MODEL-AUTHORED FIELD NAMES drawn from the untrusted imported source.
 *
 * KEYED ON `reason`, NOT the derived {@link SourceAgentFailureCode} — deliberately.
 * `defaultMapSourceRejection` below classifies on `outcome.error.branch` (the 5-value
 * `JobBranch`), which does NOT reliably identify a schema-gate rejection: a real
 * no-inference rejection carries `branch: "rejected"`, a value shared with
 * `tool_policy_violation` and matched by NONE of `defaultMapSourceRejection`'s
 * substring checks, so it falls through to the generic `provider_failed` code. Keying
 * redaction off that lossy derived code would therefore UNDER-redact the one message
 * that actually needs it (a real no-inference rejection would surface as
 * `provider_failed`, not `schema_rejected`) — the exact leak this fn exists to close.
 * `reason` is the one field the schema gate reliably stamps `"schema_rejected"` on,
 * independent of the branch-mapping bug, so it is the safe signal to redact on.
 *
 * Every OTHER reachable message (`provider-health.ts`, `model-availability.ts`,
 * `budget-enforcer.ts`, `broker.ts`'s own `no eligible provider …` / `broker lifecycle
 * fault …` templates, and every §5 `DenialReason` policy-deny message) is SoW/policy
 * -authored — a fixed template or a closed-code literal interpolated in, never
 * vendor/model/untrusted text — so forwarding it costs nothing at the Temporal
 * workflow-history boundary (ARCHITECTURE.md:155/157) and restores the diagnostic the
 * closed `SourceAgentFailureCode` taxonomy can no longer carry: it has exactly ONE
 * member (`provider_failed`) for every one of `no_eligible_provider` /
 * `provider_unavailable` / `provider_error` / `provider_cancelled` /
 * `tool_policy_violation`, so the message is the only remaining diagnostic (mirrors the
 * sibling `runAgentJob.ts` / `readOnlyAgentJob.ts` legs' own restore).
 */
function rejectionMessageFor(reason: string, brokerMessage: string): string {
  if (reason === "schema_rejected") {
    return "source-processing broker output failed the candidate-data schema gate";
  }
  return brokerMessage;
}

/**
 * Build a {@link RunSourceAgentJobPort} that assembles the read-only untrusted source-processing
 * job, DYNAMICALLY binds the routing-bound workspace (WS-8), ADMITS it (ING-7), then dispatches
 * through the Broker. A mutating-tool declaration is refused BEFORE the Broker runs; a Broker
 * rejection propagates typed (mapCandidate never reached). Never throws.
 */
export function createSourceAgentBrokerRouting(
  deps: SourceRunAgentJobDeps,
): RunSourceAgentJobPort {
  const admit = deps.admit ?? admitJob;
  const mapRejection = deps.mapRejection ?? defaultMapSourceRejection;
  return {
    async run(
      ctx: SourceIngestionContext,
    ): Promise<Result<AgentExtraction, SourceAgentFailure>> {
      const i = deps.inputs;
      // 24.22 — the REAL reader for `ctx.source.routingHints["trustLevel"]` (best-effort, §16/L25;
      // never influences `job.trustLevel` below — see the deps field's own doc for the full reasoning).
      try {
        const raw = (ctx.source.routingHints as Record<string, unknown> | undefined)?.["trustLevel"];
        const classification: SourceTrustClassification =
          raw === "trusted" ? "trusted" : raw === "untrusted" ? "untrusted" : "unspecified";
        deps.onTrustClassification?.(classification);
      } catch {
        /* an observer fault must never break the extraction leg (§16). */
      }
      // WS-8 (rule 4): bind the workspace from the ROUTING-BOUND ctx, NEVER from a source content
      // field (`ctx.source.workspaceId` is attacker-influenceable imported content — ignored).
      const workspaceId = ctx.workspaceId;
      if (workspaceId === undefined) {
        // Fail-closed defensive guard (WS-2 precondition): the source-processing job is reached only
        // AFTER routing binds a workspace (the sourceMachine has no processing edge from an unbound
        // route — this branch is unreachable BY DRIVER DESIGN), but building a job with an undefined
        // workspace would be a WS-8 hole, so reject BEFORE admission/broker (no job built, no side
        // effect). `provider_failed` is the generic fail-closed code — the closed failure taxonomy has
        // no dedicated WS-2-precondition member; since the branch is unreachable by design the exact
        // code is not load-bearing (the test pins the SAFETY property: err + zero broker calls).
        return err({
          code: "provider_failed",
          message: "source-processing job reached with no routing-bound workspace (WS-2 precondition)",
        });
      }
      const job: AgentJob = {
        id: (i.jobId ?? i.idempotencyKey) as AgentJobId,
        workflowRunId: i.workflowRunId,
        workspaceId,
        capability: i.capability as Capability,
        contextRefs: [...(i.contextRefs ?? [])],
        outputSchemaId: i.outputSchemaId,
        toolPolicy: i.toolPolicy ?? READ_ONLY_TOOL_POLICY,
        providerRoute: i.providerRoute ?? DEFAULT_ROUTE,
        // ING-7 / inv-2: an imported source is untrusted raw content — always.
        trustLevel: "untrusted",
        carriesRawContent: true,
        maxRuntimeSeconds: i.maxRuntimeSeconds,
        ...(i.maxCostUsd !== undefined ? { maxCostUsd: i.maxCostUsd } : {}),
        idempotencyKey: i.idempotencyKey,
      };

      // ── ING-7 admission (rule 6): a mutating tool on untrusted content is refused BEFORE any
      //    dispatch. Broker never runs.
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
        // gate-on-outcome: a rejection propagates typed — mapCandidate is NOT reached.
        // SAFETY RULE 7 (incidental, NOT the payload — see rejectionMessageFor's doc
        // comment): the Broker's `outcome.error.message` is forwarded VERBATIM except
        // when `outcome.error.reason === "schema_rejected"`, the one path that can carry
        // untrusted model-authored field names. The closed `code` is still what a
        // workflow driver switches on and crosses byte-identical.
        const code = mapRejection(outcome);
        return err({ code, message: rejectionMessageFor(outcome.error.reason, outcome.error.message) });
      }
      // Accepted: map the Broker CANDIDATE → an AgentExtraction (the mapper gates on the accepted
      // outcome + owns the §9 output-schema shape arch_gap).
      return ok(deps.mapCandidate(outcome));
    },
  };
}

// The minimal loopback-local DEFAULT route (a real route is resolved by the Broker from the
// ProviderMatrix, which OVERRIDES job.providerRoute before any egress/budget/exec decision; this is
// only the pre-dispatch placeholder the ING-7 predicate is evaluated over — admission is
// route-independent). 18.24 step-6 item iv — SINGLE-SOURCED to `LOCAL_EXTRACTION_ROUTE` (L5/L37): the
// boot `capabilityDefaults["source.process"]` literal, `LOCAL_EXTRACTION_ROUTE`, and this constant are now
// ONE frozen constant, so a route change can never silently drift the three copies (byte-equivalent to the
// prior inline literal). Drift-guarded by `subscription-arming-boot-wiring.test.ts`.
const DEFAULT_ROUTE: ProviderRoute = LOCAL_EXTRACTION_ROUTE;
