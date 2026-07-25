// Task 13.13 (provider leg) — the RES-1 research/web-retrieval ModelProviderPort
// processor (Perplexity Sonar + Grok Live Search), DORMANT over the injected FAKED
// transport. This suite pins the safety-load-bearing behavior:
//
//   • candidate DOSSIER with citations preserved VERBATIM (RES-1 §7 / candidate-data);
//     the provider NEVER writes Markdown or reaches a real endpoint.
//   • perplexity + xai each their OWN processor (ProviderId), never aliased to
//     openai/openrouter (safety rule 5).
//   • EGRESS VETO runs FIRST — the provider is a broker run-leg, and the broker's
//     `vetoJobEgress` fails an employer-work ack-OFF cloud job CLOSED (no cloud
//     fallback) BEFORE the run leg (hence before the provider's transport) is reached.
//   • TOTAL never-throws over a faulted/malformed/aborted transport (LESSON 11).
//   • Dormant — the injected transport is the SOLE I/O seam (no real HTTP client).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type {
  AgentJob,
  ProviderRoute,
  EgressPolicy,
  WorkspaceType,
  DataOwner,
} from "@sow/contracts";
import { validAgentJob, processorId } from "@sow/contracts";
import { allowDecision, isDeny, buildAuditSignal, type AuditSignal } from "@sow/policy";
import { vetoJobEgress } from "../src/broker/egress-veto";
import { makeAgentResult, type AgentResult } from "../src/ports/agent-result";
import {
  createBroker,
  type BrokerJobRequest,
  type BrokerDeps,
  type BrokerCandidate,
  type HealthGate,
  type BudgetGate,
  type ProviderRunner,
  type SchemaGate,
} from "../src/broker/broker";
import {
  createPerplexityResearchProvider,
  createGrokResearchProvider,
  PERPLEXITY_COMPLETIONS_PATH,
  XAI_RESPONSES_PATH,
  type ResearchDossier,
} from "../src/model/research-provider";
import {
  makeRequest,
  respondingTransport,
  throwingTransport,
  secretsReturning,
  secretsUnavailable,
} from "./_model-fixtures";

// ── route fixtures — each vendor its OWN cloud processor ─────────────────────
const perplexityRoute: ProviderRoute = {
  provider: "perplexity",
  model: "sonar-pro",
  endpoint: "https://api.perplexity.ai",
  egressClass: "cloud",
};
const xaiRoute: ProviderRoute = {
  provider: "xai",
  model: "grok-4.5",
  endpoint: "https://api.x.ai",
  egressClass: "cloud",
};

// ── candidate response bodies (Context7-grounded arch_gap candidates) ─────────
function perplexityBody(answer: string, citations: unknown[], searchResults?: unknown[]): string {
  return JSON.stringify({
    id: "cmpl-1",
    model: "sonar-pro",
    created: 1,
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: answer } }],
    citations,
    ...(searchResults !== undefined ? { search_results: searchResults } : {}),
    usage: { prompt_tokens: 12, completion_tokens: 8 },
  });
}
function grokBody(answer: string, citations: unknown[]): string {
  return JSON.stringify({
    id: "resp-1",
    model: "grok-4.5",
    content: answer,
    citations,
    usage: { input_tokens: 5, output_tokens: 9 },
  });
}

const secrets = secretsReturning("research-key-123456");

