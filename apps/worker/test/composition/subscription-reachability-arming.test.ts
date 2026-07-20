// 18.35 — the pure `resolveArmCheckReachable` resolver: bind the real SPEND-FREE subscription reachability
// probe into bootWorker's `checkReachable` ONLY behind a NEW independent reachability-enable OFF-lock, so an
// env-only subscription arm (`enabled:true` alone) stays `FAIL_CLOSED_REACHABILITY`-denied by design.
//
// The resolver is PURE — the probe + login detector are INJECTED as spies here (NO real `security` spawn / NO
// real module resolution in this suite); the real defaults bind only at the owner ENABLE flip. Every arming
// leg is pinned: env-only-arm-stays-denied (load-bearing), truthy-not-"1"/"true" (L28), AND-lock (L57),
// byte-equivalent OFF with zero probe construction (L23/L27), and the preserved explicit-injection seam (Q3).
import { describe, it, expect, vi } from "vitest";
import { probeSubscriptionReachability, detectClaudeLogin } from "@sow/providers";
import type { SubscriptionReachability } from "@sow/providers";
import {
  resolveArmCheckReachable,
  FAIL_CLOSED_REACHABILITY,
  REACHABILITY_LIVE_ENV_VAR,
  ARM_REACHABILITY_DEFAULTS,
} from "../../src/composition/subscription-reachability-arming";
import { detectClaudeKeychainLogin } from "../../src/composition/claude-keychain-login";

/** A deterministic fake reachability signal the injected probe spy returns (never real fs/keychain/module I/O). */
const FAKE_REACHABILITY: SubscriptionReachability = { loginPresent: true, sdkReachable: true };

/** An injected probe spy + login-detector spy — the resolver must wire THESE, never the real primitives. */
function spies() {
  const detectLogin = vi.fn(() => true);
  const probe = vi.fn((_deps: { readonly detectLogin: () => boolean }) => FAKE_REACHABILITY);
  return { detectLogin, probe };
}

