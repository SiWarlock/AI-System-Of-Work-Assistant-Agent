// 18.2 — the REAL broker HEALTH / BUDGET / SCHEMA gates wired into assembleBackends
// (replacing the three stubs) + the NEW worker `BudgetLedgerPort` seam. These gates
// are deny-only POLICING — no spend, no egress, no external write; ACTIVE by default
// (no dormancy knob). SAFE-BUILD: health/availability sources are FAKE/inert (no
// network reachability probe); the SCHEMA gate is the candidate-data gate (rule 2 /
// REQ-S-006). Accept-path (Option 1): the meeting/source broker candidate is a
// KnowledgeMutationPlan stand-in under the registered KMP schema (a read_only
// untrusted job can only emit a KMP — a ProposedAction is a tool_policy_violation).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { isOk, isErr, validAgentJob, validKnowledgeMutationPlan, validProposedAction } from "@sow/contracts";
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  PROPOSED_ACTION_SCHEMA_ID,
} from "@sow/contracts";
import type {
  AgentJob,
  ProviderRoute,
  ProviderMatrix,
  EgressPolicy,
} from "@sow/contracts";
import type { EnforcedBudget, HealthGateSources, AgentUsage } from "@sow/providers";
import {
  assembleBackends,
  type ProofSpineBackends,
} from "../../src/composition/backends";
import {
  createSingleRunBudgetLedger,
  createLedgeredBudgetGate,
  DEFAULT_BUDGET_DEFAULTS,
  type BudgetLedgerPort,
  type BudgetLedgerEntry,
} from "../../src/composition/budget-ledger";

// ── fixtures ────────────────────────────────────────────────────────────────
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
const WS = validAgentJob.workspaceId;
const local = {
  provider: "ollama",
  model: "local-default",
  endpoint: LOCAL_ENDPOINT,
  egressClass: "local",
} as unknown as ProviderRoute;

// A valid local employer_work meeting.close job whose candidate is a KMP (Option 1).
const kmpJob = (over: Record<string, unknown> = {}): AgentJob => ({
  ...validAgentJob,
  providerRoute: local,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  idempotencyKey: "idem-gates",
  ...over,
});
const matrix: ProviderMatrix = {
  workspaceId: WS,
  allowedProviders: ["ollama"],
  capabilityDefaults: { "meeting.close": local } as ProviderMatrix["capabilityDefaults"],
  rawCloudEgressEnabled: false,
};
const egress: EgressPolicy = {
  workspaceId: WS,
  allowedProcessors: [],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
};
const request = (job: AgentJob) => ({
  job,
  matrix,
  egress,
  workspace: { type: "employer_work" as const, dataOwner: "employer" as const },
  localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
});

const healthySources: HealthGateSources = {
  health: () => ({ state: "healthy" }),
  availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
};
const unhealthySources: HealthGateSources = {
  health: () => ({ state: "unreachable" }),
  availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
};

const opened: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of opened.splice(0)) b.close();
});
const assemble = async (
  config: Parameters<typeof assembleBackends>[0],
  candidateOutput: unknown,
): Promise<ProofSpineBackends> => {
  const b = await assembleBackends(config, { candidateOutput });
  opened.push(b);
  return b;
};

// ── BUDGET + the NEW BudgetLedgerPort seam (direct unit tests) ────────────────
describe("createLedgeredBudgetGate / BudgetLedgerPort — single-run budget accounting", () => {
  const ledgerConfig = { defaults: DEFAULT_BUDGET_DEFAULTS };

  it("budget_pre_failcloses_when_no_bounded_cap — no derivable runtime cap ⇒ deny (spec COST-2)", () => {
    const gate = createLedgeredBudgetGate(
      { defaults: { global: { maxRuntimeSeconds: 0, maxCostUsd: 0.5 } } },
      createSingleRunBudgetLedger(),
    );
    // A job with no explicit (positive) runtime cap + a config whose default is unbounded (0).
    const res = gate.pre(kmpJob({ maxRuntimeSeconds: 0 }));
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("budget_exceeded");
    expect(res.error.branch).toBe("failed_terminal");
  });

  it("budget_post_denies_over_budget_run — usage exceeds the cap ⇒ cancelled_budget (spec COST-1 REQ-S-007)", () => {
    const gate = createLedgeredBudgetGate(ledgerConfig, createSingleRunBudgetLedger());
    const budget: EnforcedBudget = { maxRuntimeSeconds: 10, maxCostUsd: 5 };
    const usage: AgentUsage = { runtimeSeconds: 100 }; // 100s > 10s cap
    const res = gate.post(kmpJob(), usage, budget);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("budget_exceeded");
    expect(res.error.branch).toBe("cancelled_budget");
  });

  it("budget_ledger_seam_single_run_accounts — post records this run's spend into the ledger (spec 18.2 seam)", () => {
    const spy: BudgetLedgerPort & { calls: BudgetLedgerEntry[] } = {
      calls: [],
      record(e: BudgetLedgerEntry): void {
        this.calls.push(e);
      },
    };
    const gate = createLedgeredBudgetGate(ledgerConfig, spy);
    const budget: EnforcedBudget = { maxRuntimeSeconds: 300, maxCostUsd: 0.5 };
    const usage: AgentUsage = { runtimeSeconds: 2 };
    const res = gate.post(kmpJob({ id: "job-ledger" }), usage, budget);
    expect(isOk(res)).toBe(true); // within budget
    // the seam is invoked with this run's spend (jobId + usage + budget)
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.jobId).toBe("job-ledger");
    expect(spy.calls[0]?.usage.runtimeSeconds).toBe(2);
    expect(spy.calls[0]?.budget.maxRuntimeSeconds).toBe(300);
    // the default single-run impl accumulates in-boot entries (19.11 durable plugs in backward)
    const single = createSingleRunBudgetLedger();
    single.record(spy.calls[0]!);
    expect(single.entries()).toHaveLength(1);
  });

  it("default_budget_defaults_match_config — DEFAULT_BUDGET_DEFAULTS mirrors config/providers.defaults.json §budgets (drift-guard)", () => {
    // The constant transcribes the config (no JSON loader yet) — pin it so a config edit
    // that isn't mirrored fails loudly rather than silently diverging from enforcement.
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../config/providers.defaults.json",
    );
    const budgets = (JSON.parse(readFileSync(configPath, "utf8")) as { budgets: {
      defaultMaxRuntimeSeconds: number;
      defaultMaxCostUsd: number;
      perCapability: Record<string, { maxCostUsd: number; maxRuntimeSeconds: number }>;
    } }).budgets;
    expect(DEFAULT_BUDGET_DEFAULTS.global).toEqual({
      maxRuntimeSeconds: budgets.defaultMaxRuntimeSeconds,
      maxCostUsd: budgets.defaultMaxCostUsd,
    });
    expect(DEFAULT_BUDGET_DEFAULTS.perCapability).toEqual(budgets.perCapability);
  });
});

