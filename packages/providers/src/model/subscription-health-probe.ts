// @sow/providers — Claude SUBSCRIPTION health probe primitive (18.22, §19.5 / §7).
//
// A PURE, TOTAL, FAIL-CLOSED reachability fold: reports whether the Claude subscription is usable (local
// `claude` login present + SDK reachable) as a typed verdict. Mirrors createClaudeSubscriptionCompletion's
// posture — ambient auth (local login, ANTHROPIC_API_KEY UNSET), and the REAL reachability check lives
// behind an INJECTED seam (like the client's lazy SDK import) so the build/unit-test touches NO SDK runtime
// and makes NO `query()` call / network request. DORMANT: the always-green stub (DEFAULT_HEALTH_SOURCES)
// stays the default; the worker wraps this probe into HealthGateSources (18.23) riding `gate.healthSource`
// — NEVER config.healthSources (Lesson 52) — selected only on the owner-armed path.
//
// FAIL-CLOSED (never a false-green, §16 / rule 7): the fold checks BOTH dimensions STRICT `=== true`, so any
// absent/partial/ambiguous check result — or a throwing check — degrades to UNHEALTHY. The unhealthy reason
// is a fixed CLOSED-SET code token (never a raw path/message/stack). The worker wrap (18.23) maps this
// minimal verdict to the sync HealthGateSources `health.state` (healthy | unreachable) + `availability`
// ({modelPresent, conformanceStatus}); the probe stays a minimal reachability verdict (layer-clean).

/**
 * The injected reachability signal. `loginPresent` = the local `claude` login exists; `sdkReachable` = the
 * Agent SDK is importable/reachable. Both must be `true` for a healthy verdict. A partial/malformed value
 * (or `undefined`) is treated as ambiguous and fails closed.
 */
export interface SubscriptionReachability {
  readonly loginPresent: boolean;
  readonly sdkReachable: boolean;
}

/** The injected reachability check (a fake in tests; the real fs/SDK check binds behind it at ENABLE). */
export type SubscriptionReachabilityCheck = () => SubscriptionReachability | undefined;

/** Injected deps for the probe — the reachability check(s). */
export interface SubscriptionHealthProbeDeps {
  readonly checkReachable: SubscriptionReachabilityCheck;
}

/** The CLOSED set of unhealthy reason codes — fixed tokens, never a raw path/message (rule 7). */
export const SubscriptionHealthReason = [
  "login_absent",
  "unreachable",
  "check_ambiguous",
  "check_threw",
] as const;
export type SubscriptionHealthReason = (typeof SubscriptionHealthReason)[number];

/** The typed health verdict. `reachable:true` ⇒ healthy (no reason); else unhealthy with a code-only reason. */
export interface SubscriptionHealthVerdict {
  readonly reachable: boolean;
  readonly reason?: SubscriptionHealthReason;
}

/**
 * PURE + TOTAL + FAIL-CLOSED: fold the injected reachability check into a health verdict. Any throw ⇒
 * `check_threw`; a non-object/undefined result ⇒ `check_ambiguous`; `loginPresent !== true` ⇒ `login_absent`;
 * `sdkReachable !== true` ⇒ `unreachable`; both `=== true` ⇒ healthy. Never throws; does NO SDK/network I/O
 * (all reachability I/O is the injected check's — the real check binds behind the seam at ENABLE).
 */
export function probeClaudeSubscriptionHealth(
  deps: SubscriptionHealthProbeDeps,
): SubscriptionHealthVerdict {
  try {
    // The ENTIRE fold sits inside the try so a throw from EITHER the check call OR a hostile property
    // getter on its returned object is caught — no read escapes it (strict totality, §16). A benign
    // absent/non-object/partial result does NOT throw; it returns fail-closed below.
    const result = deps.checkReachable();
    if (result === null || typeof result !== "object") {
      return { reachable: false, reason: "check_ambiguous" };
    }
    if (result.loginPresent !== true) {
      return { reachable: false, reason: "login_absent" };
    }
    if (result.sdkReachable !== true) {
      return { reachable: false, reason: "unreachable" };
    }
    return { reachable: true };
  } catch {
    // rule 7: a throw MAY carry a path/message/stack — fold to a fixed code, never surface it.
    return { reachable: false, reason: "check_threw" };
  }
}
