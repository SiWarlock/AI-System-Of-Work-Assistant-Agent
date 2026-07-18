// 18.23 step 0 — the ANTHROPIC_API_KEY-unset armed-path guard (dormant). Option B runs extraction on the
// Claude SUBSCRIPTION (ambient local `claude` login); a set/stale ANTHROPIC_API_KEY SHADOWS the subscription
// profile by resolution precedence. On the ARMED path the guard REFUSES fail-closed (a boot-visible typed
// error — NOT a silent raw-API fallback). Co-gated with arming: the default (unarmed) path NEVER reads env
// (byte-equivalent). Reachability-WAIVERED (L11) — boot calls it on the armed path at the owner ENABLE.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  assertSubscriptionAuthEnv,
  SUBSCRIPTION_SHADOWING_ENV_KEYS,
} from "../../src/composition/subscription-auth-guard";

describe("assertSubscriptionAuthEnv — ANTHROPIC_API_KEY-unset armed-path guard (18.23 step 0, dormant)", () => {
  it("anthropic_key_set_on_armed_path_refuses — armed + key SET ⇒ fail-closed typed refusal (no raw-API fallback) [spec(§19.5)]", () => {
    const res = assertSubscriptionAuthEnv(true, { ANTHROPIC_API_KEY: "sk-canary-stale" });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("anthropic_key_set_on_armed_path");
    expect(JSON.stringify(res.error)).not.toContain("sk-canary"); // rule 7 — the key VALUE is never echoed
  });

  it("anthropic_key_unset_on_armed_path_ok — armed + key UNSET ⇒ ok (the subscription profile is used) [spec(§19.5)]", () => {
    expect(isOk(assertSubscriptionAuthEnv(true, {}))).toBe(true);
  });

  it("default_path_never_checks_key — armed=false ⇒ ok EVEN with the key SET (dormant default never reads env) [spec(L23)]", () => {
    // The guard fires ONLY when armed — proving the shipped (unarmed) default is byte-equivalent + never
    // refuses on a set key (which is the normal state today: the worker may have a key set for other uses).
    expect(isOk(assertSubscriptionAuthEnv(false, { ANTHROPIC_API_KEY: "sk-whatever" }))).toBe(true);
  });

  it("armed_truthy_not_true_never_refuses — STRICT ===true; a truthy-not-true armed value ⇒ unarmed, never reads env [spec(L28)]", () => {
    expect(isOk(assertSubscriptionAuthEnv("true" as unknown as boolean, { ANTHROPIC_API_KEY: "sk-x" }))).toBe(true);
  });

  // 18.24 step-6 — enumerate the FULL grounded shadowing-env set (runbook CHECKPOINT-1 RESULT; Context7
  // /nothflare/claude-agent-sdk-docs). Extends the guard from the single arch-named var to all 8 SDK
  // credential/base-url overrides that can displace the ambient `claude` subscription login (a missed one
  // is a silent FAIL-OPEN → wrong billing / redirected egress). The `some()` logic is unchanged (L61).
  const FULL_SHADOWING_SET = [
    // Class A — auth-shadowing (which auth/provider):
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    // Class B — egress-redirect (content could go elsewhere):
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_URL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ] as const;

  it("shadowing_env_full_set_enumerated — the guard watches ALL 8 grounded shadowing vars (Context7) [spec(§19.5)]", () => {
    // The exact set (order-independent) — a var dropped from the constant is a silent fail-open vector.
    expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS].sort()).toStrictEqual([...FULL_SHADOWING_SET].sort());
  });

  it("shadowing_env_full_set_each_var_fails_closed — for EACH of the 8 vars: armed+set ⇒ refuse; armed all-unset ⇒ ok; unarmed+set ⇒ ok [spec(§19.5)]", () => {
    for (const key of FULL_SHADOWING_SET) {
      const armedSet = assertSubscriptionAuthEnv(true, { [key]: "shadow-value" });
      expect(isErr(armedSet)).toBe(true);
      if (isErr(armedSet)) {
        expect(armedSet.error.code).toBe("anthropic_key_set_on_armed_path");
        expect(JSON.stringify(armedSet.error)).not.toContain("shadow-value"); // rule 7 — value never echoed
      }
      // The SAME var set on the UNARMED path ⇒ ok (byte-equivalent default never reads env).
      expect(isOk(assertSubscriptionAuthEnv(false, { [key]: "shadow-value" }))).toBe(true);
    }
    // All 8 unset on the armed path ⇒ ok (the subscription profile is used).
    expect(isOk(assertSubscriptionAuthEnv(true, {}))).toBe(true);
  });
});
