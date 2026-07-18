// 18.18a / flip-wiring (worker) — the `buildRealProviderTransportGate` assembly helper: the SINGLE
// tested chokepoint that composes the owner's crossing bundle into a `ProviderTransportGate`
// `{ enabled: true, make: () => createRealProviderRunner(runnerDeps), healthSource? }`.
//
// DORMANT / mock-tested, NOT enabled — the real runner is BUILT (thunk) + mock-tested, never fired;
// the ENABLE (owner sets the gate + provisions the key) is the lead's owner-gated step, not this slice.
//
// L52 (the load-bearing invariant): the real health source rides `gate.healthSource` ONLY — it is
// selected by `selectHealthSources` on the ARMED path, or fails closed to UNAVAILABLE_HEALTH_SOURCES
// when the arming bundle omitted it. The helper NEVER binds `config.healthSources` (which takes `??`
// precedence at backends.ts:794 and would re-open the always-green false-green under a real transport).
import { describe, it, expect, vi } from "vitest";
import { buildRealProviderTransportGate } from "../../src/composition/real-provider-transport-gate";
import {
  selectHealthSources,
  UNAVAILABLE_HEALTH_SOURCES,
  type RealProviderRunnerDeps,
} from "../../src/composition/provider-runner";
import type { ProviderRunner, HealthGateSources } from "@sow/providers";

// The helper NEVER inspects runnerDeps — it only forwards them to `createRunner`. A cast stub suffices.
const RUNNER_DEPS = {} as unknown as RealProviderRunnerDeps;
const FAKE_RUNNER = {} as unknown as ProviderRunner;
// A GREEN health stub — used as the `selectHealthSources` OFF-path arg to PROVE the armed-without-source
// path returns UNAVAILABLE, never this green stub (the false-green L52 guards against).
const GREEN_STUB: HealthGateSources = {
  health: () => ({ state: "healthy" }),
  availability: () => ({ modelPresent: true, conformanceStatus: "passing" }),
};

describe("buildRealProviderTransportGate — the worker flip-wiring gate-assembly helper (18.18a)", () => {
  it("gate_is_enabled_true_literal — the assembled crossing bundle is armed BY CONSTRUCTION (`enabled === true`)", () => {
    const gate = buildRealProviderTransportGate({
      runnerDeps: RUNNER_DEPS,
      healthSource: () => GREEN_STUB,
      createRunner: () => FAKE_RUNNER,
    });
    // Literal true — the OFF path is "don't build the gate / leave config.providerTransport unset",
    // NOT a false `enabled` (selectProviderRunner is STRICT `=== true`).
    expect(gate.enabled).toBe(true);
  });

  it("make_is_a_thunk_zero_invocation_at_build — createRealProviderRunner is called 0x at build, exactly 1x on gate.make() (L23/L27 factory-spy)", () => {
    const createRunner = vi.fn((_d: RealProviderRunnerDeps) => FAKE_RUNNER);
    const gate = buildRealProviderTransportGate({ runnerDeps: RUNNER_DEPS, createRunner });
    // Building the bundle constructs NOTHING — no socket, no runner (dormant until armed + invoked).
    expect(createRunner).toHaveBeenCalledTimes(0);
    const runner = gate.make?.();
    expect(createRunner).toHaveBeenCalledTimes(1);
    expect(createRunner).toHaveBeenCalledWith(RUNNER_DEPS); // the injected runnerDeps flow through unchanged
    expect(runner).toBe(FAKE_RUNNER);
  });

  it("healthSource_rides_the_gate_not_config — the real health source is on the GATE (ProviderTransportGate.healthSource), never a config.healthSources binding (L52)", () => {
    const healthSource = () => GREEN_STUB;
    const gate = buildRealProviderTransportGate({ runnerDeps: RUNNER_DEPS, healthSource, createRunner: () => FAKE_RUNNER });
    // The helper's product is a ProviderTransportGate carrying the source on `gate.healthSource` — the
    // AND-locked arming path. It produces NO config.healthSources (its return type can't; the L52 pin).
    expect(gate.healthSource).toBe(healthSource);
    expect(gate.enabled).toBe(true);
  });

  it("healthSource_omitted_fails_closed_to_unavailable — an armed gate WITHOUT a healthSource ⇒ selectHealthSources returns UNAVAILABLE (never the green stub) (L52 AND-lock)", () => {
    // Arming the run leg but omitting the health source must degrade CLOSED, not ride the always-green stub.
    const gate = buildRealProviderTransportGate({ runnerDeps: RUNNER_DEPS, createRunner: () => FAKE_RUNNER });
    expect(gate.healthSource).toBeUndefined();
    // The armed path (enabled:true + make fn) with no healthSource ⇒ UNAVAILABLE, NOT the passed green stub.
    expect(selectHealthSources(gate, GREEN_STUB)).toBe(UNAVAILABLE_HEALTH_SOURCES);
  });
});
