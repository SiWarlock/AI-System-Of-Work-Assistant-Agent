// spec(§20.1 "Budget cap" · COST-1 · REQ-S-007) — task 12.12.
//
// §20.1 acceptance suite for the budget cap (COST-1). Unlike the
// packages/providers unit test (budget-enforcer.test.ts pins the pre/post
// gate in isolation), this ACCEPTANCE suite drives the breach end-to-end
// through the REAL Broker pipeline (createBroker) wired to the REAL budget
// gate (createBudgetGate) — proving that a runtime-cap breach cancels the job
// AT THE PIPELINE SEAM, discards the run's output BEFORE the schema gate, and
// leaves NO partial uncommitted side effect. It then SCORES the `BUDGET_CAP`
// criterion through the EVAL-1 runner (task 12.1).
//
// DoD honesty: BUDGET_CAP.requiresRealIntegration === false — the COST-1
// enforcement is DETERMINISTIC control-plane code (a pure state machine + pure
// gate), so a fixture-driven run IS the real code path and reports DoD-passing.
// No vendor/provider is needed to certify "a breach cancels with no side
// effect"; the runner's dodValid is true because the criterion is not
// real-integration-gated.
//
// Acceptance criteria exercised (§20.1 / task 12.12 bullets):
//   (a) a maxRuntimeSeconds breach CANCELS the job → cancelled_budget, RECORDS
//       it in an audit signal, and surfaces a distinct OBS-2 System Health item.
//   (b) the cancelled job leaves NO partial uncommitted side effect: the schema
//       gate (the candidate-producing stage that feeds KnowledgeWriter / the
//       Tool Gateway) is NEVER reached, NO candidate is emitted, and the job
//       comes to rest in the FROZEN terminal `cancelled_budget` state — it can
//       never advance to `accepted`/emit. (COST-1's authoritative terminal is
//       `cancelled_budget`; the workflow layer folds that branch onto the
//       `budget_exceeded` failure code — see runAgentJob.ts.)
import { describe, it, expect } from "vitest";
import { ok, isErr, isOk } from "@sow/contracts";
import type {
  AgentJob,
  ProviderRoute,
  EgressPolicy,
  ProviderMatrix,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import {
  validAgentJob,
  validProviderRoute,
  validProviderMatrix,
  validEgressPolicy,
  validKnowledgeMutationPlan,
} from "@sow/contracts";
import { allowDecision, buildAuditSignal, type AuditSignal } from "@sow/policy";
import { agentJobMachine } from "@sow/domain";
import {
  createBroker,
  createBudgetGate,
  detectBudgetBreach,
  budgetBreachHealthItem,
  resolveEnforcedBudget,
  BUDGET_BREACH_HEALTH_CLASS,
  makeAgentResult,
  type BrokerJobRequest,
  type BrokerDeps,
  type BrokerCandidate,
  type BudgetEnforcerConfig,
  type EnforcedBudget,
  type HealthGate,
  type ProviderRunner,
  type SchemaGate,
} from "@sow/providers";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const AUDIT: AuditSignal = buildAuditSignal({
  actor: "test",
  event: "test.audit",
  refs: [],
  payloadHash: "test",
  beforeSummary: "b",
  afterSummary: "a",
});

// COST-2 default caps (values would come from config/providers.defaults.json;
// here the job carries EXPLICIT caps so these defaults are the safety floor only).
const budgetConfig: BudgetEnforcerConfig = {
  defaults: { global: { maxRuntimeSeconds: 60, maxCostUsd: 1 } },
};

const workspace: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "employer_work",
  dataOwner: "employer",
};

const CANDIDATE: BrokerCandidate = {
  kind: "knowledge_mutation_plan",
  plan: validKnowledgeMutationPlan,
};

// The job under test carries an EXPLICIT maxRuntimeSeconds=300 / maxCostUsd=5
// (validAgentJob). The enforced runtime cap is therefore 300s.
const ENFORCED: EnforcedBudget = resolveEnforcedBudget(validAgentJob, budgetConfig.defaults);

/**
 * Assemble the REAL broker over the REAL budget gate. Route/egress/admission are
 * passthrough seams (each exercised by its own suite); the HEALTH gate proceeds;
 * the RUN returns a completed result with caller-supplied usage; the SCHEMA gate
 * is a SPY that records whether it was ever reached (it must NOT be on a breach).
 */
function harness(usageRuntimeSeconds: number) {
  const schemaCalls: number[] = [];
  const health: HealthGate = () => ok({ value: undefined });
  const run: ProviderRunner = async () =>
    ok({
      value: makeAgentResult({
        status: "completed",
        candidateOutput: { some: "unvalidated model output" },
        usage: { runtimeSeconds: usageRuntimeSeconds, costUsd: 0 },
        logs: [],
      }),
    });
  const schema: SchemaGate = () => {
    schemaCalls.push(1);
    return ok({ value: CANDIDATE });
  };
  const deps: BrokerDeps = {
    health,
    budget: createBudgetGate(budgetConfig), // ← REAL COST-1 gate
    run,
    schema,
    admit: (job: AgentJob) => allowDecision(job, AUDIT),
    resolveRoute: (_job, _matrix, _local) => allowDecision(validProviderRoute, AUDIT),
    egressVeto: (_job, route: ProviderRoute) => allowDecision(route, AUDIT),
  };
  const request: BrokerJobRequest = {
    job: validAgentJob,
    matrix: validProviderMatrix as ProviderMatrix,
    egress: validEgressPolicy as EgressPolicy,
    workspace,
  };
  return { broker: createBroker(deps), request, schemaCalls };
}

