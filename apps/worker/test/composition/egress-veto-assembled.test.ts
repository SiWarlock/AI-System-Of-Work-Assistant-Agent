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
import type { AgentJob, ProviderRoute, ProviderMatrix, EgressPolicy, ProcessorId } from "@sow/contracts";
import { NO_ELIGIBLE_PROVIDER_HEALTH_CLASS } from "@sow/providers";
import { assembleBackends, type ProofSpineBackends } from "../../src/composition/backends";
import { buildAutoIngestProofSpineParams } from "../../src/boot";

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

  it("assembled_broker_denies_employer_raw_cloud_runtime — employer-raw + ack OFF + a cloud {runtime} route ⇒ DENY EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED, no run leg (rule 5)", async () => {
    // 18.23 step 5 — the SUBSCRIPTION-extraction cloud route at ENABLE is a `{runtime}` route, NOT a
    // provider route. The egress veto is route-shape-AGNOSTIC (processorOfRoute keys off egressClass, not
    // provider-vs-runtime), and a `{runtime}` route skips the provider-allowlist in resolveRoute (its
    // providerOfRoute is null) ⇒ it RESOLVES and reaches the veto, which DENIES exactly like a provider
    // cloud route. Pins the assembled-broker coverage gap for the cloud runtime route before the owner ENABLE.
    const backends = await assembleBackends({});
    opened.push(backends);
    const runtimeCloudRoute = {
      runtime: "claude-agent-sdk",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    } as unknown as ProviderRoute;
    const outcome = await backends.broker.runJob({
      job: employerRawJob(runtimeCloudRoute, { idempotencyKey: "idem-runtime-cloud-deny" }),
      matrix: matrixFor(runtimeCloudRoute, []), // allowedProviders empty — a runtime route skips the allowlist
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // fail CLOSED at the egress veto, BEFORE the run leg — no cloud fallback, no subscription runner needed.
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("assembled_broker_allows_employer_ack_on_cloud_runtime — flipping ONLY ack ON (+ allowlisting the runtime processor) on the SAME cloud {runtime} route RESOLVES PAST the veto (non-vacuity positive control, L7)", async () => {
    // Lesson 7 non-vacuity: SAME employer-raw job + SAME cloud {runtime} route as the DENY above, but ack
    // ON + the runtime processor (processorOfRoute ⇒ "claude-agent-sdk") allowlisted (incl. for raw content)
    // ⇒ the veto ALLOWS → the job resolves PAST the veto to the dormant stub run leg + is accepted. The only
    // VETO-RELEVANT diff from the deny case is the ack flag + the allowlist (the {candidateOutput} is
    // post-veto stub-only), proving the DENY is specifically the employer-raw+ack-OFF condition — NOT a
    // blanket {runtime}-route rejection (which would make
    // assembled_broker_denies_employer_raw_cloud_runtime vacuously green). Works dormant (stub run leg).
    const backends = await assembleBackends({}, { candidateOutput: validKnowledgeMutationPlan });
    opened.push(backends);
    const runtimeCloudRoute = {
      runtime: "claude-agent-sdk",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com",
      egressClass: "cloud",
    } as unknown as ProviderRoute;
    const ackOnRuntimeEgress: EgressPolicy = {
      workspaceId: validAgentJob.workspaceId,
      allowedProcessors: [processorId("claude-agent-sdk")],
      rawContentAllowedProcessors: [processorId("claude-agent-sdk")],
      employerRawEgressAcknowledged: true,
    } as unknown as EgressPolicy;
    const outcome = await backends.broker.runJob({
      job: employerRawJob(runtimeCloudRoute, { idempotencyKey: "idem-runtime-cloud-ackon-allow" }),
      matrix: matrixFor(runtimeCloudRoute, []),
      egress: ackOnRuntimeEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isOk(outcome)).toBe(true); // resolved PAST the egress veto (reached the dormant stub + accepted)
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
    expect(outcome.value.usage.runtimeSeconds).toBe(1); // the DORMANT stub (SAFE-BUILD; no real cloud call)
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

// 18.30 — PRE-ARM ASSURANCE for the already-built-dormant auto-ingest trigger: the SOURCE-ingestion dispatch
// path (capability `source.process`) is subject to BOTH hard safety gates at the REAL assembled broker (L50 —
// pin at the assembled root, not only the injected-fake unit level). So the eventual owner-gated auto-ingest
// ARM (18.10) flips a PROVEN-SAFE seam: (1) an untrusted source job carrying a mutating tool policy is
// admission-REJECTED (ING-7 / rule 6 / L47); (2) an employer-raw + ack-OFF + cloud source route fails closed
// at the egress veto (rule 5) — NEVER a cloud egress of raw employer content. The prior coverage tied rule-5
// only to `meeting.close` (above) and drove `source.process` on a LOCAL route (`sourceIngestion-live`, where
// the veto ALLOWS via the loopback fall-through) — the untrusted-mutating + employer-raw-cloud cases on the
// source.process capability were the gap. NOT arming: `providerTransport` stays UNSET ⇒ the dormant stub run
// leg; the denied paths never reach it. The armed extraction route is a cloud `{runtime}` route (18.23), so
// these mirror the runtime-route deny/allow above, re-keyed onto `source.process`.
describe("18.30 — auto-ingest source.process dispatch path is admission+veto safe at the assembled root (pre-ARM assurance)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  const SOURCE_CAP = "source.process";
  // The armed subscription-extraction route (18.23): a cloud `{runtime}` route (providerOfRoute null ⇒ skips
  // the provider allowlist, reaches the veto), NOT a provider route.
  const runtimeCloudRoute = {
    runtime: "claude-agent-sdk",
    model: "claude-sonnet-5",
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
  } as unknown as ProviderRoute;
  // A mutating tool policy — the ING-7 reject trigger for untrusted content.
  const MUTATING = { mode: "scoped_write", allowedTools: ["write"], deniedTools: [], allowsMutating: true };
  // A read-only policy — the ING-7-clean posture the real (untrusted) source path carries.
  const READ_ONLY = { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false };
  // A ProviderMatrix keyed on `source.process` (allowedProviders empty — a `{runtime}` route skips the allowlist).
  const sourceMatrix = (route: ProviderRoute): ProviderMatrix =>
    ({
      workspaceId: validAgentJob.workspaceId,
      allowedProviders: [],
      capabilityDefaults: { [SOURCE_CAP]: route } as ProviderMatrix["capabilityDefaults"],
      rawCloudEgressEnabled: false,
    }) as unknown as ProviderMatrix;

  it("assembled_source_untrusted_mutating_admission_rejected — a source.process job (untrusted + mutating toolPolicy) is REJECTED at ADMISSION through the REAL assembled broker; route/veto/run never reached (ING-7 / rule 6 / L47/L50)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: employerRawJob(runtimeCloudRoute, {
        capability: SOURCE_CAP,
        trustLevel: "untrusted",
        toolPolicy: MUTATING,
        idempotencyKey: "idem-source-ing7-deny",
      }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // ADMISSION is pipeline stage 1 — the reject short-circuits BEFORE route/veto/run (never reached).
    expect(outcome.error.stage).toBe("admission");
    expect(outcome.error.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
  });

  it("assembled_source_employer_raw_cloud_fails_closed_at_egress_veto — a source.process job (untrusted + read_only, so ING-7 ADMITS) with employer-raw + ack OFF + a cloud {runtime} route fails closed at the EGRESS VETO; run leg never reached (rule 5)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: employerRawJob(runtimeCloudRoute, {
        capability: SOURCE_CAP,
        trustLevel: "untrusted",
        toolPolicy: READ_ONLY,
        idempotencyKey: "idem-source-veto-deny",
      }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: ackOffEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // ING-7 ADMITS (read_only) → route resolves (source.process → cloud {runtime}) → the rule-5 veto DENIES:
    // employer-raw + ack OFF + cloud ⇒ no run leg, no cloud (raw employer content can't cloud-egress on the
    // source path). This is the gap `sourceIngestion-live` (LOCAL route only) left unpinned.
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(outcome.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS); // parity with the 18.9 sibling
  });

  it("assembled_source_ack_on_cloud_resolves_past_veto — flipping ONLY ack ON (+ allowlisting the runtime processor) on the SAME source.process cloud {runtime} route resolves PAST the veto to the dormant stub (non-vacuity control, L7) — proves the DENY above is the employer-raw+ack-OFF condition, not a blanket source-route rejection", async () => {
    const backends = await assembleBackends({}, { candidateOutput: validKnowledgeMutationPlan });
    opened.push(backends);
    const ackOnEgress = {
      workspaceId: validAgentJob.workspaceId,
      allowedProcessors: [processorId("claude-agent-sdk")],
      rawContentAllowedProcessors: [processorId("claude-agent-sdk")],
      employerRawEgressAcknowledged: true,
    } as unknown as EgressPolicy;
    const outcome = await backends.broker.runJob({
      job: employerRawJob(runtimeCloudRoute, {
        capability: SOURCE_CAP,
        trustLevel: "untrusted",
        toolPolicy: READ_ONLY,
        idempotencyKey: "idem-source-veto-ackon-allow",
      }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: ackOnEgress,
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isOk(outcome)).toBe(true); // resolved PAST the veto to the dormant stub (SAFE-BUILD, no real cloud)
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
    expect(outcome.value.usage.runtimeSeconds).toBe(1); // the DORMANT stub's fixed value
  });
});

// 18.31 — the auto-ingest EGRESS-ALLOWLIST seam is the OPERATIVE veto gate for a PERSONAL-workspace
// `source.process` cloud `{runtime}` route (the armed subscription-extraction shape, 18.23). The egress policy
// here is produced by the REAL 18.31 seam — `buildAutoIngestProofSpineParams(ws, allowlist).resolved.egressPolicy`
// — so these drive the exact value the desktop forward (18.32) will populate through the real
// `assembleBackends(...).broker.runJob` (the reachability evidence for the new param, per the brief's Step 7.5).
// A personal-ws source job carries RAW content, so the cloud processor must be in BOTH `allowedProcessors` AND
// `rawContentAllowedProcessors` to clear the veto (both populated by the single seam param). The employer-raw veto
// (18.30) is INDEPENDENT — allowlisting a processor never bypasses it. providerTransport stays UNSET ⇒ the dormant
// stub run leg (SAFE-BUILD; no real cloud call is possible).
describe("18.31 — the egress-allowlist seam gates a personal-ws source.process cloud {runtime} route at the assembled root (rule 5)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  const SOURCE_CAP = "source.process";
  // The armed subscription-extraction route (18.23): a cloud `{runtime}` route (providerOfRoute null ⇒ skips
  // the provider allowlist, reaches the veto), processor `claude-agent-sdk`.
  const runtimeCloudRoute = {
    runtime: "claude-agent-sdk",
    model: "claude-sonnet-5",
    endpoint: "https://api.anthropic.com",
    egressClass: "cloud",
  } as unknown as ProviderRoute;
  // A read-only policy — the ING-7-clean posture the real (untrusted) source path carries (so admission ADMITS).
  const READ_ONLY = { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false };
  const PERSONAL = { type: "personal_business", dataOwner: "user" } as const;
  // A ProviderMatrix keyed on `source.process` (allowedProviders empty — a `{runtime}` route skips the allowlist).
  const sourceMatrix = (route: ProviderRoute): ProviderMatrix =>
    ({
      workspaceId: validAgentJob.workspaceId,
      allowedProviders: [],
      capabilityDefaults: { [SOURCE_CAP]: route } as ProviderMatrix["capabilityDefaults"],
      rawCloudEgressEnabled: false,
    }) as unknown as ProviderMatrix;
  // An untrusted, read-only source.process job CARRYING RAW CONTENT (source ingestion carries raw content).
  const rawSourceJob = (over: Record<string, unknown> = {}): AgentJob =>
    ({
      ...validAgentJob,
      providerRoute: runtimeCloudRoute,
      carriesRawContent: true,
      capability: SOURCE_CAP,
      trustLevel: "untrusted",
      toolPolicy: READ_ONLY,
      ...over,
    }) as unknown as AgentJob;
  // The egress policy built THROUGH the real 18.31 seam — the value the desktop forward will populate.
  const egressFor = (allowlist: readonly ProcessorId[]): EgressPolicy =>
    buildAutoIngestProofSpineParams(String(validAgentJob.workspaceId), allowlist).resolved
      .egressPolicy as unknown as EgressPolicy;

  it("assembled_broker_allows_claude_agent_sdk_cloud_route_only_when_allowlisted — allowlist populated ⇒ resolves PAST the egress veto to the dormant stub (§5 rule 5, L50)", async () => {
    const backends = await assembleBackends({}, { candidateOutput: validKnowledgeMutationPlan });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: rawSourceJob({ idempotencyKey: "idem-personal-allowlisted-allow" }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: egressFor([processorId("claude-agent-sdk")]), // both lists carry the processor (seam-populated)
      workspace: PERSONAL,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    // The allowlist clears the veto (personal ws ⇒ no employer veto; processor in BOTH lists ⇒ raw-content OK).
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("knowledge_mutation_plan");
    expect(outcome.value.usage.runtimeSeconds).toBe(1); // the DORMANT stub (SAFE-BUILD; no real cloud call)
  });

  it("assembled_broker_denies_claude_agent_sdk_cloud_route_when_allowlist_empty — the SAME route with an EMPTY allowlist ⇒ DENY PROCESSOR_NOT_ALLOWED at the egress veto (the allowlist is the operative gate, non-vacuity for the allow above)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: rawSourceJob({ idempotencyKey: "idem-personal-empty-deny" }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: egressFor([]), // the byte-equivalent dormant default (both lists empty)
      workspace: PERSONAL,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // The ONLY veto-relevant diff from the allow above is the allowlist ⇒ proves it is the operative gate.
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("PROCESSOR_NOT_ALLOWED");
  });

  it("allowlisting_a_processor_never_bypasses_employer_raw_veto — the SAME claude-agent-sdk allowlist on an EMPLOYER-work + ack-OFF workspace STILL denies EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED (the employer veto precedes the allowlist — preserves the 18.30 pin)", async () => {
    const backends = await assembleBackends({});
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      // egressFor(...) always sets employerRawEgressAcknowledged:false ⇒ ack OFF; the processor IS allowlisted
      // in both lists — WITHOUT the employer veto this would ALLOW, so a DENY proves the veto (which runs BEFORE
      // the allowlist) is what fails it closed. Allowlisting is additive within rule-3, never a rule-5 bypass.
      job: rawSourceJob({ idempotencyKey: "idem-employer-allowlisted-still-deny" }),
      matrix: sourceMatrix(runtimeCloudRoute),
      egress: egressFor([processorId("claude-agent-sdk")]),
      workspace: EMPLOYER,
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("egress_veto");
    expect(outcome.error.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });
});
