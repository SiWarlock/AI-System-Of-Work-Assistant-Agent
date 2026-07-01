// @sow/providers — the Runtime/Provider Broker (§7 task 5.2).
//
// This module OWNS the FIXED-ORDER gate pipeline. It orchestrates, in EXACTLY
// this order (reordering is a defect):
//
//   admission (ING-7, @sow/policy admitJob)
//     → route resolution (capabilityDefaults, ./route-resolution)
//     → EGRESS VETO (@sow/policy egressVeto — AFTER selection; narrow/deny only,
//       never a cloud fallback)
//     → provider health / model availability (5.9, injected)
//     → budget caps (5.4, injected — COST-1/2)
//     → schema / tool-policy gate + output normalization (5.5, injected)
//     → emit a KnowledgeMutationPlan / ProposedAction CANDIDATE.
//
// Each gate failure SHORT-CIRCUITS to a typed denial carrying an AuditSignal; the
// broker returns and no later gate runs — so a later gate can never widen an
// earlier denial. The AgentJob lifecycle is driven through the FROZEN @sow/domain
// machine via ./agent-job-machine (spine ordering enforced there).
//
// STRICT SIDE-EFFECT RULE (safety): the broker emits ONLY a candidate — it never
// imports or calls a write adapter, never writes Markdown / an external system.
// A cancelled / budget-breached / schema-rejected job discards output BEFORE any
// hand-off. Never throws across the boundary — every outcome is a typed Result.
import { ok, err, isOk, isErr } from "@sow/contracts";
import type {
  AgentJob,
  ProviderMatrix,
  ProviderRoute,
  EgressPolicy,
  WorkspaceType,
  DataOwner,
  KnowledgeMutationPlan,
  ProposedAction,
  Result,
} from "@sow/contracts";
import {
  admitJob,
  isDeny,
  buildAuditSignal,
  type PolicyDecision,
  type AuditSignal,
  type DenialReason,
  type LocalProviderConfig,
} from "@sow/policy";
import { resolveJobRoute } from "./route-resolution";
import { vetoJobEgress } from "./egress-veto";
import { newJobLifecycle } from "./agent-job-machine";
import type { AgentJobState, JobBranch, JobLifecycle } from "./agent-job-machine";
import type { AgentResult, AgentUsage } from "../ports/agent-result";

// arch_gap: the frozen `FailureClass` enum has no provider-routing / no-eligible-
// provider member, and no distinct budget/schema broker classes beyond
// `budget_breach` / `schema_rejection`. Rather than mint enum members on a frozen
// contract, the broker surfaces the "no eligible provider after the gate
// sequence" fail-closed System Health item (OBS-2) under this named class —
// mirroring @sow/policy's POLICY_DENIAL_HEALTH_CLASS arch_gap convention. Flagged
// in the task manifest.
export const NO_ELIGIBLE_PROVIDER_HEALTH_CLASS = "provider_routing_unavailable" as const;

const BROKER_ACTOR = "broker:pipeline" as const;
const BROKER_MARKER = "broker:pipeline-decision" as const;

/** Broker-internal failure reasons for gates that don't emit a §5 DenialReason. */
export const BrokerFailureReason = [
  "no_eligible_provider",
  "provider_unavailable",
  "budget_exceeded",
  "provider_error",
  "provider_cancelled",
  "schema_rejected",
  "tool_policy_violation",
  "lifecycle_fault",
] as const;
export type BrokerFailureReason = (typeof BrokerFailureReason)[number];

/** The pipeline stages, in fixed order (the value ordering IS the contract). */
export const BrokerStage = [
  "admission",
  "route_resolution",
  "egress_veto",
  "health",
  "budget_pre",
  "run",
  "budget_post",
  "schema_gate",
  "emit",
] as const;
export type BrokerStage = (typeof BrokerStage)[number];

// ── gate step outcome vocabulary ────────────────────────────────────────────

/** A gate PROCEEDS with a produced value + an optional audit signal. */
export interface GateProceed<T> {
  readonly value: T;
  readonly audit?: AuditSignal;
}

