// 18.1 — the REAL ModelProviderPort transport bound into the broker's run leg,
// behind the default-OFF `config.providerTransport` dormancy gate. These tests pin:
//   • the real runner maps ProviderOutput → GateResult<AgentResult> and
//     ProviderError → GateResult err, never throwing (§16 / §19.5);
//   • the gate OFF selects the EXACT stub (byte-identical shipped default) and never
//     invokes the real-runner factory (L16/L27 zero-invocation);
//   • a missing/locked provider key degrades through the never-reject
//     KeychainLockController — held RETRYABLE + a keychain-locked HealthItem, NO
//     plaintext, NO terminal reject (safety rule 7 / L21/L29);
//   • an off-allowlist local endpoint is rejected invalid_request with no dispatch
//     (safety rule 5 — local zero-egress);
//   • the broker's egress veto still runs BEFORE the run leg once the real runner is
//     bound (a vetoed job never reaches it; §7 — 18.9 builds on this ordering).
//
// SAFE-BUILD: every provider call runs against a FAKE HttpTransport / fake facade —
// no real endpoint, no real key, no real spend, no network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { ok, err, isOk, isErr, validAgentJob } from "@sow/contracts";
import type {
  AgentJob,
  ProviderRoute,
  ProviderId,
  ProviderMatrix,
  EgressPolicy,
  AuditId,
  HealthItem,
} from "@sow/contracts";
import {
  createBroker,
  makeAgentResult,
  type ProviderRunner,
  type EnforcedBudget,
  type HttpTransport,
  type HttpTransportRequest,
  type SecretsAccessor,
  type BrokerCandidate,
} from "@sow/providers";
import { allowDecision, denyDecision, buildAuditSignal, FAIL_CLOSED_DENIAL } from "@sow/policy";
import {
  createRealProviderRunner,
  selectProviderRunner,
  type ProviderTransportGate,
} from "../../src/composition/provider-runner";
import {
  createStubProviderRunner,
  assembleBackends,
  type ProofSpineBackends,
} from "../../src/composition/backends";
import {
  createKeychainLockController,
  type KeychainLockController,
  type ProviderDegradationStore,
} from "../../src/lifecycle/degraded/keychain-locked";
import type { HealthSurface, HealthFailure, SurfacedHealthItem } from "../../src/health/surface";
import type { DrainResult } from "@sow/integrations";

// ── deterministic constants + fixtures ─────────────────────────────────────────
const NOW = "2026-07-17T00:00:00.000Z";
const now = (): string => NOW;
const LOCAL_ENDPOINT = "http://127.0.0.1:11434";

const cloudRoute = (provider: ProviderId, endpoint = "https://api.provider.test"): ProviderRoute =>
  ({ provider, model: "test-model", endpoint, egressClass: "cloud" }) as unknown as ProviderRoute;
const localRoute = (endpoint: string): ProviderRoute =>
  ({ provider: "ollama", model: "local-default", endpoint, egressClass: "local" }) as unknown as ProviderRoute;

const makeJob = (route: ProviderRoute, over: Record<string, unknown> = {}): AgentJob =>
  ({
    id: "job-1",
    workflowRunId: "wf-1",
    workspaceId: "ws-1",
    capability: "meeting.close",
    contextRefs: [],
    outputSchemaId: "sow:test.output",
    toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [] },
    providerRoute: route,
    trustLevel: "trusted",
    carriesRawContent: false,
    maxRuntimeSeconds: 30,
    idempotencyKey: "idem-1",
    ...over,
  }) as unknown as AgentJob;

const budget: EnforcedBudget = { maxRuntimeSeconds: 30 };

// A canned Anthropic Messages 2xx body the claude wire parses to `{ title: "T" }`.
const CANNED_CLAUDE_BODY = JSON.stringify({
  content: [{ type: "text", text: JSON.stringify({ title: "T" }) }],
  usage: { input_tokens: 5, output_tokens: 7 },
});

