// 18.23 step 3b — wrap the 18.22 subscription health probe verdict into the broker's HealthGateSources
// (dormant). A healthy verdict ⇒ health {state:"healthy"} + availability {modelPresent:true,
// conformanceStatus:"passing"}; an unhealthy verdict ⇒ a NON-healthy health.state (⇒ the broker HEALTH
// gate denies) + fail-closed availability. Rides `gate.healthSource` ONLY (never config.healthSources — L52);
// selected only on the owner-armed path. Reachability-WAIVERED (L11) — boot binds it at the ENABLE (step 6).
import { describe, it, expect } from "vitest";
import type { ProviderRoute, AgentJob } from "@sow/contracts";
import { createSubscriptionHealthSources } from "../../src/composition/subscription-health-sources";

const route = {} as unknown as ProviderRoute;
const job = {} as unknown as AgentJob;

describe("createSubscriptionHealthSources — 18.22 verdict → HealthGateSources (18.23 step 3b, dormant)", () => {
  it("health_wrap_healthy — a reachable verdict ⇒ healthy state + present/passing availability [spec(§7)]", () => {
    const sources = createSubscriptionHealthSources(() => ({ reachable: true }));
    expect(sources.health(route, job)).toEqual({ state: "healthy" });
    expect(sources.availability(route, job)).toEqual({ modelPresent: true, conformanceStatus: "passing" });
  });

  // Intentional coverage-of-intent: the wrap DROPS `verdict.reason` by design (it maps only on
  // `reachable`), so all four unhealthy reasons must fold to the SAME fail-closed state — a reason can
  // never leak a false-green. Parametrizing pins that uniformity (any unhealthy reason ⇒ deny).
  it.each([
    { reason: "login_absent" as const },
    { reason: "unreachable" as const },
    { reason: "check_ambiguous" as const },
    { reason: "check_threw" as const },
  ])("health_wrap_unhealthy_$reason — an unhealthy verdict ⇒ non-healthy state (HEALTH gate denies) + fail-closed availability [spec(§7)]", ({ reason }) => {
    const sources = createSubscriptionHealthSources(() => ({ reachable: false, reason }));
    // NON-healthy state ⇒ the broker HEALTH gate denies (never a false-green under a real transport, L52).
    expect(sources.health(route, job)).toEqual({ state: "unreachable" });
    expect(sources.availability(route, job)).toEqual({ modelPresent: false, conformanceStatus: "failing" });
  });
});
