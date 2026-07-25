// spec(§12 · §5 rule-5 · REQ-F-022) — task 13.13r: research egress-leakage DoD eval.
//
// Proves the RES-1 research path FAILS CLOSED for employer-work raw content with the
// egress acknowledgment OFF — on BOTH legs, over the FAKED transport (zero real egress):
//   · the research PROVIDER (perplexity/xai) is a broker run-leg — the BROKER's egress
//     veto (`vetoJobEgress`) DENIES the cloud research route before the run leg, so the
//     provider's injected transport is never reached; and
//   · the free KEY-LESS aggregator is a connector that SELF-runs the REAL @sow/policy
//     `egressVeto` FIRST (over its synthetic cloud-classed route) and fails closed
//     before any fetch — being key-less is NOT a bypass.
// A personal-workspace call SUCCEEDS over the faked transport (returns candidate data),
// so neither pin is an always-deny. Imports the landed provider/aggregator; edits none.
// Deterministic, faked transport — nothing reaches a real endpoint (§ARM-RESEARCH dormant).
import { describe, it, expect } from "vitest";
import { ok, isOk, isErr } from "@sow/contracts";
import type {
  AgentJob,
  EgressPolicy,
  ProviderRoute,
  WorkspaceType,
  DataOwner,
  Capability,
} from "@sow/contracts";
import { processorId } from "@sow/contracts";
import { isDeny } from "@sow/policy";
import { vetoJobEgress } from "@sow/providers/broker/egress-veto";
import {
  createPerplexityResearchProvider,
  createGrokResearchProvider,
  type ResearchDossier,
} from "@sow/providers/model/research-provider";
import type {
  CloudProviderDeps,
  HttpTransport,
  SecretsAccessor,
} from "@sow/providers/model/http-transport";
import type { ModelProviderPort } from "@sow/providers/ports/model-provider-port";
import { createFreeSourceAggregator, FREE_SOURCES, type ResearchContext } from "@sow/integrations";
import type { FreeSourceTransport } from "@sow/integrations";

// ── fixtures (mirror suites/egress-ack/egress-veto.test.ts) ───────────────────
const perplexityRoute: ProviderRoute = {
  provider: "perplexity",
  model: "sonar",
  endpoint: "https://api.perplexity.ai",
  egressClass: "cloud",
};
const xaiRoute: ProviderRoute = {
  provider: "xai",
  model: "grok-4",
  endpoint: "https://api.x.ai",
  egressClass: "cloud",
};

const baseJob = (over: Partial<AgentJob> = {}): AgentJob => ({
  id: "job-research-001" as AgentJob["id"],
  workflowRunId: "wf-research-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-emp-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as Capability, // the veto is capability-agnostic for this decision
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: perplexityRoute,
  trustLevel: "trusted",
  carriesRawContent: false,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem-research-001",
  ...over,
});

// The synthetic free-source aggregator route classifies as the `free-source-web-research`
// egress processor (its `runtime` key); the provider routes classify as perplexity/xai.
// A personal-workspace call must have the route's processor allowlisted to ALLOW (else
// egressVeto denies PROCESSOR_NOT_ALLOWED) — the employer-raw DENY fires earlier regardless.
const RESEARCH_PROCESSORS = [
  processorId("perplexity"),
  processorId("xai"),
  processorId("free-source-web-research"),
];
const egressPolicy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: "ws-emp-001" as EgressPolicy["workspaceId"],
  allowedProcessors: RESEARCH_PROCESSORS,
  rawContentAllowedProcessors: RESEARCH_PROCESSORS,
  employerRawEgressAcknowledged: false,
  ...over,
});

const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "employer_work", dataOwner: "employer" };
const personalWs: { type: WorkspaceType; dataOwner: DataOwner } = { type: "personal_business", dataOwner: "user" };

// ── faked transports (in-memory spies — zero real I/O) ────────────────────────
const CANNED_ANSWER = "canned-research-answer";
// A Perplexity-shaped body so the provider's parser yields a ResearchDossier.
const PERPLEXITY_OK_BODY = JSON.stringify({
  choices: [{ message: { content: CANNED_ANSWER } }],
  citations: ["https://source.example/1"],
  usage: { prompt_tokens: 5, completion_tokens: 7 },
});

interface SpyHttpTransport extends HttpTransport {
  invoked: number;
}
// The canned body is Perplexity-shaped (only the perplexity positive control reaches it;
// the deny legs never call complete(), and grok has no positive-path coverage here).
function makeSpyHttpTransport(): SpyHttpTransport {
  const spy: SpyHttpTransport = {
    invoked: 0,
    send() {
      spy.invoked += 1;
      return Promise.resolve({ status: 200, body: PERPLEXITY_OK_BODY });
    },
  };
  return spy;
}
const fakeSecrets: SecretsAccessor = { getSecret: () => Promise.resolve(ok("fake-key")) };
const providerDeps = (transport: HttpTransport): CloudProviderDeps => ({
  transport,
  secrets: fakeSecrets,
  secretRef: "keychain://providers/perplexity",
});

const CANNED_FREE_BODY = '{"hits":[{"title":"x"}]}';
interface SpyFreeTransport extends FreeSourceTransport {
  invoked: number;
}
function makeSpyFreeTransport(): SpyFreeTransport {
  const spy: SpyFreeTransport = {
    invoked: 0,
    send() {
      spy.invoked += 1;
      return Promise.resolve({ status: 200, body: CANNED_FREE_BODY });
    },
  };
  return spy;
}

