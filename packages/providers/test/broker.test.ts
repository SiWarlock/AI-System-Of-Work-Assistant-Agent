// spec(§7) — the Runtime/Provider Broker OWNS the fixed-order gate pipeline:
//   admission (ING-7) → route resolution → egress veto → health → budget →
//   schema/tool gate → normalize → emit candidate.
// Each gate failure SHORT-CIRCUITS to a typed denial + AuditSignal; a later gate
// can never widen an earlier denial (once denied, no further gate runs). Health /
// budget / run / schema are INJECTED here (built in 5.9/5.4/5.5). Never throws.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, ProviderMatrix, ProviderRoute, EgressPolicy } from "@sow/contracts";
import { validAgentJob, validProviderRoute } from "@sow/contracts";
import { allowDecision, buildAuditSignal, type AuditSignal } from "@sow/policy";
import { makeAgentResult, type AgentResult } from "../src/ports/agent-result";
import {
  createBroker,
  NO_ELIGIBLE_PROVIDER_HEALTH_CLASS,
  type BrokerJobRequest,
  type BrokerDeps,
  type BrokerCandidate,
  type HealthGate,
  type BudgetGate,
  type ProviderRunner,
  type SchemaGate,
  type IdempotencyLedger,
  type BrokerAccepted,
} from "../src/broker/broker";

const AUDIT: AuditSignal = buildAuditSignal({
  actor: "test",
  event: "test.audit",
  refs: [],
  payloadHash: "test",
  beforeSummary: "b",
  afterSummary: "a",
});

// ── canned candidate + provider result ──────────────────────────────────────
const CANDIDATE: BrokerCandidate = {
  kind: "knowledge_mutation_plan",
  plan: {
    planId: "plan-x" as never,
    workspaceId: validAgentJob.workspaceId,
    sourceRefs: [{ sourceId: "src-x" as never }],
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: true,
    provenanceOrigin: "meeting_close",
  } as never,
};

function completedResult(): AgentResult {
  return makeAgentResult({
    status: "completed",
    candidateOutput: { title: "candidate" },
    usage: { runtimeSeconds: 3, costUsd: 0.02 },
    logs: [],
  });
}

// ── passthrough / OK gate mocks (with a call-order recorder) ─────────────────
function recorder() {
  const calls: string[] = [];
  const health: HealthGate = () => {
    calls.push("health");
    return ok({ value: undefined });
  };
  const budget: BudgetGate = {
    pre: (job: AgentJob) => {
      calls.push("budget.pre");
      return ok({ value: { maxRuntimeSeconds: job.maxRuntimeSeconds, maxCostUsd: job.maxCostUsd } });
    },
    post: () => {
      calls.push("budget.post");
      return ok({ value: undefined });
    },
  };
  const run: ProviderRunner = async () => {
    calls.push("run");
    return ok({ value: completedResult() });
  };
  const schema: SchemaGate = () => {
    calls.push("schema");
    return ok({ value: CANDIDATE });
  };
  // Egress passthrough (real veto tested separately) — allow the resolved route.
  const egressVeto = (
    _job: AgentJob,
    route: ProviderRoute,
  ): ReturnType<NonNullable<BrokerDeps["egressVeto"]>> => {
    calls.push("egress");
    return allowDecision(route, AUDIT);
  };
  const admit: NonNullable<BrokerDeps["admit"]> = (job) => {
    calls.push("admission");
    return allowDecision(job, AUDIT);
  };
  const resolveRoute: NonNullable<BrokerDeps["resolveRoute"]> = (_job, _matrix) => {
    calls.push("route");
    return allowDecision(validProviderRoute, AUDIT);
  };
  return { calls, health, budget, run, schema, egressVeto, admit, resolveRoute };
}

function matrixFor(route: ProviderRoute): ProviderMatrix {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProviders: ["claude"],
    capabilityDefaults: { "meeting.close": route } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: true,
  };
}

const CLOUD_OK_EGRESS: EgressPolicy = {
  workspaceId: validAgentJob.workspaceId,
  allowedProcessors: ["claude" as never],
  rawContentAllowedProcessors: ["claude" as never],
  employerRawEgressAcknowledged: true,
};

function baseRequest(job: AgentJob = validAgentJob): BrokerJobRequest {
  return {
    job,
    matrix: matrixFor(validProviderRoute),
    egress: CLOUD_OK_EGRESS,
    workspace: { type: "personal_business", dataOwner: "user" },
  };
}

function depsFrom(r: ReturnType<typeof recorder>, extra?: Partial<BrokerDeps>): BrokerDeps {
  return {
    health: r.health,
    budget: r.budget,
    run: r.run,
    schema: r.schema,
    egressVeto: r.egressVeto,
    admit: r.admit,
    resolveRoute: r.resolveRoute,
    ...extra,
  };
}

describe("Broker — happy path + fixed ordering", () => {
  it("drives the full pipeline to accepted with the normalized candidate", async () => {
    const r = recorder();
    const broker = createBroker(depsFrom(r));
    const out = await broker.runJob(baseRequest());
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.jobState).toBe("accepted");
    expect(out.value.candidate).toEqual(CANDIDATE);
    expect(out.value.route).toEqual(validProviderRoute);
    expect(out.value.replayed).toBe(false);
  });

  it("runs the gates in EXACTLY the §7 order", async () => {
    const r = recorder();
    const broker = createBroker(depsFrom(r));
    await broker.runJob(baseRequest());
    expect(r.calls).toEqual([
      "admission",
      "route",
      "egress",
      "health",
      "budget.pre",
      "run",
      "budget.post",
      "schema",
    ]);
  });
});