// ── candidate dossier + verbatim citations ───────────────────────────────────
describe("research provider — candidate dossier with citations VERBATIM", () => {
  it("perplexity returns a dossier: answer + citations + search_results preserved verbatim", async () => {
    const citations = ["https://a.example/1", "https://b.example/2"];
    const searchResults = [{ title: "A", url: "https://a.example/1", snippet: "…" }];
    const transport = respondingTransport(200, perplexityBody("The synthesized answer.", citations, searchResults));
    const provider = createPerplexityResearchProvider({ transport, secrets, secretRef: "keychain://providers/perplexity" });

    const res = await provider.complete(makeRequest({ provider: "perplexity", model: "sonar-pro", endpoint: "https://api.perplexity.ai" }));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const dossier = res.value.candidateOutput as ResearchDossier;
    expect(dossier.answer).toBe("The synthesized answer.");
    expect(dossier.citations).toEqual(citations); // VERBATIM — never summarized/dropped
    expect(dossier.searchResults).toEqual(searchResults);
    expect(transport.calls).toBe(1);
  });

  it("xai (grok) returns a dossier: answer + citations verbatim", async () => {
    const citations = ["https://x.example/post/1"];
    const transport = respondingTransport(200, grokBody("Grok's answer.", citations));
    const provider = createGrokResearchProvider({ transport, secrets, secretRef: "keychain://providers/xai" });

    const res = await provider.complete(makeRequest({ provider: "xai", model: "grok-4.5", endpoint: "https://api.x.ai" }));
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const dossier = res.value.candidateOutput as ResearchDossier;
    expect(dossier.answer).toBe("Grok's answer.");
    expect(dossier.citations).toEqual(citations);
  });

  it("xai parse handles the NESTED Responses envelope (output[].content[].text) — not just the flat SDK shape", async () => {
    // arch_gap: the raw /v1/responses envelope is OpenAI-Responses-style. A real Grok
    // response must NOT fold to malformed_output (LESSON 3 — candidate shape defeating intent).
    const nested = JSON.stringify({
      id: "resp-2",
      output: [{ content: [{ type: "output_text", text: "Nested Grok answer." }] }],
      citations: ["https://x.example/nested/1"],
    });
    const provider = createGrokResearchProvider({ transport: respondingTransport(200, nested), secrets, secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "xai" }));
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      const dossier = res.value.candidateOutput as ResearchDossier;
      expect(dossier.answer).toBe("Nested Grok answer.");
      expect(dossier.citations).toEqual(["https://x.example/nested/1"]);
    }
  });

  it("perplexity dispatches POST /chat/completions with Bearer auth + the sonar model", async () => {
    const transport = respondingTransport(200, perplexityBody("x", []));
    const provider = createPerplexityResearchProvider({ transport, secrets, secretRef: "keychain://providers/perplexity" });
    await provider.complete(makeRequest({ provider: "perplexity", model: "sonar-pro", endpoint: "https://api.perplexity.ai" }));
    const sent = transport.lastRequest!;
    expect(sent.url).toBe(`https://api.perplexity.ai${PERPLEXITY_COMPLETIONS_PATH}`);
    expect(sent.headers.Authorization).toBe("Bearer research-key-123456");
    expect(JSON.parse(sent.body).model).toBe("sonar-pro");
  });

  it("xai dispatches POST /v1/responses declaring the x_search tool", async () => {
    const transport = respondingTransport(200, grokBody("x", []));
    const provider = createGrokResearchProvider({ transport, secrets, secretRef: "keychain://providers/xai" });
    await provider.complete(makeRequest({ provider: "xai", model: "grok-4.5", endpoint: "https://api.x.ai" }));
    const sent = transport.lastRequest!;
    expect(sent.url).toBe(`https://api.x.ai${XAI_RESPONSES_PATH}`);
    const tools = JSON.parse(sent.body).tools as Array<{ type: string }>;
    expect(tools.some((t) => t.type === "x_search")).toBe(true);
  });
});

// ── rule 5: each vendor its OWN processor, never aliased ──────────────────────
describe("research provider — each its OWN processor (rule 5)", () => {
  it("perplexity/xai providerId is its own — never openai/openrouter", () => {
    const p = createPerplexityResearchProvider({ transport: respondingTransport(200, "{}"), secrets, secretRef: "r" });
    const g = createGrokResearchProvider({ transport: respondingTransport(200, "{}"), secrets, secretRef: "r" });
    expect(p.providerId).toBe("perplexity");
    expect(g.providerId).toBe("xai");
    for (const id of [p.providerId, g.providerId]) {
      expect(id).not.toBe("openai");
      expect(id).not.toBe("openrouter");
    }
  });
});

