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

  // 18.38 — the FULL grounded provider surface, RE-GROUNDED against the SDK-BUNDLED claude-code (2.1.201 — the
  // ACTUAL Agent-SDK `query()` runtime; the standalone 2.1.216 CLI is a SEPARATE newer artifact). Extends
  // 18.37's 30-key set to 60. A repo-source `strings` re-ground of the shipped binary + claude-code-guide vs
  // live docs found 18.37's public-docs grounding under-covered the shipped surface a THIRD time (worker L72 —
  // ground vs the AUTHORITATIVE RUNTIME-BUNDLED binary, not public docs). New: the GATEWAY + CCR-router provider
  // switches, the SKIP_*_AUTH gateway-handoff signals, the *_FILE/_FILE_DESCRIPTOR credential-indirection
  // channels, ANTHROPIC_IDENTITY_TOKEN(_FILE), the Mantle API key, the GCP first-party family (FWD — present in
  // 2.1.216, over-inclusion fail-safe for an SDK bump), the CC-namespaced base-url/proxy redirects,
  // ANTHROPIC_UNIX_SOCKET / ANTHROPIC_CONFIG_DIR, and the mTLS cert-store. A missed var/case is a silent
  // FAIL-OPEN → wrong billing / redirected egress on the armed path (L61/L72). The `some()` logic is unchanged;
  // a set var DEGRADES the arm fail-closed, never crashes boot (L52/L62). Single-sourced (settings-`env` reuses it).
  const FULL_SHADOWING_SET = [
    // Class A — auth-shadowing: direct tokens + credential-indirection channels (the *_FILE(_DESCRIPTOR) variants
    // are the easiest way a credential slips past a name-prefix allowlist — grounded, corroborated).
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    // Class A — host-managed auth cluster (18.38 Step-8 security re-ground — the "still-missed" cluster the reviewer caught).
    "CLAUDE_CODE_HFI_BEARER_TOKEN",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
    // Class A — provider / gateway / router / host switches (watched → the generic-cloud-cred exclusion stays sound, L72).
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_CCR_V2",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    // Class A — SKIP-auth gateway-handoff signals (a "provider creds held by a gateway" flag ⇒ leaving the subscription).
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
    // Class A — by-presence provider credentials (Anthropic-namespaced / Bedrock bearer / CCR-router token).
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_AWS_AUTH",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
    "ANTHROPIC_GOOGLE_CLOUD_AUTH",
    "ANTHROPIC_ENVIRONMENT_KEY",
    "ANTHROPIC_PROFILE",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CCR_OAUTH_TOKEN_FILE",
    // Class B — egress-redirect (content could go elsewhere / be intercepted); both proxy cases (Node honors lowercase).
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_URL",
    "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_GB_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "ANTHROPIC_UNIX_SOCKET",
    "ANTHROPIC_CONFIG_DIR",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "CLAUDE_CODE_PROXY_URL",
    "CLAUDE_CODE_PROXY_HOST",
    "CLAUDE_CODE_HTTP_PROXY",
    "CLAUDE_CODE_HTTPS_PROXY",
    // bare-CLAUDE_ namespace (18.38 Step-8 re-verify — the reviewer's cross-namespace sweep; the denylist's structural leak).
    "CLAUDE_ENV_FILE",
    "CLAUDE_AI_AUTHORIZE_URL",
    "CLAUDE_AI_ORIGIN",
    "CLAUDE_LOCAL_OAUTH_API_BASE",
    "CLAUDE_LOCAL_OAUTH_APPS_BASE",
    "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE",
    "CLAUDE_BRIDGE_BASE_URL",
    "CLAUDE_BRIDGE_SESSION_INGRESS_URL",
    "CLAUDE_BRIDGE_OAUTH_TOKEN",
    "CLAUDE_BRIDGE_USE_CCR_V2",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    // Class C — mTLS client certs + cert-store (change the client identity → mTLS to a custom endpoint w/ a redirect).
    "CLAUDE_CODE_CLIENT_CERT",
    "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
    "CLAUDE_CODE_CERT_STORE",
  ] as const;

  it("shadowing_env_full_set_enumerated — the guard watches ALL 81 grounded shadowing vars (SDK-bundled 2.1.201 full-namespace re-ground) [spec(§19.5)]", () => {
    // The exact set (order-independent) — a var dropped from the constant is a silent fail-open vector.
    expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS].sort()).toStrictEqual([...FULL_SHADOWING_SET].sort());
    // Count + no-dup pins: the sort-compare alone passes if a duplicate is added symmetrically to BOTH lists
    // (a silent under-count of real coverage) — pin the exact count AND uniqueness so a dup can't hide.
    expect(SUBSCRIPTION_SHADOWING_ENV_KEYS).toHaveLength(81);
    expect(new Set(SUBSCRIPTION_SHADOWING_ENV_KEYS).size).toBe(SUBSCRIPTION_SHADOWING_ENV_KEYS.length);
  });

  it("shadowing_env_full_set_each_var_fails_closed — for EACH of the 81 vars: armed+set ⇒ refuse; armed all-unset ⇒ ok; unarmed+set ⇒ ok [spec(§19.5)]", () => {
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
    // All 81 unset on the armed path ⇒ ok (the subscription profile is used).
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
      // 18.38 note-only (owner/lead-approved 2026-07-20): NODE_EXTRA_CA_CERTS is a TLS-interception enabler but
      // INERT without a watched proxy/base-url redirect (all now watched); watching it by-presence would
      // false-degrade legit CI/TLS armed configs (L65/NO_PROXY class). Pinned EXCLUDED so a future well-meaning
      // add fails HERE (not just the set===N mirror) and forces a reconsider.
      "NODE_EXTRA_CA_CERTS",
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
      // 18.38 — the GCP first-party routing/region IDs are pure routing (carry no cred, redirect nothing) → EXCLUDED,
      // mirroring the AWS/Vertex routing-ID exclusions; watching them would false-degrade a legit GCP-provider config.
      "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
      "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
      "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
      "CLOUD_ML_REGION",
      // 18.38 Step-8 — bare-CLAUDE_ vars deliberately EXCLUDED as a DIFFERENT subsystem (NOT the model-billing/egress
      // path: background-shell/PTY auth, device MFA, remote session-ingress; extraction runs maxTurns:1 / tools:[] /
      // no background tasks ⇒ inert). Documented so a future re-ground doesn't re-flag them; 18.40 env-scrub covers
      // them by construction regardless. Also EXCLUDED (ambiguous / routinely-set ⇒ would false-degrade): CLAUDE_BASE,
      // CLAUDE_PROJECT_DIR, CLAUDE_JOB_DIR, CLAUDE_SESSION_ID.
      "CLAUDE_BG_CLAIM_AUTH",
      "CLAUDE_BG_PTY_AUTH",
      "CLAUDE_TRUSTED_DEVICE_TOKEN",
      "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
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

  it("gcp_cred_activating_switches_all_watched — restores the generic-GCP-cred exclusion soundness (L72, GCP analog) [spec(§19.5)]", () => {
    // ⭐ L72 (GCP analog of the AWS soundness pin). The generic GCP creds (GOOGLE_APPLICATION_CREDENTIALS /
    // GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT) are EXCLUDED because a provider SWITCH is the real trigger + is watched.
    // They activate under Vertex OR Anthropic-on-Google-Cloud — so the exclusion is fail-OPEN unless BOTH switches
    // are watched. In the 2.1.201 runtime Vertex alone already covers them; watching CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD
    // restores soundness for the 2.1.216+ Anthropic-on-GCP provider (forward-safe over-inclusion). Pin both switches
    // watched, AND the generic GCP creds + GCP routing IDs stay UNWATCHED (the exclusion holds).
    for (const sw of ["CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"] as const) {
      expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS] as string[], `${sw} must be watched`).toContain(sw);
      expect(isErr(assertSubscriptionAuthEnv(true, { [sw]: "1" })), `armed + ${sw} ⇒ refuse`).toBe(true);
    }
    for (const cred of ["GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"] as const) {
      expect([...SUBSCRIPTION_SHADOWING_ENV_KEYS] as string[], `${cred} must stay excluded`).not.toContain(cred);
      expect(isOk(assertSubscriptionAuthEnv(true, { [cred]: "present" })), `armed + ${cred} ⇒ ok (switch is the trigger)`).toBe(true);
    }
  });
});
