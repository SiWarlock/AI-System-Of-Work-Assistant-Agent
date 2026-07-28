// spec(§5) — Employer-Work raw-content egress VETO (hard denial #1) + normal
// egress allowlist enforcement (REQ-S-002/S-005/F-001). The veto is evaluated
// AFTER provider selection and can only NARROW or DENY, never widen. Order:
// (1) resolve processor; (2) EMPLOYER_WORK + raw + ack=false ⇒ ONLY a
// loopback-local (proc===null) route survives, any egress processor (incl. a
// tunneled-'local') FAILS CLOSED with EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED and
// there is NO cloud fallback; (3) egress routes must clear allowedProcessors
// (+ rawContentAllowedProcessors when raw); (4) a genuine loopback-local route
// is always egress-safe. Every decision emits a redaction-safe AuditSignal with
// healthSignalClass set (egress System-Health visibility, REQ-S-002).
import { describe, it, expect } from "vitest";
import type { AgentJob, DataOwner, EgressPolicy, ProviderRoute, WorkspaceType } from "@sow/contracts";
import { processorId } from "@sow/contracts";
import { egressVeto } from "../src/egress";
import { isAllow, isDeny, type PolicyDecision } from "../src/decision";
import { isRedactionSafe } from "../src/audit-signal";

// ── fixtures (pure literals, no clock/random) ────────────────────────────────
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
  id: "job-egress-001" as AgentJob["id"],
  workflowRunId: "wf-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-001" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: cloudRoute,
  trustLevel: "trusted",
  carriesRawContent: false,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem-egress-001",
  ...over,
});

const egressPolicy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  workspaceId: "ws-001" as EgressPolicy["workspaceId"],
  allowedProcessors: [processorId("claude")],
  rawContentAllowedProcessors: [processorId("claude")],
  employerRawEgressAcknowledged: false,
  ...over,
});

const employerWs: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "employer_work",
  dataOwner: "employer",
};
const personalWs: { type: WorkspaceType; dataOwner: DataOwner } = {
  type: "personal_business",
  dataOwner: "user",
};

// Shared assertion: every decision — allow AND deny — is auditable.
function expectAuditable(d: PolicyDecision<ProviderRoute>): void {
  expect(isRedactionSafe(d.audit)).toBe(true);
  expect(d.audit.healthSignalClass).toBeDefined();
}

describe("egressVeto — Employer-Work raw-content VETO (hard denial #1)", () => {
  it("employer_work + raw + ack=false + cloud route ⇒ EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED (no cloud fallback)", () => {
    // Processor is BOTH allowlisted and raw-allowlisted — the veto still bites
    // because ack=false. The veto has precedence over the allowlist path.
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
      cloudRoute,
      egressPolicy({
        allowedProcessors: [processorId("claude")],
        rawContentAllowedProcessors: [processorId("claude")],
        employerRawEgressAcknowledged: false,
      }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
      expect(d.audit.denialCode).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    }
    expectAuditable(d);
  });

  it("employer_work + raw + ack=false + LOOPBACK-LOCAL route ⇒ allow (the only eligible route)", () => {
    // Empty allowlists — a genuine loopback-local (proc===null) never leaves the
    // machine, so it is egress-safe regardless of the allowlist.
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
      loopbackLocalRoute,
      egressPolicy({ allowedProcessors: [], rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value).toEqual(loopbackLocalRoute);
    expectAuditable(d);
  });

  it("tunneled-'local' (egressClass local but REMOTE endpoint) + employer raw + ack=false ⇒ DENIED (treated as egress)", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
      tunneledLocalRoute,
      egressPolicy({ employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expectAuditable(d);
  });

  it("employer_work + NON-raw + ack=false + allowlisted cloud route ⇒ allow (veto bites raw content ONLY)", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: false }),
      cloudRoute,
      egressPolicy({ allowedProcessors: [processorId("claude")], employerRawEgressAcknowledged: false }),
      employerWs,
    );
    expect(isAllow(d)).toBe(true);
    expectAuditable(d);
  });
});