/** A gate DENIES: a typed reason, message, audit, the terminal branch it maps to, retryability. */
export interface GateDeny {
  readonly reason: DenialReason | BrokerFailureReason;
  readonly message: string;
  readonly audit: AuditSignal;
  readonly branch: JobBranch;
  readonly retryable: boolean;
}

/** A gate result: proceed-with-value or a typed deny. Never a throw (§16). */
export type GateResult<T> = Result<GateProceed<T>, GateDeny>;

/** The enforced per-job budget the pre-gate derives (COST-2 default cap applied). */
export interface EnforcedBudget {
  readonly maxRuntimeSeconds: number;
  readonly maxCostUsd?: number;
}

// ── injected gate ports (5.9 / 5.4 / 5.5 fill these; the broker owns ordering) ─

/** 5.9 — provider health / model-availability gate. */
export type HealthGate = (
  route: ProviderRoute,
  job: AgentJob,
) => GateResult<void> | Promise<GateResult<void>>;

/** 5.4 — budget enforcement: pre-run cap derivation + post-run breach detection. */
export interface BudgetGate {
  /** Derive/validate the enforced budget (applies the COST-2 default cap). */
  pre(job: AgentJob): GateResult<EnforcedBudget>;
  /** Detect a runtime/cost breach after the run — breach ⇒ cancel (deny). */
  post(job: AgentJob, usage: AgentUsage, budget: EnforcedBudget): GateResult<void>;
}

/** Invokes the resolved runtime/model port and returns the candidate AgentResult. */
export type ProviderRunner = (
  route: ProviderRoute,
  job: AgentJob,
  budget: EnforcedBudget,
  signal?: AbortSignal,
) => Promise<GateResult<AgentResult>>;

/** 5.5 — schema/tool-policy gate + normalization → a candidate. */
export type SchemaGate = (
  job: AgentJob,
  result: AgentResult,
) => GateResult<BrokerCandidate> | Promise<GateResult<BrokerCandidate>>;

/** The emitted CANDIDATE — never applied; the strict side-effect rule stops here. */
export type BrokerCandidate =
  | { readonly kind: "knowledge_mutation_plan"; readonly plan: KnowledgeMutationPlan }
  | { readonly kind: "proposed_action"; readonly action: ProposedAction };

/** Replay ledger: an already-accepted idempotencyKey is served from here, not re-run. */
export interface IdempotencyLedger {
  get(idempotencyKey: string): BrokerAccepted | undefined;
  record(idempotencyKey: string, accepted: BrokerAccepted): void;
}

// ── broker input + injected dependencies ────────────────────────────────────

export interface BrokerJobRequest {
  readonly job: AgentJob;
  readonly matrix: ProviderMatrix;
  readonly egress: EgressPolicy;
  readonly workspace: { readonly type: WorkspaceType; readonly dataOwner: DataOwner };
  readonly localConfig?: LocalProviderConfig;
}

export interface BrokerDeps {
  readonly health: HealthGate;
  readonly budget: BudgetGate;
  readonly run: ProviderRunner;
  readonly schema: SchemaGate;
  /** Optional replay ledger (bullet: no duplicate accept/audit/candidate on re-drive). */
  readonly ledger?: IdempotencyLedger;
  // Test seams / overrides for the policy-backed early gates. Default to @sow/policy.
  readonly admit?: (job: AgentJob) => PolicyDecision<AgentJob>;
  readonly resolveRoute?: (
    job: AgentJob,
    matrix: ProviderMatrix,
    localConfig?: LocalProviderConfig,
  ) => PolicyDecision<ProviderRoute>;
  readonly egressVeto?: (
    job: AgentJob,
    route: ProviderRoute,
    egress: EgressPolicy,
    workspace: { type: WorkspaceType; dataOwner: DataOwner },
  ) => PolicyDecision<ProviderRoute>;
}

// ── broker outcome ──────────────────────────────────────────────────────────

/** A distinct System Health item (OBS-2) surfaced when the pipeline fails closed. */
export interface BrokerHealthItem {
  readonly healthClass: string;
  readonly message: string;
  readonly refs: readonly string[];
}