const cannedTransport = (status: number, body: string, calls: HttpTransportRequest[]): HttpTransport => ({
  send(req: HttpTransportRequest): Promise<{ status: number; body: string }> {
    calls.push(req);
    return Promise.resolve({ status, body });
  },
});
const throwingTransport = (calls: HttpTransportRequest[]): HttpTransport => ({
  send(req: HttpTransportRequest): Promise<{ status: number; body: string }> {
    calls.push(req);
    // A secret-shaped detail in the throw — the runner's deny must NEVER echo it (rule 7).
    return Promise.reject(new Error("network boom sk-canary-secret"));
  },
});

const okFacade = (secret: string): SecretsAccessor => ({
  getSecret: () => Promise.resolve(ok(secret)),
});
const lockedFacade: SecretsAccessor = {
  getSecret: () => Promise.resolve(err({ reason: "locked" })),
};

// A REAL never-reject KeychainLockController over fakes — proves the L21/L29 wiring
// end-to-end (held-set state + onKeychainLocked routing), not a stubbed contract.
function makeController(): {
  controller: KeychainLockController;
  recorded: HealthFailure[];
} {
  const recorded: HealthFailure[] = [];
  const surface: HealthSurface = {
    record: (f: HealthFailure) => {
      recorded.push(f);
      return Promise.resolve(
        ok({
          dedupeKey: "k",
          subjectRef: f.subjectRef,
          item: { id: "h1" } as unknown as HealthItem,
          openedAt: NOW,
          lastSeen: NOW,
          occurrenceCount: 1,
        } as SurfacedHealthItem),
      );
    },
    acknowledge: () => Promise.resolve(ok(undefined)),
    resolve: () => Promise.resolve(ok(undefined)),
    list: () => Promise.resolve(ok([])),
    readModel: () => Promise.resolve(ok({} as never)),
  };
  const degradationStore: ProviderDegradationStore = {
    markDegraded: () => Promise.resolve(),
    clearDegraded: () => Promise.resolve(),
    isDegraded: () => Promise.resolve(false),
  };
  const controller = createKeychainLockController({
    surface,
    degradationStore,
    auditRef: "audit:test" as AuditId,
    wakeDrain: () => Promise.resolve({} as DrainResult),
  });
  return { controller, recorded };
}

