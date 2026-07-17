// 18.9 — the Employer-Work egress VETO honored at the WORKER'S REAL ASSEMBLED
// broker (safety rule 5). This pins the DEFAULT `vetoJobEgress` + DEFAULT
// `resolveJobRoute` AS WIRED BY `assembleBackends` — the real production pipeline.
//
// Distinct from the existing coverage (which this does NOT duplicate):
//   • providers `egress-veto.test.ts` drives `createBroker` with an INJECTED FAKE
//     `resolveRoute` + a WRAPPED `egressVeto` dep — it proves the veto FUNCTION, not
//     the worker's real assembly.
//   • 18.1's `provider-runner.test.ts:egress_veto_precedes_run_leg` injects a FAKE
//     deny-veto to pin the generic ordering.
//   • the `assembleBackends` dormancy test drives employer+local but with
//     `carriesRawContent: false` — so the rule-5 veto NEVER bites there.
// A worker-side wiring regression (the veto overridden/dropped in the real
// assembly, or OpenRouter miscategorized as local/an OpenAI alias) would slip past
// ALL of the above but be caught here.
//
// Rule 5 (verbatim): raw Employer-Work content with egress-ack OFF may be sent only
// to a local zero-egress provider, else the job fails closed — NEVER a cloud
// fallback. OpenRouter is its OWN processor, not an OpenAI alias.
//
// SAFE-BUILD: `providerTransport` stays UNSET ⇒ the run leg is the dormant stub;
// the denied cloud paths never reach it (no real cloud call is possible). The
// leakage-eval (zero raw employer content on a real cloud egress) is the CROSSING.
import { describe, it, expect, afterEach } from "vitest";
import { isOk, isErr, processorId, validAgentJob, validKnowledgeMutationPlan } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ProviderMatrix, EgressPolicy } from "@sow/contracts";
import { NO_ELIGIBLE_PROVIDER_HEALTH_CLASS } from "@sow/providers";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434";

const cloudRoute = (provider: string, endpoint = "https://api.provider.test"): ProviderRoute =>
  ({ provider, model: "test-model", endpoint, egressClass: "cloud" }) as unknown as ProviderRoute;
// OpenRouter — its OWN cloud processor (never an OpenAI alias, never local).
const openrouterRoute: ProviderRoute = {
  provider: "openrouter",
  model: "anthropic/claude-opus-4",
  endpoint: "https://openrouter.ai/api/v1",
  egressClass: "cloud",
} as unknown as ProviderRoute;
const loopbackLocalRoute: ProviderRoute = {
  provider: "ollama",
  model: "local-default",
  endpoint: LOCAL_ENDPOINT,
  egressClass: "local",
} as unknown as ProviderRoute;
// The LAUNDERING/EXFIL hole: a route that CLAIMS egressClass 'local' but points at a
// REMOTE endpoint. processorOfRoute treats it as EGRESS (a 'local' label can never
// launder a remote target past the veto) — it must be DENIED, not run zero-egress.
const TUNNELED_REMOTE_ENDPOINT = "https://exfil.example.com:11434";
const tunneledLocalRoute: ProviderRoute = {
  provider: "ollama",
  model: "local-default",
  endpoint: TUNNELED_REMOTE_ENDPOINT,
  egressClass: "local",
} as unknown as ProviderRoute;

// An employer-work job CARRYING RAW CONTENT — the ONLY posture the rule-5 veto bites
// (the existing assembly test uses carriesRawContent:false, so it never engages it).
const employerRawJob = (route: ProviderRoute, over: Record<string, unknown> = {}): AgentJob =>
  ({ ...validAgentJob, providerRoute: route, carriesRawContent: true, ...over }) as unknown as AgentJob;

const matrixFor = (route: ProviderRoute, allowed: string[]): ProviderMatrix =>
  ({
    workspaceId: validAgentJob.workspaceId,
    allowedProviders: allowed,
    capabilityDefaults: { "meeting.close": route } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: false,
  }) as unknown as ProviderMatrix;

// egress-ack OFF: raw employer content may NOT cloud-egress (no processor allowlisted).
const ackOffEgress: EgressPolicy = {
  workspaceId: validAgentJob.workspaceId,
  allowedProcessors: [],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
} as unknown as EgressPolicy;

// ack OFF, but the cloud processor IS allowlisted (incl. for raw content). The
// allowlist WOULD clear this route — so a DENY here proves the rule-5 veto (which runs
// BEFORE the allowlist) is what fails it closed, not an incidental empty allowlist.
const ackOffButAllowlistedEgress: EgressPolicy = {
  workspaceId: validAgentJob.workspaceId,
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
} as unknown as EgressPolicy;