export interface BrokerAccepted {
  readonly jobState: AgentJobState; // "accepted"
  readonly route: ProviderRoute;
  readonly candidate: BrokerCandidate;
  readonly usage: AgentUsage;
  readonly audits: readonly AuditSignal[];
  /** True iff this outcome was served from the idempotency ledger (a replay). */
  readonly replayed: boolean;
}

export interface BrokerRejection {
  readonly stage: BrokerStage;
  readonly reason: DenialReason | BrokerFailureReason;
  readonly message: string;
  readonly audit: AuditSignal;
  /** The last LEGAL machine state reached (truthful — no fabricated illegal edge). */
  readonly jobState: AgentJobState;
  /** The semantic terminal branch this failure maps to. */
  readonly branch: JobBranch;
  readonly retryable: boolean;
  /** Present on a fail-closed no-eligible-provider outcome (route/egress/health). */
  readonly healthItem?: BrokerHealthItem;
  readonly audits: readonly AuditSignal[];
}

export type BrokerOutcome = Result<BrokerAccepted, BrokerRejection>;

// ── the broker ──────────────────────────────────────────────────────────────

export interface Broker {
  runJob(req: BrokerJobRequest, signal?: AbortSignal): Promise<BrokerOutcome>;
}

/**
 * Build a Broker over the injected gates. The ordering is HARD-WIRED in `runJob`;
 * the injected steps fill behavior (5.4/5.5/5.9) without ever being able to
 * reorder the pipeline. Pure factory (no I/O of its own).
 */