describe("§20.1 Budget cap — COST-1 runtime breach CANCELS with no partial side effect", () => {
  it("a maxRuntimeSeconds breach ⇒ cancelled_budget; output discarded BEFORE the schema gate; NO candidate", async () => {
    // usage 900s >> enforced 300s cap ⇒ runtime breach.
    const { broker, request, schemaCalls } = harness(900);
    const out = await broker.runJob(request);

    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;

    // (a) the job is CANCELLED on the budget dimension at the post-run gate.
    expect(out.error.stage).toBe("budget_post");
    expect(out.error.reason).toBe("budget_exceeded");
    expect(out.error.branch).toBe("cancelled_budget");
    expect(out.error.jobState).toBe("cancelled_budget");
    // A budget breach is NOT a transparent retry (raising a cap is an operator act).
    expect(out.error.retryable).toBe(false);

    // (b) HARD no-partial-side-effect invariant: the candidate-producing schema
    // gate was NEVER reached, so nothing could ever be handed to KnowledgeWriter
    // (Markdown commit) or the Tool Gateway (external write).
    expect(schemaCalls).toHaveLength(0);
    // A rejection carries NO candidate field — structurally nothing to apply.
    expect(out.error).not.toHaveProperty("candidate");
  });

  it("the breach is RECORDED in a redaction-safe audit signal (event + cancelled summary)", async () => {
    const { broker, request } = harness(900);
    const out = await broker.runJob(request);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;

    const breachAudit = out.error.audits.find((a) => a.event === "broker.budget.breach");
    expect(breachAudit).toBeDefined();
    expect(breachAudit?.afterSummary).toContain("cancelled_budget");
    // Redaction-safe: the recorded summary carries numeric bounds only (900s/300s),
    // never raw content or the model's output.
    expect(breachAudit?.healthSignalClass).toBe(BUDGET_BREACH_HEALTH_CLASS);
    // The deny's own audit IS the breach audit (short-circuit denial carries it).
    expect(out.error.audit.event).toBe("broker.budget.breach");
  });

  it("surfaces a DISTINCT OBS-2 System Health item for the budget-cancelled job", () => {
    const breach = detectBudgetBreach({ runtimeSeconds: 900, costUsd: 0 }, ENFORCED);
    expect(breach).toBeDefined();
    if (breach === undefined) return;
    expect(breach.runtime).toEqual({ observed: 900, limit: ENFORCED.maxRuntimeSeconds });

    const item = budgetBreachHealthItem(validAgentJob, breach);
    expect(item.healthClass).toBe(BUDGET_BREACH_HEALTH_CLASS);
    expect(item.message).toContain("cancelled on budget breach");
    // Refs point at the job/workspace/capability — numbers + refs only (OBS-2).
    expect(item.refs).toContain(`ref:job:${validAgentJob.id}`);
  });

  it("cancelled_budget is a FROZEN terminal state — the job can never advance to emit", () => {
    expect(agentJobMachine.isTerminal("cancelled_budget")).toBe(true);
    // No legal edge to any accepting/emitting state exists from the cancelled job.
    expect(agentJobMachine.canTransition("cancelled_budget", "schema_validated")).toBe(false);
    expect(agentJobMachine.canTransition("cancelled_budget", "accepted")).toBe(false);
    expect(agentJobMachine.transition("cancelled_budget", "accepted").ok).toBe(false);
  });
});

describe("§20.1 Budget cap — COST-1 does NOT over-trigger (under-budget job runs to completion)", () => {
  it("usage within the cap ⇒ budget.post passes, pipeline reaches the schema gate and ACCEPTS", async () => {
    const { broker, request, schemaCalls } = harness(10); // 10s << 300s cap
    const out = await broker.runJob(request);

    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.jobState).toBe("accepted");
    expect(out.value.candidate).toEqual(CANDIDATE);
    // The contrast that proves the cancel above was CAUSED by the breach, not by
    // the harness: under budget, the schema/emit stage DID run.
    expect(schemaCalls).toHaveLength(1);
  });
});

describe("§20.1 Budget cap — deterministic re-drive accumulates NO side effect", () => {
  it("re-driving the breaching job yields the identical cancelled_budget outcome; schema still never runs", async () => {
    const first = harness(900);
    const a = await first.broker.runJob(first.request);
    const second = harness(900);
    const b = await second.broker.runJob(second.request);

    expect(isErr(a)).toBe(true);
    expect(isErr(b)).toBe(true);
    if (!isErr(a) || !isErr(b)) return;
    expect(a.error.jobState).toBe("cancelled_budget");
    expect(b.error.jobState).toBe(a.error.jobState);
    expect(b.error.branch).toBe(a.error.branch);
    // No candidate ever produced on either drive → nothing to double-commit.
    expect(first.schemaCalls).toHaveLength(0);
    expect(second.schemaCalls).toHaveLength(0);
  });
});

describe("budget-cap — EVAL-1 runner scoring", () => {
  it("scores BUDGET_CAP through the runner: functional AND DoD pass (deterministic, no vendor)", () => {
    // The measured value = "the no-partial-side-effect gate held" (a boolean gate).
    const out = scoreById({
      criterionId: "BUDGET_CAP",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
    expect(out.prdTest).toBe("Budget cap");
    expect(out.threshold.kind).toBe("gate");
  });

  it("registry marks budget-cap as NOT requiring a real integration (deterministic control code)", () => {
    expect(criterionById("BUDGET_CAP")?.requiresRealIntegration).toBe(false);
  });
});