// ── the real runner: output/error mapping + never-throws (§19.5 / §16) ──────────
describe("createRealProviderRunner — provider-output/error mapping", () => {
  it("real_runner_maps_provider_output_to_agent_result — ProviderOutput → GateResult<AgentResult> (spec §19.5)", async () => {
    const calls: HttpTransportRequest[] = [];
    const { controller } = makeController();
    const runner = createRealProviderRunner({
      transport: cannedTransport(200, CANNED_CLAUDE_BODY, calls),
      facade: okFacade("sk-canary"),
      controller,
      allowedEndpoints: [],
      now,
    });
    const res = await runner(cloudRoute("claude"), makeJob(cloudRoute("claude")), budget);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const agentResult = res.value.value;
    expect(agentResult.status).toBe("completed");
    expect(agentResult.candidateOutput).toEqual({ title: "T" });
    expect(agentResult.usage.inputTokens).toBe(5);
    expect(agentResult.usage.outputTokens).toBe(7);
    expect(calls).toHaveLength(1); // dispatched through the injected (fake) transport
  });

  it("real_runner_maps_provider_error_to_gate_err_never_throws — Err path, never throws, redaction-safe (spec §16)", async () => {
    const calls: HttpTransportRequest[] = [];
    const { controller } = makeController();
    const runner = createRealProviderRunner({
      transport: throwingTransport(calls),
      facade: okFacade("sk-canary"),
      controller,
      allowedEndpoints: [],
      now,
    });
    // Capture UNCONDITIONALLY (L15) — a resolve-instead-of-reject still hits the asserts.
    const res = await runner(cloudRoute("claude"), makeJob(cloudRoute("claude")), budget);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.retryable).toBe(true); // transport_error is retryable
    expect(res.error.branch).toBe("failed_retryable");
    // rule 7: the thrown secret-shaped detail never survives into the deny.
    expect(JSON.stringify(res.error)).not.toContain("sk-canary");
  });

  it("runtime_branch_route_is_fail_closed — an agentic (AgentRuntimePort) route → typed provider_unavailable, no dispatch (spec §19.5 Q4)", async () => {
    const calls: HttpTransportRequest[] = [];
    const { controller } = makeController();
    const runner = createRealProviderRunner({
      transport: cannedTransport(200, CANNED_CLAUDE_BODY, calls),
      facade: okFacade("sk-canary"),
      controller,
      allowedEndpoints: [],
      now,
    });
    // A `runtime`-branch (agentic) route — the dormant AgentRuntimePort leg, not bound this slice.
    const runtimeRoute = {
      runtime: "claude-agent-sdk",
      model: "m",
      endpoint: "https://x.test",
      egressClass: "cloud",
    } as unknown as ProviderRoute;
    const res = await runner(runtimeRoute, makeJob(runtimeRoute), budget);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("provider_unavailable"); // fail-closed typed deny, not a silent no-op
    expect(res.error.branch).toBe("failed_terminal");
    expect(res.error.retryable).toBe(false);
    expect(calls).toHaveLength(0); // the dormant agentic leg never dispatches
  });

  it("runner_is_total_on_a_rogue_collaborator_throw — a throwing controller can't break the run leg (spec §16)", async () => {
    const calls: HttpTransportRequest[] = [];
    // A misbehaving controller whose holdJob THROWS. The broker awaits the run leg WITHOUT a
    // guard, so the runner must stay TOTAL: fail closed to a typed deny, never propagate the throw.
    const throwingController = {
      ...makeController().controller,
      holdJob: () => {
        throw new Error("controller boom sk-canary-secret");
      },
    } as unknown as KeychainLockController;
    const runner = createRealProviderRunner({
      transport: cannedTransport(200, CANNED_CLAUDE_BODY, calls),
      facade: lockedFacade, // → auth_unavailable → holdJob (which throws)
      controller: throwingController,
      allowedEndpoints: [],
      now,
    });
    const res = await runner(cloudRoute("claude"), makeJob(cloudRoute("claude")), budget);
    expect(isErr(res)).toBe(true); // RESOLVED (not thrown) — the runner is total
    if (!isErr(res)) return;
    expect(res.error.branch).toBe("failed_terminal");
    expect(JSON.stringify(res.error)).not.toContain("sk-canary"); // no cause echoed (rule 7)
  });
});

// ── the dormancy gate: OFF ⇒ byte-identical stub + zero factory invocation ──────
describe("selectProviderRunner — default-OFF dormancy gate", () => {
  const stub = createStubProviderRunner({ candidateOutput: { k: 1 } });

  it("gate_off_uses_stub_byte_identical — unset/false/AND-missing ⇒ the EXACT stub (spec L16 L27)", () => {
    expect(selectProviderRunner(undefined, stub)).toBe(stub);
    expect(selectProviderRunner({}, stub)).toBe(stub);
    expect(selectProviderRunner({ enabled: false, make: () => stub }, stub)).toBe(stub);
    expect(selectProviderRunner({ enabled: true }, stub)).toBe(stub); // AND-lock: no factory ⇒ stub
    // truthy-but-not-`true` never arms (L28 — no false-arming coerce vector).
    const truthy: ProviderTransportGate = {
      enabled: "true" as unknown as boolean,
      make: () => stub,
    };
    expect(selectProviderRunner(truthy, stub)).toBe(stub);
  });

  it("gate_off_never_invokes_real_factory — factory-spy zero-invocation off, once-on (spec L16 L27)", () => {
    const real: ProviderRunner = () =>
      Promise.resolve(
        ok({ value: makeAgentResult({ status: "completed", candidateOutput: {}, usage: { runtimeSeconds: 0 }, logs: [] }) }),
      );
    const make = vi.fn<() => ProviderRunner>(() => real);
    expect(selectProviderRunner(undefined, stub)).toBe(stub);
    expect(selectProviderRunner({ enabled: false, make }, stub)).toBe(stub);
    expect(make).not.toHaveBeenCalled(); // nothing real constructed on the OFF path
    // AND-lock ON: strict flag + factory ⇒ the real runner (factory invoked exactly once).
    expect(selectProviderRunner({ enabled: true, make }, stub)).toBe(real);
    expect(make).toHaveBeenCalledTimes(1);
  });
});