// ── EGRESS VETO runs FIRST — the load-bearing rule-5 pin ──────────────────────
const EMPLOYER: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const PERSONAL: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };

function egressPolicy(over: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    workspaceId: validAgentJob.workspaceId,
    allowedProcessors: [processorId("perplexity"), processorId("xai")],
    rawContentAllowedProcessors: [processorId("perplexity"), processorId("xai")],
    employerRawEgressAcknowledged: true,
    ...over,
  };
}
function jobWith(over: Partial<AgentJob> = {}): AgentJob {
  return { ...validAgentJob, ...over };
}

// A broker recorder harness (mirrors egress-veto.test.ts) — records the gate order
// so we can prove the veto fires BEFORE the run leg (where the provider + its
// transport live). The `run` leg is a spy: if it is never called, the provider's
// transport is never reached.
function recorder(routeToResolve: ProviderRoute) {
  const calls: string[] = [];
  const AUDIT: AuditSignal = buildAuditSignal({
    actor: "test", event: "test.audit", refs: [], payloadHash: "test", beforeSummary: "b", afterSummary: "a",
  });
  const health: HealthGate = () => { calls.push("health"); return ok({ value: undefined }); };
  const budget: BudgetGate = {
    pre: (job: AgentJob) => { calls.push("budget.pre"); return ok({ value: { maxRuntimeSeconds: job.maxRuntimeSeconds, maxCostUsd: job.maxCostUsd } }); },
    post: () => { calls.push("budget.post"); return ok({ value: undefined }); },
  };
  const run: ProviderRunner = async () => { calls.push("run"); return ok({ value: completedResult() }); };
  const schema: SchemaGate = () => { calls.push("schema"); return ok({ value: CANDIDATE }); };
  const admit: NonNullable<BrokerDeps["admit"]> = (job) => { calls.push("admission"); return allowDecision(job, AUDIT); };
  const resolveRoute: NonNullable<BrokerDeps["resolveRoute"]> = () => { calls.push("route"); return allowDecision(routeToResolve, AUDIT); };
  const egressVeto: NonNullable<BrokerDeps["egressVeto"]> = (job, route, egress, workspace) => { calls.push("egress"); return vetoJobEgress(job, route, egress, workspace); };
  return { calls, health, budget, run, schema, admit, resolveRoute, egressVeto };
}
function depsFrom(r: ReturnType<typeof recorder>): BrokerDeps {
  return { health: r.health, budget: r.budget, run: r.run, schema: r.schema, egressVeto: r.egressVeto, admit: r.admit, resolveRoute: r.resolveRoute };
}
const CANDIDATE: BrokerCandidate = {
  kind: "knowledge_mutation_plan",
  plan: {
    planId: "plan-x" as never, workspaceId: validAgentJob.workspaceId, sourceRefs: [{ sourceId: "src-x" as never }],
    creates: [], patches: [], linkMutations: [], frontmatterUpdates: [], externalActionProposals: [],
    confidence: 0.9, requiresApproval: true, provenanceOrigin: "meeting_close",
  } as never,
};
function completedResult(): AgentResult {
  return makeAgentResult({ status: "completed", candidateOutput: { title: "candidate" }, usage: { runtimeSeconds: 3, costUsd: 0.02 }, logs: [] });
}

