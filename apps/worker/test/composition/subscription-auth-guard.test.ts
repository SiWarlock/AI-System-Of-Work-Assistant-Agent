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

  // 18.37 — the FULL grounded provider surface (extends 18.28's 13-key set to 29; claude-code-guide vs LIVE
  // Claude-Code docs 2026-07-20: env-vars.md / authentication.md / amazon-bedrock.md / google-vertex-ai.md /
  // microsoft-foundry.md). Adds the account-shadow token (`CLAUDE_CODE_OAUTH_TOKEN`, precedence #5 — above the
  // subscription), the two missing provider switches (`CLAUDE_CODE_USE_FOUNDRY` + `CLAUDE_CODE_USE_MANTLE` —
  // ⭐ Mantle is load-bearing: the AWS creds below activate under Bedrock OR Mantle, so EXCLUDING them is only
  // fail-safe because BOTH switches are watched), the Anthropic-namespaced by-presence provider creds, the
  // per-provider base-URL/endpoint redirects, and the mTLS client-cert vars. A missed var/case is a silent
  // FAIL-OPEN → wrong billing / redirected egress on the armed path (L61). The `some()` logic is unchanged; a
  // set var DEGRADES the arm fail-closed, never crashes boot (L52/L62).
  const FULL_SHADOWING_SET = [
    // Class A — auth-shadowing (which auth/provider): direct tokens + provider switches.
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    // Class A — by-presence provider credentials (Anthropic-namespaced / Bedrock bearer).
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    // Class B — egress-redirect (content could go elsewhere / be intercepted).
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    // Class C — mTLS client certs (change the client identity → mTLS to a custom endpoint when paired w/ a redirect).
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  ] as const;

  it("shadowing_env_full_set_enumerated — the guard watches ALL 30 grounded shadowing vars (claude-code-guide, live docs) [spec(§19.5)]", () => {
    // The exact set (order-independent) — a var dropped from the constant is a silent fail-open vector.
    expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS].sort()).toStrictEqual([...FULL_SHADOWING_SET].sort());
  });

  it("shadowing_env_full_set_each_var_fails_closed — for EACH of the 30 vars: armed+set ⇒ refuse; armed all-unset ⇒ ok; unarmed+set ⇒ ok [spec(§19.5)]", () => {
    for (const key of FULL_SHADOWING_SET) {
      const armedSet = assertSubscriptionAuthEnv(true, { [key]: "shadow-value" });
      expect(isErr(armedSet), `armed + ${key} set must refuse`).toBe(true);
      if (isErr(armedSet)) {
        expect(armedSet.error.code).toBe("anthropic_key_set_on_armed_path");
        expect(JSON.stringify(armedSet.error)).not.toContain("shadow-value"); // rule 7 — value never echoed
      }
      // The SAME var set on the UNARMED path ⇒ ok (byte-equivalent default never reads env).
      expect(isOk(assertSubscriptionAuthEnv(false, { [key]: "shadow-value" })), `unarmed + ${key} ⇒ ok`).toBe(true);
    }
    // All 29 unset on the armed path ⇒ ok (the subscription profile is used).
    expect(isOk(assertSubscriptionAuthEnv(true, {}))).toBe(true);
  });

  it("shadowing_env_exclusions_stay_excluded — bypass/routing/generic-cred values do NOT degrade the armed path [spec(L65)]", () => {
    // L65 — a var that does NOT shadow BY PRESENCE ALONE stays out: NO_PROXY (bypass-allowlist), the generic
    // cloud creds (inert without a watched USE_* switch — Bedrock/Vertex/Foundry/Mantle all watched), and pure
    // routing/project-ID/region values. Watching any of these would permanently FALSE-degrade a legit armed
    // config (the common-var class). Each present alone on the ARMED path ⇒ ok (no refusal).
    const excluded = [
      "NO_PROXY",
      "no_proxy",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GCLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "ANTHROPIC_AWS_WORKSPACE_ID",
      "ANTHROPIC_WORKSPACE_ID",
      "CLOUD_ML_REGION",
    ] as const;
    for (const key of excluded) {
      expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS] as string[], `${key} must NOT be watched`).not.toContain(key);
      expect(isOk(assertSubscriptionAuthEnv(true, { [key]: "present" })), `armed + ${key} ⇒ ok (not a shadow)`).toBe(true);
    }
  });

  it("aws_cred_activating_switches_all_watched — the load-bearing dependency for the generic-AWS-cred exclusion [spec(§19.5)]", () => {
    // ⭐ The generic AWS creds are EXCLUDED because the provider switch is the real trigger + is watched. But the
    // AWS creds activate under Bedrock, Mantle, AND Claude-Platform-on-AWS (claude-code `_HAS_3P_PROVIDER_AT_LOAD`)
    // — so excluding them is fail-OPEN unless ALL THREE AWS-cred-activating switches are watched. Pin every one.
    for (const sw of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"] as const) {
      expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS] as string[], `${sw} must be watched`).toContain(sw);
      expect(isErr(assertSubscriptionAuthEnv(true, { [sw]: "1" })), `armed + ${sw} ⇒ refuse`).toBe(true);
    }
  });
});