export function createBroker(deps: BrokerDeps): Broker {
  const admit = deps.admit ?? admitJob;
  const resolve = deps.resolveRoute ?? resolveJobRoute;
  const veto = deps.egressVeto ?? vetoJobEgress;

  return {
    async runJob(req: BrokerJobRequest, signal?: AbortSignal): Promise<BrokerOutcome> {
      const { job, matrix, egress, workspace, localConfig } = req;
      const audits: AuditSignal[] = [];

      // ── replay guard: an already-accepted key is served, not re-run ─────────
      const prior = deps.ledger?.get(job.idempotencyKey);
      if (prior !== undefined) {
        return ok({ ...prior, replayed: true });
      }

      let life: JobLifecycle = newJobLifecycle("created");

      // ── 1. ADMISSION (ING-7): created → admitted ────────────────────────────
      const adm = admit(job);
      audits.push(adm.audit);
      if (isDeny(adm)) {
        return err(
          reject("admission", adm.reason, adm.message, adm.audit, life.state, "rejected", false, audits),
        );
      }
      const admitted = life.advance("admitted");
      if (isErr(admitted)) return err(lifecycleFault("admission", life.state, audits));
      life = admitted.value;

      // ── 2. ROUTE RESOLUTION (capabilityDefaults, job's workspace) ───────────
      const routed = resolve(job, matrix, localConfig);
      audits.push(routed.audit);
      if (isDeny(routed)) {
        // No route → fail closed with a System Health item; never a silent fallback.
        return err(
          failClosedNoProvider("route_resolution", routed.reason, routed.message, routed.audit, life.state, job, audits),
        );
      }
      let route: ProviderRoute = routed.value;

      // ── 3. EGRESS VETO (AFTER selection; narrow/deny only, no cloud fallback) ─
      const vetoed = veto(job, route, egress, workspace);
      audits.push(vetoed.audit);
      if (isDeny(vetoed)) {
        return err(
          failClosedNoProvider("egress_veto", vetoed.reason, vetoed.message, vetoed.audit, life.state, job, audits),
        );
      }
      route = vetoed.value; // the veto may only NARROW the route, never widen it.

      // ── 4. HEALTH / model availability (5.9) ────────────────────────────────
      const health = await deps.health(route, job);
      if (isErr(health)) {
        const d = health.error;
        audits.push(d.audit);
        return err(
          failClosedNoProvider("health", d.reason, d.message, d.audit, life.state, job, audits),
        );
      }
      if (health.value.audit) audits.push(health.value.audit);

      // Selection COMMITTED (route resolved + egress-cleared + healthy): admitted → provider_selected.
      const selected = life.advance("provider_selected");
      if (isErr(selected)) return err(lifecycleFault("health", life.state, audits));
      life = selected.value;

      // The matrix-resolved, egress-VETOED `route` is AUTHORITATIVE for execution
      // AND budget (§7). Thread it as the job's effective route so no downstream
      // consumer — a runtime adapter dispatching to `job.providerRoute`, or the
      // budget/cost enforcer pricing `job.providerRoute` — can execute or bill an
      // UN-VETOED route. Without this, the egress veto vets `route` while the
      // adapter egresses to `job.providerRoute` (the veto would not bind the
      // executed target; COST-1/2 would price the wrong route).
      const effectiveJob: AgentJob =
        routesEqual(job.providerRoute, route) ? job : { ...job, providerRoute: route };
      if (effectiveJob !== job) {
        audits.push(
          brokerAudit(
            "provider.route.overridden",
            "job.providerRoute diverged from the matrix-resolved+vetoed route; the vetted route is authoritative for execution and budget",
            [`ref:job:${job.id}`],
          ),
        );
      }

      // ── 5. BUDGET pre (5.4): derive enforced caps (COST-2 default) ──────────
      const bpre = deps.budget.pre(effectiveJob);
      if (isErr(bpre)) {
        const d = bpre.error;
        audits.push(d.audit);
        return err(reject("budget_pre", d.reason, d.message, d.audit, life.state, d.branch, d.retryable, audits));
      }
      if (bpre.value.audit) audits.push(bpre.value.audit);
      const budget: EnforcedBudget = bpre.value.value;

      // ── 6. RUN the resolved port: provider_selected → running ───────────────
      const runningState = life.advance("running");
      if (isErr(runningState)) return err(lifecycleFault("run", life.state, audits));
      life = runningState.value;

      const ran = await deps.run(route, effectiveJob, budget, signal);
      if (isErr(ran)) {
        const d = ran.error;
        audits.push(d.audit);
        // The domain machine has no running→failed_* edge; the lifecycle rests at
        // its last legal state ("running") and the semantic branch rides the
        // rejection (truthful — no fabricated illegal edge). arch_gap noted above.
        return err(reject("run", d.reason, d.message, d.audit, life.state, d.branch, d.retryable, audits));
      }
      if (ran.value.audit) audits.push(ran.value.audit);
      const result: AgentResult = ran.value.value;

      // A cooperatively-cancelled result carries NO committable output — discard
      // it (running → cancelled_budget) BEFORE the schema gate (no side effect).
      if (result.status === "cancelled") {
        const cancelled = life.advance("cancelled_budget");
        if (isErr(cancelled)) return err(lifecycleFault("run", life.state, audits));
        life = cancelled.value;
        const audit = brokerAudit("provider.run.cancelled", "provider run cancelled cooperatively; output discarded (no side effect)", [
          `ref:job:${job.id}`,
        ]);
        audits.push(audit);
        return err(
          reject("run", "provider_cancelled", "provider run cancelled; output discarded before any hand-off", audit, life.state, "cancelled_budget", true, audits),
        );
      }

      // ── 7. BUDGET post (5.4): breach ⇒ cancel (running → cancelled_budget) ───
      const bpost = deps.budget.post(effectiveJob, result.usage, budget);
      if (isErr(bpost)) {
        const d = bpost.error;
        const cancelled = life.advance("cancelled_budget");
        if (isErr(cancelled)) return err(lifecycleFault("budget_post", life.state, audits));
        life = cancelled.value;
        audits.push(d.audit);
        // No partial side effect: output discarded before the schema gate — no candidate emitted.
        return err(reject("budget_post", d.reason, d.message, d.audit, life.state, "cancelled_budget", d.retryable, audits));
      }
      if (bpost.value.audit) audits.push(bpost.value.audit);

      // ── 8. SCHEMA / TOOL gate + normalize (5.5): running → schema_validated ─
      const validatedState = life.advance("schema_validated");
      if (isErr(validatedState)) return err(lifecycleFault("schema_gate", life.state, audits));
      life = validatedState.value;

      const gated = await deps.schema(effectiveJob, result);
      if (isErr(gated)) {
        const d = gated.error;
        audits.push(d.audit);
        // schema_validated → {rejected | failed_retryable | failed_terminal} are legal.
        const branched = life.advance(d.branch);
        if (!isErr(branched)) life = branched.value;
        return err(reject("schema_gate", d.reason, d.message, d.audit, life.state, d.branch, d.retryable, audits));
      }
      if (gated.value.audit) audits.push(gated.value.audit);
      const candidate: BrokerCandidate = gated.value.value;

      // ── 9. EMIT the candidate: schema_validated → accepted ──────────────────
      const acceptedState = life.advance("accepted");
      if (isErr(acceptedState)) return err(lifecycleFault("emit", life.state, audits));
      life = acceptedState.value;

      const accepted: BrokerAccepted = {
        jobState: life.state,
        route,
        candidate,
        usage: result.usage,
        audits: [...audits],
        replayed: false,
      };
      deps.ledger?.record(job.idempotencyKey, accepted);
      return ok(accepted);
    },
  };
}