const EMPLOYER = { type: "employer_work", dataOwner: "employer" } as const;

describe("18.9 — Employer-Work egress veto honored at the real assembled broker (rule 5)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("assembled_broker_employer_raw_ack_off_cloud_fails_closed_at_egress_veto — a cloud route DENIES (no cloud fallback); the run leg is never reached (rule 5)", async () => {
    // providerTransport UNSET ⇒ the dormant stub run leg; no real cloud call possible.
    const backends = await assembleBackends({});
    opened.push(backends);
    const route = cloudRoute("claude");
    const outcome = await backends.broker.runJob({
      job: employerRawJob(route, { idempotencyKey: "idem-cloud-deny" }),
      matrix: matrixFor(route, ["claude"]),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    // fail CLOSED at the egress veto — the pipeline short-circuits BEFORE the run leg
    // (stage `egress_veto` precedes `run` in the fixed pipeline order → run unreached).
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(outcome.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS);
    // no cloud fallback: the pipeline denied at the veto and emitted no candidate (isErr above).
  });

  it("assembled_broker_employer_raw_ack_off_openrouter_cloud_denied — OpenRouter classified CLOUD (its own processor) ⇒ DENIED, never laundered to a local ALLOW", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: employerRawJob(openrouterRoute, { idempotencyKey: "idem-openrouter-deny" }),
      matrix: matrixFor(openrouterRoute, ["openrouter"]),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // The EGRESS veto bit it: processorOfRoute classifies 'openrouter' as a CLOUD
    // processor (non-null) → rule-5 DENY — NOT a route-resolution PROVIDER_NOT_ALLOWED
    // (unknown) and NOT laundered to a local ALLOW. (The own-processor-vs-OpenAI-alias
    // DISTINCTNESS is unit-pinned in packages/policy processorOfRoute/LOCAL_PROVIDERS;
    // under ack-OFF openrouter and openai deny identically, so this level pins CLOUD→deny.)
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("assembled_broker_employer_raw_ack_off_local_runs_loopback — the ONLY survivor: a genuine loopback-local route ALLOWS + runs zero-egress on the dormant stub (rule 5)", async () => {
    // A valid KMP candidate so the (allowed) job flows through the real 18.2 schema gate.
    const backends = await assembleBackends({}, { candidateOutput: validKnowledgeMutationPlan });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: employerRawJob(loopbackLocalRoute, { idempotencyKey: "idem-local-allow" }),
      matrix: matrixFor(loopbackLocalRoute, ["ollama"]),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    // veto ALLOWED the loopback-local route; the job ran zero-egress on the DORMANT
    // stub (usage.runtimeSeconds === 1 is the stub's FIXED value — proof it was the
    // dormant stub, not a real provider call — SAFE-BUILD).
    expect(outcome.value.route).toEqual(loopbackLocalRoute);
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
    expect(outcome.value.usage.runtimeSeconds).toBe(1);
  });

  it("assembled_broker_veto_denies_even_when_processor_allowlisted — the rule-5 veto runs BEFORE the allowlist: a raw employer cloud egress the allowlist WOULD permit still fails closed", async () => {
    // Strongest dropped-veto pin: the processor IS allowlisted (incl. rawContent), so
    // WITHOUT the veto this route would ALLOW→run (isErr flips to false). The veto's
    // precedence over the allowlist is what keeps it fail-closed with ack OFF.
    const backends = await assembleBackends({});
    opened.push(backends);
    const route = cloudRoute("claude");
    const outcome = await backends.broker.runJob({
      job: employerRawJob(route, { idempotencyKey: "idem-cloud-allowlisted-deny" }),
      matrix: matrixFor(route, ["claude"]),
      egress: ackOffButAllowlistedEgress, // processor allowlisted — but ack is OFF
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("assembled_broker_tunneled_local_denied — a route CLAIMING egressClass 'local' but pointing REMOTE is treated as EGRESS and DENIED (no laundering past the veto)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: employerRawJob(tunneledLocalRoute, { idempotencyKey: "idem-tunneled-deny" }),
      matrix: matrixFor(tunneledLocalRoute, ["ollama"]),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      // the tunneled endpoint IS in the local allowlist ⇒ route-resolution PASSES, so the
      // egress VETO (not the local-endpoint allowlist) is what must fail it closed — the
      // sharpest rule-5 edge, pinned end-to-end at the real assembly.
      localConfig: { allowedLocalEndpoints: [TUNNELED_REMOTE_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // processorOfRoute classifies a non-loopback 'local' claim as EGRESS (proc !== null)
    // → the veto DENIES; a 'local' label can never launder a remote endpoint past rule 5.
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });
});
