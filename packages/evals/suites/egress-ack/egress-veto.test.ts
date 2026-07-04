// spec(§20.1 "Egress acknowledgment" · §16.5 · REQ-S-002) — task 12.14.
//
// The §20.1 acceptance suite for the Employer-Work egress veto (safety rule 5).
// Unlike the packages/policy unit test (which pins the §5 predicate directly),
// this drives the veto through the BROKER SEAM `vetoJobEgress` — the real
// composition that fixed-orders the veto AFTER route selection and treats it as
// pass-or-deny — and then SCORES the `EGRESS_ACKNOWLEDGMENT` criterion through
// the EVAL-1 runner (task 12.1).
//
// DoD honesty: this run is over the policy/broker seams with fixture routes, not
// a real conformant provider, so the runner must report it functionally-passing
// but NOT DoD-certified (§20.2: a mock-backed run cannot report DoD-passing). The
// suite asserts exactly that — the full DoD certification of egress-ack lands
// with the real-integration meeting-closeout run (12.16 / live).
//
// Acceptance criteria exercised (§20.1 / task 12.14 bullets):
//  • OFF: Employer-Work raw job may select ONLY a loopback-local provider; with
//    no local route it FAILS CLOSED — there is no cloud fallback.
//  • ON: cloud processors are permitted (the employer flow is enabled).
//  • OpenRouter is its OWN processor (never an OpenAI alias); routing via
//    OpenRouter under OFF is blocked, and 'openai'-only allowlist rejects it.
//  • Local Ollama/LM Studio is non-egress ONLY as a genuine loopback endpoint;
//    a 'local'-classed but REMOTE endpoint is treated as egress and fails closed.
import { describe, it, expect } from "vitest";
import type { AgentJob, DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import { isAllow, isDeny } from "@sow/policy";
import { vetoJobEgress } from "@sow/providers/broker/egress-veto";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

// ── fixtures (pure literals; mirror packages/policy/test/egress.test.ts) ──────
const T0 = "2026-06-30T12:00:00Z";

const cloudRoute: ProviderRoute = {
  provider: "claude",
  model: "claude-opus-4",
  endpoint: "https://api.anthropic.com",
  egressClass: "cloud",
};
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
  // egressClass claims 'local' but the endpoint is remote — the exfil hole.
  provider: "ollama",
  model: "llama3.1",
  endpoint: "https://exfil.example.com:11434",
  egressClass: "local",
};

const baseJob = (over: Partial<AgentJob> = {}): AgentJob => ({
  id: "job-egress-ack-001" as AgentJob["id"],
  workflowRunId: "wf-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-emp-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: cloudRoute,
  trustLevel: "trusted",
  carriesRawContent: false,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem-egress-ack-001",
  ...over,
});

const egressPolicy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: "ws-emp-001" as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
  ...over,
});

const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "employer_work",
  dataOwner: "employer",
};

describe("§20.1 Egress acknowledgment — OFF fails closed (no cloud fallback)", () => {
  it("OFF + employer raw + cloud route ⇒ DENY EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: cloudRoute }),
      cloudRoute,
      egressPolicy({ employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("OFF + employer raw + genuine loopback-local ⇒ ALLOW (the sole eligible route)", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: loopbackLocalRoute }),
      loopbackLocalRoute,
      egressPolicy({ allowedProcessors: [], rawContentAllowedProcessors: [] }),
      employerWs,
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value).toEqual(loopbackLocalRoute);
  });

  it("OFF + employer raw + tunneled-'local' (remote endpoint) ⇒ DENY (treated as egress)", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: tunneledLocalRoute }),
      tunneledLocalRoute,
      egressPolicy({ employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });
});

describe("§20.1 Egress acknowledgment — ON permits the employer flow", () => {
  it("ON + employer raw + allowlisted + raw-allowlisted cloud ⇒ ALLOW", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: cloudRoute }),
      cloudRoute,
      egressPolicy({
        employerRawEgressAcknowledged: true,
        acknowledgedAt: T0,
        allowedProcessors: [processorId("claude")],
        rawContentAllowedProcessors: [processorId("claude")],
      }),
      employerWs,
    );
    expect(isAllow(d)).toBe(true);
  });

  it("ON does NOT bypass the allowlist — non-allowlisted processor still denied", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: cloudRoute }),
      cloudRoute,
      egressPolicy({
        employerRawEgressAcknowledged: true,
        acknowledgedAt: T0,
        allowedProcessors: [processorId("openai")],
        rawContentAllowedProcessors: [processorId("openai")],
      }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROCESSOR_NOT_ALLOWED");
  });
});

describe("§20.1 Egress acknowledgment — OpenRouter is its OWN processor", () => {
  it("OFF + employer raw + openrouter route ⇒ DENY (no cloud fallback, not an OpenAI alias)", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: openrouterRoute }),
      openrouterRoute,
      egressPolicy({ employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
  });

  it("ON + openrouter route but ONLY 'openai' allowlisted ⇒ PROCESSOR_NOT_ALLOWED (no aliasing)", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: openrouterRoute }),
      openrouterRoute,
      egressPolicy({
        employerRawEgressAcknowledged: true,
        acknowledgedAt: T0,
        allowedProcessors: [processorId("openai")],
        rawContentAllowedProcessors: [processorId("openai")],
      }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROCESSOR_NOT_ALLOWED");
  });

  it("ON + openrouter route allowlisted as 'openrouter' ⇒ ALLOW", () => {
    const d = vetoJobEgress(
      baseJob({ carriesRawContent: true, providerRoute: openrouterRoute }),
      openrouterRoute,
      egressPolicy({
        employerRawEgressAcknowledged: true,
        acknowledgedAt: T0,
        allowedProcessors: [processorId("openrouter")],
        rawContentAllowedProcessors: [processorId("openrouter")],
      }),
      employerWs,
    );
    expect(isAllow(d)).toBe(true);
  });
});

describe("§20.1 Egress acknowledgment — EVAL-1 runner scoring (DoD honesty)", () => {
  it("marks a SEAM run functionally-passing but NOT DoD-certified", () => {
    // Every governance scenario above holds ⇒ functional pass. But this suite
    // ran over policy/broker seams with fixture routes — not a real conformant
    // provider — so §20.2 forbids reporting it DoD-passing. The runner enforces it.
    const out = scoreById({
      criterionId: "EGRESS_ACKNOWLEDGMENT",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(false);
    expect(out.dodPass).toBe(false);
    expect(out.reason).toContain("DoD-INVALID");
  });

  it("would be DoD-certified from a real conformant-provider run", () => {
    const out = scoreById({
      criterionId: "EGRESS_ACKNOWLEDGMENT",
      value: true,
      fromRealIntegration: true,
    });
    expect(out.dodPass).toBe(true);
  });

  it("registry marks egress-ack real-integration-required", () => {
    expect(criterionById("EGRESS_ACKNOWLEDGMENT")?.requiresRealIntegration).toBe(true);
  });
});
