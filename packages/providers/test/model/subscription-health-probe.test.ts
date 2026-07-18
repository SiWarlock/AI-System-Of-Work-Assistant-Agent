// spec(§19.5)/spec(§7) — 18.22: the fakeable, fail-closed Claude-SUBSCRIPTION health probe primitive.
// Reports whether the subscription is usable (local `claude` login present + SDK reachable) as a typed
// verdict — the real availability signal the worker wraps into HealthGateSources at the owner ENABLE flip
// (18.23), riding gate.healthSource (never config.healthSources, L52). DORMANT: the always-green stub stays
// the default; this probe is selected only on the armed path. FAIL-CLOSED: any absent/ambiguous/throwing
// check ⇒ unhealthy, never a false-green. The reachability check is INJECTED — no SDK query()/network at build.
import { describe, it, expect, vi } from "vitest";
import {
  probeClaudeSubscriptionHealth,
  type SubscriptionReachability,
  type SubscriptionReachabilityCheck,
} from "../../src/model/subscription-health-probe";

const present: SubscriptionReachability = { loginPresent: true, sdkReachable: true };

describe("probeClaudeSubscriptionHealth — fail-closed fakeable subscription health probe (18.22)", () => {
  it("reachable_login_healthy", () => {
    // spec(§7) — login present + reachable (per the injected check) ⇒ a healthy verdict, no reason.
    const v = probeClaudeSubscriptionHealth({ checkReachable: () => present });
    expect(v.reachable).toBe(true);
    expect("reason" in v).toBe(false);
  });

  it("absent_login_unhealthy", () => {
    // spec(§7) — no local `claude` login ⇒ UNHEALTHY (fail-closed), code-only reason.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: () => ({ loginPresent: false, sdkReachable: true }),
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("login_absent");
  });

  it("unreachable_unhealthy", () => {
    // spec(§7) — login present but SDK not reachable ⇒ UNHEALTHY.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: () => ({ loginPresent: true, sdkReachable: false }),
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("unreachable");
  });

  it("ambiguous_defaults_unhealthy", () => {
    // spec(§16) — an absent/undefined (or non-object) check result ⇒ UNHEALTHY, never a false-green.
    const v = probeClaudeSubscriptionHealth({ checkReachable: () => undefined });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("check_ambiguous");
  });

  it("null_result_folds_ambiguous", () => {
    // spec(§16) — a `null` result (typeof null === "object") must hit the `=== null` guard, NOT fall
    // through to `null.loginPresent` (a TypeError that would break totality). Pins the null branch.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: (() => null) as unknown as SubscriptionReachabilityCheck,
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("check_ambiguous");
  });

  it("truthy_non_boolean_login_fails_closed", () => {
    // spec(§7)/L52 — the load-bearing false-green defense is STRICT `=== true`, NOT truthiness: a
    // truthy-non-boolean (`"yes"`) must NOT green. A regression to `if (!result.loginPresent)` reopens
    // the false-green surface — this pins it.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: (() =>
        ({ loginPresent: "yes", sdkReachable: "yes" }) as unknown as SubscriptionReachability),
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("login_absent");
  });

  it("partial_object_missing_sdk_reachable_is_unreachable", () => {
    // spec(§7) — an object missing `sdkReachable` folds through the strict two-dimension check to
    // `unreachable` (undefined !== true), NOT a false-green. Pins the sdkReachable strictness.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: (() => ({ loginPresent: true }) as unknown as SubscriptionReachability),
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("unreachable");
  });

  it("check_throw_folds_unhealthy", () => {
    // spec(§16) — the injected check throwing folds to UNHEALTHY; no throw escapes the probe (total).
    const v = probeClaudeSubscriptionHealth({
      checkReachable: () => {
        throw new Error("/Users/secret/path boom");
      },
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("check_threw");
  });

  it("no_sdk_call_at_build", () => {
    // spec(§19.5) — the probe does NO SDK query()/network at build; the INJECTED check is the only I/O seam
    // (assert it is the single thing invoked). The real reachability check binds behind this seam at ENABLE.
    const spy = vi.fn((): SubscriptionReachability => present);
    const v = probeClaudeSubscriptionHealth({ checkReachable: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(v.reachable).toBe(true);
  });

  it("reason_is_code_only", () => {
    // spec(§16)/rule 7 — an unhealthy reason is a FIXED closed-set token, never a raw path/message/stack.
    const v = probeClaudeSubscriptionHealth({
      checkReachable: () => {
        throw new Error("/Users/dreddy/.claude/creds leaked");
      },
    });
    expect(v.reachable).toBe(false);
    expect(v.reason).toBe("check_threw");
    expect(v.reason).not.toMatch(/\/|Users|leaked|Error/);
  });
});