describe("egressVeto — acknowledgment re-opens the allowlist (per-job, no cache)", () => {
  it("employer_work + raw + ack=TRUE + processor allowlisted + raw-allowlisted ⇒ allow", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
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
    expectAuditable(d);
  });

  it("ack ON then OFF then ON ⇒ allow / deny / allow (pure re-evaluation, no cached allow)", () => {
    const job = baseJob({ carriesRawContent: true });
    const ackOn = egressPolicy({
      employerRawEgressAcknowledged: true,
      acknowledgedAt: T0,
      allowedProcessors: [processorId("claude")],
      rawContentAllowedProcessors: [processorId("claude")],
    });
    const ackOff = egressPolicy({
      employerRawEgressAcknowledged: false,
      allowedProcessors: [processorId("claude")],
      rawContentAllowedProcessors: [processorId("claude")],
    });

    const first = egressVeto(job, cloudRoute, ackOn, employerWs);
    const second = egressVeto(job, cloudRoute, ackOff, employerWs);
    const third = egressVeto(job, cloudRoute, ackOn, employerWs);

    expect(isAllow(first)).toBe(true);
    expect(isDeny(second)).toBe(true);
    if (isDeny(second)) expect(second.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(isAllow(third)).toBe(true); // flipping back re-allows — no cached deny/allow
  });

  it("ack ON does NOT bypass the allowlist — non-allowlisted processor ⇒ PROCESSOR_NOT_ALLOWED", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
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
    expectAuditable(d);
  });
});