// ── the credential path: locked/missing ⇒ held retryable, no plaintext (rule 7) ─
// A LOCKED key mints a keychain-locked HealthItem (via the lock-routing accessor's
// onKeychainLocked); a MISSING (facade-unbound — the DORMANT default) key holds retryable
// with NO health item (17.3: "a config error is not a lock"). BOTH fail closed: retryable,
// never terminal, never a plaintext dispatch.
describe("createRealProviderRunner — credential fail-closed degrade", () => {
  it.each([
    { label: "locked", facade: lockedFacade as SecretsAccessor | undefined, mintsHealthItem: true },
    { label: "missing (facade unbound — the dormant default)", facade: undefined, mintsHealthItem: false },
  ])(
    "$label secret ⇒ held retryable, no plaintext, no terminal reject (spec rule7 L21 L29)",
    async ({ facade, mintsHealthItem }) => {
      const calls: HttpTransportRequest[] = [];
      const { controller, recorded } = makeController();
      const runner = createRealProviderRunner({
        transport: cannedTransport(200, CANNED_CLAUDE_BODY, calls),
        ...(facade !== undefined ? { facade } : {}), // undefined ⇒ dormant (every resolve is `missing`)
        controller,
        allowedEndpoints: [],
        now,
      });
      const res = await runner(cloudRoute("claude"), makeJob(cloudRoute("claude"), { id: "job-locked" }), budget);
      // fail-closed: a RETRYABLE deny, NEVER terminal.
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.retryable).toBe(true);
      expect(res.error.branch).not.toBe("failed_terminal");
      // the never-reject controller HOLDS the dependent job (retryable; LIFE-6 re-drive).
      expect(controller.heldJobs()).toContain("job-locked");
      // NO plaintext / NO egress: a locked/missing secret never dispatches to the transport.
      expect(calls).toHaveLength(0);
      // ONLY a locked key surfaces a keychain-locked HealthItem; a missing (unbound) key does not.
      if (mintsHealthItem) {
        expect(recorded.length).toBeGreaterThan(0);
        expect(recorded[0]?.subjectRef).toBe("keychain:claude");
      } else {
        expect(recorded).toHaveLength(0);
      }
    },
  );
});

// ── the local route: off-allowlist endpoint rejected, no egress (rule 5) ────────
describe("createRealProviderRunner — local zero-egress allowlist", () => {
  it("local_off_allowlist_rejected — an off-allowlist ollama endpoint is invalid_request, no dispatch (spec rule5)", async () => {
    const calls: HttpTransportRequest[] = [];
    const { controller } = makeController();
    const runner = createRealProviderRunner({
      transport: cannedTransport(200, "{}", calls),
      controller,
      allowedEndpoints: [LOCAL_ENDPOINT],
      now,
    });
    const bad = localRoute("http://evil.example.com:11434");
    const res = await runner(bad, makeJob(bad), budget);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.retryable).toBe(false); // invalid_request is terminal
    expect(res.error.branch).toBe("failed_terminal");
    expect(calls).toHaveLength(0); // never egressed to the off-allowlist endpoint
  });
});