describe("resolveArmCheckReachable — the reachability-enable OFF-lock (18.35)", () => {
  it("armed_and_enabled_binds_real_probe: arm+signal ⇒ a thunk wiring the injected probe with the injected detectLogin", () => {
    // spec(§19.5) — the real spend-free health source is what makes CP2 "health available" reachable at the flip.
    const { probe, detectLogin } = spies();
    const check = resolveArmCheckReachable({ enabled: true }, "1", { probe, detectLogin });

    // Nothing runs until the returned check is invoked (the probe is deferred inside the thunk).
    expect(probe).not.toHaveBeenCalled();

    const result = check();
    expect(result).toEqual(FAKE_REACHABILITY);
    expect(probe).toHaveBeenCalledTimes(1);
    // The thunk wires the INJECTED detectLogin into the probe — not a real Keychain probe.
    expect(probe).toHaveBeenCalledWith({ detectLogin });
    expect(detectLogin).not.toHaveBeenCalled(); // the detector fires inside the probe (here a spy), never at wiring
  });

  it("env_only_arm_stays_fail_closed: arm enabled + enable signal ABSENT ⇒ FAIL_CLOSED, real probe never constructed", () => {
    // spec(§ARM-18) ⛔ LOAD-BEARING — env-only arm stays HEALTH-denied; the real-probe injection is a distinct owner step (L52).
    const { probe, detectLogin } = spies();
    const check = resolveArmCheckReachable({ enabled: true }, undefined, { probe, detectLogin });

    expect(check).toBe(FAIL_CLOSED_REACHABILITY); // identity ⇒ no thunk constructed
    expect(check()).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("enable_signal_truthy_not_true_does_not_arm: only strict \"1\"/\"true\" arm; every other value ⇒ FAIL_CLOSED", () => {
    // L28 — every arming check earns a truthy-not-accepted regression guard (incl. the string "false").
    const rejected: readonly (string | undefined)[] = ["false", "0", "", "yes", "2", "TRUE", "True", "1 ", " 1"];
    for (const signal of rejected) {
      const { probe, detectLogin } = spies();
      const check = resolveArmCheckReachable({ enabled: true }, signal, { probe, detectLogin });
      expect(check, `signal=${JSON.stringify(signal)} must not arm`).toBe(FAIL_CLOSED_REACHABILITY);
      expect(probe).not.toHaveBeenCalled();
    }
    // A non-string truthy vector (the `{}` case) is structurally excluded by the `string | undefined` param type;
    // a defensive cast proves the strict `=== "1"|"true"` still rejects it (never a truthy-object arm).
    const { probe } = spies();
    expect(resolveArmCheckReachable({ enabled: true }, {} as unknown as string, { probe })).toBe(
      FAIL_CLOSED_REACHABILITY,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("enable_signal_without_arm_stays_fail_closed: signal present but arm DISABLED/absent ⇒ FAIL_CLOSED (OFF guard first)", () => {
    // L57 AND-lock — a supplied reachability signal can NEVER arm a disabled gate; the OFF guard precedes the signal read.
    const armInputs: readonly ({ enabled?: boolean } | undefined)[] = [{ enabled: false }, {}, undefined];
    for (const arm of armInputs) {
      const { probe, detectLogin } = spies();
      const check = resolveArmCheckReachable(arm, "1", { probe, detectLogin });
      expect(check, `arm=${JSON.stringify(arm)} + signal present must not arm`).toBe(FAIL_CLOSED_REACHABILITY);
      expect(probe).not.toHaveBeenCalled();
    }
    // L28 letter — the `enabled` axis is strict `!== true` too: a truthy-not-`true` enabled (only reachable via a
    // mistyped config) never arms, even with the signal present.
    const { probe } = spies();
    expect(resolveArmCheckReachable({ enabled: 1 as unknown as boolean }, "1", { probe })).toBe(
      FAIL_CLOSED_REACHABILITY,
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("default_off_is_byte_equivalent_zero_probe_construction: neither signal ⇒ FAIL_CLOSED + zero probe construction", () => {
    // L23/L27 — shipped default byte-equivalent; the resolver constructs NOTHING on the OFF path.
    const { probe, detectLogin } = spies();
    const check = resolveArmCheckReachable(undefined, undefined, { probe, detectLogin });

    expect(check).toBe(FAIL_CLOSED_REACHABILITY); // exact constant ⇒ no thunk built
    expect(check()).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
    expect(detectLogin).not.toHaveBeenCalled();
  });

  it("explicit_injected_checkReachable_still_wins: an explicitly supplied checkReachable is honored over the resolver default", () => {
    // Q3 — preserve the existing inject-a-fake pathway (boot reads `config.subscriptionArm?.checkReachable`).
    const explicit = vi.fn(() => FAKE_REACHABILITY);
    const { probe } = spies();
    // Even with the enable signal ABSENT (would otherwise FAIL_CLOSED), the explicit injection wins.
    const check = resolveArmCheckReachable({ enabled: true, checkReachable: explicit }, undefined, { probe });
    expect(check).toBe(explicit);
    expect(probe).not.toHaveBeenCalled(); // the real probe default is never wired when an explicit check is given
    // Fully-armed precedence: enabled:true + signal "1" (the real probe would otherwise bind) — the explicit
    // injection STILL wins (order-invariant: returned before any thunk construction).
    expect(resolveArmCheckReachable({ enabled: true, checkReachable: explicit }, "1", { probe })).toBe(explicit);
    expect(probe).not.toHaveBeenCalled();
  });

  it("default_detector_is_keychain_not_filepath: the PRODUCTION default detectLogin is the macOS Keychain probe, not the file-path detector", () => {
    // provider L10 (LOAD-BEARING) — the 18.26 file-path default (`detectClaudeLogin`) fails closed on macOS BY
    // DESIGN, so defaulting to it would leave the armed+enabled path silently HEALTH-denied FOREVER (fail-SAFE ⇒
    // none of the injected-deps tests above would catch it). The resolver's default MUST be the live macOS
    // Keychain-PRESENCE detector. No I/O — a referential-identity pin on the exposed defaults.
    expect(ARM_REACHABILITY_DEFAULTS.detectLogin).toBe(detectClaudeKeychainLogin);
    expect(ARM_REACHABILITY_DEFAULTS.detectLogin).not.toBe(detectClaudeLogin); // non-vacuity: the two are distinct fns
    expect(ARM_REACHABILITY_DEFAULTS.probe).toBe(probeSubscriptionReachability);
  });

  it("REACHABILITY_LIVE_ENV_VAR is the single-sourced reachability-enable env var name", () => {
    // Single-source the signal var name (L5/L37) so boot.ts + the desktop .env-allowlist follow-up reference one literal.
    expect(REACHABILITY_LIVE_ENV_VAR).toBe("SOW_SUBSCRIPTION_REACHABILITY_LIVE");
  });
});