describe("Broker — short-circuit denials (a later gate never widens an earlier one)", () => {
  it("admission (ING-7) deny short-circuits: no route/egress/run/schema", async () => {
    const untrusted: AgentJob = {
      ...validAgentJob,
      trustLevel: "untrusted",
      carriesRawContent: true,
      toolPolicy: {
        mode: "scoped_write",
        allowedTools: ["write.file" as never],
        deniedTools: [],
        allowsMutating: true,
      },
    };
    const r = recorder();
    // Use the REAL admitJob (drop the override) so ING-7 actually fires.
    const broker = createBroker(depsFrom(r, { admit: undefined }));
    const out = await broker.runJob(baseRequest(untrusted));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("admission");
    expect(out.error.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
    expect(out.error.branch).toBe("rejected");
    // downstream gates never ran
    expect(r.calls).not.toContain("route");
    expect(r.calls).not.toContain("run");
    expect(r.calls).not.toContain("schema");
  });

  it("health deny fails closed with a distinct System Health item; job never reaches provider_selected", async () => {
    const r = recorder();
    const denyHealth: HealthGate = () =>
      err({ reason: "provider_unavailable", message: "model down", audit: AUDIT, branch: "failed_retryable", retryable: true });
    const broker = createBroker(depsFrom(r, { health: denyHealth }));
    const out = await broker.runJob(baseRequest());
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("health");
    expect(out.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS);
    expect(out.error.jobState).toBe("admitted"); // provider_selected NOT committed
    expect(r.calls).not.toContain("run");
  });

  it("budget breach (post) cancels with NO partial side effect: schema/emit never run, no candidate", async () => {
    const r = recorder();
    const breach: BudgetGate = {
      pre: r.budget.pre,
      post: () =>
        err({ reason: "budget_exceeded", message: "runtime cap", audit: AUDIT, branch: "cancelled_budget", retryable: false }),
    };
    const broker = createBroker(depsFrom(r, { budget: breach }));
    const out = await broker.runJob(baseRequest());
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("budget_post");
    expect(out.error.branch).toBe("cancelled_budget");
    expect(out.error.jobState).toBe("cancelled_budget");
    expect(r.calls).not.toContain("schema");
  });

  it("schema/tool-policy reject → rejected branch, no candidate emitted", async () => {
    const r = recorder();
    const rejSchema: SchemaGate = () =>
      err({ reason: "schema_rejected", message: "schema-invalid output", audit: AUDIT, branch: "rejected", retryable: false });
    const broker = createBroker(depsFrom(r, { schema: rejSchema }));
    const out = await broker.runJob(baseRequest());
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("schema_gate");
    expect(out.error.jobState).toBe("rejected");
  });

  it("a cooperatively-cancelled provider result discards output (cancelled_budget, no candidate)", async () => {
    const r = recorder();
    const cancelledRun: ProviderRunner = async () =>
      ok({ value: makeAgentResult({ status: "cancelled", candidateOutput: undefined, usage: { runtimeSeconds: 1 }, logs: [] }) });
    const broker = createBroker(depsFrom(r, { run: cancelledRun }));
    const out = await broker.runJob(baseRequest());
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.jobState).toBe("cancelled_budget");
    expect(r.calls).not.toContain("schema");
  });
});

describe("Broker — egress veto composes fail-closed (real @sow/policy egressVeto, no cloud fallback)", () => {
  it("Employer-Work raw content with ack OFF + cloud route → vetoed, no cloud fallback, System Health item", async () => {
    const r = recorder();
    // Drop the egress override → real veto runs AFTER selection.
    const broker = createBroker(depsFrom(r, { egressVeto: undefined }));
    const employerJob: AgentJob = { ...validAgentJob, carriesRawContent: true, trustLevel: "trusted" };
    const req: BrokerJobRequest = {
      job: employerJob,
      matrix: matrixFor(validProviderRoute), // cloud claude route
      egress: {
        workspaceId: validAgentJob.workspaceId,
        allowedProcessors: ["claude" as never],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      },
      workspace: { type: "employer_work", dataOwner: "employer" },
    };
    const out = await broker.runJob(req);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("egress_veto");
    expect(out.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(out.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS);
    expect(r.calls).not.toContain("run"); // never fell back to a cloud call
  });
});

describe("Broker — invariants: ToolPolicy binding + replay safety", () => {
  it("passes the admitted job's ToolPolicy through UNCHANGED to run + schema (never relaxed)", async () => {
    const r = recorder();
    let seenAtRun: AgentJob["toolPolicy"] | undefined;
    const capturingRun: ProviderRunner = async (_route, job) => {
      seenAtRun = job.toolPolicy;
      return ok({ value: completedResult() });
    };
    const broker = createBroker(depsFrom(r, { run: capturingRun }));
    const req = baseRequest();
    await broker.runJob(req);
    expect(seenAtRun).toBe(req.job.toolPolicy); // same reference — not rebuilt/relaxed
  });

  it("replay: a re-driven accepted idempotencyKey returns the recorded outcome and re-runs NO gate", async () => {
    const store = new Map<string, BrokerAccepted>();
    const ledger: IdempotencyLedger = {
      get: (k) => store.get(k),
      record: (k, v) => void store.set(k, v),
    };
    const r1 = recorder();
    const broker1 = createBroker(depsFrom(r1, { ledger }));
    const first = await broker1.runJob(baseRequest());
    expect(isOk(first)).toBe(true);

    const r2 = recorder();
    const broker2 = createBroker(depsFrom(r2, { ledger }));
    const second = await broker2.runJob(baseRequest());
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.jobState).toBe("accepted");
    expect(r2.calls).toEqual([]); // no gate re-ran → no duplicate audit/candidate
  });
});
