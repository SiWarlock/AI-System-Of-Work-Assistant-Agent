// 18.23 step 0 — the ANTHROPIC_API_KEY-unset armed-path guard (staged ENABLE; DORMANT).
//
// Option B runs extraction on the Claude SUBSCRIPTION (ambient local `claude` login). A set/stale
// ANTHROPIC_API_KEY SHADOWS the subscription profile by the Agent SDK's resolution precedence — so on the
// ARMED path the worker MUST run with it UNSET. This guard REFUSES fail-closed (a boot-visible typed error,
// NOT a silent raw-API fallback) when the key is set on the armed path.
//
// CO-GATED with arming (STRICT `=== true`): the default (unarmed) path NEVER reads env, so the shipped
// default is byte-equivalent — a worker that legitimately has a key set for other uses is unaffected until
// the owner arms. Rule 7: the fault is CODE-ONLY — the key VALUE is never read into the result.
//
// Reachability-WAIVERED (L11): NO production caller this slice — boot calls this on the armed path at the
// owner ENABLE (step 6, HARD STOP), alongside the route/health/transport arming (one flip).
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";

/** A redaction-safe fault (code-only; the env VALUE is NEVER surfaced — rule 7).
 *  NB: the `code` string is LEGACY (coined when the guard watched only `ANTHROPIC_API_KEY`); it now covers the
 *  full auth-shadowing + egress-redirect set below. Kept unchanged deliberately — a rename is a contract change
 *  for zero safety gain (the code is code-only + already redaction-safe). */
export interface SubscriptionAuthFault {
  readonly code: "anthropic_key_set_on_armed_path";
}

