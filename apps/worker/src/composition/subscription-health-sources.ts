// 18.23 step 3b — wrap the 18.22 Claude-subscription health probe verdict into the broker's
// HealthGateSources (staged ENABLE; DORMANT).
//
// The 18.22 `probeClaudeSubscriptionHealth` folds an injected reachability check into a minimal
// `SubscriptionHealthVerdict` ({reachable, reason?}); this wrap maps that verdict to the sync
// `{ health, availability }` the broker's 5.9 gate reads. FAIL-CLOSED / no false-green (L52): only a
// `reachable` verdict yields healthy/present-passing; ANY unhealthy verdict yields a NON-healthy
// `health.state` (⇒ the HEALTH gate DENIES) + fail-closed availability — so a real transport can never
// ride a green-stub health source.
//
// Rides `gate.healthSource` ONLY (never `config.healthSources` — L52; the arming caveat), selected only on
// the owner-armed path. `route`/`job` are ignored — subscription reachability is a GLOBAL property (the
// ambient local `claude` login), not per-route. Reachability-WAIVERED (L11): boot binds this at the owner
// ENABLE (step 6), with the caller supplying `() => probeClaudeSubscriptionHealth({ checkReachable })`.
import type { HealthGateSources, SubscriptionHealthVerdict } from "@sow/providers";

/**
 * Build the {@link HealthGateSources} that report the Claude-subscription reachability. `probe` is a thunk
 * over the 18.22 verdict producer (the caller binds the real reachability check at ENABLE). Pure; the
 * verdict drives both dimensions fail-closed (only `reachable` ⇒ healthy).
 */
export function createSubscriptionHealthSources(
  probe: () => SubscriptionHealthVerdict,
): HealthGateSources {
  // NOTE (double-probe): the two-function HealthGateSources shape means `probe()` runs once per dimension
  // (health + availability) per gate evaluation — so a real reachability check would run TWICE per job. A
  // split verdict stays FAIL-CLOSED (either dimension unhealthy ⇒ deny — no false-green), so this is not a
  // correctness bug. #13 ENABLE Future-TODO: the binding supplies a SHORT-TTL-MEMOIZED probe thunk so one
  // reachability check feeds both dimensions (the coalesce belongs at the binding, not this pure wrap).
  return {
    health: () => ({ state: probe().reachable ? "healthy" : "unreachable" }),
    availability: () =>
      probe().reachable
        ? { modelPresent: true, conformanceStatus: "passing" }
        : { modelPresent: false, conformanceStatus: "failing" },
  };
}
