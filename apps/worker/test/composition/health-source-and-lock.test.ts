// 18.14 / CP-4 — the broker HEALTH source is AND-LOCKED to the 18.1 providerTransport arming.
//
// The always-green DEFAULT_HEALTH_SOURCES is correct ONLY while the transport is dormant (the stub
// is always available). Once the REAL transport is ARMED (18.1's providerTransport gate), an
// always-green health source would admit a DEAD / unreachable real provider — a false-green into
// the broker's deny-only HEALTH gate. This slice AND-locks the health SOURCE selection to the SAME
// providerTransport arming as the run leg (a single owner flip arms BOTH — no split-brain): armed ⇒
// a real availability source; dormant ⇒ the stub (byte-equivalent green). Arming the runner but
// omitting the health source FAILS CLOSED (unreachable) — never stub-green.
//
// SAFE-BUILD: the real availability probe (reachability against a live endpoint) is UNBOUND by
// default (reachable-when-armed, worker L11); the dormant path is byte-equivalent; no real endpoint
// call, no spend anywhere in this slice's tested/dormant paths (fake sources only).
import { describe, it, expect, vi, afterEach } from "vitest";
import { isOk, isErr, ok, validAgentJob } from "@sow/contracts";
import type { AgentJob, ProviderRoute, ProviderMatrix, EgressPolicy } from "@sow/contracts";
import {
  createHealthGate,
  NO_ELIGIBLE_PROVIDER_HEALTH_CLASS,
  type HealthGateSources,
  type ProviderHealthState,
  type ProviderRunner,
} from "@sow/providers";
import {
  selectHealthSources,
  UNAVAILABLE_HEALTH_SOURCES,
  type ProviderTransportGate,
} from "../../src/composition/provider-runner";
import { assembleBackends, DEFAULT_HEALTH_SOURCES, type ProofSpineBackends } from "../../src/composition/backends";

const route: ProviderRoute = {
  provider: "claude",
  model: "m",
  endpoint: "https://api.provider.test",
  egressClass: "cloud",
} as unknown as ProviderRoute;
const job: AgentJob = validAgentJob;

// A real (fake, in-test) availability source reporting a specific provider-health state.
const sourceReporting = (state: ProviderHealthState): HealthGateSources => ({
  health: () => ({ state }),
  availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
});

// A no-op runner factory — the SELECTION only checks `typeof make === "function"`; the runner is
// never invoked in these tests (the health gate short-circuits before the run leg).
const noopRunner = (() => Promise.resolve(ok({ value: null }))) as unknown as ProviderRunner;
const armedGate = (healthSource?: () => HealthGateSources): ProviderTransportGate =>
  ({
    enabled: true,
    make: () => noopRunner,
    ...(healthSource ? { healthSource } : {}),
  }) as ProviderTransportGate;

describe("18.14/CP-4 — HEALTH source AND-locked to the providerTransport arming", () => {
  // ── selection unit (mirrors selectProviderRunner) ───────────────────────────
  it("undefined_gate_selects_stub_byte_equivalent — providerTransport unset ⇒ the EXACT stub instance (shipped default unchanged)", () => {
    expect(selectHealthSources(undefined, DEFAULT_HEALTH_SOURCES)).toBe(DEFAULT_HEALTH_SOURCES);
  });

  it("dormant_gate_selects_stub_factory_not_invoked — a gate present but NOT enabled ⇒ the stub; the real healthSource factory is NEVER invoked (factory-spy OFF pin, L23)", () => {
    const healthSourceFactory = vi.fn(() => sourceReporting("unreachable"));
    const selected = selectHealthSources(
      { healthSource: healthSourceFactory } as ProviderTransportGate,
      DEFAULT_HEALTH_SOURCES,
    );
    expect(selected).toBe(DEFAULT_HEALTH_SOURCES);
    expect(healthSourceFactory).not.toHaveBeenCalled();
  });

  it("truthy_not_true_enabled_does_not_arm — enabled truthy-non-`true` (\"true\"/1) ⇒ the stub, real factory NOT invoked (L28)", () => {
    for (const v of ["true", 1, "false", {}] as unknown as boolean[]) {
      const healthSourceFactory = vi.fn(() => sourceReporting("unreachable"));
      const selected = selectHealthSources(
        { enabled: v, make: () => noopRunner, healthSource: healthSourceFactory } as unknown as ProviderTransportGate,
        DEFAULT_HEALTH_SOURCES,
      );
      expect(selected).toBe(DEFAULT_HEALTH_SOURCES);
      expect(healthSourceFactory).not.toHaveBeenCalled();
    }
  });

  it("armed_selects_real_source — enabled===true & make bound & healthSource bound ⇒ the real source (not the always-green stub)", () => {
    const real = sourceReporting("unreachable");
    const selected = selectHealthSources(armedGate(() => real), DEFAULT_HEALTH_SOURCES);
    expect(selected).toBe(real);
    expect(selected).not.toBe(DEFAULT_HEALTH_SOURCES);
  });

  it("armed_without_healthSource_fails_closed — arming the runner but OMITTING healthSource ⇒ the UNAVAILABLE (unreachable) source, NEVER the always-green stub (closes the false-green hole)", () => {
    const selected = selectHealthSources(armedGate(), DEFAULT_HEALTH_SOURCES);
    expect(selected).toBe(UNAVAILABLE_HEALTH_SOURCES);
    expect(selected).not.toBe(DEFAULT_HEALTH_SOURCES);
    expect(selected.health(route, job).state).toBe("unreachable"); // reports NOT healthy (fail-closed)
  });

  // ── end-to-end through createHealthGate (the deny/admit behavior) ────────────
  it("armed_unhealthy_provider_denies — armed transport + a real source reporting unreachable ⇒ HEALTH gate DENIES (fail-closed, not green)", async () => {
    const sources = selectHealthSources(armedGate(() => sourceReporting("unreachable")), DEFAULT_HEALTH_SOURCES);
    const out = await createHealthGate(sources)(route, job);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("provider_unavailable");
  });

  it("armed_healthy_provider_admits — armed transport + a real source reporting healthy ⇒ HEALTH gate ADMITS (non-vacuity, not a blanket deny)", async () => {
    const sources = selectHealthSources(armedGate(() => sourceReporting("healthy")), DEFAULT_HEALTH_SOURCES);
    const out = await createHealthGate(sources)(route, job);
    expect(isOk(out)).toBe(true);
  });

  it("dormant_default_admits_green_byte_equivalent — unset transport ⇒ the stub source ⇒ HEALTH gate green (today's exact boot)", async () => {
    const out = await createHealthGate(selectHealthSources(undefined, DEFAULT_HEALTH_SOURCES))(route, job);
    expect(isOk(out)).toBe(true);
  });
});