/**
 * The credential/base-url env vars that SHADOW the subscription profile by the Agent SDK's resolution
 * precedence (a set env var here makes the SDK use that credential/endpoint instead of the ambient `claude`
 * subscription login → wrong billing or redirected egress). The Agent SDK `query()` runs on Claude Code, so
 * Claude Code's auth/egress env vars apply.
 *
 * 18.37 — the FULL grounded PROVIDER surface (extends 18.28's 13-key set to 29). Grounded via claude-code-guide
 * vs LIVE Claude-Code docs 2026-07-20 (env-vars.md / authentication.md / amazon-bedrock.md / google-vertex-ai.md
 * / microsoft-foundry.md). The set is SINGLE-SOURCED — `assertSubscriptionAuthEnv` (the `process.env` guard) AND
 * 18.36's `subscription-settings-guard` settings-`env` leg both consume it, so one edit hardens both.
 *   • Class A — auth-shadowing (WHICH auth/provider): the direct tokens `ANTHROPIC_API_KEY` (#3),
 *     `ANTHROPIC_AUTH_TOKEN` (#2), `CLAUDE_CODE_OAUTH_TOKEN` (#5 — a `setup-token` OAuth token that outranks the
 *     `/login` subscription and can carry a DIFFERENT account); the provider switches `CLAUDE_CODE_USE_BEDROCK` /
 *     `_USE_VERTEX` / `_USE_FOUNDRY` / `_USE_MANTLE` / `_USE_ANTHROPIC_AWS` (switch to AWS/GCP/Azure/Mantle/
 *     Claude-Platform-on-AWS — a different provider/egress; the 5 grounded in claude-code `_HAS_3P_PROVIDER_AT_LOAD`);
 *     and the Anthropic-namespaced by-presence provider creds `ANTHROPIC_AWS_API_KEY` / `ANTHROPIC_FOUNDRY_API_KEY`
 *     / `ANTHROPIC_FOUNDRY_AUTH_TOKEN` / `AWS_BEARER_TOKEN_BEDROCK`.
 *   • Class B — egress-redirect: `ANTHROPIC_BASE_URL` (the real redirect defense), `ANTHROPIC_API_URL` (a legacy
 *     SDK alias — kept, harmless), `ANTHROPIC_CUSTOM_HEADERS`, the per-provider base-URL/endpoint overrides
 *     (`ANTHROPIC_BEDROCK_BASE_URL` / `_VERTEX_BASE_URL` / `_FOUNDRY_BASE_URL` / `_AWS_BASE_URL` /
 *     `_BEDROCK_MANTLE_BASE_URL` / `ANTHROPIC_FOUNDRY_RESOURCE` — the Foundry endpoint is built from it), and the
 *     proxy vars in BOTH cases (`HTTP_PROXY`/`http_proxy`/… — Node/undici honor lowercase; a missed case = silent fail-OPEN).
 *   • Class C — mTLS client certs (`CLAUDE_CODE_CLIENT_CERT` / `_CLIENT_KEY` / `_CLIENT_KEY_PASSPHRASE`): change
 *     the client identity → mTLS to a custom endpoint when paired with a base-URL redirect.
 * A `some()` over this set keeps the guard extensible without a logic change (L61); over-inclusion is the
 * fail-safe direction (a watched var the SDK doesn't honor only degrades the owner-gated armed path).
 *
 * ⚠ DELIBERATELY EXCLUDED (each does NOT shadow BY PRESENCE ALONE — watching them would permanently FALSE-degrade
 * a legit armed config, the L65 `NO_PROXY`-class): `NO_PROXY`/`no_proxy` (a bypass allowlist, not a redirect); the
 * COMMON generic cloud creds `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`/`AWS_PROFILE`/
 * `GOOGLE_APPLICATION_CREDENTIALS`/`GCLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT` — inert unless a `USE_*` switch is set,
 * and ALL FIVE switches are watched above (⭐ load-bearing: the generic AWS creds activate under Bedrock, Mantle,
 * AND Claude-Platform-on-AWS — so this exclusion is fail-OPEN unless `_USE_MANTLE` + `_USE_ANTHROPIC_AWS` are BOTH
 * watched, which they now are); and routing/project-IDs/regions (`ANTHROPIC_VERTEX_PROJECT_ID`
 * /`ANTHROPIC_AWS_WORKSPACE_ID`/`ANTHROPIC_WORKSPACE_ID`/`CLOUD_ML_REGION` — carry no credential, redirect nothing).
 *
 * ⚠ NOT env-var reachable (backstopped elsewhere): `apiKeyHelper` (precedence #4, above the subscription) is a
 * SETTINGS key — covered by 18.36's `subscription-settings-guard` `SETTINGS_INJECTION_FIELDS`; a Claude-apps
 * GATEWAY session outranks even the switches with no single env var (a §ARM-18 deployment-checklist residual). A
 * final re-verify vs the LIVE docs at the flip stays a HARD precondition (the SDK's honored set shifts by version;
 * reconsider `NODE_EXTRA_CA_CERTS` there — inert unless a watched proxy var is also set).
 */
export const SUBSCRIPTION_SHADOWING_ENV_KEYS = [
  // Class A — auth-shadowing: direct tokens + provider switches.
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
  // Class B — egress-redirect (both proxy cases — Node honors lowercase; NO_PROXY excluded, see above):
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
  // Class C — mTLS client certs (change the client identity → mTLS to a custom endpoint when paired w/ a redirect):
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
] as const;

/**
 * On the ARMED subscription path, refuse fail-closed if ANY subscription-shadowing env var is set. STRICT
 * `=== true` on `armed` (a truthy-not-`true` value ⇒ unarmed, never reads env — L28); co-gated so the
 * default path is byte-equivalent. The refusal is a typed `Result` err (boot maps it to a boot-visible
 * fail-closed error, never a silent fallback — §16). Rule 7: the fault is code-only — no env VALUE is read
 * into the result. Pure apart from the injected/default env read; never throws.
 */
export function assertSubscriptionAuthEnv(
  armed: boolean,
  env: Record<string, string | undefined> = process.env,
): Result<void, SubscriptionAuthFault> {
  if (armed === true && SUBSCRIPTION_SHADOWING_ENV_KEYS.some((k) => env[k] !== undefined)) {
    return err({ code: "anthropic_key_set_on_armed_path" });
  }
  return ok(undefined);
}
