// 18.18a / flip-wiring (worker) — `buildRealProviderTransportGate`: the SINGLE tested chokepoint that
// composes the owner's crossing bundle into a `ProviderTransportGate`
// `{ enabled: true, make: () => createRealProviderRunner(runnerDeps), healthSource? }`.
//
// DORMANT / mock-tested, NOT enabled — the real runner is BUILT (a thunk) + mock-tested, never fired;
// the ENABLE (owner sets `config.providerTransport` + provisions the key) is the lead's owner-gated
// step, not this slice. Building the bundle crosses no hard line.
//
// L52 (the load-bearing invariant): the real health source rides `gate.healthSource` ONLY — it is
// selected by `selectHealthSources` on the ARMED path, or fails closed to UNAVAILABLE_HEALTH_SOURCES
// when the arming bundle omitted it. The helper's product is a `ProviderTransportGate`; it
// STRUCTURALLY CANNOT bind `config.healthSources` (which takes `??` precedence at backends.ts:794 and
// would re-open the always-green false-green under a real transport).
import {
  createRealProviderRunner,
  type ProviderTransportGate,
  type RealProviderRunnerDeps,
} from "./provider-runner";
import type { ProviderRunner, HealthGateSources } from "@sow/providers";

/**
 * Deps for {@link buildRealProviderTransportGate} — the owner's crossing bundle:
 * - `runnerDeps` — EXACTLY `createRealProviderRunner`'s {@link RealProviderRunnerDeps}
 *   (`transport`, `facade`, `controller`, `allowedEndpoints`, `now`, `logSink`) — no new shape
 *   drift (L5). The helper NEVER inspects it; it only forwards it to `createRunner`.
 * - `healthSource` — OPTIONAL owner-provisioned real HEALTH source (L52). Omitted ⇒ the armed gate
 *   fails closed to `UNAVAILABLE_HEALTH_SOURCES` (never the always-green stub). The real
 *   reachability/availability PRODUCER is an owner-provisioned arming input (routed to task #13 as
 *   the last functional prerequisite for a WORKING vs. safely-fail-closed first extraction).
 * - `createRunner` — the runner factory, defaulting to {@link createRealProviderRunner}; injectable
 *   so a test proves the factory-spy zero-invocation (L23/L27) without constructing the real client.
 */
export interface RealProviderTransportGateDeps {
  readonly runnerDeps: RealProviderRunnerDeps;
  readonly healthSource?: () => HealthGateSources;
  readonly createRunner?: (deps: RealProviderRunnerDeps) => ProviderRunner;
}

/**
 * Compose the owner's crossing bundle into a {@link ProviderTransportGate}. Armed BY CONSTRUCTION
 * (`enabled: true` literal — the OFF path is "don't build the gate / leave `config.providerTransport`
 * unset", NEVER a false `enabled`; `selectProviderRunner` is STRICT `=== true`). `make` is a THUNK:
 * `createRunner` is invoked ONLY when `gate.make()` is called (0× at build — L23/L27 factory-spy — so
 * building the bundle opens no socket and constructs no runner). The optional `healthSource` rides
 * the GATE (L52); it is never bound to `config.healthSources`.
 */
export function buildRealProviderTransportGate(
  deps: RealProviderTransportGateDeps,
): ProviderTransportGate {
  const { runnerDeps, healthSource, createRunner = createRealProviderRunner } = deps;
  return {
    enabled: true,
    make: () => createRunner(runnerDeps),
    ...(healthSource !== undefined ? { healthSource } : {}),
  };
}