// orch2 confirmation (L39 spirit): the armed-without-healthSource fail-closed path must be
// operator-VISIBLE — the deny surfaces an OBS-2 System Health item END-TO-END at the assembled
// broker (createHealthGate mints the provider_unreachable deny; the broker's failClosedNoProvider
// attaches the OBS-2 BrokerHealthItem), not just a silent per-record broker-err.
describe("18.14/CP-4 — armed-without-healthSource misconfig is operator-VISIBLE (System Health)", () => {
  const LOCAL_ENDPOINT = "http://127.0.0.1:11434";
  const localRoute: ProviderRoute = {
    provider: "ollama",
    model: "local-default",
    endpoint: LOCAL_ENDPOINT,
    egressClass: "local",
  } as unknown as ProviderRoute;
  const opened: ProofSpineBackends[] = [];
  afterEach(() => {
    for (const b of opened.splice(0)) b.close();
  });

  it("armed_without_healthSource_surfaces_health_item — arming the runner but OMITTING healthSource ⇒ the assembled broker DENIES at stage 'health' AND surfaces an OBS-2 System Health item (loud misconfig, not a silent black hole)", async () => {
    // providerTransport armed (enabled + make) but NO healthSource ⇒ selectHealthSources yields
    // UNAVAILABLE_HEALTH_SOURCES ⇒ the HEALTH gate denies. A local loopback route clears the egress
    // veto so the job actually REACHES the HEALTH gate (the run leg is never reached).
    const backends = await assembleBackends({
      providerTransport: { enabled: true, make: () => noopRunner }, // armed, healthSource OMITTED
    });
    opened.push(backends);
    const outcome = await backends.broker.runJob({
      job: {
        ...validAgentJob,
        carriesRawContent: false,
        idempotencyKey: "idem-health-misconfig",
      } as unknown as AgentJob,
      matrix: {
        workspaceId: validAgentJob.workspaceId,
        allowedProviders: ["ollama"],
        capabilityDefaults: { "meeting.close": localRoute } as ProviderMatrix["capabilityDefaults"],
        rawCloudEgressEnabled: false,
      } as unknown as ProviderMatrix,
      egress: {
        workspaceId: validAgentJob.workspaceId,
        allowedProcessors: [],
        rawContentAllowedProcessors: [],
        employerRawEgressAcknowledged: false,
      } as unknown as EgressPolicy,
      workspace: { type: "personal_business", dataOwner: "user" },
      localConfig: { allowedLocalEndpoints: [LOCAL_ENDPOINT] },
    });
    expect(isErr(outcome)).toBe(true);
    if (!isErr(outcome)) return;
    // Denied at the HEALTH gate (run leg never reached) …
    expect(outcome.error.stage).toBe("health");
    expect(outcome.error.reason).toBe("provider_unavailable");
    // … AND surfaces an OBS-2 System Health item (operator-visible — closes L39).
    expect(outcome.error.healthItem).toBeDefined();
    expect(outcome.error.healthItem?.healthClass).toBe(NO_ELIGIBLE_PROVIDER_HEALTH_CLASS);
  });
});