// Models the broker's FIXED ORDER (egress veto BEFORE the provider run leg). The
// provider is constructed with its spy transport UP FRONT, then the REAL vetoJobEgress
// runs: on DENY, complete() (and thus the wired transport) is never reached — so
// `transportInvoked === 0` is a genuine no-egress proof, not a not-yet-wired tautology.
type ProviderComplete = Awaited<ReturnType<ModelProviderPort["complete"]>>;
async function runProviderUnderBrokerVeto(opts: {
  create: (deps: CloudProviderDeps) => ModelProviderPort;
  route: ProviderRoute;
  job: AgentJob;
  policy: EgressPolicy;
  ws: { type: WorkspaceType; dataOwner: DataOwner };
}): Promise<
  | { denied: true; reason: string; transportInvoked: number }
  | { denied: false; transportInvoked: number; output: ProviderComplete }
> {
  const transport = makeSpyHttpTransport();
  const provider = opts.create(providerDeps(transport)); // wired BEFORE the veto
  const decision = vetoJobEgress(opts.job, opts.route, opts.policy, opts.ws);
  if (isDeny(decision)) {
    return { denied: true, reason: decision.reason, transportInvoked: transport.invoked };
  }
  const output = await provider.complete({
    route: opts.route,
    model: opts.route.model,
    capability: "meeting.close" as Capability,
    inputRefs: [],
    outputSchemaId: "sow:research-dossier",
    budget: { maxRuntimeSeconds: 300 },
    idempotencyKey: "idem-research-001",
  });
  return { denied: false, transportInvoked: transport.invoked, output };
}

// ===========================================================================
// (1) research PROVIDER — broker-veto-gated, employer-raw ack-OFF fails closed
// ===========================================================================
describe("§5 rule-5 — research provider (perplexity/xai): employer-raw ack-OFF FAILS CLOSED", () => {
  for (const [name, create, route] of [
    ["perplexity", createPerplexityResearchProvider, perplexityRoute],
    ["xai", createGrokResearchProvider, xaiRoute],
  ] as const) {
    it(`${name}: broker veto DENIES before the run leg — transport never invoked`, async () => {
      const r = await runProviderUnderBrokerVeto({
        create,
        route,
        job: baseJob({ carriesRawContent: true, providerRoute: route }),
        policy: egressPolicy({ employerRawEgressAcknowledged: false }),
        ws: employerWs,
      });
      expect(r.denied).toBe(true);
      if (r.denied) expect(r.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
      expect(r.transportInvoked).toBe(0); // no cloud egress, no fallback
    });
  }
});

// ===========================================================================
// (2) free KEY-LESS aggregator — self-run egressVeto, employer-raw ack-OFF fails closed
// ===========================================================================
describe("§5 rule-5 — free key-less aggregator: employer-raw ack-OFF FAILS CLOSED (key-less ≠ bypass)", () => {
  it("the aggregator's OWN egressVeto DENIES before any fetch — transport never invoked", async () => {
    const transport = makeSpyFreeTransport();
    // NOTE: no egressVeto injected ⇒ the aggregator uses the REAL @sow/policy veto.
    const aggregator = createFreeSourceAggregator({ transport });
    const ctx: ResearchContext = {
      job: baseJob({ carriesRawContent: true }),
      egress: egressPolicy({ employerRawEgressAcknowledged: false }),
      workspace: employerWs,
    };
    const res = await aggregator.research("employer secret query", ctx);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe("egress_denied");
      expect(res.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    }
    expect(transport.invoked).toBe(0); // key-less is NOT a bypass — no fetch, no fallback
  });
});

// ===========================================================================
// (3) positive control — a personal call SUCCEEDS over the faked transport (no over-deny)
// ===========================================================================
describe("positive control — a personal-workspace call succeeds over the faked transport", () => {
  it("provider: the veto ALLOWS a personal call → transport invoked once → a candidate dossier (canned)", async () => {
    const r = await runProviderUnderBrokerVeto({
      create: createPerplexityResearchProvider,
      route: perplexityRoute,
      job: baseJob({ carriesRawContent: true, providerRoute: perplexityRoute, workspaceId: "ws-personal-001" as AgentJob["workspaceId"] }),
      policy: egressPolicy({ workspaceId: "ws-personal-001" as EgressPolicy["workspaceId"] }),
      ws: personalWs,
    });
    expect(r.denied).toBe(false);
    if (!r.denied) {
      expect(r.transportInvoked).toBe(1);
      expect(isOk(r.output)).toBe(true);
      if (isOk(r.output)) {
        const dossier = r.output.value.candidateOutput as ResearchDossier;
        expect(dossier.answer).toBe(CANNED_ANSWER); // the FAKE body — proves no real endpoint
        expect(dossier.citations.length).toBeGreaterThan(0);
      }
    }
  });

  it("aggregator: a personal call ALLOWS → fetches every free source over the fake → candidate data", async () => {
    const transport = makeSpyFreeTransport();
    const aggregator = createFreeSourceAggregator({ transport });
    const ctx: ResearchContext = {
      job: baseJob({ carriesRawContent: true, workspaceId: "ws-personal-001" as AgentJob["workspaceId"] }),
      egress: egressPolicy({ workspaceId: "ws-personal-001" as EgressPolicy["workspaceId"] }),
      workspace: personalWs,
    };
    const res = await aggregator.research("personal query", ctx);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.results.length).toBe(FREE_SOURCES.length);
      // candidate data returned VERBATIM from the FAKE transport (proves no real endpoint)
      expect(res.value.results.every((x) => x.ok)).toBe(true);
      expect(res.value.results[0]?.raw).toEqual({ hits: [{ title: "x" }] });
    }
    expect(transport.invoked).toBe(FREE_SOURCES.length);
  });
});
