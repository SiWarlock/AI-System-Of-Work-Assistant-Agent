// spec(§7) — the broker's egress-veto composition step (task 5.3): compose the
// §5 @sow/policy egressVeto AFTER route resolution as a pure VETO that can only
// NARROW or DENY — never widen/substitute the selected route. On an unacknowledged
// Employer-Work raw-content job with no loopback-local route the broker FAILS
// CLOSED (no cloud fallback), surfacing the typed denial + AuditSignal. Proves the
// ordering: the veto runs BEFORE health/budget and no later gate can re-open it.
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type {
  AgentJob,
  ProviderRoute,
  EgressPolicy,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import { validAgentJob, validProviderRoute, processorId } from "@sow/contracts";
import {
  isAllow,
  isDeny,
  allowDecision,
  buildAuditSignal,
  type AuditSignal,
  type PolicyDecision,
} from "@sow/policy";
import { vetoJobEgress, type EgressVetoFn } from "../src/broker/egress-veto";
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
} from "../src/broker/broker";

// ── route fixtures ───────────────────────────────────────────────────────────
const cloudRoute: ProviderRoute = validProviderRoute; // claude / cloud
const openrouterRoute: ProviderRoute = {
  provider: "openrouter",
  model: "anthropic/claude-opus-4",
  endpoint: "https://openrouter.ai/api/v1",
  egressClass: "cloud",
};
const loopbackLocalRoute: ProviderRoute = {
  provider: "ollama",
  model: "llama3.1",
  endpoint: "http://127.0.0.1:11434",
  egressClass: "local",
};
const tunneledLocalRoute: ProviderRoute = {
  // egressClass CLAIMS 'local' but points at a remote endpoint — the exfil hole.
  provider: "ollama",
  model: "llama3.1",
  endpoint: "https://exfil.example.com:11434",
  egressClass: "local",
};

// ── egress / job / workspace builders ────────────────────────────────────────
function egressPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProcessors: [processorId("claude")],
    rawContentAllowedProcessors: [processorId("claude")],
    employerRawEgressAcknowledged: true,
    ...over,
  };
}

function jobWith(over: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, ...over };
}

const EMPLOYER: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "employer_work",
  dataOwner: "employer",
};
const PERSONAL: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "personal_business",
  dataOwner: "user",
};

// ── unit: vetoJobEgress delegates to the §5 veto (fail-closed, no cloud fallback)
describe("vetoJobEgress — Employer-Work raw egress veto (safety rule 5)", () => {
  it("Employer-Work raw content + ack OFF + cloud route ⇒ DENY (no cloud fallback), typed + AuditSignal", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      cloudRoute,
      egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      EMPLOYER,
    );
    expect(isDeny(d)).toBe(true);
    if (!isDeny(d)) return;
    expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    // typed denial carries a redaction-safe AuditSignal (code set; refs/host-only).
    expect(d.audit.denialCode).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    // the endpoint appears only as a host-ref — the raw scheme/path/userinfo never leaks.
    expect(JSON.stringify(d.audit)).not.toContain("https://");
  });

  it("Employer-Work raw content + ack OFF + OpenRouter cloud route ⇒ DENY (OpenRouter is its OWN processor, not an OpenAI alias)", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      openrouterRoute,
      egressPolicy({
        allowedProcessors: [processorId("openrouter")],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      }),
      EMPLOYER,
    );
    expect(isDeny(d)).toBe(true);
    if (!isDeny(d)) return;
    expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("Employer-Work raw content + ack OFF + a TUNNELED-'local' (remote-endpoint) route ⇒ DENY (no laundering, no cloud fallback)", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      tunneledLocalRoute,
      egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      EMPLOYER,
    );
    expect(isDeny(d)).toBe(true);
    if (!isDeny(d)) return;
    expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("Employer-Work raw content + ack OFF + a GENUINE loopback-local route ⇒ ALLOW (the only survivor)", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      loopbackLocalRoute,
      egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      EMPLOYER,
    );
    expect(isAllow(d)).toBe(true);
    if (!isAllow(d)) return;
    // narrow-only: the permitted route is the SAME route it was handed, unmodified.
    expect(d.value).toEqual(loopbackLocalRoute);
  });

  it("Employer-Work raw content + ack ON + cloud route in the allowlist ⇒ ALLOW (workspace gate acknowledged)", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      cloudRoute,
      egressPolicy({ employerRawEgressAcknowledged: true }),
      EMPLOYER,
    );
    expect(isAllow(d)).toBe(true);
    if (!isAllow(d)) return;
    expect(d.value).toEqual(cloudRoute);
  });

  it("non-employer workspace + cloud route in the allowlist ⇒ ALLOW (the veto only bites employer-raw-unacked)", () => {
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      cloudRoute,
      egressPolicy({ employerRawEgressAcknowledged: false }),
      PERSONAL,
    );
    expect(isAllow(d)).toBe(true);
  });
});

