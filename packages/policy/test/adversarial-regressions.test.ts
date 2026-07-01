// spec(§5) — ADVERSARIAL-VERIFY REGRESSION SUITE (session 005, Phase 3).
// Each block encodes the EXACT bypass an adversarial-verify lens found against the
// first-pass §5 build, so the hole stays closed. Findings (see
// docs/audits/phase3-security.md):
//   #1 CRITICAL — extractHost() userinfo-before-path confusion → loopback spoof →
//                 Employer-Work egress veto bypass (HARD DENIAL #1, safety rule 5).
//   #2 MED      — raw endpoint (userinfo creds) leaked into AuditSignal refs
//                 (safety rule 7 / §16 redaction).
//   #3 MED      — approval-policy auto-allowed external writes to every target but
//                 telegram (REQ-F-012 §9 approval-gate bypass).
//   #4 MED      — resolveRoute fail-OPEN for prototype-member capability names
//                 (absence-=-deny violated).
import { describe, it, expect } from "vitest";
import type {
  AgentJob,
  Capability,
  EgressPolicy,
  ProposedAction,
  ProviderMatrix,
  ProviderRoute,
} from "@sow/contracts";
import { egressVeto } from "../src/egress";
import { isLoopbackEndpoint, processorOfRoute } from "../src/processors";
import { resolveRoute } from "../src/provider-matrix";
import { requiresApproval } from "../src/approval-policy";
import type { ResolvedWorkspacePolicy } from "../src/workspace-policy";
import { buildAuditSignal, isRedactionSafe } from "../src/audit-signal";
import { isAllow, isDeny, type PolicyDecision } from "../src/decision";

// ── shared fixtures ──────────────────────────────────────────────────────────
const employerJob = (over: Partial<AgentJob> = {}): AgentJob => ({
  id: "job-reg-001" as AgentJob["id"],
  workflowRunId: "wf-001" as AgentJob["workflowRunId"],
  workspaceId: "ws-emp" as AgentJob["workspaceId"],
  capability: "meeting.close" as AgentJob["capability"],
  contextRefs: [{ refKind: "source", ref: "src:1" }],
  outputSchemaId: "sow:knowledge-mutation-plan",
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
  providerRoute: { provider: "ollama", model: "x", endpoint: "http://127.0.0.1:11434", egressClass: "local" },
  trustLevel: "trusted",
  carriesRawContent: true,
  maxRuntimeSeconds: 300,
  idempotencyKey: "idem-reg-001",
  ...over,
});
const egressAckOff: EgressPolicy = {
  workspaceId: "ws-emp" as EgressPolicy["workspaceId"],
  allowedProcessors: [],
  rawContentAllowedProcessors: [],
  employerRawEgressAcknowledged: false,
};
const EMPLOYER = { type: "employer_work", dataOwner: "employer" } as const;
const reason = (d: PolicyDecision<unknown>): string | undefined =>
  isDeny(d) ? (d as { reason: string }).reason : undefined;

// ── FINDING #1 (CRITICAL): loopback spoof via '@' / '\' in path/query/fragment ──
describe("regression #1 — extractHost must not read an @-in-path as the authority (egress veto bypass)", () => {
  // A remote host with a loopback literal placed AFTER the authority (in path,
  // query, fragment, or via a backslash) must NOT be classified loopback.
  const spoofs = [
    "http://evil.com/@127.0.0.1",
    "http://evil.com/?k=@127.0.0.1",
    "http://evil.com/#@127.0.0.1",
    "http://evil.com\\@127.0.0.1",
    "evil.com/@127.0.0.1",
    "http://evil.com/@localhost",
    "http://evil.com/@[::1]",
  ];
  for (const endpoint of spoofs) {
    it(`isLoopbackEndpoint(${JSON.stringify(endpoint)}) === false`, () => {
      expect(isLoopbackEndpoint(endpoint)).toBe(false);
    });
    it(`processorOfRoute treats ${JSON.stringify(endpoint)} as EGRESS (non-null)`, () => {
      const route: ProviderRoute = { provider: "ollama", model: "x", endpoint, egressClass: "local" };
      expect(processorOfRoute(route)).not.toBeNull();
    });
    it(`egressVeto DENIES employer+raw+ack=false for ${JSON.stringify(endpoint)}`, () => {
      const route: ProviderRoute = { provider: "ollama", model: "x", endpoint, egressClass: "local" };
      const d = egressVeto(employerJob({ providerRoute: route }), route, egressAckOff, EMPLOYER);
      expect(isDeny(d)).toBe(true);
      expect(reason(d)).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    });
  }
  // Genuine loopback must still pass (no over-correction).
  it("genuine loopback endpoints remain loopback", () => {
    for (const ep of ["http://127.0.0.1:11434", "http://localhost:1234", "http://[::1]:8080", "/var/run/x.sock", "unix:/tmp/x.sock", "file:///tmp/x.sock"]) {
      expect(isLoopbackEndpoint(ep)).toBe(true);
    }
  });
  // file:/unix: with a REMOTE authority is not loopback (defense-in-depth).
  it("file://<remote>/unix://<remote> authority is not loopback", () => {
    expect(isLoopbackEndpoint("file://evil.com/exfil")).toBe(false);
    expect(isLoopbackEndpoint("unix://evil.com/exfil")).toBe(false);
  });
});