describe("egressVeto — normal allowlist (egress routes, proc!==null)", () => {
  it("non-employer cloud route with an allowlisted processor ⇒ allow", () => {
    const d = egressVeto(
      baseJob(),
      cloudRoute,
      egressPolicy({ allowedProcessors: [processorId("claude")], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.audit.refs).toContain("ref:processor:claude");
    expectAuditable(d);
  });

  it("processor NOT in allowedProcessors ⇒ PROCESSOR_NOT_ALLOWED", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: false }),
      cloudRoute,
      egressPolicy({ allowedProcessors: [processorId("openai")], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROCESSOR_NOT_ALLOWED");
    expectAuditable(d);
  });

  it("raw content but processor NOT in rawContentAllowedProcessors ⇒ PROCESSOR_NOT_ALLOWED", () => {
    const d = egressVeto(
      baseJob({ carriesRawContent: true }),
      cloudRoute,
      egressPolicy({ allowedProcessors: [processorId("claude")], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROCESSOR_NOT_ALLOWED");
    expectAuditable(d);
  });

  it("a genuine loopback-local route bypasses the allowlist (proc===null ⇒ always allow)", () => {
    const d = egressVeto(
      baseJob(),
      loopbackLocalRoute,
      egressPolicy({ allowedProcessors: [], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isAllow(d)).toBe(true);
    expectAuditable(d);
  });
});

describe("egressVeto — OpenRouter is its OWN processor (never an OpenAI alias)", () => {
  it("openrouter route allowlisted as 'openrouter' ⇒ allow (refs carry 'openrouter')", () => {
    const d = egressVeto(
      baseJob(),
      openrouterRoute,
      egressPolicy({ allowedProcessors: [processorId("openrouter")], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.audit.refs).toContain("ref:processor:openrouter");
    expectAuditable(d);
  });

  it("openrouter route with ONLY 'openai' allowlisted ⇒ PROCESSOR_NOT_ALLOWED (no aliasing)", () => {
    const d = egressVeto(
      baseJob(),
      openrouterRoute,
      egressPolicy({ allowedProcessors: [processorId("openai")], rawContentAllowedProcessors: [] }),
      personalWs,
    );
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("PROCESSOR_NOT_ALLOWED");
    expectAuditable(d);
  });
});

describe("egressVeto — fail-closed on malformed input (never fail-open)", () => {
  it("null egress policy ⇒ MALFORMED_POLICY_INPUT (deny, not allow)", () => {
    const d = egressVeto(baseJob(), cloudRoute, null as unknown as EgressPolicy, employerWs);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
    expectAuditable(d);
  });

  it("null route ⇒ MALFORMED_POLICY_INPUT (deny, not allow)", () => {
    const d = egressVeto(baseJob(), null as unknown as ProviderRoute, egressPolicy(), employerWs);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
    expectAuditable(d);
  });

  // task #25 — a BLANK route identity must DENY, not throw.
  //
  // The step-0 malformed guard validates `endpoint` and `egressClass` but never the
  // identity, so `{provider: ""}` reaches `processorOfRoute`, which brands the raw
  // identity — and the brand constructor throws on a blank string. The veto is
  // contractually total (§16: every outcome is a typed PolicyDecision, never a
  // thrown error), so this escapes as an exception where it owes a decision.
  //
  // Asserted at the VETO, not just at `processorOfRoute`, because the veto is the
  // safety property: a rule-5 gate that throws hands its caller an exception
  // instead of a denial, and any caller with a `catch` that defaults permissive
  // turns a crash into a fail-OPEN on the raw-employer-egress path.
  for (const [label, route] of [
    ["blank provider", { provider: "", model: "m", endpoint: "https://x.example.com", egressClass: "cloud" }],
    ["whitespace provider", { provider: "   ", model: "m", endpoint: "https://x.example.com", egressClass: "cloud" }],
    ["blank runtime", { runtime: "", model: "m", endpoint: "https://x.example.com", egressClass: "cloud" }],
    ["blank identity claiming loopback-local", { provider: "", model: "m", endpoint: "http://127.0.0.1:11434", egressClass: "local" }],
  ] as const) {
    it(`${label} ⇒ a DENY decision, never a thrown error`, () => {
      const job = baseJob({ carriesRawContent: true });
      const run = (): PolicyDecision<ProviderRoute> =>
        egressVeto(job, route as unknown as ProviderRoute, egressPolicy(), employerWs);
      expect(run).not.toThrow();
      const d = run();
      expect(isAllow(d)).toBe(false);
      expect(isDeny(d)).toBe(true);
      // The CODE is pinned, not just the direction: identity validation could later
      // migrate into the step-0 malformed guard, which would keep a bare isDeny()
      // green while silently relocating the enforcement point. Employer-raw-unacked
      // bites first here, which is the branch that must own this input.
      if (isDeny(d)) expect(d.reason).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
      expectAuditable(d);
    });
  }

  it("a blank RUNTIME on a loopback endpoint no longer reads as non-egress", () => {
    // The one shape whose classification actually FLIPS. It never threw: the
    // runtime branch returned null (NON-EGRESS) at the loopback check before ever
    // reaching the brand, so an unidentifiable route was being treated as a genuine
    // local engine and allowed. Now it is EGRESS and denies. Safe direction, and
    // the only semantic change in this slice — so it gets its own pin.
    const route = {
      runtime: "",
      model: "m",
      endpoint: "http://127.0.0.1:11434",
      egressClass: "local",
    } as unknown as ProviderRoute;
    const d = egressVeto(baseJob({ carriesRawContent: true }), route, egressPolicy(), employerWs);
    expect(isAllow(d)).toBe(false);
    expect(isDeny(d)).toBe(true);
    expectAuditable(d);
  });

  it("an UNCLASSIFIABLE route is never satisfiable by an allowlist entry naming the sentinel", () => {
    // `MALFORMED_ROUTE` means "could not classify", not a destination. Without a
    // dedicated deny it would flow into the normal allowlist step like a real
    // processor id, so a workspace whose allowlist literally names it would ALLOW
    // an unidentifiable route — and that entry is operator-reachable, since boot
    // brands operator-supplied strings into this list.
    const route = {
      provider: "",
      model: "m",
      endpoint: "https://x.example.com",
      egressClass: "cloud",
    } as unknown as ProviderRoute;
    const sentinel = processorId("MALFORMED_ROUTE");
    const d = egressVeto(
      baseJob(),
      route,
      egressPolicy({
        allowedProcessors: [sentinel],
        rawContentAllowedProcessors: [sentinel],
        employerRawEgressAcknowledged: true,
        acknowledgedAt: "2026-07-28T00:00:00.000Z",
      }),
      personalWs,
    );
    expect(isAllow(d)).toBe(false);
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
    expectAuditable(d);
  });
});