// ── unit: narrow-only invariant — the veto can NEVER widen/substitute the route ─
describe("vetoJobEgress — narrow-only: the veto is a pass-or-deny gate, never a route substitution", () => {
  it("on ALLOW, the permitted route is structurally identical to the input route (no widening)", () => {
    const job = jobWith({ carriesRawContent: false, trustLevel: "trusted" });
    const d = vetoJobEgress(job, cloudRoute, egressPolicy(), PERSONAL);
    expect(isAllow(d)).toBe(true);
    if (!isAllow(d)) return;
    expect(d.value).toEqual(cloudRoute);
  });

  it("defense-in-depth: an underlying veto that ALLOWS a WIDENED/substituted route ⇒ FAIL CLOSED (MALFORMED_POLICY_INPUT)", () => {
    const audit: AuditSignal = buildAuditSignal({
      actor: "test",
      event: "test.widen",
      refs: [],
      payloadHash: "test",
      beforeSummary: "b",
      afterSummary: "a",
    });
    // A rogue veto that "allows" but swaps the local pick for a cloud provider —
    // the broker must not trust it; a later gate would run on a route the veto
    // never actually cleared (re-opening the veto).
    const wideningVeto: EgressVetoFn = (): PolicyDecision<ProviderRoute> =>
      allowDecision(cloudRoute, audit);
    const job = jobWith({ carriesRawContent: true, trustLevel: "trusted" });
    const d = vetoJobEgress(
      job,
      loopbackLocalRoute, // the route we handed in was local…
      egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      EMPLOYER,
      wideningVeto, // …but the veto tried to hand back a cloud route
    );
    expect(isDeny(d)).toBe(true);
    if (!isDeny(d)) return;
    expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
  });

  it("a veto that allows the SAME route it was handed passes through unchanged", () => {
    const audit: AuditSignal = buildAuditSignal({
      actor: "test",
      event: "test.same",
      refs: [],
      payloadHash: "test",
      beforeSummary: "b",
      afterSummary: "a",
    });
    const passthrough: EgressVetoFn = (_j, route): PolicyDecision<ProviderRoute> =>
      allowDecision(route, audit);
    const job = jobWith({ carriesRawContent: false, trustLevel: "trusted" });
    const d = vetoJobEgress(job, cloudRoute, egressPolicy(), PERSONAL, passthrough);
    expect(isAllow(d)).toBe(true);
    if (!isAllow(d)) return;
    expect(d.value).toEqual(cloudRoute);
  });
});

// ── composition: ordering + no-reopen through the real broker ─────────────────
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

function recorder(routeToResolve: ProviderRoute) {
  const calls: string[] = [];
  const AUDIT: AuditSignal = buildAuditSignal({
    actor: "test",
    event: "test.audit",
    refs: [],
    payloadHash: "test",
    beforeSummary: "b",
    afterSummary: "a",
  });
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
  const admit: NonNullable<BrokerDeps["admit"]> = (job) => {
    calls.push("admission");
    return allowDecision(job, AUDIT);
  };
  const resolveRoute: NonNullable<BrokerDeps["resolveRoute"]> = () => {
    calls.push("route");
    return allowDecision(routeToResolve, AUDIT);
  };
  // The REAL composition step under test — wired as the broker's veto.
  const egressVetoDep: NonNullable<BrokerDeps["egressVeto"]> = (job, route, egress, workspace) => {
    calls.push("egress");
    return vetoJobEgress(job, route, egress, workspace);
  };
  return { calls, health, budget, run, schema, admit, resolveRoute, egressVeto: egressVetoDep };
}

function depsFrom(r: ReturnType<typeof recorder>): BrokerDeps {
  return {
    health: r.health,
    budget: r.budget,
    run: r.run,
    schema: r.schema,
    egressVeto: r.egressVeto,
    admit: r.admit,
    resolveRoute: r.resolveRoute,
  };
}

describe("Broker composition — veto runs BEFORE health/budget; a denial re-opens NO later gate", () => {
  it("Employer-Work raw + ack OFF + cloud route ⇒ fail-closed at egress_veto; health/budget/run NEVER run", async () => {
    const r = recorder(cloudRoute);
    const broker = createBroker(depsFrom(r));
    const req: BrokerJobRequest = {
      job: jobWith({ carriesRawContent: true, trustLevel: "trusted" }),
      matrix: {
        workspaceId: validAgentJob.workspaceId,
        allowedProviders: ["claude"],
        capabilityDefaults: { "meeting.close": cloudRoute } as never,
        rawCloudEgressEnabled: true,
      },
      egress: egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      workspace: EMPLOYER,
    };
    const out = await broker.runJob(req);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("egress_veto");
    expect(out.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(out.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS);
    // ordering + no-reopen: egress ran, but no gate AFTER it did.
    expect(r.calls).toEqual(["admission", "route", "egress"]);
    expect(r.calls).not.toContain("health");
    expect(r.calls).not.toContain("run");
  });

  it("Employer-Work raw + ack OFF + a loopback-LOCAL route ⇒ veto ALLOWS the narrowed local route and the pipeline proceeds", async () => {
    const r = recorder(loopbackLocalRoute);
    const broker = createBroker(depsFrom(r));
    const req: BrokerJobRequest = {
      job: jobWith({ carriesRawContent: true, trustLevel: "trusted" }),
      matrix: {
        workspaceId: validAgentJob.workspaceId,
        allowedProviders: ["ollama"],
        capabilityDefaults: { "meeting.close": loopbackLocalRoute } as never,
        rawCloudEgressEnabled: false,
      },
      egress: egressPolicy({
        allowedProcessors: [],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      }),
      workspace: EMPLOYER,
    };
    const out = await broker.runJob(req);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.route).toEqual(loopbackLocalRoute);
    // veto ran BEFORE health, and the later gates ran on the narrowed local route.
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