// ── helpers (pure) ──────────────────────────────────────────────────────────

function reject(
  stage: BrokerStage,
  reason: DenialReason | BrokerFailureReason,
  message: string,
  audit: AuditSignal,
  jobState: AgentJobState,
  branch: JobBranch,
  retryable: boolean,
  audits: readonly AuditSignal[],
): BrokerRejection {
  return { stage, reason, message, audit, jobState, branch, retryable, audits: [...audits] };
}

/**
 * A route/egress/health denial means NO eligible provider survived the gate
 * sequence → fail closed (bullet: never a silent fallback) and attach a distinct
 * System Health item (OBS-2). Branch is `failed_retryable` (the operator may fix
 * the matrix / bring a provider up and re-drive).
 */
function failClosedNoProvider(
  stage: BrokerStage,
  reason: DenialReason | BrokerFailureReason,
  message: string,
  audit: AuditSignal,
  jobState: AgentJobState,
  job: AgentJob,
  audits: readonly AuditSignal[],
): BrokerRejection {
  const healthItem: BrokerHealthItem = {
    healthClass: NO_ELIGIBLE_PROVIDER_HEALTH_CLASS,
    message: `no eligible provider after the gate sequence (${stage}): ${message}`,
    refs: [`ref:job:${job.id}`, `ref:workspace:${job.workspaceId}`, `ref:capability:${String(job.capability)}`],
  };
  return {
    stage,
    reason,
    message,
    audit,
    jobState,
    branch: "failed_retryable",
    retryable: true,
    healthItem,
    audits: [...audits],
  };
}

function lifecycleFault(
  stage: BrokerStage,
  jobState: AgentJobState,
  audits: readonly AuditSignal[],
): BrokerRejection {
  const audit = brokerAudit(
    "broker.lifecycle.fault",
    `internal lifecycle fault at ${stage}: illegal transition from ${jobState}`,
    [`ref:stage:${stage}`, `ref:state:${jobState}`],
  );
  return {
    stage,
    reason: "lifecycle_fault",
    message: `broker lifecycle fault at ${stage}`,
    audit,
    jobState,
    branch: "failed_terminal",
    retryable: false,
    audits: [...audits, audit],
  };
}

function brokerAudit(event: string, afterSummary: string, refs: readonly string[]): AuditSignal {
  return buildAuditSignal({
    actor: BROKER_ACTOR,
    event,
    refs,
    payloadHash: BROKER_MARKER,
    beforeSummary: "broker pipeline in progress",
    afterSummary,
  });
}

/**
 * Structural equality of two ProviderRoutes on the fields that determine the
 * egress target + cost: the port key (provider | runtime), model, endpoint,
 * egressClass. Used to decide whether the matrix-resolved route diverged from
 * the job's declared `providerRoute` (and thus whether to emit the override
 * audit note). Pure.
 */
function routesEqual(a: ProviderRoute, b: ProviderRoute): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return false;
  const aKey = "provider" in a ? `p:${a.provider}` : "runtime" in a ? `r:${a.runtime}` : "?";
  const bKey = "provider" in b ? `p:${b.provider}` : "runtime" in b ? `r:${b.runtime}` : "?";
  return aKey === bKey && a.model === b.model && a.endpoint === b.endpoint && a.egressClass === b.egressClass;
}
