// spec(§7) — ADVERSARIAL-VERIFY REGRESSION SUITE (Phase 5). Pins the finding that
// the broker resolved + egress-VETOED the matrix `route`, but the budget/cost
// enforcer and the runtime adapters read the JOB'S OWN `providerRoute` — so the
// egress veto did not bind the EXECUTED egress target and COST-1/2 priced the
// wrong route (see docs/audits/phase5-*.md). Fix: the vetted matrix route is
// threaded as the job's EFFECTIVE route for execution + budget.
import { describe, it, expect } from "vitest";
import { ok, isOk } from "@sow/contracts";
import type { AgentJob, ProviderMatrix, ProviderRoute, EgressPolicy } from "@sow/contracts";
import { validAgentJob } from "@sow/contracts";
import { allowDecision, buildAuditSignal, type AuditSignal } from "@sow/policy";
import { makeAgentResult } from "../src/ports/agent-result";
import {
  createBroker,
  type BrokerDeps,
  type BrokerJobRequest,
  type BrokerCandidate,
  type HealthGate,
  type BudgetGate,
  type ProviderRunner,
  type SchemaGate,
} from "../src/broker/broker";

const AUDIT: AuditSignal = buildAuditSignal({ actor: "t", event: "e", refs: [], payloadHash: "h", beforeSummary: "b", afterSummary: "a" });
const CANDIDATE: BrokerCandidate = {
  kind: "knowledge_mutation_plan",
  plan: { planId: "p" as never, workspaceId: validAgentJob.workspaceId, sourceRefs: [{ sourceId: "s" as never }], creates: [], patches: [], linkMutations: [], frontmatterUpdates: [], externalActionProposals: [], confidence: 0.9, requiresApproval: true, provenanceOrigin: "meeting_close" } as never,
};

// The matrix resolves the capability to THIS route (authoritative + vetted).
const MATRIX_ROUTE: ProviderRoute = { provider: "claude", model: "claude-opus-4", endpoint: "https://api.anthropic.com", egressClass: "cloud" };
// The job DECLARES a DIFFERENT route (a divergent, un-vetted exfil target).
const DIVERGENT_ROUTE: ProviderRoute = { provider: "openai", model: "x", endpoint: "https://exfil.example.com", egressClass: "cloud" };

function matrixFor(route: ProviderRoute): ProviderMatrix {
  return { workspaceId: validAgentJob.workspaceId, allowedProviders: ["claude", "openai"], capabilityDefaults: { "meeting.close": route } as ProviderMatrix["capabilityDefaults"], rawCloudEgressEnabled: true };
}
const EGRESS_OK: EgressPolicy = { workspaceId: validAgentJob.workspaceId, allowedProcessors: ["claude" as never, "openai" as never], rawContentAllowedProcessors: ["claude" as never, "openai" as never], employerRawEgressAcknowledged: true };

describe("regression — the vetted matrix route (not job.providerRoute) is executed + budgeted", () => {
  it("run + budget.pre receive the matrix-resolved route, never the job's divergent providerRoute", async () => {
    let runRoute: ProviderRoute | undefined;
    let budgetRoute: ProviderRoute | undefined;

    const health: HealthGate = () => ok({ value: undefined });
    const budget: BudgetGate = {
      pre: (job: AgentJob) => {
        budgetRoute = job.providerRoute;
        return ok({ value: { maxRuntimeSeconds: job.maxRuntimeSeconds, maxCostUsd: job.maxCostUsd } });
      },
      post: () => ok({ value: undefined }),
    };
    const run: ProviderRunner = async (_route, job) => {
      runRoute = job.providerRoute;
      return ok({ value: makeAgentResult({ status: "completed", candidateOutput: {}, usage: { runtimeSeconds: 1, costUsd: 0.01 }, logs: [] }) });
    };
    const schema: SchemaGate = () => ok({ value: CANDIDATE });
    const egressVeto = (_j: AgentJob, route: ProviderRoute): ReturnType<NonNullable<BrokerDeps["egressVeto"]>> => allowDecision(route, AUDIT);
    const admit: NonNullable<BrokerDeps["admit"]> = (job) => allowDecision(job, AUDIT);
    const resolveRoute: NonNullable<BrokerDeps["resolveRoute"]> = () => allowDecision(MATRIX_ROUTE, AUDIT);

    const deps: BrokerDeps = { health, budget, run, schema, egressVeto, admit, resolveRoute };
    const job: AgentJob = { ...validAgentJob, providerRoute: DIVERGENT_ROUTE };
    const req: BrokerJobRequest = { job, matrix: matrixFor(MATRIX_ROUTE), egress: EGRESS_OK, workspace: { type: "personal_business", dataOwner: "user" } };

    const out = await createBroker(deps).runJob(req);
    expect(isOk(out)).toBe(true);
    // The EXECUTED route is the vetted matrix route — not the job's declared exfil route.
    expect(runRoute).toEqual(MATRIX_ROUTE);
    expect(runRoute?.endpoint).not.toContain("exfil");
    // Budget/cost is priced on the vetted route too (COST-1/2 binds the executed route).
    expect(budgetRoute).toEqual(MATRIX_ROUTE);
    expect(budgetRoute).not.toEqual(DIVERGENT_ROUTE);
  });
});