// ── SCHEMA (candidate-data gate, rule 2) + HEALTH + tool-policy (broker-drive) ─
describe("assembleBackends — real HEALTH/BUDGET/SCHEMA gates wired into the broker", () => {
  it("schema_gate_rejects_invalid_candidate_no_side_effect — invalid candidate ⇒ schema_rejected (spec rule2 REQ-S-006)", async () => {
    // The stub run yields a candidate that FAILS the KMP ajv/output-schema.
    const backends = await assemble({ healthSources: healthySources }, { not: "a valid KMP" });
    const outcome = await backends.broker.runJob(request(kmpJob()));
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("schema_gate");
    expect(outcome.error.reason).toBe("schema_rejected");
    expect(outcome.error.branch).toBe("rejected");
    expect(outcome.error.retryable).toBe(false);
  });

  it("schema_gate_accepts_valid_candidate — a valid KMP passes ⇒ knowledge_mutation_plan candidate emitted (spec §7)", async () => {
    const backends = await assemble({ healthSources: healthySources }, validKnowledgeMutationPlan);
    const outcome = await backends.broker.runJob(request(kmpJob()));
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
  });

  it("health_gate_denies_unhealthy_provider — unreachable provider ⇒ fail-closed retryable deny, zero run (spec §7)", async () => {
    const backends = await assemble({ healthSources: unhealthySources }, validKnowledgeMutationPlan);
    const outcome = await backends.broker.runJob(request(kmpJob()));
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("health");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.healthItem).toBeDefined();
  });

  it("health_gate_proceeds_healthy — a healthy source proceeds past health to acceptance (spec §7 accept)", async () => {
    const backends = await assemble({ healthSources: healthySources }, validKnowledgeMutationPlan);
    const outcome = await backends.broker.runJob(request(kmpJob()));
    expect(isOk(outcome)).toBe(true);
  });

  it("assembleBackends_default_meeting_close_stays_green — the DEFAULT gates accept a valid meeting.close job (spec accept-path)", async () => {
    // Default config (no healthSources override ⇒ the inert healthy default) + a valid KMP
    // stub extraction ⇒ the meeting.close job passes health + budget + schema (accept-path preserved).
    const backends = await assemble({}, validKnowledgeMutationPlan);
    const outcome = await backends.broker.runJob(request(kmpJob({ capability: "meeting.close" })));
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
  });

  it("pa_candidate_on_readonly_untrusted_is_tool_policy_violation — a ProposedAction on a read_only untrusted job ⇒ rejected (spec rule2 ING-7-adjacent)", async () => {
    const backends = await assemble({ healthSources: healthySources }, validProposedAction);
    // An untrusted, read_only job (allowsMutating:false) — a PA candidate implies a mutating action.
    const job = kmpJob({
      outputSchemaId: PROPOSED_ACTION_SCHEMA_ID,
      trustLevel: "untrusted",
      carriesRawContent: true,
      toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    });
    const outcome = await backends.broker.runJob(request(job));
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("schema_gate");
    expect(outcome.error.reason).toBe("tool_policy_violation");
    expect(outcome.error.branch).toBe("rejected");
  });

  it("budget_ledger_wired_into_broker — assembleBackends routes budget.post through the injected ledger (spec 18.2 wiring)", async () => {
    // Pin that the ledger seam is actually invoked on the production broker path (not just the
    // direct unit test) — a refactor dropping the wrapper in assembleBackends would fail here.
    const spy: BudgetLedgerPort & { calls: BudgetLedgerEntry[] } = {
      calls: [],
      record(e: BudgetLedgerEntry): void {
        this.calls.push(e);
      },
    };
    const backends = await assemble(
      { healthSources: healthySources, budgetLedger: spy },
      validKnowledgeMutationPlan,
    );
    const outcome = await backends.broker.runJob(request(kmpJob()));
    expect(isOk(outcome)).toBe(true);
    expect(spy.calls).toHaveLength(1); // the broker's budget.post recorded this run
    expect(spy.calls[0]?.usage.runtimeSeconds).toBe(1); // the stub run's fixed usage
  });
});