// ── the broker ordering: egress veto precedes the run leg (§7; 18.9 builds on it) ─
describe("broker pipeline — egress veto precedes the bound real run leg", () => {
  it("egress_veto_precedes_run_leg — a vetoed job never reaches the real runner (spec §7)", async () => {
    const calls: HttpTransportRequest[] = [];
    const { controller } = makeController();
    const realRunner = createRealProviderRunner({
      transport: cannedTransport(200, CANNED_CLAUDE_BODY, calls),
      facade: okFacade("sk-canary"),
      controller,
      allowedEndpoints: [],
      now,
    });
    const runSpy = vi.fn(realRunner);
    const audit = buildAuditSignal({
      actor: "test",
      event: "test",
      refs: [],
      payloadHash: "h",
      beforeSummary: "b",
      afterSummary: "a",
    });
    const route = cloudRoute("claude");
    const job = makeJob(route);
    const broker = createBroker({
      health: () => ok({ value: undefined }),
      budget: { pre: () => ok({ value: budget }), post: () => ok({ value: undefined }) },
      run: runSpy,
      schema: () => ok({ value: { kind: "proposed_action", action: {} as never } as BrokerCandidate }),
      admit: (j) => allowDecision(j, audit),
      resolveRoute: () => allowDecision(route, audit),
      egressVeto: () => denyDecision(FAIL_CLOSED_DENIAL, "egress veto (test)", audit),
    });
    const outcome = await broker.runJob({
      job,
      matrix: {} as never,
      egress: {} as never,
      workspace: { type: "employer_work", dataOwner: "employer" },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    expect(outcome.error.stage).toBe("egress_veto");
    expect(runSpy).not.toHaveBeenCalled(); // the real run leg is never reached
    expect(calls).toHaveLength(0); // and nothing dispatched
  });
});

// ── the DORMANCY GUARANTEE at the real assembly site: assembleBackends({}) wires
//    `run` through the gate with the stub fallback + reads the right config field.
//    A wiring typo (wrong field / missing stub fallback) slips past the pure T3/T4
//    helper tests — this drives the REAL broker (real policy gates) to the run leg.
describe("assembleBackends — default run leg IS the stub (byte-identical dormancy at the real site)", () => {
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("assembleBackends_default_run_leg_is_stub_byte_identical — no providerTransport ⇒ stub extraction flows verbatim (spec L16 L27)", async () => {
    const STUB_OUT = { marker: "stub-42" };
    // No `providerTransport` (the shipped default) ⇒ the gate MUST fall back to
    // createStubProviderRunner(extraction).
    const backends = await assembleBackends({}, { candidateOutput: STUB_OUT });
    opened.push(backends);

    const wsId = validAgentJob.workspaceId;
    // A LOCAL (non-egress) ollama route — the employer_work + local + meeting.close
    // posture the live proof-spine flows through the real broker gates to acceptance.
    const local = {
      provider: "ollama",
      model: "local-default",
      endpoint: LOCAL_ENDPOINT,
      egressClass: "local",
    } as unknown as ProviderRoute;
    const job: AgentJob = { ...validAgentJob, providerRoute: local, idempotencyKey: "idem-stub-pin" };
    const matrix: ProviderMatrix = {
      workspaceId: wsId,
      allowedProviders: ["ollama"],
      capabilityDefaults: { "meeting.close": local } as ProviderMatrix["capabilityDefaults"],
      rawCloudEgressEnabled: false,
    };
    const egress: EgressPolicy = {
      workspaceId: wsId,
      allowedProcessors: [],
      rawContentAllowedProcessors: [],
      employerRawEgressAcknowledged: false,
    };

    const outcome = await backends.broker.runJob({
      job,
      matrix,
      egress,
      workspace: { type: "employer_work", dataOwner: "employer" },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });

    // The DEFAULT run leg is the stub: its fixed extraction flows VERBATIM into the
    // accepted candidate, with the stub's fixed usage (runtimeSeconds 1). Byte-identical.
    expect(isOk(outcome)).toBe(true);
    if (!isOk(outcome)) return;
    expect(outcome.value.candidate.kind).toBe("proposed_action");
    if (outcome.value.candidate.kind !== "proposed_action") return;
    expect(
      (outcome.value.candidate.action.payload as { candidateOutput: unknown }).candidateOutput,
    ).toEqual(STUB_OUT);
    expect(outcome.value.usage.runtimeSeconds).toBe(1);
  });
});