describe("research provider — egress veto runs BEFORE the transport (rule 5)", () => {
  it("employer-work raw + ack OFF + perplexity cloud route ⇒ fail-closed at egress_veto; run (⇒ transport) NEVER reached", async () => {
    const r = recorder(perplexityRoute);
    const broker = createBroker(depsFrom(r));
    const req: BrokerJobRequest = {
      job: jobWith({ carriesRawContent: true, trustLevel: "trusted" }),
      matrix: { workspaceId: validAgentJob.workspaceId, allowedProviders: ["perplexity"], capabilityDefaults: { "meeting.close": perplexityRoute } as never, rawCloudEgressEnabled: true },
      egress: egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      workspace: EMPLOYER,
    };
    const out = await broker.runJob(req);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.stage).toBe("egress_veto");
    expect(out.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    // The veto ran; NO gate after it (health/run — hence the provider's transport) did.
    expect(r.calls).toEqual(["admission", "route", "egress"]);
    expect(r.calls).not.toContain("run");
  });

  // Non-vacuity control: when NOT vetoed, the pipeline DOES reach the run leg — so the
  // veto-first assertion above is not passing merely because the pipeline is broken.
  it("personal workspace + ack-ON ⇒ the pipeline REACHES the run leg (proves the pin is non-vacuous)", async () => {
    const r = recorder(perplexityRoute);
    const broker = createBroker(depsFrom(r));
    const req: BrokerJobRequest = {
      job: jobWith({ carriesRawContent: true, trustLevel: "trusted" }),
      matrix: { workspaceId: validAgentJob.workspaceId, allowedProviders: ["perplexity"], capabilityDefaults: { "meeting.close": perplexityRoute } as never, rawCloudEgressEnabled: true },
      egress: egressPolicy({ employerRawEgressAcknowledged: true }),
      workspace: PERSONAL,
    };
    await broker.runJob(req);
    expect(r.calls).toContain("run");
  });

  it("vetoJobEgress DENIES an employer-work ack-OFF call on BOTH the perplexity and xai cloud routes", () => {
    for (const route of [perplexityRoute, xaiRoute]) {
      const d = vetoJobEgress(
        jobWith({ carriesRawContent: true, trustLevel: "trusted" }),
        route,
        egressPolicy({ rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
        EMPLOYER,
      );
      expect(isDeny(d)).toBe(true);
      if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    }
  });
});

// ── TOTAL never-throws + dormant ─────────────────────────────────────────────
describe("research provider — TOTAL never-throws + dormant (no real endpoint)", () => {
  it("a throwing transport folds to a typed err (never throws)", async () => {
    const provider = createPerplexityResearchProvider({ transport: throwingTransport(new Error("boom")), secrets, secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "perplexity" }));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("transport_error");
  });

  it("a malformed (non-JSON) body ⇒ malformed_output", async () => {
    const provider = createPerplexityResearchProvider({ transport: respondingTransport(200, "<<not json>>"), secrets, secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "perplexity" }));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("malformed_output");
  });

  it("a 2xx body missing the answer content ⇒ malformed_output", async () => {
    const provider = createGrokResearchProvider({ transport: respondingTransport(200, JSON.stringify({ citations: [] })), secrets, secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "xai" }));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("malformed_output");
  });

  it("a non-2xx status ⇒ a typed err (500 retryable transport_error)", async () => {
    const provider = createPerplexityResearchProvider({ transport: respondingTransport(503, ""), secrets, secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "perplexity" }));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) { expect(res.error.kind).toBe("transport_error"); expect(res.error.retryable).toBe(true); }
  });

  it("a missing/locked key degrades to auth_unavailable; the transport is NOT called", async () => {
    const transport = respondingTransport(200, perplexityBody("x", []));
    const provider = createPerplexityResearchProvider({ transport, secrets: secretsUnavailable("missing"), secretRef: "r" });
    const res = await provider.complete(makeRequest({ provider: "perplexity" }));
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("auth_unavailable");
    expect(transport.calls).toBe(0);
  });

  it("no real endpoint reachable — the module constructs NO real HTTP client (injected transport is the sole seam)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/model/research-provider.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["node:https", "node:http", "undici", "axios", "fetch(", "XMLHttpRequest"]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