// ── FINDING #2 (MED): endpoint userinfo creds must not reach audit refs ─────────
describe("regression #2 — endpoint credentials must not leak into AuditSignal refs", () => {
  const credEndpoint = "https://svc:hunter2Pass@proxy.example.com/v1";
  it("egressVeto decision refs omit the userinfo password", () => {
    const route: ProviderRoute = { provider: "claude", model: "m", endpoint: credEndpoint, egressClass: "cloud" };
    const egress: EgressPolicy = {
      workspaceId: "ws-1" as EgressPolicy["workspaceId"],
      allowedProcessors: ["claude"] as EgressPolicy["allowedProcessors"],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    };
    const d = egressVeto(
      employerJob({ workspaceId: "ws-1" as AgentJob["workspaceId"], carriesRawContent: false, providerRoute: route }),
      route,
      egress,
      { type: "personal_business", dataOwner: "user" },
    );
    // The redaction target is the AUDIT SIGNAL (what reaches log/System-Health
    // sinks), NOT the resolved-route decision VALUE (operational data the broker
    // needs to make the call). The audit refs must be host-only, cred-free.
    expect(JSON.stringify(d.audit)).not.toContain("hunter2Pass");
    expect(isRedactionSafe(d.audit)).toBe(true);
  });
  it("resolveRoute decision refs omit the userinfo password", () => {
    const m: ProviderMatrix = {
      workspaceId: "ws-1" as ProviderMatrix["workspaceId"],
      allowedProviders: ["claude"],
      capabilityDefaults: { "meeting.close": { provider: "claude", model: "m", endpoint: credEndpoint, egressClass: "cloud" } } as ProviderMatrix["capabilityDefaults"],
      rawCloudEgressEnabled: true,
    };
    const d = resolveRoute(m, "meeting.close" as Capability);
    expect(JSON.stringify(d.audit)).not.toContain("hunter2Pass");
    expect(isRedactionSafe(d.audit)).toBe(true);
  });
  it("isRedactionSafe flags a userinfo-credential-bearing ref", () => {
    const leaky = buildAuditSignal({
      actor: "t", event: "e", refs: ["ref:endpoint:https://svc:hunter2Pass@proxy.example.com/v1"],
      payloadHash: "h", beforeSummary: "b", afterSummary: "a",
    });
    expect(isRedactionSafe(leaky)).toBe(false);
  });
});

// ── FINDING #3 (MED): external-write targets must never auto-allow ──────────────
describe("regression #3 — approval-policy must not auto-allow external-write targets", () => {
  const resolved = (over: Partial<ResolvedWorkspacePolicy> = {}): ResolvedWorkspacePolicy => ({
    workspaceId: "ws-1" as ResolvedWorkspacePolicy["workspaceId"],
    type: "personal_business",
    dataOwner: "user",
    defaultVisibility: "isolated",
    egressPolicy: {
      workspaceId: "ws-1" as EgressPolicy["workspaceId"],
      allowedProcessors: [], rawContentAllowedProcessors: [], employerRawEgressAcknowledged: false,
    },
    providerMatrix: {
      workspaceId: "ws-1" as ProviderMatrix["workspaceId"],
      allowedProviders: [], capabilityDefaults: {}, rawCloudEgressEnabled: false,
    },
    ...over,
  });
  const action = (targetSystem: ProposedAction["targetSystem"]): ProposedAction => ({
    actionId: "a1" as ProposedAction["actionId"],
    targetSystem,
    canonicalObjectKey: "k",
    payload: {},
    approvalPolicy: "auto_private",
    idempotencyKey: "i",
  });
  for (const t of ["github", "linear", "asana", "drive", "telegram", "todoist"] as const) {
    it(`${t} + auto_private + user/isolated STILL requires approval`, () => {
      const d = requiresApproval(action(t), resolved());
      expect(isAllow(d)).toBe(true);
      expect(isAllow(d) && d.value.requiresApproval).toBe(true);
    });
  }
  // The sole spec-sanctioned auto-create-private surface (Flow 6) still auto-allows.
  it("calendar + auto_private + user/isolated may auto-allow (not over-narrowed to zero)", () => {
    const d = requiresApproval(action("calendar"), resolved());
    expect(isAllow(d)).toBe(true);
    expect(isAllow(d) && d.value.requiresApproval).toBe(false);
  });
});

// ── FINDING #4 (MED): prototype-member capability names must fail closed ─────────
describe("regression #4 — resolveRoute must fail closed for prototype-member capabilities", () => {
  const m: ProviderMatrix = {
    workspaceId: "ws-1" as ProviderMatrix["workspaceId"],
    allowedProviders: ["claude"],
    capabilityDefaults: { "meeting.close": { provider: "claude", model: "m", endpoint: "https://api", egressClass: "cloud" } } as ProviderMatrix["capabilityDefaults"],
    rawCloudEgressEnabled: true,
  };
  for (const cap of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"] as const) {
    it(`resolveRoute(matrix, ${JSON.stringify(cap)}) ⇒ NO_ROUTE_FOR_CAPABILITY (never a garbage ALLOW)`, () => {
      const d = resolveRoute(m, cap as Capability);
      expect(isAllow(d)).toBe(false);
      expect(reason(d)).toBe("NO_ROUTE_FOR_CAPABILITY");
    });
  }
  it("a genuinely configured capability still resolves", () => {
    const d = resolveRoute(m, "meeting.close" as Capability);
    expect(isAllow(d)).toBe(true);
  });
});
